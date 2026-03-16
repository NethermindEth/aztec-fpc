/**
 * Environment bootstrap for cold-start smoke tests.
 *
 * Connects to the Aztec node, registers accounts and contracts, waits for the
 * topup service to fund the FPC with FeeJuice, and exposes L1 infrastructure
 * so each test can bridge its own tokens independently.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import type { ExtendedViemWalletClient } from "@aztec/ethereum/types";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { TestERC20Abi } from "@aztec/l1-artifacts";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import pino from "pino";
import { type Chain, extractChain, type GetContractReturnType, getContract, type Hex } from "viem";
import * as viemChains from "viem/chains";
import { deriveAccount, resolveScriptAccounts } from "../common/script-credentials.ts";
import { type CliArgs, CliError } from "./cli.ts";

const pinoLogger = pino();

// ---------------------------------------------------------------------------
// TestContext — everything tests need
// ---------------------------------------------------------------------------

export type TestContext = {
  args: CliArgs;
  node: ReturnType<typeof createAztecNodeClient>;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  token: Contract;
  counter: Contract;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  bridgeAddress: AztecAddress;
  sponsoredFpcAddress: AztecAddress;
  l1WalletClient: ExtendedViemWalletClient;
  l1Erc20: GetContractReturnType;
  portalManager: L1ToL2TokenPortalManager;
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function loadArtifact(artifactPath: string): ContractArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw err;
  }
}

function resolveFpcArtifactPath(repoRoot: string): string {
  for (const name of ["fpc-FPCMultiAsset.json", "fpc-FPC.json"]) {
    const p = path.join(repoRoot, "target", name);
    if (existsSync(p)) return p;
  }
  throw new Error("FPC artifact not found in target/");
}

async function registerAndGet(
  node: ReturnType<typeof createAztecNodeClient>,
  wallet: EmbeddedWallet,
  address: AztecAddress,
  artifact: ContractArtifact,
  secretKey?: Fr,
) {
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`Contract not found on node: ${address.toString()}`);
  }
  await wallet.registerContract(instance, artifact, secretKey);
  return Contract.at(address, artifact, wallet);
}

// ---------------------------------------------------------------------------
// setup()
// ---------------------------------------------------------------------------

export async function setup(args: CliArgs): Promise<TestContext> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  pinoLogger.info("[cold-start-smoke] starting");
  pinoLogger.info(`[cold-start-smoke] node_url=${args.nodeUrl}`);
  pinoLogger.info(`[cold-start-smoke] l1_rpc_url=${args.l1RpcUrl}`);
  pinoLogger.info(`[cold-start-smoke] attestation_url=${args.attestationUrl}`);
  pinoLogger.info(`[cold-start-smoke] manifest=${args.manifestPath}`);

  // 1. Read manifest
  if (!existsSync(args.manifestPath)) {
    throw new CliError(`Manifest not found: ${args.manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(args.manifestPath, "utf8")) as DevnetDeployManifest;

  if (!manifest.contracts.bridge) {
    throw new Error("Manifest missing contracts.bridge");
  }
  if (!manifest.contracts.counter) {
    throw new Error("Manifest missing contracts.counter");
  }
  if (!manifest.l1_contracts) {
    throw new Error("Manifest missing l1_contracts");
  }

  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);
  const bridgeAddress = AztecAddress.fromString(manifest.contracts.bridge);
  const counterAddress = AztecAddress.fromString(manifest.contracts.counter);
  const l1PortalAddress = manifest.l1_contracts.token_portal;
  const l1Erc20Address = manifest.l1_contracts.erc20;

  pinoLogger.info(
    `[cold-start-smoke] manifest loaded. fpc=${manifest.contracts.fpc} token=${manifest.contracts.accepted_asset} bridge=${manifest.contracts.bridge}`,
  );

  // 2. Connect to node
  const node = createAztecNodeClient(args.nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    pxeConfig: { proverEnabled: true },
  });

  // 3. Setup accounts
  const { l1PrivateKey } = await resolveScriptAccounts(args.nodeUrl, args.l1RpcUrl, wallet, 0);

  const operatorSecretFr = Fr.fromHexString(args.operatorSecretKey);
  const operatorAccount = await deriveAccount(operatorSecretFr, wallet);
  const operator = operatorAccount.address;

  pinoLogger.info(`[cold-start-smoke] accounts ready. operator=${operator.toString()}`);

  // 4. Register deployed contracts
  const tokenArtifact = loadArtifact(path.join(repoRoot, "target", "token_contract-Token.json"));
  const bridgeArtifact = loadArtifact(
    path.join(repoRoot, "target", "token_bridge_contract-TokenBridge.json"),
  );
  const fpcArtifact = loadArtifact(resolveFpcArtifactPath(repoRoot));
  const counterArtifact = loadArtifact(path.join(repoRoot, "target", "mock_counter-Counter.json"));

  const token = await registerAndGet(node, wallet, tokenAddress, tokenArtifact);
  await registerAndGet(node, wallet, fpcAddress, fpcArtifact, Fr.ZERO);
  await registerAndGet(node, wallet, bridgeAddress, bridgeArtifact);
  const counter = await registerAndGet(node, wallet, counterAddress, counterArtifact);

  // Register the canonical SponsoredFPC contract (address derived from artifact + salt)
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  const sponsoredFpcAddress = sponsoredFpcInstance.address;

  // 5. Wait for the topup service to fund the FPC with FeeJuice
  pinoLogger.info("[cold-start-smoke] waiting for FPC FeeJuice balance (funded by topup service)");

  const FEE_JUICE_POLL_MS = 2_000;
  const feeJuiceDeadline = Date.now() + args.messageTimeoutSeconds * 1_000;
  let fpcFeeJuiceBalance = 0n;
  while (Date.now() < feeJuiceDeadline) {
    fpcFeeJuiceBalance = await getFeeJuiceBalance(fpcAddress, node);
    if (fpcFeeJuiceBalance > 0n) break;
    await new Promise((resolve) => setTimeout(resolve, FEE_JUICE_POLL_MS));
  }
  if (fpcFeeJuiceBalance === 0n) {
    throw new Error(
      `FPC FeeJuice balance is still 0 after ${args.messageTimeoutSeconds}s — is the topup service running?`,
    );
  }
  pinoLogger.info(`[cold-start-smoke] FPC FeeJuice balance=${fpcFeeJuiceBalance}`);

  const nodeInfo = await node.getNodeInfo();
  const l1Chain = extractChain({
    chains: Object.values(viemChains) as readonly Chain[],
    id: nodeInfo.l1ChainId,
  });
  const l1WalletClient = createExtendedL1Client([args.l1RpcUrl], l1PrivateKey as Hex, l1Chain);

  // 6. Set up L1 clients for token bridging (tests bridge their own tokens)
  const l1MintKey = (args.l1DeployerKey ?? l1PrivateKey) as Hex;
  const l1MintClient = createExtendedL1Client([args.l1RpcUrl], l1MintKey, l1Chain);

  const l1Erc20 = getContract({
    address: l1Erc20Address as Hex,
    abi: TestERC20Abi,
    client: l1MintClient,
  });

  const portalManager = new L1ToL2TokenPortalManager(
    EthAddress.fromString(l1PortalAddress),
    EthAddress.fromString(l1Erc20Address),
    undefined,
    l1WalletClient,
    createLogger("cold-start:bridge"),
  );

  return {
    args,
    node,
    wallet,
    operator,
    token,
    counter,
    fpcAddress,
    tokenAddress,
    bridgeAddress,
    sponsoredFpcAddress,
    l1WalletClient,
    l1Erc20,
    portalManager,
  };
}
