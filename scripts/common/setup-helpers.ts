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
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import pino from "pino";

const pinoLogger = pino();

// ---------------------------------------------------------------------------
// Contract registration
// ---------------------------------------------------------------------------

export async function registerAndGet(
  node: AztecNode,
  wallet: EmbeddedWallet,
  addressHex: string,
  artifactPath: string,
  secretKey?: Fr,
) {
  const address = AztecAddress.fromString(addressHex);
  const instance = await node.getContract(address);
  if (!instance) {
    throw new Error(`Contract not found on node: ${addressHex}`);
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

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function readManifest(manifestPath: string): DevnetDeployManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as DevnetDeployManifest;
}

// ---------------------------------------------------------------------------
// Node + wallet
// ---------------------------------------------------------------------------

export async function connectAndCreateWallet(nodeUrl: string, proverEnabled: boolean) {
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled },
  });
  return { node, wallet };
}

// ---------------------------------------------------------------------------
// Core contract registration (token + FPC + counter)
// ---------------------------------------------------------------------------

export type CoreContracts = {
  token: Contract;
  fpc: Contract;
  counter?: Contract;
  faucet?: Contract;
  bridge?: Contract;
};

export async function registerCoreContracts(
  repoRoot: string,
  manifest: DevnetDeployManifest,
  node: AztecNode,
  wallet: EmbeddedWallet,
): Promise<CoreContracts> {
  const target = path.join(repoRoot, "target");

  const token = await registerAndGet(
    node,
    wallet,
    manifest.contracts.accepted_asset,
    path.join(target, "token_contract-Token.json"),
  );
  const fpc = await registerAndGet(
    node,
    wallet,
    manifest.contracts.fpc,
    path.join(target, "fpc-FPCMultiAsset.json"),
    Fr.ZERO,
  );

  const counter = manifest.contracts.counter
    ? await registerAndGet(
        node,
        wallet,
        manifest.contracts.counter,
        path.join(target, "mock_counter-Counter.json"),
      )
    : undefined;

  const faucet = manifest.contracts.faucet
    ? await registerAndGet(
        node,
        wallet,
        manifest.contracts.faucet,
        path.join(target, "faucet-Faucet.json"),
      )
    : undefined;

  const bridge = manifest.contracts.bridge
    ? await registerAndGet(
        node,
        wallet,
        manifest.contracts.bridge,
        path.join(target, "token_bridge_contract-TokenBridge.json"),
      )
    : undefined;

  return { token, fpc, counter, faucet, bridge };
}

// ---------------------------------------------------------------------------
// SponsoredFPC registration
// ---------------------------------------------------------------------------

export async function registerSponsoredFpc(wallet: EmbeddedWallet) {
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  return sponsoredFpcInstance.address;
}

// ---------------------------------------------------------------------------
// FeeJuice balance polling
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Common setup
// ---------------------------------------------------------------------------

export type SetupArgs = {
  nodeUrl: string;
  manifestPath: string;
  proverEnabled: boolean;
  messageTimeoutSeconds: number;
};

export type SetupResult = {
  manifest: DevnetDeployManifest;
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

  const manifest = readManifest(args.manifestPath);

  pinoLogger.info(
    `[${label}] manifest loaded. fpc=${manifest.contracts.fpc} token=${manifest.contracts.accepted_asset}`,
  );

  const { node, wallet } = await connectAndCreateWallet(args.nodeUrl, args.proverEnabled);

  const operator = AztecAddress.fromString(manifest.operator.address);
  pinoLogger.info(`[${label}] operator=${operator.toString()}`);

  const contracts = await registerCoreContracts(repoRoot, manifest, node, wallet);

  const sponsoredFpcAddress = await registerSponsoredFpc(wallet);

  await waitForFpcFeeJuice(contracts.fpc.address, node, args.messageTimeoutSeconds, label);

  return { manifest, node, wallet, operator, contracts, sponsoredFpcAddress };
}
