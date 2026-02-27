import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract, ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

type FullE2EMode = "fpc";

type FullE2EConfig = {
  mode: FullE2EMode;
  nodeUrl: string;
  l1RpcUrl: string;
  l1PrivateKey: string;
  relayAdvanceBlocks: number;
  requiredTopupCycles: 1 | 2;
  topupCheckIntervalMs: number;
  topupWei: bigint | null;
  thresholdWei: bigint | null;
  nodeTimeoutMs: number;
  httpTimeoutMs: number;
  topupWaitTimeoutMs: number;
  topupPollMs: number;
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
  operatorSecretHex: string;
  user: AztecAddress;
  wallet: EmbeddedWallet;
  token: Contract;
  fpc: Contract;
  attestationConfigPath: string;
  topupConfigPath: string;
  summaryPath: string;
  topupAmountWei: bigint;
  topupThresholdWei: bigint;
  feePerDaGas: bigint;
  feePerL2Gas: bigint;
  maxGasCostNoTeardown: bigint;
};

type ManagedProcess = {
  name: string;
  process: ChildProcessWithoutNullStreams;
  getLogs: () => string;
};

type TopupBridgeSubmission = {
  messageHash: string;
  leafIndex: bigint;
  claimSecretHash: string;
  claimSecret?: string;
};

type TopupLogCounters = {
  submissionCount: number;
  confirmedCount: number;
  timeoutCount: number;
  failedCount: number;
};

type QuoteResponse = {
  accepted_asset: string;
  rate_num: string;
  rate_den: string;
  valid_until: string;
  signature: string;
};

type OrchestrationResult = {
  attestationBaseUrl: string;
  topupOpsBaseUrl: string;
  observedBridgeSubmissions: number;
  observedBridgeConfirmed: number;
  feeJuiceAfterCycle1: bigint;
  feeJuiceAfterTx1: bigint;
  feeJuiceAfterCycle2: bigint | null;
};

const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
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
- FPC_FULL_E2E_HTTP_TIMEOUT_MS (default: 30000)
- FPC_FULL_E2E_TOPUP_WAIT_TIMEOUT_MS (default: 240000)
- FPC_FULL_E2E_TOPUP_POLL_MS (default: 2000)
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
- FPC_FULL_E2E_L1_PRIVATE_KEY (default: local anvil key)
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

function assertPrivateKeyHex(value: string, fieldName: string): void {
  if (!HEX_32_BYTE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a 32-byte 0x-prefixed private key`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
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
        () =>
          reject(new Error(`Timed out waiting for Aztec node after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

function startManagedProcess(
  name: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): ManagedProcess {
  let logs = "";
  const processHandle = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  processHandle.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    process.stdout.write(`[${name}] ${text}`);
  });
  processHandle.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    process.stderr.write(`[${name}] ${text}`);
  });

  return {
    name,
    process: processHandle,
    getLogs: () => logs,
  };
}

async function stopManagedProcess(proc: ManagedProcess): Promise<void> {
  if (proc.process.exitCode !== null) {
    return;
  }

  proc.process.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) {
      return;
    }
    await sleep(100);
  }
  proc.process.kill("SIGKILL");
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep retrying while the service boots.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health endpoint: ${url}`);
}

async function waitForLog(
  proc: ManagedProcess,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (proc.getLogs().includes(expected)) {
      return;
    }
    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before logging "${expected}" (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${proc.name} log "${expected}". Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}

function parseTopupBridgeSubmissions(logs: string): TopupBridgeSubmission[] {
  const submissions: TopupBridgeSubmission[] = [];
  const pattern =
    /Bridge submitted\. l1_to_l2_message_hash=(0x[0-9a-fA-F]+) leaf_index=(\d+) claim_secret_hash=(0x[0-9a-fA-F]+)(?: claim_secret=([^\s]+))?/g;
  let match: RegExpExecArray | null = pattern.exec(logs);
  while (match) {
    submissions.push({
      messageHash: match[1],
      leafIndex: BigInt(match[2]),
      claimSecretHash: match[3],
      claimSecret: match[4],
    });
    match = pattern.exec(logs);
  }
  return submissions;
}

function countTopupOutcome(logs: string, outcome: "confirmed" | "timeout" | "failed"): number {
  const pattern = new RegExp(`Bridge confirmation outcome=${outcome}\\b`, "g");
  let count = 0;
  let match: RegExpExecArray | null = pattern.exec(logs);
  while (match) {
    count += 1;
    match = pattern.exec(logs);
  }
  return count;
}

function getTopupLogCounters(logs: string): TopupLogCounters {
  return {
    submissionCount: parseTopupBridgeSubmissions(logs).length,
    confirmedCount: countTopupOutcome(logs, "confirmed"),
    timeoutCount: countTopupOutcome(logs, "timeout"),
    failedCount: countTopupOutcome(logs, "failed"),
  };
}

function getTopupLogCountersFromProcess(proc: ManagedProcess): TopupLogCounters {
  return getTopupLogCounters(proc.getLogs());
}

async function waitForNextBridgeSubmission(
  proc: ManagedProcess,
  timeoutMs: number,
  previousSubmissionCount: number,
): Promise<{ submission: TopupBridgeSubmission; submissionCount: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const logs = proc.getLogs();
    const submissions = parseTopupBridgeSubmissions(logs);
    if (submissions.length > previousSubmissionCount) {
      const submission =
        submissions[previousSubmissionCount] ??
        submissions[submissions.length - 1];
      return {
        submission,
        submissionCount: submissions.length,
      };
    }

    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before next bridge submission (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for next bridge submission from ${proc.name}. Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}

async function waitForNextBridgeConfirmedOutcome(
  proc: ManagedProcess,
  timeoutMs: number,
  previousConfirmedCount: number,
  previousTimeoutCount: number,
  previousFailedCount: number,
): Promise<{ confirmedCount: number; timeoutCount: number; failedCount: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const logs = proc.getLogs();
    const confirmedCount = countTopupOutcome(logs, "confirmed");
    const timeoutCount = countTopupOutcome(logs, "timeout");
    const failedCount = countTopupOutcome(logs, "failed");

    if (timeoutCount > previousTimeoutCount) {
      throw new Error(
        `Top-up service reported timeout bridge outcome while waiting for confirmed cycle. Recent logs:\n${logs.slice(-4000)}`,
      );
    }
    if (failedCount > previousFailedCount) {
      throw new Error(
        `Top-up service reported failed bridge outcome while waiting for confirmed cycle. Recent logs:\n${logs.slice(-4000)}`,
      );
    }
    if (confirmedCount > previousConfirmedCount) {
      return { confirmedCount, timeoutCount, failedCount };
    }

    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before confirmed bridge outcome (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for confirmed bridge outcome from ${proc.name}. Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}

async function advanceL2Blocks(
  token: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  blocks: number,
): Promise<void> {
  for (let i = 0; i < blocks; i += 1) {
    await token.methods.mint_to_private(user, 1n).send({
      from: operator,
      wait: { timeout: 180 },
    });
    console.log(`[full-lifecycle-e2e] relay_block_advanced=${i + 1}/${blocks}`);
  }
}

async function waitForPositiveFeeJuiceBalance(
  node: ReturnType<typeof createAztecNodeClient>,
  feePayerAddress: AztecAddress,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const balance = await getFeeJuiceBalance(feePayerAddress, node);
    if (balance > 0n) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for positive Fee Juice balance on ${feePayerAddress.toString()}`,
  );
}

async function waitForFeeJuiceBalanceAboveBaseline(
  node: ReturnType<typeof createAztecNodeClient>,
  feePayerAddress: AztecAddress,
  baseline: bigint,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const balance = await getFeeJuiceBalance(feePayerAddress, node);
    if (balance > baseline) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for Fee Juice balance above baseline=${baseline} on ${feePayerAddress.toString()}`,
  );
}

async function claimTopupBridgeSubmission(
  node: ReturnType<typeof createAztecNodeClient>,
  result: DeploymentRuntimeResult,
  submission: TopupBridgeSubmission,
  relayAdvanceBlocks: number,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  if (!submission.claimSecret) {
    throw new Error(
      `Cannot claim bridge submission ${submission.messageHash}: claim_secret is missing from topup logs`,
    );
  }

  // Force block production to make L1->L2 messages claimable deterministically on local devnet.
  await advanceL2Blocks(
    result.token,
    result.operator,
    result.user,
    relayAdvanceBlocks,
  );

  await waitForL1ToL2MessageReady(node, Fr.fromHexString(submission.messageHash), {
    timeoutSeconds: Math.max(1, Math.floor(timeoutMs / 1000)),
    forPublicConsumption: false,
  });

  const feeJuice = FeeJuiceContract.at(result.wallet);
  await feeJuice.methods
    .claim(
      result.fpc.address,
      result.topupAmountWei,
      Fr.fromString(submission.claimSecret),
      new Fr(submission.leafIndex),
    )
    .send({ from: result.operator });

  return waitForPositiveFeeJuiceBalance(
    node,
    result.fpc.address,
    timeoutMs,
    pollMs,
  );
}

async function fetchQuote(
  quoteUrl: string,
  timeoutMs: number,
): Promise<QuoteResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(quoteUrl);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        const parsed = JSON.parse(bodyText) as QuoteResponse;
        if (
          typeof parsed.accepted_asset === "string" &&
          typeof parsed.rate_num === "string" &&
          typeof parsed.rate_den === "string" &&
          typeof parsed.valid_until === "string" &&
          typeof parsed.signature === "string"
        ) {
          return parsed;
        }
        lastError = `Invalid quote payload: ${bodyText}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(500);
  }

  throw new Error(`Timed out requesting quote. Last error: ${lastError}`);
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
  if (feeBips > 10_000) {
    throw new Error(`FPC_FULL_E2E_FEE_BIPS must be <= 10000, got ${feeBips}`);
  }

  const l1PrivateKey =
    process.env.FPC_FULL_E2E_L1_PRIVATE_KEY ?? DEFAULT_LOCAL_L1_PRIVATE_KEY;
  assertPrivateKeyHex(l1PrivateKey, "FPC_FULL_E2E_L1_PRIVATE_KEY");

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

  return {
    mode,
    nodeUrl:
      nodeUrlFromAztecEnv ??
      nodeUrlFromFpcEnv ??
      `http://${nodeHost}:${nodePort}`,
    l1RpcUrl: l1RpcUrlOverride ?? `http://${l1Host}:${l1Port}`,
    l1PrivateKey,
    relayAdvanceBlocks,
    requiredTopupCycles: requiredTopupCyclesRaw,
    topupCheckIntervalMs: readEnvPositiveInteger(
      "FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS",
      2_000,
    ),
    topupWei: readOptionalEnvBigInt("FPC_FULL_E2E_TOPUP_WEI"),
    thresholdWei: readOptionalEnvBigInt("FPC_FULL_E2E_THRESHOLD_WEI"),
    nodeTimeoutMs: readEnvPositiveInteger("FPC_FULL_E2E_NODE_TIMEOUT_MS", 45_000),
    httpTimeoutMs: readEnvPositiveInteger("FPC_FULL_E2E_HTTP_TIMEOUT_MS", 30_000),
    topupWaitTimeoutMs: readEnvPositiveInteger(
      "FPC_FULL_E2E_TOPUP_WAIT_TIMEOUT_MS",
      240_000,
    ),
    topupPollMs: readEnvPositiveInteger("FPC_FULL_E2E_TOPUP_POLL_MS", 2_000),
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

  const operatorSecretHex = operatorData.secret.toString();
  assertPrivateKeyHex(operatorSecretHex, "operator secret");

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
  const feePerDaGas = minFees.feePerDaGas;
  const feePerL2Gas = minFees.feePerL2Gas;
  const maxGasCostNoTeardown =
    BigInt(config.daGasLimit) * feePerDaGas +
    BigInt(config.l2GasLimit) * feePerL2Gas;

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
    operatorSecretHex,
    user,
    wallet,
    token,
    fpc,
    attestationConfigPath,
    topupConfigPath,
    summaryPath,
    topupAmountWei,
    topupThresholdWei,
    feePerDaGas,
    feePerL2Gas,
    maxGasCostNoTeardown,
  };
}

async function runTx1ToCreatePostFeeSpendBoundary(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  attestationBaseUrl: string,
): Promise<void> {
  const quote = await fetchQuote(
    `${attestationBaseUrl}/quote?user=${result.user.toString()}`,
    config.httpTimeoutMs,
  );
  const quoteSigBytes = Array.from(
    Buffer.from(quote.signature.replace(/^0x/, ""), "hex"),
  );
  const rateNum = BigInt(quote.rate_num);
  const rateDen = BigInt(quote.rate_den);
  const validUntil = BigInt(quote.valid_until);

  if (quoteSigBytes.length !== 64) {
    throw new Error(
      `Quote signature length must be 64 bytes, got ${quoteSigBytes.length}`,
    );
  }
  if (rateDen === 0n) {
    throw new Error("Attestation quote returned zero denominator");
  }
  if (
    quote.accepted_asset.toLowerCase() !==
    result.token.address.toString().toLowerCase()
  ) {
    throw new Error(
      `Quote accepted_asset mismatch. expected=${result.token.address.toString()} got=${quote.accepted_asset}`,
    );
  }

  const expectedCharge = ceilDiv(result.maxGasCostNoTeardown * rateNum, rateDen);
  const mintAmount = expectedCharge + 1_000_000n;
  await result.token.methods
    .mint_to_private(result.user, mintAmount)
    .send({ from: result.operator });
  await result.token.methods
    .mint_to_public(result.user, 2n)
    .send({ from: result.operator });

  const transferAuthwitNonce = Fr.random();
  const transferCall = result.token.methods.transfer_private_to_private(
    result.user,
    result.operator,
    expectedCharge,
    transferAuthwitNonce,
  );
  const transferAuthwit = await result.wallet.createAuthWit(result.user, {
    caller: result.fpc.address,
    action: transferCall,
  });

  const feeEntrypointCall = await result.fpc.methods
    .fee_entrypoint(
      transferAuthwitNonce,
      rateNum,
      rateDen,
      validUntil,
      quoteSigBytes,
    )
    .getFunctionCall();

  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload(
        [feeEntrypointCall],
        [transferAuthwit],
        [],
        [],
        result.fpc.address,
      ),
    getFeePayer: async () => result.fpc.address,
    getGasSettings: () => undefined,
  };

  await result.token.methods.transfer_public_to_public(
    result.user,
    result.user,
    1n,
    Fr.random(),
  ).send({
    from: result.user,
    fee: {
      paymentMethod,
      gasSettings: {
        gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
        maxFeesPerGas: {
          feePerDaGas: result.feePerDaGas,
          feePerL2Gas: result.feePerL2Gas,
        },
      },
    },
    wait: { timeout: 180 },
  });

  console.log(
    `[full-lifecycle-e2e] tx1 boundary transaction accepted (expected_charge=${expectedCharge})`,
  );
}

async function orchestrateServicesAndAssertBridgeCycles(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
): Promise<OrchestrationResult> {
  const managed: ManagedProcess[] = [];
  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNodeReady(node, config.nodeTimeoutMs);

  const attestationBaseUrl = `http://127.0.0.1:${config.attestationPort}`;
  const topupOpsBaseUrl = `http://127.0.0.1:${config.topupOpsPort}`;

  try {
    const attestation = startManagedProcess(
      "full-e2e-attestation",
      "bun",
      [
        "run",
        path.join(result.repoRoot, "services", "attestation", "dist", "index.js"),
        "--config",
        result.attestationConfigPath,
      ],
      {
        cwd: result.repoRoot,
        env: {
          ...process.env,
          OPERATOR_SECRET_KEY: result.operatorSecretHex,
        },
      },
    );
    managed.push(attestation);

    await waitForHealth(`${attestationBaseUrl}/health`, config.httpTimeoutMs);
    console.log("[full-lifecycle-e2e] PASS: attestation /health");

    const topup = startManagedProcess(
      "full-e2e-topup",
      "bun",
      [
        "run",
        path.join(result.repoRoot, "services", "topup", "dist", "index.js"),
        "--config",
        result.topupConfigPath,
      ],
      {
        cwd: result.repoRoot,
        env: {
          ...process.env,
          L1_OPERATOR_PRIVATE_KEY: config.l1PrivateKey,
          TOPUP_LOG_CLAIM_SECRET: "1",
        },
      },
    );
    managed.push(topup);

    await waitForHealth(`${topupOpsBaseUrl}/health`, config.httpTimeoutMs);
    await waitForLog(topup, "Top-up service started", config.httpTimeoutMs);
    await waitForHealth(`${topupOpsBaseUrl}/ready`, config.topupWaitTimeoutMs);
    console.log("[full-lifecycle-e2e] PASS: topup /health and /ready");

    let topupCounters = getTopupLogCountersFromProcess(topup);
    let cycle1Submission: { submission: TopupBridgeSubmission; submissionCount: number };
    if (topupCounters.submissionCount > 0) {
      const existingSubmissions = parseTopupBridgeSubmissions(topup.getLogs());
      const latestSubmission = existingSubmissions[existingSubmissions.length - 1];
      if (!latestSubmission) {
        throw new Error("Top-up submission counter was non-zero but no submission could be parsed");
      }
      cycle1Submission = {
        submission: latestSubmission,
        submissionCount: existingSubmissions.length,
      };
      console.log(
        `[full-lifecycle-e2e] using existing bridge submission for cycle #1 (message_hash=${latestSubmission.messageHash})`,
      );
    } else {
      cycle1Submission = await waitForNextBridgeSubmission(
        topup,
        config.topupWaitTimeoutMs,
        0,
      );
    }
    topupCounters.submissionCount = cycle1Submission.submissionCount;
    await advanceL2Blocks(
      result.token,
      result.operator,
      result.user,
      config.relayAdvanceBlocks,
    );
    const cycle1Outcome = await waitForNextBridgeConfirmedOutcome(
      topup,
      config.topupWaitTimeoutMs,
      topupCounters.confirmedCount,
      topupCounters.timeoutCount,
      topupCounters.failedCount,
    );
    topupCounters.confirmedCount = cycle1Outcome.confirmedCount;
    topupCounters.timeoutCount = cycle1Outcome.timeoutCount;
    topupCounters.failedCount = cycle1Outcome.failedCount;

    let feeJuiceAfterCycle1 = await getFeeJuiceBalance(result.fpc.address, node);
    if (feeJuiceAfterCycle1 === 0n) {
      console.log(
        `[full-lifecycle-e2e] bridge cycle #1 confirmed but Fee Juice is still zero; claiming bridge message ${cycle1Submission.submission.messageHash}`,
      );
      feeJuiceAfterCycle1 = await claimTopupBridgeSubmission(
        node,
        result,
        cycle1Submission.submission,
        config.relayAdvanceBlocks,
        config.topupWaitTimeoutMs,
        config.topupPollMs,
      );
    }
    topupCounters = getTopupLogCountersFromProcess(topup);
    console.log(
      `[full-lifecycle-e2e] PASS: bridge cycle #1 confirmed before tx1 (message_hash=${cycle1Submission.submission.messageHash}, leaf_index=${cycle1Submission.submission.leafIndex}, fee_juice=${feeJuiceAfterCycle1})`,
    );

    const cycle2Baseline: TopupLogCounters = { ...topupCounters };
    await runTx1ToCreatePostFeeSpendBoundary(config, result, attestationBaseUrl);
    const feeJuiceAfterTx1 = await getFeeJuiceBalance(result.fpc.address, node);
    console.log(`[full-lifecycle-e2e] fee_juice_after_tx1=${feeJuiceAfterTx1}`);

    let feeJuiceAfterCycle2: bigint | null = null;
    if (config.requiredTopupCycles === 2) {
      const cycle2Submission = await waitForNextBridgeSubmission(
        topup,
        config.topupWaitTimeoutMs,
        cycle2Baseline.submissionCount,
      );
      topupCounters.submissionCount = cycle2Submission.submissionCount;
      await advanceL2Blocks(
        result.token,
        result.operator,
        result.user,
        config.relayAdvanceBlocks,
      );
      const cycle2Outcome = await waitForNextBridgeConfirmedOutcome(
        topup,
        config.topupWaitTimeoutMs,
        cycle2Baseline.confirmedCount,
        cycle2Baseline.timeoutCount,
        cycle2Baseline.failedCount,
      );
      topupCounters.confirmedCount = cycle2Outcome.confirmedCount;
      topupCounters.timeoutCount = cycle2Outcome.timeoutCount;
      topupCounters.failedCount = cycle2Outcome.failedCount;

      feeJuiceAfterCycle2 = await getFeeJuiceBalance(result.fpc.address, node);
      if (feeJuiceAfterCycle2 <= feeJuiceAfterTx1) {
        console.log(
          `[full-lifecycle-e2e] bridge cycle #2 confirmed but Fee Juice did not increase; claiming bridge message ${cycle2Submission.submission.messageHash}`,
        );
        await claimTopupBridgeSubmission(
          node,
          result,
          cycle2Submission.submission,
          config.relayAdvanceBlocks,
          config.topupWaitTimeoutMs,
          config.topupPollMs,
        );
        feeJuiceAfterCycle2 = await waitForFeeJuiceBalanceAboveBaseline(
          node,
          result.fpc.address,
          feeJuiceAfterTx1,
          config.topupWaitTimeoutMs,
          config.topupPollMs,
        );
      }
      topupCounters = getTopupLogCountersFromProcess(topup);
      console.log(
        `[full-lifecycle-e2e] PASS: bridge cycle #2 confirmed after tx1 and before tx2 (message_hash=${cycle2Submission.submission.messageHash}, leaf_index=${cycle2Submission.submission.leafIndex}, fee_juice=${feeJuiceAfterCycle2})`,
      );
    } else {
      console.log(
        "[full-lifecycle-e2e] PASS: second bridge cycle requirement skipped (FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES=1)",
      );
    }

    const finalTopupCounters = getTopupLogCountersFromProcess(topup);
    return {
      attestationBaseUrl,
      topupOpsBaseUrl,
      observedBridgeSubmissions: finalTopupCounters.submissionCount,
      observedBridgeConfirmed: finalTopupCounters.confirmedCount,
      feeJuiceAfterCycle1,
      feeJuiceAfterTx1,
      feeJuiceAfterCycle2,
    };
  } finally {
    for (const proc of managed.reverse()) {
      await stopManagedProcess(proc);
    }
  }
}

function writeStep5Summary(
  summaryPath: string,
  orchestration: OrchestrationResult,
): void {
  let summary: Record<string, unknown> = {};
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    summary = {};
  }

  summary.step5 = {
    completedAt: new Date().toISOString(),
    attestationBaseUrl: orchestration.attestationBaseUrl,
    topupOpsBaseUrl: orchestration.topupOpsBaseUrl,
    observedBridgeSubmissions: orchestration.observedBridgeSubmissions,
    observedBridgeConfirmed: orchestration.observedBridgeConfirmed,
    feeJuiceAfterCycle1: orchestration.feeJuiceAfterCycle1.toString(),
    feeJuiceAfterTx1: orchestration.feeJuiceAfterTx1.toString(),
    feeJuiceAfterCycle2:
      orchestration.feeJuiceAfterCycle2 === null
        ? null
        : orchestration.feeJuiceAfterCycle2.toString(),
  };

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
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

  const orchestration = await orchestrateServicesAndAssertBridgeCycles(
    config,
    result,
  );
  writeStep5Summary(result.summaryPath, orchestration);

  console.log(
    `[full-lifecycle-e2e] Step 5 complete: service orchestration and bridge-cycle assertions passed (confirmed_cycles=${orchestration.observedBridgeConfirmed})`,
  );
  console.log("[full-lifecycle-e2e] Step 6+ tx invariant assertions are pending.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[full-lifecycle-e2e] ERROR: ${message}`);
  process.exitCode = 1;
});
