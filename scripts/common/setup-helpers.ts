/**
 * Shared setup helpers for smoke-test bootstrap scripts.
 *
 * Extracts the duplicated artifact-loading, contract-registration, node
 * connection, SponsoredFPC registration, and FeeJuice
 * polling logic that was copy-pasted across cold-start, always-revert, and
 * same-token-transfer setup modules.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import type { ExtendedViemWalletClient } from "@aztec/ethereum/types";
import type { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { TestERC20Abi } from "@aztec/l1-artifacts";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  type DeployManifest,
  readDeployManifest,
} from "@aztec-fpc/contract-deployment/src/manifest.ts";
import {
  readTestTokenManifest,
  type TestTokenManifest,
} from "@aztec-fpc/contract-deployment/src/test-token-manifest.ts";
import pino from "pino";
import { type Chain, extractChain, type GetContractReturnType, getContract, type Hex } from "viem";
import * as viemChains from "viem/chains";

const pinoLogger = pino();

export async function registerAndGet(
  node: AztecNode,
  wallet: EmbeddedWallet,
  address: AztecAddress,
  artifactPath: string,
  secretKey?: Fr,
) {
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`Contract not found on node: ${address.toString()}`);
  }
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  let artifact: ContractArtifact;
  try {
    artifact = loadContractArtifact(parsed);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      artifact = loadContractArtifactForPublic(parsed);
    } else {
      throw err;
    }
  }
  await wallet.registerContract(instance, artifact, secretKey);
  return Contract.at(address, artifact, wallet);
}

export function readManifest(manifestPath: string): DeployManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  return readDeployManifest(manifestPath);
}

export async function connectAndCreateWallet(nodeUrl: string, proverEnabled: boolean) {
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled, syncChainTip: "checkpointed" },
  });
  return { node, wallet };
}
export type CoreContracts = {
  token: Contract;
  fpc: Contract;
  counter: Contract;
  faucet: Contract;
  bridge: Contract;
};

export async function registerCoreContracts(
  repoRoot: string,
  manifest: DeployManifest,
  testTokenManifest: TestTokenManifest,
  node: AztecNode,
  wallet: EmbeddedWallet,
): Promise<CoreContracts> {
  const target = path.join(repoRoot, "target");

  const token = await registerAndGet(
    node,
    wallet,
    testTokenManifest.contracts.token,
    path.join(target, "token_contract-Token.json"),
  );
  const fpc = await registerAndGet(
    node,
    wallet,
    manifest.contracts.fpc,
    path.join(target, "fpc-FPCMultiAsset.json"),
    Fr.ZERO,
  );
  const counter = await registerAndGet(
    node,
    wallet,
    testTokenManifest.contracts.counter,
    path.join(target, "mock_counter-Counter.json"),
  );
  const faucet = await registerAndGet(
    node,
    wallet,
    testTokenManifest.contracts.faucet,
    path.join(target, "faucet-Faucet.json"),
  );
  const bridge = await registerAndGet(
    node,
    wallet,
    testTokenManifest.contracts.bridge,
    path.join(target, "token_bridge_contract-TokenBridge.json"),
  );

  return { token, fpc, counter, faucet, bridge };
}

export async function registerSponsoredFpc(wallet: EmbeddedWallet) {
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  return sponsoredFpcInstance.address;
}

export async function waitForFpcFeeJuice(
  fpcAddress: AztecAddress,
  node: AztecNode,
  timeoutSeconds: number,
  label: string,
): Promise<bigint> {
  pinoLogger.info(`[${label}] waiting for FPC FeeJuice balance > 0 (via topup service)`);

  const POLL_MS = 2_000;
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let balance = 0n;
  while (Date.now() < deadline) {
    balance = await getFeeJuiceBalance(fpcAddress, node);
    if (balance > 0n) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (balance === 0n) {
    throw new Error(
      `FPC FeeJuice balance is still 0 after ${timeoutSeconds}s — is the topup service running?`,
    );
  }

  pinoLogger.info(`[${label}] FPC FeeJuice balance=${balance}`);
  return balance;
}

/**
 * Mint L1 ERC20 tokens, retrying on nonce collisions.
 *
 * Multiple test containers share the same deployer key for minting (the
 * TestERC20 owner).  When they run in parallel, separate viem clients
 * independently query anvil for the next nonce, and one of them loses the
 * race.  A short backoff + retry lets the winner's tx confirm so the loser
 * picks up the incremented nonce on the next attempt.
 */
export async function mintL1Erc20WithRetry(
  l1Erc20: L1Infra["l1Erc20"],
  l1Client: ExtendedViemWalletClient,
  to: `0x${string}`,
  amount: bigint,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const hash = await l1Erc20.write.mint([to, amount]);
      const receipt = await l1Client.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        throw new Error("L1 ERC20 mint transaction reverted");
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/nonce|already known|replacement/i.test(msg) && attempt < maxRetries) {
        pinoLogger.warn(
          `L1 mint attempt ${attempt}/${maxRetries} hit nonce error, retrying in ${attempt}s`,
        );
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

export type L1InfraArgs = {
  l1RpcUrl: string;
  l1PrivateKey: Hex;
  l1DeployerKey: string;
  l1PortalAddress: EthAddress;
  l1Erc20Address: EthAddress;
  node: AztecNode;
  loggerName: string;
};

export type L1Infra = {
  l1WalletClient: ExtendedViemWalletClient;
  l1Erc20: GetContractReturnType<typeof TestERC20Abi, ExtendedViemWalletClient>;
  portalManager: L1ToL2TokenPortalManager;
};

export async function setupL1Infrastructure(args: L1InfraArgs): Promise<L1Infra> {
  const nodeInfo = await args.node.getNodeInfo();
  const l1Chain = extractChain({
    chains: Object.values(viemChains) as readonly Chain[],
    id: nodeInfo.l1ChainId,
  });

  const l1WalletClient = createExtendedL1Client([args.l1RpcUrl], args.l1PrivateKey, l1Chain);
  const l1MintClient = createExtendedL1Client([args.l1RpcUrl], args.l1DeployerKey, l1Chain);

  const l1Erc20 = getContract({
    address: args.l1Erc20Address.toString(),
    abi: TestERC20Abi,
    client: l1MintClient,
  });

  const portalManager = new L1ToL2TokenPortalManager(
    args.l1PortalAddress,
    args.l1Erc20Address,
    undefined,
    l1WalletClient,
    createLogger(args.loggerName),
  );

  return { l1WalletClient, l1Erc20, portalManager };
}

export type SetupArgs = {
  nodeUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  proverEnabled: boolean;
  messageTimeoutSeconds: number;
};

export type SetupResult = {
  manifest: DeployManifest;
  testTokenManifest: TestTokenManifest;
  node: AztecNode;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  contracts: CoreContracts;
  sponsoredFpcAddress: AztecAddress;
};

export async function setup(
  args: SetupArgs,
  repoRoot: string,
  label: string,
): Promise<SetupResult> {
  pinoLogger.info(`[${label}] starting`);
  pinoLogger.info(`[${label}] node_url=${args.nodeUrl}`);
  pinoLogger.info(`[${label}] manifest=${args.manifestPath}`);
  pinoLogger.info(`[${label}] test_token_manifest=${args.testTokenManifestPath}`);

  const manifest = readManifest(args.manifestPath);
  const testTokenManifest = readTestTokenManifest(args.testTokenManifestPath);

  pinoLogger.info(
    `[${label}] manifests loaded. fpc=${manifest.contracts.fpc} token=${testTokenManifest.contracts.token}`,
  );

  const { node, wallet } = await connectAndCreateWallet(args.nodeUrl, args.proverEnabled);

  const operator = manifest.operator.address;
  pinoLogger.info(`[${label}] operator=${operator.toString()}`);

  const contracts = await registerCoreContracts(
    repoRoot,
    manifest,
    testTokenManifest,
    node,
    wallet,
  );

  const sponsoredFpcAddress = await registerSponsoredFpc(wallet);

  await waitForFpcFeeJuice(contracts.fpc.address, node, args.messageTimeoutSeconds, label);

  return { manifest, testTokenManifest, node, wallet, operator, contracts, sponsoredFpcAddress };
}
