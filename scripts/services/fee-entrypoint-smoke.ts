/**
 * Negative-path smoke test: verifies that `fee_entrypoint` cannot be called
 * as a root-level transaction (outside the setup phase).
 *
 * Uses pre-deployed contracts from a deployment manifest and fetches a real
 * quote from the attestation service via the FPC SDK. The happy-path flow is
 * covered by the Noir contract unit tests
 * (`contracts/fpc/src/test/fee_entrypoint.nr`) and the same-token-transfer
 * integration test (`scripts/same-token-transfer/test-same-token-transfer.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";

const pinoLogger = pino();

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { Gas } from "@aztec/stdlib/gas";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import { FpcClient } from "@aztec-fpc/sdk";
import { resolveScriptAccounts } from "../common/script-credentials.ts";

const FPC_ARTIFACT_FILE_CANDIDATES = ["fpc-FPCMultiAsset.json", "fpc-FPC.json"] as const;

type SmokeConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  manifestPath: string;
  attestationBaseUrl: string;
  daGasLimit: number;
  l2GasLimit: number;
};

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric env var ${name}=${value}`);
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

async function expectFailure(
  scenario: string,
  expectedSubstrings: string[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    const normalized = message.toLowerCase();
    if (expectedSubstrings.some((needle) => normalized.includes(needle.toLowerCase()))) {
      pinoLogger.info(`[smoke] PASS: ${scenario}`);
      return;
    }
    throw new Error(`${scenario} failed with unexpected error: ${message}`);
  }
  throw new Error(`${scenario} unexpectedly succeeded`);
}

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
  const explicitPath = process.env.FPC_FPC_ARTIFACT;
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath);
  }

  for (const artifactFile of FPC_ARTIFACT_FILE_CANDIDATES) {
    const candidatePath = path.join(repoRoot, "target", artifactFile);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const fallback = path.join(repoRoot, "target", FPC_ARTIFACT_FILE_CANDIDATES[0]);
  throw new Error(
    `FPC artifact not found. Looked for ${FPC_ARTIFACT_FILE_CANDIDATES.map((entry) => path.join(repoRoot, "target", entry)).join(", ")}. Set FPC_FPC_ARTIFACT to override. Default fallback path: ${fallback}`,
  );
}

function getConfig(): SmokeConfig {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const l1RpcUrl = process.env.L1_RPC_URL ?? "http://localhost:8545";
  const manifestPath = requireEnv("FPC_COLD_START_MANIFEST");
  const attestationBaseUrl = requireEnv("FPC_ATTESTATION_URL").replace(/\/$/, "");
  const daGasLimit = readEnvNumber("FPC_SMOKE_DA_GAS_LIMIT", 200_000);
  const l2GasLimit = readEnvNumber("FPC_SMOKE_L2_GAS_LIMIT", 1_000_000);

  return {
    nodeUrl,
    l1RpcUrl,
    manifestPath,
    attestationBaseUrl,
    daGasLimit,
    l2GasLimit,
  };
}

async function main() {
  const config = getConfig();

  // Read pre-deployed contract addresses from manifest.
  if (!existsSync(config.manifestPath)) {
    throw new Error(`Manifest not found: ${config.manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8")) as DevnetDeployManifest;
  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);
  const operator = AztecAddress.fromString(manifest.operator.address);

  pinoLogger.info(`[smoke] manifest=${config.manifestPath}`);
  pinoLogger.info(`[smoke] fpc=${fpcAddress.toString()}`);
  pinoLogger.info(`[smoke] token=${tokenAddress.toString()}`);

  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node);

  const { accounts: testAccounts } = await resolveScriptAccounts(
    config.nodeUrl,
    config.l1RpcUrl,
    wallet,
    1,
  );
  const user = testAccounts[0].address;
  pinoLogger.info(`[smoke] user=${user.toString()}`);

  // Use the SDK to fetch a real quote from the attestation service.
  const fpcClient = new FpcClient({
    fpcAddress,
    operator,
    node,
    attestationBaseUrl: config.attestationBaseUrl,
  });

  const estimatedGas = {
    gasLimits: new Gas(config.daGasLimit, config.l2GasLimit),
    teardownGasLimits: new Gas(0, 0),
  };
  const { quote } = await fpcClient.createPaymentMethod({
    wallet,
    user,
    tokenAddress,
    estimatedGas,
  });

  const fjAmount = BigInt(quote.fj_amount);
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const validUntil = BigInt(quote.valid_until);
  const sigBytes = Array.from(Buffer.from(quote.signature.replace(/^0x/, ""), "hex"));

  pinoLogger.info(`[smoke] fj_amount=${fjAmount}`);
  pinoLogger.info(`[smoke] aa_payment_amount=${aaPaymentAmount}`);
  pinoLogger.info(`[smoke] valid_until=${validUntil}`);

  // Load FPC artifact to call fee_entrypoint directly (bypassing the SDK's
  // payment method, which would correctly route it through the setup phase).
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const fpcArtifactPath = resolveFpcArtifactPath(repoRoot);
  const fpcArtifact = loadArtifact(fpcArtifactPath);
  const fpc = Contract.at(fpcAddress, fpcArtifact, wallet);

  // Negative test: calling fee_entrypoint directly as a root-level transaction
  // must fail because it is only valid in the setup phase. The quote is real
  // (valid signature from the attestation service), but the phase check fires
  // before any quote or signature validation.
  await expectFailure(
    "direct fee_entrypoint call rejected outside setup phase",
    ["must run in setup phase", "unknown auth witness"],
    () =>
      fpc.methods
        .fee_entrypoint(tokenAddress, Fr.random(), fjAmount, aaPaymentAmount, validUntil, sigBytes)
        .send({
          from: user,
          wait: { timeout: 180 },
        }),
  );

  pinoLogger.info("[smoke] PASS: fee_entrypoint negative-path smoke succeeded");
}

try {
  await main();
} catch (error) {
  pinoLogger.error(`[smoke] FAIL: ${(error as Error).message}`);
  process.exit(1);
}
