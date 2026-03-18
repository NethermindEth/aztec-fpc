/**
 * Environment bootstrap for same-token-transfer smoke tests.
 *
 * Connects to the Aztec node, registers accounts and contracts, and waits for
 * the topup service to fund the FPC with FeeJuice. Unlike the cold-start setup,
 * this flow uses a faucet instead of an L1 bridge — no L1 token infrastructure
 * is needed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import { FpcClient } from "@aztec-fpc/sdk";
import pino from "pino";
import { deriveAccount } from "../common/script-credentials.ts";
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
  fpcClient: FpcClient;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  token: Contract;
  faucet: Contract;
  counter: Contract;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
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

  pinoLogger.info("[same-token-transfer] starting");
  pinoLogger.info(`[same-token-transfer] node_url=${args.nodeUrl}`);
  pinoLogger.info(`[same-token-transfer] manifest=${args.manifestPath}`);

  // 1. Read manifest
  if (!existsSync(args.manifestPath)) {
    throw new CliError(`Manifest not found: ${args.manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(args.manifestPath, "utf8")) as DevnetDeployManifest;

  if (!manifest.contracts.faucet) {
    throw new Error("Manifest missing contracts.faucet (required for same-token-transfer)");
  }
  if (!manifest.contracts.counter) {
    throw new Error("Manifest missing contracts.counter (required for same-token-transfer)");
  }
  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);
  const faucetAddress = AztecAddress.fromString(manifest.contracts.faucet);
  const counterAddress = AztecAddress.fromString(manifest.contracts.counter);

  pinoLogger.info(
    `[same-token-transfer] manifest loaded. fpc=${manifest.contracts.fpc} token=${manifest.contracts.accepted_asset} faucet=${manifest.contracts.faucet}`,
  );

  // 2. Connect to node
  const node = createAztecNodeClient(args.nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: args.proverEnabled },
  });

  // 3. Setup operator account
  const operatorSecretFr = Fr.fromHexString(args.operatorSecretKey);
  const operatorAccount = await deriveAccount(operatorSecretFr, wallet);
  const operator = operatorAccount.address;

  pinoLogger.info(`[same-token-transfer] operator=${operator.toString()}`);

  // 4. Register deployed contracts (faucet + counter for non-FPC operations)
  const tokenArtifact = loadArtifact(path.join(repoRoot, "target", "token_contract-Token.json"));
  const fpcArtifact = loadArtifact(resolveFpcArtifactPath(repoRoot));
  const faucetArtifact = loadArtifact(path.join(repoRoot, "target", "faucet-Faucet.json"));
  const counterArtifact = loadArtifact(path.join(repoRoot, "target", "mock_counter-Counter.json"));

  const token = await registerAndGet(node, wallet, tokenAddress, tokenArtifact);
  await registerAndGet(node, wallet, fpcAddress, fpcArtifact);
  const faucet = await registerAndGet(node, wallet, faucetAddress, faucetArtifact);
  const counter = await registerAndGet(node, wallet, counterAddress, counterArtifact);

  // Register the canonical SponsoredFPC contract (address derived from artifact + salt)
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  const sponsoredFeePayment = new SponsoredFeePaymentMethod(sponsoredFpcInstance.address);

  // 5. Create FpcClient
  const fpcClient = new FpcClient({
    fpcAddress,
    operator,
    node,
    attestationBaseUrl: args.attestationUrl,
  });

  // 6. Wait for topup service to fund FPC with FeeJuice
  pinoLogger.info("[same-token-transfer] waiting for FPC FeeJuice balance > 0 (via topup service)");

  const FJ_POLL_MS = 2_000;
  const FJ_TIMEOUT_MS = args.messageTimeoutSeconds * 1_000;
  const fjDeadline = Date.now() + FJ_TIMEOUT_MS;
  let fjBalance = 0n;
  while (Date.now() <= fjDeadline) {
    fjBalance = await getFeeJuiceBalance(fpcAddress, node);
    if (fjBalance > 0n) break;
    await new Promise((resolve) => setTimeout(resolve, FJ_POLL_MS));
  }
  if (fjBalance === 0n) {
    throw new Error(`Timed out waiting for FPC FeeJuice balance on ${fpcAddress.toString()}`);
  }

  pinoLogger.info(`[same-token-transfer] FPC FeeJuice balance=${fjBalance}`);

  return {
    args,
    node,
    wallet,
    operator,
    fpcClient,
    fpcAddress,
    tokenAddress,
    token,
    faucet,
    counter,
    sponsoredFeePayment,
  };
}
