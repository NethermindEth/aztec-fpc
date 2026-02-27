import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { type AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

type FullE2EMode = "fpc";

type FullE2EConfig = {
  mode: FullE2EMode;
  nodeUrl: string;
  l1RpcUrl: string;
  relayAdvanceBlocks: number;
  requiredTopupCycles: 1 | 2;
  topupCheckIntervalMs: number;
  topupWei: bigint | null;
  thresholdWei: bigint | null;
  nodeTimeoutMs: number;
  attestationPort: number;
  topupOpsPort: number;
  quoteValiditySeconds: number;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  daGasLimit: number;
  l2GasLimit: number;
  feeJuiceTopupSafetyMultiplier: bigint;
  topupConfirmTimeoutMs: number;
  topupConfirmPollInitialMs: number;
  topupConfirmPollMaxMs: number;
};

type DeploymentRuntimeResult = {
  repoRoot: string;
  runDir: string;
  operator: AztecAddress;
  user: AztecAddress;
  token: Contract;
  fpc: Contract;
  attestationConfigPath: string;
  topupConfigPath: string;
  summaryPath: string;
  topupAmountWei: bigint;
  topupThresholdWei: bigint;
};

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_QUOTE_VALIDITY_SECONDS = 3600;
const MAX_PORT = 65535;

function printHelp(): void {
  console.log(`Usage: bun run e2e:full-lifecycle [--help]

Config env vars:
- FPC_FULL_E2E_MODE=fpc
- FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS (default: 2, must be >=2)
- FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES (default: 2, allowed: 1|2)
- FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS (default: 2000)
- FPC_FULL_E2E_TOPUP_WEI (optional bigint > 0)
- FPC_FULL_E2E_THRESHOLD_WEI (optional bigint > 0)
- FPC_FULL_E2E_NODE_TIMEOUT_MS (default: 45000)
- FPC_FULL_E2E_ATTESTATION_PORT (default: 3300)
- FPC_FULL_E2E_TOPUP_OPS_PORT (default: 3401)
- FPC_FULL_E2E_DA_GAS_LIMIT (default: 1000000)
- FPC_FULL_E2E_L2_GAS_LIMIT (default: 1000000)
- FPC_FULL_E2E_TOPUP_SAFETY_MULTIPLIER (default: 5)
- FPC_FULL_E2E_QUOTE_VALIDITY_SECONDS (default: 3600, max: 3600)
- FPC_FULL_E2E_MARKET_RATE_NUM (default: 1)
- FPC_FULL_E2E_MARKET_RATE_DEN (default: 1000)
- FPC_FULL_E2E_FEE_BIPS (default: 200)
- FPC_FULL_E2E_TOPUP_CONFIRM_TIMEOUT_MS (default: 180000)
- FPC_FULL_E2E_TOPUP_CONFIRM_POLL_INITIAL_MS (default: 1000)
- FPC_FULL_E2E_TOPUP_CONFIRM_POLL_MAX_MS (default: 15000)
- FPC_FULL_E2E_NODE_HOST/FPC_FULL_E2E_NODE_PORT (default: 127.0.0.1:8080)
- FPC_FULL_E2E_L1_HOST/FPC_FULL_E2E_L1_PORT (default: 127.0.0.1:8545)
- AZTEC_NODE_URL or FPC_FULL_E2E_NODE_URL overrides node host/port
- FPC_FULL_E2E_L1_RPC_URL overrides l1 host/port
`);
}

function parseMode(value: string | undefined): FullE2EMode {
  const normalized = (value ?? "fpc").trim().toLowerCase();
  if (normalized === "fpc") {
    return "fpc";
  }
  throw new Error(
    `Invalid FPC_FULL_E2E_MODE=${value}. This runner is FPC-only and accepts: fpc`,
  );
}

function readEnvPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid integer env var ${name}: value cannot be empty`);
  }
  if (!POSITIVE_INTEGER_PATTERN.test(normalized)) {
    throw new Error(`Invalid integer env var ${name}=${value}`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid integer env var ${name}=${value} (out of safe integer range)`,
    );
  }
  return parsed;
}

function readEnvPort(name: string, fallback: number): number {
  const parsed = readEnvPositiveInteger(name, fallback);
  if (parsed > MAX_PORT) {
    throw new Error(`Invalid port env var ${name}=${parsed} (max ${MAX_PORT})`);
  }
  return parsed;
}

function readEnvString(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid env var ${name}: value cannot be empty`);
  }
  return normalized;
}

function readOptionalEnvString(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid env var ${name}: value cannot be empty`);
  }
  return normalized;
}

function readOptionalEnvUrl(name: string): string | null {
  const value = readOptionalEnvString(name);
  if (value === null) return null;
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid URL env var ${name}=${value}`);
  }
  return value;
}

function readEnvBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (value === undefined) return fallback;

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid bigint env var ${name}: value cannot be empty`);
  }
  if (!UINT_DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }

  const parsed = BigInt(normalized);
  if (parsed <= 0n) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return parsed;
}

function readOptionalEnvBigInt(name: string): bigint | null {
  const value = process.env[name];
  if (value === undefined) return null;

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid bigint env var ${name}: value cannot be empty`);
  }
  if (!UINT_DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }

  const parsed = BigInt(normalized);
  if (parsed <= 0n) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return parsed;
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw error;
  }
}

async function waitForNodeReady(
  node: ReturnType<typeof createAztecNodeClient>,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for Aztec node after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

function getConfig(): FullE2EConfig {
  const mode = parseMode(process.env.FPC_FULL_E2E_MODE);
  const relayAdvanceBlocks = readEnvPositiveInteger(
    "FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS",
    2,
  );
  const requiredTopupCyclesRaw = readEnvPositiveInteger(
    "FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES",
    2,
  );
  const quoteValiditySeconds = readEnvPositiveInteger(
    "FPC_FULL_E2E_QUOTE_VALIDITY_SECONDS",
    3600,
  );
  const nodeHost = readEnvString("FPC_FULL_E2E_NODE_HOST", "127.0.0.1");
  const nodePort = readEnvPort("FPC_FULL_E2E_NODE_PORT", 8080);
  const l1Host = readEnvString("FPC_FULL_E2E_L1_HOST", "127.0.0.1");
  const l1Port = readEnvPort("FPC_FULL_E2E_L1_PORT", 8545);
  const nodeUrlFromAztecEnv = readOptionalEnvUrl("AZTEC_NODE_URL");
  const nodeUrlFromFpcEnv = readOptionalEnvUrl("FPC_FULL_E2E_NODE_URL");
  const l1RpcUrlOverride = readOptionalEnvUrl("FPC_FULL_E2E_L1_RPC_URL");
  const topupConfirmTimeoutMs = readEnvPositiveInteger(
    "FPC_FULL_E2E_TOPUP_CONFIRM_TIMEOUT_MS",
    180_000,
  );
  const topupConfirmPollInitialMs = readEnvPositiveInteger(
    "FPC_FULL_E2E_TOPUP_CONFIRM_POLL_INITIAL_MS",
    1_000,
  );
  const topupConfirmPollMaxMs = readEnvPositiveInteger(
    "FPC_FULL_E2E_TOPUP_CONFIRM_POLL_MAX_MS",
    15_000,
  );

  const attestationPort = readEnvPort("FPC_FULL_E2E_ATTESTATION_PORT", 3300);
  const topupOpsPort = readEnvPort("FPC_FULL_E2E_TOPUP_OPS_PORT", 3401);
  const feeBips = readEnvPositiveInteger("FPC_FULL_E2E_FEE_BIPS", 200);

  if (relayAdvanceBlocks < 2) {
    throw new Error(
      `FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS must be an integer >= 2, got ${relayAdvanceBlocks}`,
    );
  }
  if (requiredTopupCyclesRaw !== 1 && requiredTopupCyclesRaw !== 2) {
    throw new Error(
      `FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES must be 1 or 2, got ${requiredTopupCyclesRaw}`,
    );
  }
  if (quoteValiditySeconds > MAX_QUOTE_VALIDITY_SECONDS) {
    throw new Error(
      `FPC_FULL_E2E_QUOTE_VALIDITY_SECONDS must be <= ${MAX_QUOTE_VALIDITY_SECONDS}, got ${quoteValiditySeconds}`,
    );
  }
  if (topupConfirmPollInitialMs > topupConfirmPollMaxMs) {
    throw new Error(
      `FPC_FULL_E2E_TOPUP_CONFIRM_POLL_INITIAL_MS must be <= FPC_FULL_E2E_TOPUP_CONFIRM_POLL_MAX_MS`,
    );
  }
  if (topupConfirmPollMaxMs > topupConfirmTimeoutMs) {
    throw new Error(
      `FPC_FULL_E2E_TOPUP_CONFIRM_POLL_MAX_MS must be <= FPC_FULL_E2E_TOPUP_CONFIRM_TIMEOUT_MS`,
    );
  }
  if (attestationPort === topupOpsPort) {
    throw new Error(
      "FPC_FULL_E2E_ATTESTATION_PORT must differ from FPC_FULL_E2E_TOPUP_OPS_PORT",
    );
  }
  if (feeBips > 10_000) {
    throw new Error(`FPC_FULL_E2E_FEE_BIPS must be <= 10000, got ${feeBips}`);
  }

  return {
    mode,
    nodeUrl:
      nodeUrlFromAztecEnv ??
      nodeUrlFromFpcEnv ??
      `http://${nodeHost}:${nodePort}`,
    l1RpcUrl: l1RpcUrlOverride ?? `http://${l1Host}:${l1Port}`,
    relayAdvanceBlocks,
    requiredTopupCycles: requiredTopupCyclesRaw,
    topupCheckIntervalMs: readEnvPositiveInteger(
      "FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS",
      2_000,
    ),
    topupWei: readOptionalEnvBigInt("FPC_FULL_E2E_TOPUP_WEI"),
    thresholdWei: readOptionalEnvBigInt("FPC_FULL_E2E_THRESHOLD_WEI"),
    nodeTimeoutMs: readEnvPositiveInteger("FPC_FULL_E2E_NODE_TIMEOUT_MS", 45_000),
    attestationPort,
    topupOpsPort,
    quoteValiditySeconds,
    marketRateNum: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvPositiveInteger("FPC_FULL_E2E_MARKET_RATE_DEN", 1000),
    feeBips,
    daGasLimit: readEnvPositiveInteger("FPC_FULL_E2E_DA_GAS_LIMIT", 1_000_000),
    l2GasLimit: readEnvPositiveInteger("FPC_FULL_E2E_L2_GAS_LIMIT", 1_000_000),
    feeJuiceTopupSafetyMultiplier: readEnvBigInt(
      "FPC_FULL_E2E_TOPUP_SAFETY_MULTIPLIER",
      5n,
    ),
    topupConfirmTimeoutMs,
    topupConfirmPollInitialMs,
    topupConfirmPollMaxMs,
  };
}

function printConfigSummary(config: FullE2EConfig): void {
  console.log(
    `[full-lifecycle-e2e] Config loaded: mode=${config.mode}, nodeUrl=${config.nodeUrl}, l1RpcUrl=${config.l1RpcUrl}, relayAdvanceBlocks=${config.relayAdvanceBlocks}, requiredTopupCycles=${config.requiredTopupCycles}`,
  );
}

async function deployContractsAndWriteRuntimeConfig(
  config: FullE2EConfig,
): Promise<DeploymentRuntimeResult> {
  const scriptDir =
    typeof __dirname === "string"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");
  const runDir = mkdtempSync(path.join(os.tmpdir(), "fpc-full-lifecycle-e2e-"));
  const tokenArtifactPath = path.join(repoRoot, "target", "token_contract-Token.json");
  const fpcArtifactPath = path.join(repoRoot, "target", "fpc-FPC.json");

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNodeReady(node, config.nodeTimeoutMs);
  const wallet = await EmbeddedWallet.create(node);

  const testAccounts = await getInitialTestAccountsData();
  const operatorData = testAccounts.at(0);
  const userData = testAccounts.at(1);
  if (!operatorData || !userData) {
    throw new Error("Expected at least 2 initial test accounts");
  }

  const [operator, user] = await Promise.all([
    wallet
      .createSchnorrAccount(
        operatorData.secret,
        operatorData.salt,
        operatorData.signingKey,
      )
      .then((account) => account.address),
    wallet
      .createSchnorrAccount(userData.secret, userData.salt, userData.signingKey)
      .then((account) => account.address),
  ]);

  const token = await Contract.deploy(
    wallet,
    tokenArtifact,
    ["SmokeToken", "SMK", 18, operator, operator],
    "constructor_with_minter",
  ).send({ from: operator });

  const schnorr = new Schnorr();
  const operatorSigningKey =
    operatorData.signingKey ?? deriveSigningKey(operatorData.secret);
  const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

  const fpc = await Contract.deploy(wallet, fpcArtifact, [
    operator,
    operatorPubKey.x,
    operatorPubKey.y,
    token.address,
  ]).send({ from: operator });

  const minFees = await node.getCurrentMinFees();
  const maxGasCostNoTeardown =
    BigInt(config.daGasLimit) * minFees.feePerDaGas +
    BigInt(config.l2GasLimit) * minFees.feePerL2Gas;
  const minimumTopupWei =
    maxGasCostNoTeardown *
      config.feeJuiceTopupSafetyMultiplier *
      BigInt(config.requiredTopupCycles) +
    1_000_000n;
  const topupAmountWei = config.topupWei ?? minimumTopupWei;
  if (topupAmountWei < minimumTopupWei) {
    throw new Error(
      `FPC_FULL_E2E_TOPUP_WEI=${topupAmountWei} is below required minimum ${minimumTopupWei}`,
    );
  }
  const topupThresholdWei = config.thresholdWei ?? topupAmountWei;
  if (topupThresholdWei <= 0n) {
    throw new Error("Top-up threshold must be greater than zero");
  }
  if (topupThresholdWei > topupAmountWei) {
    throw new Error(
      `Top-up threshold (${topupThresholdWei}) must be <= top-up amount (${topupAmountWei}) for deterministic bridge cycles`,
    );
  }

  const attestationConfigPath = path.join(runDir, "attestation.fpc.config.yaml");
  const topupConfigPath = path.join(runDir, "topup.fpc.config.yaml");
  const topupBridgeStatePath = path.join(runDir, "topup.bridge-state.json");
  const summaryPath = path.join(runDir, "run-summary.json");

  writeFileSync(
    attestationConfigPath,
    `${[
      `fpc_address: "${fpc.address.toString()}"`,
      `aztec_node_url: "${config.nodeUrl}"`,
      `quote_validity_seconds: ${config.quoteValiditySeconds}`,
      `port: ${config.attestationPort}`,
      `accepted_asset_name: "SmokeToken"`,
      `accepted_asset_address: "${token.address.toString()}"`,
      `market_rate_num: ${config.marketRateNum}`,
      `market_rate_den: ${config.marketRateDen}`,
      `fee_bips: ${config.feeBips}`,
    ].join("\n")}\n`,
    "utf8",
  );

  writeFileSync(
    topupConfigPath,
    `${[
      `fpc_address: "${fpc.address.toString()}"`,
      `aztec_node_url: "${config.nodeUrl}"`,
      `l1_rpc_url: "${config.l1RpcUrl}"`,
      `threshold: "${topupThresholdWei}"`,
      `top_up_amount: "${topupAmountWei}"`,
      `bridge_state_path: "${topupBridgeStatePath}"`,
      `ops_port: ${config.topupOpsPort}`,
      `check_interval_ms: ${config.topupCheckIntervalMs}`,
      `confirmation_timeout_ms: ${config.topupConfirmTimeoutMs}`,
      `confirmation_poll_initial_ms: ${config.topupConfirmPollInitialMs}`,
      `confirmation_poll_max_ms: ${config.topupConfirmPollMaxMs}`,
    ].join("\n")}\n`,
    "utf8",
  );

  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        repoRoot,
        runDir,
        nodeUrl: config.nodeUrl,
        l1RpcUrl: config.l1RpcUrl,
        operator: operator.toString(),
        user: user.toString(),
        tokenAddress: token.address.toString(),
        fpcAddress: fpc.address.toString(),
        attestationConfigPath,
        topupConfigPath,
        topupBridgeStatePath,
        topupThresholdWei: topupThresholdWei.toString(),
        topupAmountWei: topupAmountWei.toString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    repoRoot,
    runDir,
    operator,
    user,
    token,
    fpc,
    attestationConfigPath,
    topupConfigPath,
    summaryPath,
    topupAmountWei,
    topupThresholdWei,
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const config = getConfig();
  printConfigSummary(config);

  const result = await deployContractsAndWriteRuntimeConfig(config);
  console.log(`[full-lifecycle-e2e] operator=${result.operator.toString()}`);
  console.log(`[full-lifecycle-e2e] user=${result.user.toString()}`);
  console.log(`[full-lifecycle-e2e] token=${result.token.address.toString()}`);
  console.log(`[full-lifecycle-e2e] fpc=${result.fpc.address.toString()}`);
  console.log(`[full-lifecycle-e2e] topup_threshold_wei=${result.topupThresholdWei}`);
  console.log(`[full-lifecycle-e2e] topup_amount_wei=${result.topupAmountWei}`);
  console.log(`[full-lifecycle-e2e] attestation_config=${result.attestationConfigPath}`);
  console.log(`[full-lifecycle-e2e] topup_config=${result.topupConfigPath}`);
  console.log(`[full-lifecycle-e2e] run_summary=${result.summaryPath}`);
  console.log(
    `[full-lifecycle-e2e] Step 4 complete: deployment and runtime config wiring generated in ${result.runDir}`,
  );
  console.log("[full-lifecycle-e2e] Step 5+ service orchestration is pending.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[full-lifecycle-e2e] ERROR: ${message}`);
  process.exitCode = 1;
});
