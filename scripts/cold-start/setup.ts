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
import { type Fq, Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { TestERC20Abi } from "@aztec/l1-artifacts";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import {
  computePartialAddress,
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import pino from "pino";
import { createWalletClient, fallback, getContract, type Hex, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  // biome-ignore lint/suspicious/noExplicitAny: accessing protected PXE for raw proving
  pxe: any;
  operator: AztecAddress;
  operatorSigningKey: Fq;
  attestationUrl: string;
  fpc: Contract;
  token: Contract;
  bridge: Contract;
  counter: Contract;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  bridgeAddress: AztecAddress;
  counterAddress: AztecAddress;
  sponsoredFpcAddress: AztecAddress;
  feePerDaGas: bigint;
  feePerL2Gas: bigint;
  fjFeeAmount: bigint;
  // biome-ignore lint/suspicious/noExplicitAny: viem version mismatch between @aztec/viem and viem makes explicit types impractical
  l1WalletClient: any;
  // biome-ignore lint/suspicious/noExplicitAny: viem version mismatch
  l1Erc20: any;
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
) {
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`Contract not found on node: ${address.toString()}`);
  }
  await wallet.registerContract(instance, artifact);
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
  if (!manifest.contracts.fpc_secret_key) {
    throw new Error("Manifest missing contracts.fpc_secret_key (required for cold-start)");
  }
  const fpcSecretFr = Fr.fromHexString(manifest.contracts.fpc_secret_key);

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
  const operatorSigningKey = operatorAccount.signingKey;

  pinoLogger.info(`[cold-start-smoke] accounts ready. operator=${operator.toString()}`);

  // 4. Register deployed contracts
  const tokenArtifact = loadArtifact(path.join(repoRoot, "target", "token_contract-Token.json"));
  const bridgeArtifact = loadArtifact(
    path.join(repoRoot, "target", "token_bridge_contract-TokenBridge.json"),
  );
  const fpcArtifact = loadArtifact(resolveFpcArtifactPath(repoRoot));
  const counterArtifact = loadArtifact(path.join(repoRoot, "target", "mock_counter-Counter.json"));

  const token = await registerAndGet(node, wallet, tokenAddress, tokenArtifact);
  const fpc = await registerAndGet(node, wallet, fpcAddress, fpcArtifact);
  const bridge = await registerAndGet(node, wallet, bridgeAddress, bridgeArtifact);
  const counter = await registerAndGet(node, wallet, counterAddress, counterArtifact);

  // Register the canonical SponsoredFPC contract (address derived from artifact + salt)
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  const sponsoredFpcAddress = sponsoredFpcInstance.address;

  // Register the FPC's keys in the PXE so the oracle can encrypt/decrypt
  // private notes for the FPC address.
  const fpcInstance = await node.getContract(fpcAddress);
  if (!fpcInstance) throw new Error(`FPC instance not found: ${fpcAddress}`);
  const fpcPartialAddr = await computePartialAddress(fpcInstance);
  // biome-ignore lint/suspicious/noExplicitAny: accessing protected PXE to register FPC's encryption keys
  await (wallet as any).pxe.registerAccount(fpcSecretFr, fpcPartialAddr);
  pinoLogger.info("[cold-start-smoke] registered FPC keys in PXE for note encryption");

  // 5. Compute gas parameters
  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = args.feePerDaGas ?? minFees.feePerDaGas;
  const feePerL2Gas = args.feePerL2Gas ?? minFees.feePerL2Gas;
  const maxGasCost = BigInt(args.daGasLimit) * feePerDaGas + BigInt(args.l2GasLimit) * feePerL2Gas;
  const fjFeeAmount = maxGasCost;

  pinoLogger.info(
    `[cold-start-smoke] gas parameters. fee_per_da_gas=${feePerDaGas} fee_per_l2_gas=${feePerL2Gas} max_gas_cost=${maxGasCost}`,
  );

  // 6. Wait for the topup service to fund the FPC with FeeJuice
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

  const l1Account = privateKeyToAccount(l1PrivateKey as Hex);
  const l1WalletClient = createWalletClient({
    account: l1Account,
    transport: fallback([http(args.l1RpcUrl)]),
  }).extend(publicActions);

  // 7. Set up L1 clients for token bridging (tests bridge their own tokens)
  const l1MintKey = (args.l1DeployerKey ?? l1PrivateKey) as Hex;
  const l1MintAccount = privateKeyToAccount(l1MintKey);
  const l1MintClient = createWalletClient({
    account: l1MintAccount,
    transport: fallback([http(args.l1RpcUrl)]),
  }).extend(publicActions);

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

  // biome-ignore lint/suspicious/noExplicitAny: accessing protected PXE for raw proving
  const pxe = (wallet as any).pxe;

  return {
    args,
    node,
    wallet,
    pxe,
    operator,
    operatorSigningKey,
    attestationUrl: args.attestationUrl,
    fpc,
    token,
    bridge,
    counter,
    fpcAddress,
    tokenAddress,
    bridgeAddress,
    counterAddress,
    sponsoredFpcAddress,
    feePerDaGas,
    feePerL2Gas,
    fjFeeAmount,
    l1WalletClient,
    l1Erc20,
    portalManager,
  };
}
