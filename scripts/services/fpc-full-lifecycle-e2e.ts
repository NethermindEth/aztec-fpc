import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  FeeJuiceContract,
  ProtocolContractAddress,
} from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/stdlib/abi";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
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
  otherUser: AztecAddress;
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
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

type QuoteInput = {
  fjAmount: bigint;
  aaPaymentAmount: bigint;
  validUntil: bigint;
  quoteSigBytes: number[];
};

type NegativeScenarioResult = {
  quoteReplayRejected: boolean;
  expiredQuoteRejected: boolean;
  overlongTtlRejected: boolean;
  senderBindingRejected: boolean;
  insufficientFeeJuiceRejected: boolean;
  insufficientFeeJuiceBudgetWei: bigint;
};

type OrchestrationResult = {
  attestationBaseUrl: string;
  topupOpsBaseUrl: string;
  observedBridgeSubmissions: number;
  observedBridgeConfirmed: number;
  feeJuiceAfterCycle1: bigint;
  feeJuiceAfterTx1: bigint;
  feeJuiceAfterCycle2: bigint | null;
  feeJuiceAfterTx2: bigint;
  tx1ExpectedCharge: bigint;
  tx2ExpectedCharge: bigint;
  step7: NegativeScenarioResult;
};

type PersistedDiagnostics = {
  diagnosticsPath: string;
  logTailPaths: Record<string, string>;
};

const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_QUOTE_VALIDITY_SECONDS = 3600;
const MAX_PORT = 65535;
const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
const DIAGNOSTIC_TAIL_LINES = 200;
const managedProcessRegistry = new Set<ManagedProcess>();
let shutdownInProgress = false;

function printHelp(): void {
  console.log(`Usage: bun run e2e:full-lifecycle:fpc:local [--help]

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
- FPC_FULL_E2E_TOPUP_SAFETY_MULTIPLIER (default: 2)
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
- FPC_FULL_E2E_ARTIFACTS_DIR (default: <repo>/tmp)
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
      error.message.includes(
        "Contract's public bytecode has not been transpiled",
      )
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
          reject(
            new Error(`Timed out waiting for Aztec node after ${timeoutMs}ms`),
          ),
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
    detached: true,
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

  const managed: ManagedProcess = {
    name,
    process: processHandle,
    getLogs: () => logs,
  };
  managedProcessRegistry.add(managed);
  processHandle.on("exit", () => {
    managedProcessRegistry.delete(managed);
  });
  return managed;
}

async function stopManagedProcess(proc: ManagedProcess): Promise<void> {
  if (proc.process.exitCode !== null) {
    managedProcessRegistry.delete(proc);
    return;
  }

  const pid = proc.process.pid;
  let signaled = false;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
      signaled = true;
    } catch {
      signaled = false;
    }
  }
  if (!signaled) {
    try {
      proc.process.kill("SIGTERM");
    } catch {
      managedProcessRegistry.delete(proc);
      return;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) {
      managedProcessRegistry.delete(proc);
      return;
    }
    await sleep(100);
  }
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      managedProcessRegistry.delete(proc);
      return;
    } catch {
      // Fallback to direct child kill if process groups are unavailable.
    }
  }
  try {
    proc.process.kill("SIGKILL");
  } catch {
    // Process may have already exited between checks.
  }
  managedProcessRegistry.delete(proc);
}

async function stopAllManagedProcesses(): Promise<void> {
  for (const proc of Array.from(managedProcessRegistry).reverse()) {
    await stopManagedProcess(proc);
  }
}

function installManagedProcessSignalHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    void (async () => {
      console.error(
        `[full-lifecycle-e2e] Received ${signal}; stopping managed processes...`,
      );
      await stopAllManagedProcesses();
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
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

function countTopupOutcome(
  logs: string,
  outcome: "confirmed" | "timeout" | "failed",
): number {
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

function getTopupLogCountersFromProcess(
  proc: ManagedProcess,
): TopupLogCounters {
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
): Promise<{
  confirmedCount: number;
  timeoutCount: number;
  failedCount: number;
}> {
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

async function claimBridgeSubmissionForTarget(
  node: ReturnType<typeof createAztecNodeClient>,
  params: {
    token: Contract;
    operator: AztecAddress;
    user: AztecAddress;
    wallet: EmbeddedWallet;
    feePayerAddress: AztecAddress;
    topupAmountWei: bigint;
  },
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
    params.token,
    params.operator,
    params.user,
    relayAdvanceBlocks,
  );

  await waitForL1ToL2MessageReady(
    node,
    Fr.fromHexString(submission.messageHash),
    {
      timeoutSeconds: Math.max(1, Math.floor(timeoutMs / 1000)),
      forPublicConsumption: false,
    },
  );

  const feeJuice = FeeJuiceContract.at(params.wallet);
  await feeJuice.methods
    .claim(
      params.feePayerAddress,
      params.topupAmountWei,
      Fr.fromString(submission.claimSecret),
      new Fr(submission.leafIndex),
    )
    .send({ from: params.operator });

  return waitForPositiveFeeJuiceBalance(
    node,
    params.feePayerAddress,
    timeoutMs,
    pollMs,
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
  return claimBridgeSubmissionForTarget(
    node,
    {
      token: result.token,
      operator: result.operator,
      user: result.user,
      wallet: result.wallet,
      feePayerAddress: result.fpc.address,
      topupAmountWei: result.topupAmountWei,
    },
    submission,
    relayAdvanceBlocks,
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
          typeof parsed.fj_amount === "string" &&
          typeof parsed.aa_payment_amount === "string" &&
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

function getFinalRate(config: FullE2EConfig): {
  rateNum: bigint;
  rateDen: bigint;
} {
  return {
    rateNum: BigInt(config.marketRateNum) * BigInt(10_000 + config.feeBips),
    rateDen: BigInt(config.marketRateDen) * 10_000n,
  };
}

function computeAaPaymentFromFj(
  config: FullE2EConfig,
  fjAmount: bigint,
): bigint {
  const { rateNum, rateDen } = getFinalRate(config);
  return ceilDiv(fjAmount * rateNum, rateDen);
}

function parseQuoteResponse(
  quote: QuoteResponse,
  expectedAsset: AztecAddress,
): QuoteInput {
  const quoteSigBytes = Array.from(
    Buffer.from(quote.signature.replace(/^0x/, ""), "hex"),
  );
  const parsed: QuoteInput = {
    fjAmount: BigInt(quote.fj_amount),
    aaPaymentAmount: BigInt(quote.aa_payment_amount),
    validUntil: BigInt(quote.valid_until),
    quoteSigBytes,
  };

  if (parsed.quoteSigBytes.length !== 64) {
    throw new Error(
      `Quote signature length must be 64 bytes, got ${parsed.quoteSigBytes.length}`,
    );
  }
  if (parsed.fjAmount <= 0n) {
    throw new Error("Attestation quote returned non-positive fj_amount");
  }
  if (parsed.aaPaymentAmount <= 0n) {
    throw new Error(
      "Attestation quote returned non-positive aa_payment_amount",
    );
  }
  if (
    quote.accepted_asset.toLowerCase() !==
    expectedAsset.toString().toLowerCase()
  ) {
    throw new Error(
      `Quote accepted_asset mismatch. expected=${expectedAsset.toString()} got=${quote.accepted_asset}`,
    );
  }
  return parsed;
}

async function getLatestL2Timestamp(
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<bigint> {
  const latest = await node.getBlock("latest");
  if (!latest) {
    throw new Error("Could not read latest L2 block");
  }
  return latest.timestamp;
}

async function signQuoteForUser(
  result: DeploymentRuntimeResult,
  fpcAddress: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  userAddress: AztecAddress,
): Promise<QuoteInput> {
  const secret = Fr.fromHexString(result.operatorSecretHex);
  const signingKey = deriveSigningKey(secret);
  const schnorr = new Schnorr();
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpcAddress.toField(),
    acceptedAsset.toField(),
    new Fr(fjAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    userAddress.toField(),
  ]);
  const signature = await schnorr.constructSignature(
    quoteHash.toBuffer(),
    signingKey,
  );
  return {
    fjAmount,
    aaPaymentAmount,
    validUntil,
    quoteSigBytes: Array.from(signature.toBuffer()),
  };
}

type FeePaidTxParams = {
  token: Contract;
  fpc: Contract;
  payer: AztecAddress;
  recipient: AztecAddress;
  transferAmount: bigint;
  quote: QuoteInput;
};

async function executeFeePaidTx(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  params: FeePaidTxParams,
): Promise<{ expectedCharge: bigint; receipt: { transactionFee: unknown } }> {
  if (params.quote.fjAmount <= 0n) {
    throw new Error("fj_amount must be positive");
  }
  if (params.quote.aaPaymentAmount <= 0n) {
    throw new Error("aa_payment_amount must be positive");
  }
  if (params.quote.quoteSigBytes.length !== 64) {
    throw new Error(
      `Quote signature length must be 64 bytes, got ${params.quote.quoteSigBytes.length}`,
    );
  }

  if (params.quote.fjAmount !== result.maxGasCostNoTeardown) {
    throw new Error(
      `quoted fj_amount mismatch. expected=${result.maxGasCostNoTeardown} got=${params.quote.fjAmount}`,
    );
  }
  const expectedCharge = params.quote.aaPaymentAmount;
  const mintAmount = expectedCharge + 1_000_000n;

  await params.token.methods
    .mint_to_private(params.payer, mintAmount)
    .send({ from: result.operator });
  await params.token.methods
    .mint_to_public(params.payer, params.transferAmount)
    .send({ from: result.operator });

  const transferAuthwitNonce = Fr.random();
  const transferCall = params.token.methods.transfer_private_to_private(
    params.payer,
    result.operator,
    params.quote.aaPaymentAmount,
    transferAuthwitNonce,
  );
  const transferAuthwit = await result.wallet.createAuthWit(params.payer, {
    caller: params.fpc.address,
    action: transferCall,
  });

  const feeEntrypointCall = await params.fpc.methods
    .fee_entrypoint(
      transferAuthwitNonce,
      params.quote.fjAmount,
      params.quote.aaPaymentAmount,
      params.quote.validUntil,
      params.quote.quoteSigBytes,
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
        params.fpc.address,
      ),
    getFeePayer: async () => params.fpc.address,
    getGasSettings: () => undefined,
  };

  const receipt = await params.token.methods
    .transfer_public_to_public(
      params.payer,
      params.recipient,
      params.transferAmount,
      Fr.random(),
    )
    .send({
      from: params.payer,
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

  return { expectedCharge, receipt };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function readSummary(summaryPath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(summaryPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function writeSummary(
  summaryPath: string,
  summary: Record<string, unknown>,
): void {
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
}

function updateSummary(
  summaryPath: string,
  updater: (summary: Record<string, unknown>) => void,
): void {
  const summary = readSummary(summaryPath);
  updater(summary);
  writeSummary(summaryPath, summary);
}

function recordPhaseResult(
  summaryPath: string,
  phase: string,
  status: "PASS" | "FAIL",
  details: Record<string, unknown> = {},
): void {
  updateSummary(summaryPath, (summary) => {
    const phaseResultsRaw = summary.phaseResults;
    const phaseResults =
      typeof phaseResultsRaw === "object" && phaseResultsRaw !== null
        ? (phaseResultsRaw as Record<string, unknown>)
        : {};
    phaseResults[phase] = {
      status,
      completedAt: new Date().toISOString(),
      ...details,
    };
    summary.phaseResults = phaseResults;
  });
}

function getLogTail(logs: string, maxLines: number): string {
  const lines = logs.split(/\r?\n/);
  const trimmed = lines.filter((line, index) => {
    if (index < lines.length - 1) return true;
    return line.length > 0;
  });
  const tail = trimmed.slice(Math.max(0, trimmed.length - maxLines));
  return tail.join("\n");
}

function sanitizeLogName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function getArtifactsRootDir(repoRoot: string): string {
  const configured = readOptionalEnvString("FPC_FULL_E2E_ARTIFACTS_DIR");
  const resolved =
    configured === null ? path.join(repoRoot, "tmp") : path.resolve(configured);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function persistFailureDiagnostics(
  runDir: string,
  summaryPath: string,
  phase: string,
  error: unknown,
  processes: ManagedProcess[],
): PersistedDiagnostics {
  const diagnosticsDir = path.join(runDir, "diagnostics");
  mkdirSync(diagnosticsDir, { recursive: true });

  const logTailPaths: Record<string, string> = {};
  for (const proc of processes) {
    const safeName = sanitizeLogName(proc.name);
    const tailPath = path.join(diagnosticsDir, `${safeName}.tail.log`);
    writeFileSync(
      tailPath,
      `${getLogTail(proc.getLogs(), DIAGNOSTIC_TAIL_LINES)}\n`,
      "utf8",
    );
    logTailPaths[proc.name] = tailPath;
  }

  const diagnosticsPath = path.join(
    diagnosticsDir,
    `failure-${Date.now()}.json`,
  );
  const details = {
    generatedAt: new Date().toISOString(),
    phase,
    error: errorMessage(error),
    tailLines: DIAGNOSTIC_TAIL_LINES,
    logTailPaths,
  };
  writeFileSync(diagnosticsPath, JSON.stringify(details, null, 2), "utf8");

  recordPhaseResult(summaryPath, phase, "FAIL", {
    diagnosticsPath,
    tailLines: DIAGNOSTIC_TAIL_LINES,
  });
  updateSummary(summaryPath, (summary) => {
    summary.failure = details;
  });

  return { diagnosticsPath, logTailPaths };
}

async function expectFailure(
  scenario: string,
  expectedSubstrings: string[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    if (
      expectedSubstrings.some((fragment) =>
        message.includes(fragment.toLowerCase()),
      )
    ) {
      console.log(`[full-lifecycle-e2e] PASS: ${scenario}`);
      return;
    }
    throw new Error(
      `[full-lifecycle-e2e] ${scenario} failed with unexpected error: ${errorMessage(
        error,
      )}`,
    );
  }
  throw new Error(`[full-lifecycle-e2e] ${scenario} unexpectedly succeeded`);
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
    nodeTimeoutMs: readEnvPositiveInteger(
      "FPC_FULL_E2E_NODE_TIMEOUT_MS",
      45_000,
    ),
    httpTimeoutMs: readEnvPositiveInteger(
      "FPC_FULL_E2E_HTTP_TIMEOUT_MS",
      30_000,
    ),
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
      2n,
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
  const artifactsRootDir = getArtifactsRootDir(repoRoot);
  const runDir = mkdtempSync(
    path.join(artifactsRootDir, "fpc-full-lifecycle-e2e-"),
  );
  const tokenArtifactPath = path.join(
    repoRoot,
    "target",
    "token_contract-Token.json",
  );
  const fpcArtifactPath = path.join(repoRoot, "target", "fpc-FPC.json");

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNodeReady(node, config.nodeTimeoutMs);
  const wallet = await EmbeddedWallet.create(node);

  const testAccounts = await getInitialTestAccountsData();
  const operatorData = testAccounts.at(0);
  const userData = testAccounts.at(1);
  const otherUserData = testAccounts.at(2);
  if (!operatorData || !userData || !otherUserData) {
    throw new Error("Expected at least 3 initial test accounts");
  }

  const [operator, user, otherUser] = await Promise.all([
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
    wallet
      .createSchnorrAccount(
        otherUserData.secret,
        otherUserData.salt,
        otherUserData.signingKey,
      )
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

  const attestationConfigPath = path.join(
    runDir,
    "attestation.fpc.config.yaml",
  );
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
        otherUser: otherUser.toString(),
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
    otherUser,
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

async function runFeePaidTargetTxAndAssert(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  attestationBaseUrl: string,
  txLabel: "tx1" | "tx2",
  targetTransferAmount: bigint,
): Promise<bigint> {
  const requestedFjAmount = result.maxGasCostNoTeardown;
  const quote = await fetchQuote(
    `${attestationBaseUrl}/quote?user=${result.user.toString()}&fj_amount=${requestedFjAmount.toString()}`,
    config.httpTimeoutMs,
  );
  const quoteSigBytes = Array.from(
    Buffer.from(quote.signature.replace(/^0x/, ""), "hex"),
  );
  const fjAmount = BigInt(quote.fj_amount);
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const validUntil = BigInt(quote.valid_until);

  if (quoteSigBytes.length !== 64) {
    throw new Error(
      `Quote signature length must be 64 bytes, got ${quoteSigBytes.length}`,
    );
  }
  if (fjAmount <= 0n) {
    throw new Error("Attestation quote returned non-positive fj_amount");
  }
  if (aaPaymentAmount <= 0n) {
    throw new Error(
      "Attestation quote returned non-positive aa_payment_amount",
    );
  }
  if (fjAmount !== requestedFjAmount) {
    throw new Error(
      `Attestation quote fj_amount mismatch. expected=${requestedFjAmount} got=${fjAmount}`,
    );
  }
  if (
    quote.accepted_asset.toLowerCase() !==
    result.token.address.toString().toLowerCase()
  ) {
    throw new Error(
      `Quote accepted_asset mismatch. expected=${result.token.address.toString()} got=${quote.accepted_asset}`,
    );
  }

  const expectedCharge = aaPaymentAmount;
  const mintAmount = expectedCharge + 1_000_000n;
  await result.token.methods
    .mint_to_private(result.user, mintAmount)
    .send({ from: result.operator });

  const userPrivateBefore = BigInt(
    (
      await result.token.methods
        .balance_of_private(result.user)
        .simulate({ from: result.user })
    ).toString(),
  );
  const operatorPrivateBefore = BigInt(
    (
      await result.token.methods
        .balance_of_private(result.operator)
        .simulate({ from: result.operator })
    ).toString(),
  );
  const userPublicBefore = BigInt(
    (
      await result.token.methods
        .balance_of_public(result.user)
        .simulate({ from: result.user })
    ).toString(),
  );
  const operatorPublicBefore = BigInt(
    (
      await result.token.methods
        .balance_of_public(result.operator)
        .simulate({ from: result.operator })
    ).toString(),
  );

  const transferAuthwitNonce = Fr.random();
  const transferCall = result.token.methods.transfer_private_to_private(
    result.user,
    result.operator,
    aaPaymentAmount,
    transferAuthwitNonce,
  );
  const transferAuthwit = await result.wallet.createAuthWit(result.user, {
    caller: result.fpc.address,
    action: transferCall,
  });

  const feeEntrypointCall = await result.fpc.methods
    .fee_entrypoint(
      transferAuthwitNonce,
      fjAmount,
      aaPaymentAmount,
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

  const receipt = await result.token.methods
    .transfer_public_to_public(
      result.user,
      result.operator,
      targetTransferAmount,
      Fr.random(),
    )
    .send({
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

  const userPrivateAfter = BigInt(
    (
      await result.token.methods
        .balance_of_private(result.user)
        .simulate({ from: result.user })
    ).toString(),
  );
  const operatorPrivateAfter = BigInt(
    (
      await result.token.methods
        .balance_of_private(result.operator)
        .simulate({ from: result.operator })
    ).toString(),
  );
  const userPublicAfter = BigInt(
    (
      await result.token.methods
        .balance_of_public(result.user)
        .simulate({ from: result.user })
    ).toString(),
  );
  const operatorPublicAfter = BigInt(
    (
      await result.token.methods
        .balance_of_public(result.operator)
        .simulate({ from: result.operator })
    ).toString(),
  );

  const userDebited = userPrivateBefore - userPrivateAfter;
  const operatorCredited = operatorPrivateAfter - operatorPrivateBefore;
  if (userDebited !== expectedCharge) {
    throw new Error(
      `[full-lifecycle-e2e] ${txLabel} user debit mismatch. expected=${expectedCharge} got=${userDebited}`,
    );
  }
  if (operatorCredited !== expectedCharge) {
    throw new Error(
      `[full-lifecycle-e2e] ${txLabel} operator credit mismatch. expected=${expectedCharge} got=${operatorCredited}`,
    );
  }

  const userPublicDelta = userPublicAfter - userPublicBefore;
  const operatorPublicDelta = operatorPublicAfter - operatorPublicBefore;
  if (userPublicDelta !== -targetTransferAmount) {
    throw new Error(
      `[full-lifecycle-e2e] ${txLabel} target call user public delta mismatch. expected=${-targetTransferAmount} got=${userPublicDelta}`,
    );
  }
  if (operatorPublicDelta !== targetTransferAmount) {
    throw new Error(
      `[full-lifecycle-e2e] ${txLabel} target call operator public delta mismatch. expected=${targetTransferAmount} got=${operatorPublicDelta}`,
    );
  }

  console.log(
    `[full-lifecycle-e2e] PASS: ${txLabel} accepted (expected_charge=${expectedCharge}, tx_fee_juice=${receipt.transactionFee}, user_debited=${userDebited}, operator_credited=${operatorCredited}, user_public_delta=${userPublicDelta}, operator_public_delta=${operatorPublicDelta})`,
  );
  return expectedCharge;
}

async function negativeQuoteReplayRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  attestationBaseUrl: string,
): Promise<void> {
  const requestedFjAmount = result.maxGasCostNoTeardown;
  const quote = parseQuoteResponse(
    await fetchQuote(
      `${attestationBaseUrl}/quote?user=${result.user.toString()}&fj_amount=${requestedFjAmount.toString()}`,
      config.httpTimeoutMs,
    ),
    result.token.address,
  );

  await executeFeePaidTx(config, result, {
    token: result.token,
    fpc: result.fpc,
    payer: result.user,
    recipient: result.operator,
    transferAmount: 1n,
    quote,
  });

  await expectFailure(
    "negative quote replay rejected",
    ["quote already used"],
    () =>
      executeFeePaidTx(config, result, {
        token: result.token,
        fpc: result.fpc,
        payer: result.user,
        recipient: result.operator,
        transferAmount: 1n,
        quote,
      }),
  );
}

async function negativeExpiredQuoteRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<void> {
  const fjAmount = result.maxGasCostNoTeardown;
  const aaPaymentAmount = computeAaPaymentFromFj(config, fjAmount);
  const latestTimestamp = await getLatestL2Timestamp(node);
  const expiredQuote = await signQuoteForUser(
    result,
    result.fpc.address,
    result.token.address,
    fjAmount,
    aaPaymentAmount,
    latestTimestamp,
    result.user,
  );

  await advanceL2Blocks(result.token, result.operator, result.user, 1);

  await expectFailure(
    "negative expired quote rejected",
    ["quote expired"],
    () =>
      executeFeePaidTx(config, result, {
        token: result.token,
        fpc: result.fpc,
        payer: result.user,
        recipient: result.operator,
        transferAmount: 1n,
        quote: expiredQuote,
      }),
  );
}

async function negativeOverlongTtlRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<void> {
  const fjAmount = result.maxGasCostNoTeardown;
  const aaPaymentAmount = computeAaPaymentFromFj(config, fjAmount);
  const latestTimestamp = await getLatestL2Timestamp(node);
  const ttlSafetyBufferSeconds = 600n;
  const ttlTooLargeQuote = await signQuoteForUser(
    result,
    result.fpc.address,
    result.token.address,
    fjAmount,
    aaPaymentAmount,
    latestTimestamp +
      BigInt(MAX_QUOTE_VALIDITY_SECONDS) +
      ttlSafetyBufferSeconds,
    result.user,
  );

  await expectFailure(
    "negative overlong quote ttl rejected",
    ["quote ttl too large"],
    () =>
      executeFeePaidTx(config, result, {
        token: result.token,
        fpc: result.fpc,
        payer: result.user,
        recipient: result.operator,
        transferAmount: 1n,
        quote: ttlTooLargeQuote,
      }),
  );
}

async function negativeSenderBindingRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<void> {
  const fjAmount = result.maxGasCostNoTeardown;
  const aaPaymentAmount = computeAaPaymentFromFj(config, fjAmount);
  const latestTimestamp = await getLatestL2Timestamp(node);
  const quoteSignedForUser = await signQuoteForUser(
    result,
    result.fpc.address,
    result.token.address,
    fjAmount,
    aaPaymentAmount,
    latestTimestamp + 600n,
    result.user,
  );

  await expectFailure(
    "negative quote sender binding rejected",
    ["invalid quote signature"],
    () =>
      executeFeePaidTx(config, result, {
        token: result.token,
        fpc: result.fpc,
        payer: result.otherUser,
        recipient: result.operator,
        transferAmount: 1n,
        quote: quoteSignedForUser,
      }),
  );
}

function buildTopupConfigYaml(
  config: FullE2EConfig,
  fpcAddress: AztecAddress,
  bridgeStatePath: string,
  thresholdWei: bigint,
  topupAmountWei: bigint,
): string {
  return `${[
    `fpc_address: "${fpcAddress.toString()}"`,
    `aztec_node_url: "${config.nodeUrl}"`,
    `l1_rpc_url: "${config.l1RpcUrl}"`,
    `threshold: "${thresholdWei}"`,
    `top_up_amount: "${topupAmountWei}"`,
    `bridge_state_path: "${bridgeStatePath}"`,
    `ops_port: ${config.topupOpsPort}`,
    `check_interval_ms: ${config.topupCheckIntervalMs}`,
    `confirmation_timeout_ms: ${config.topupConfirmTimeoutMs}`,
    `confirmation_poll_initial_ms: ${config.topupConfirmPollInitialMs}`,
    `confirmation_poll_max_ms: ${config.topupConfirmPollMaxMs}`,
  ].join("\n")}\n`;
}

async function negativeInsufficientFeeJuiceSecondTxRejected(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: ReturnType<typeof createAztecNodeClient>,
  estimatedSingleTxFeeJuice: bigint,
): Promise<bigint> {
  const tokenArtifactPath = path.join(
    result.repoRoot,
    "target",
    "token_contract-Token.json",
  );
  const fpcArtifactPath = path.join(result.repoRoot, "target", "fpc-FPC.json");
  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  const isolatedToken = await Contract.deploy(
    result.wallet,
    tokenArtifact,
    ["InsufficientToken", "INS", 18, result.operator, result.operator],
    "constructor_with_minter",
  ).send({ from: result.operator });

  const secret = Fr.fromHexString(result.operatorSecretHex);
  const signingKey = deriveSigningKey(secret);
  const schnorr = new Schnorr();
  const operatorPubKey = await schnorr.computePublicKey(signingKey);
  const isolatedFpc = await Contract.deploy(result.wallet, fpcArtifact, [
    result.operator,
    operatorPubKey.x,
    operatorPubKey.y,
    isolatedToken.address,
  ]).send({ from: result.operator });

  const isolatedCasesRoot = path.join(result.runDir, "insufficient");
  mkdirSync(isolatedCasesRoot, { recursive: true });
  const isolatedRunDir = mkdtempSync(
    path.join(isolatedCasesRoot, "fpc-full-lifecycle-e2e-insufficient-"),
  );
  const bridgeStatePath = path.join(isolatedRunDir, "topup.bridge-state.json");
  const topupConfigPath = path.join(isolatedRunDir, "topup.config.yaml");

  const minimumBudget = 1_000_000n;
  const txHeadroom =
    estimatedSingleTxFeeJuice <= 0n
      ? 1_000_000_000n
      : ceilDiv(estimatedSingleTxFeeJuice, 2n);
  const budgetWei = result.maxGasCostNoTeardown + txHeadroom + 1_000_000n;
  const effectiveBudgetWei =
    budgetWei > minimumBudget ? budgetWei : minimumBudget;

  writeFileSync(
    topupConfigPath,
    buildTopupConfigYaml(
      config,
      isolatedFpc.address,
      bridgeStatePath,
      effectiveBudgetWei,
      effectiveBudgetWei,
    ),
    "utf8",
  );

  const isolatedTopup = startManagedProcess(
    "full-e2e-topup-insufficient",
    "bun",
    [
      "run",
      path.join(result.repoRoot, "services", "topup", "dist", "index.js"),
      "--config",
      topupConfigPath,
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

  try {
    await waitForHealth(
      `http://127.0.0.1:${config.topupOpsPort}/health`,
      config.httpTimeoutMs,
    );
    await waitForHealth(
      `http://127.0.0.1:${config.topupOpsPort}/ready`,
      config.topupWaitTimeoutMs,
    );
    const submission = await waitForNextBridgeSubmission(
      isolatedTopup,
      config.topupWaitTimeoutMs,
      0,
    );
    await advanceL2Blocks(
      isolatedToken,
      result.operator,
      result.user,
      config.relayAdvanceBlocks,
    );
    await waitForNextBridgeConfirmedOutcome(
      isolatedTopup,
      config.topupWaitTimeoutMs,
      0,
      0,
      0,
    );

    let isolatedBalance = await getFeeJuiceBalance(isolatedFpc.address, node);
    if (isolatedBalance === 0n) {
      isolatedBalance = await claimBridgeSubmissionForTarget(
        node,
        {
          token: isolatedToken,
          operator: result.operator,
          user: result.user,
          wallet: result.wallet,
          feePayerAddress: isolatedFpc.address,
          topupAmountWei: effectiveBudgetWei,
        },
        submission.submission,
        config.relayAdvanceBlocks,
        config.topupWaitTimeoutMs,
        config.topupPollMs,
      );
    }
    if (isolatedBalance <= 0n) {
      throw new Error(
        "isolated insufficient-fee scenario funding did not produce Fee Juice",
      );
    }
  } finally {
    await stopManagedProcess(isolatedTopup);
  }

  const fjAmount = result.maxGasCostNoTeardown;
  const aaPaymentAmount = computeAaPaymentFromFj(config, fjAmount);
  const quoteAnchor = await getLatestL2Timestamp(node);
  const quote1 = await signQuoteForUser(
    result,
    isolatedFpc.address,
    isolatedToken.address,
    fjAmount,
    aaPaymentAmount,
    quoteAnchor + 600n,
    result.user,
  );
  const quote2 = await signQuoteForUser(
    result,
    isolatedFpc.address,
    isolatedToken.address,
    fjAmount,
    aaPaymentAmount,
    quoteAnchor + 601n,
    result.user,
  );

  await executeFeePaidTx(config, result, {
    token: isolatedToken,
    fpc: isolatedFpc,
    payer: result.user,
    recipient: result.operator,
    transferAmount: 1n,
    quote: quote1,
  });

  await expectFailure(
    "negative insufficient fee juice rejected second tx",
    [
      "insufficient fee payer balance",
      "fee payer balance",
      "insufficient fee payer",
      "not enough fee",
    ],
    () =>
      executeFeePaidTx(config, result, {
        token: isolatedToken,
        fpc: isolatedFpc,
        payer: result.user,
        recipient: result.operator,
        transferAmount: 1n,
        quote: quote2,
      }),
  );

  return effectiveBudgetWei;
}

async function runStep7NegativeScenarios(
  config: FullE2EConfig,
  result: DeploymentRuntimeResult,
  node: ReturnType<typeof createAztecNodeClient>,
  attestationBaseUrl: string,
  topup: ManagedProcess,
  estimatedSingleTxFeeJuice: bigint,
): Promise<NegativeScenarioResult> {
  await negativeQuoteReplayRejected(config, result, attestationBaseUrl);
  await negativeExpiredQuoteRejected(config, result, node);
  await negativeOverlongTtlRejected(config, result, node);
  await negativeSenderBindingRejected(config, result, node);

  await stopManagedProcess(topup);
  console.log(
    "[full-lifecycle-e2e] topup stopped before insufficient Fee Juice negative scenario",
  );

  const insufficientFeeJuiceBudgetWei =
    await negativeInsufficientFeeJuiceSecondTxRejected(
      config,
      result,
      node,
      estimatedSingleTxFeeJuice,
    );

  return {
    quoteReplayRejected: true,
    expiredQuoteRejected: true,
    overlongTtlRejected: true,
    senderBindingRejected: true,
    insufficientFeeJuiceRejected: true,
    insufficientFeeJuiceBudgetWei,
  };
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
  let phase = "step5.start_services";
  let topup: ManagedProcess | null = null;

  try {
    const attestation = startManagedProcess(
      "full-e2e-attestation",
      "bun",
      [
        "run",
        path.join(
          result.repoRoot,
          "services",
          "attestation",
          "dist",
          "index.js",
        ),
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

    phase = "step5.attestation_health";
    await waitForHealth(`${attestationBaseUrl}/health`, config.httpTimeoutMs);
    console.log("[full-lifecycle-e2e] PASS: attestation /health");

    topup = startManagedProcess(
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

    phase = "step5.topup_health_ready";
    await waitForHealth(`${topupOpsBaseUrl}/health`, config.httpTimeoutMs);
    await waitForLog(topup, "Top-up service started", config.httpTimeoutMs);
    await waitForHealth(`${topupOpsBaseUrl}/ready`, config.topupWaitTimeoutMs);
    console.log("[full-lifecycle-e2e] PASS: topup /health and /ready");

    phase = "step5.bridge_cycle_1";
    let topupCounters = getTopupLogCountersFromProcess(topup);
    let cycle1Submission: {
      submission: TopupBridgeSubmission;
      submissionCount: number;
    };
    if (topupCounters.submissionCount > 0) {
      const existingSubmissions = parseTopupBridgeSubmissions(topup.getLogs());
      const latestSubmission =
        existingSubmissions[existingSubmissions.length - 1];
      if (!latestSubmission) {
        throw new Error(
          "Top-up submission counter was non-zero but no submission could be parsed",
        );
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

    let feeJuiceAfterCycle1 = await getFeeJuiceBalance(
      result.fpc.address,
      node,
    );
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

    await result.token.methods
      .mint_to_public(result.user, 2n)
      .send({ from: result.operator });

    phase = "step6.tx1";
    const cycle2Baseline: TopupLogCounters = { ...topupCounters };
    const tx1ExpectedCharge = await runFeePaidTargetTxAndAssert(
      config,
      result,
      attestationBaseUrl,
      "tx1",
      1n,
    );
    const feeJuiceAfterTx1 = await getFeeJuiceBalance(result.fpc.address, node);
    console.log(`[full-lifecycle-e2e] fee_juice_after_tx1=${feeJuiceAfterTx1}`);

    let feeJuiceAfterCycle2: bigint | null = null;
    if (config.requiredTopupCycles === 2) {
      phase = "step5.bridge_cycle_2";
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

    phase = "step6.tx2";
    const tx2ExpectedCharge = await runFeePaidTargetTxAndAssert(
      config,
      result,
      attestationBaseUrl,
      "tx2",
      1n,
    );
    const feeJuiceAfterTx2 = await getFeeJuiceBalance(result.fpc.address, node);
    console.log(`[full-lifecycle-e2e] fee_juice_after_tx2=${feeJuiceAfterTx2}`);

    const estimatedSingleTxFeeJuice =
      feeJuiceAfterTx1 > feeJuiceAfterTx2
        ? feeJuiceAfterTx1 - feeJuiceAfterTx2
        : 0n;
    if (!topup) {
      throw new Error("Top-up process handle was lost before step7");
    }
    phase = "step7.negative_scenarios";
    const step7 = await runStep7NegativeScenarios(
      config,
      result,
      node,
      attestationBaseUrl,
      topup,
      estimatedSingleTxFeeJuice,
    );

    const finalTopupCounters = getTopupLogCountersFromProcess(topup);
    return {
      attestationBaseUrl,
      topupOpsBaseUrl,
      observedBridgeSubmissions: finalTopupCounters.submissionCount,
      observedBridgeConfirmed: finalTopupCounters.confirmedCount,
      feeJuiceAfterCycle1,
      feeJuiceAfterTx1,
      feeJuiceAfterCycle2,
      feeJuiceAfterTx2,
      tx1ExpectedCharge,
      tx2ExpectedCharge,
      step7,
    };
  } catch (error) {
    const diagnostics = persistFailureDiagnostics(
      result.runDir,
      result.summaryPath,
      phase,
      error,
      managed,
    );
    throw new Error(
      `[phase=${phase}] ${errorMessage(error)} (diagnostics=${diagnostics.diagnosticsPath})`,
    );
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
  const summary = readSummary(summaryPath);

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
  summary.step6 = {
    completedAt: new Date().toISOString(),
    tx1ExpectedCharge: orchestration.tx1ExpectedCharge.toString(),
    tx2ExpectedCharge: orchestration.tx2ExpectedCharge.toString(),
    feeJuiceAfterTx2: orchestration.feeJuiceAfterTx2.toString(),
  };
  summary.step7 = {
    completedAt: new Date().toISOString(),
    quoteReplayRejected: orchestration.step7.quoteReplayRejected,
    expiredQuoteRejected: orchestration.step7.expiredQuoteRejected,
    overlongTtlRejected: orchestration.step7.overlongTtlRejected,
    senderBindingRejected: orchestration.step7.senderBindingRejected,
    insufficientFeeJuiceRejected:
      orchestration.step7.insufficientFeeJuiceRejected,
    insufficientFeeJuiceBudgetWei:
      orchestration.step7.insufficientFeeJuiceBudgetWei.toString(),
  };

  writeSummary(summaryPath, summary);
  recordPhaseResult(summaryPath, "step5", "PASS");
  recordPhaseResult(summaryPath, "step6", "PASS");
  recordPhaseResult(summaryPath, "step7", "PASS");
}

function writeStep8Summary(summaryPath: string, runDir: string): void {
  const diagnosticsDir = path.join(runDir, "diagnostics");
  mkdirSync(diagnosticsDir, { recursive: true });

  updateSummary(summaryPath, (summary) => {
    summary.step8 = {
      completedAt: new Date().toISOString(),
      diagnosticsDir,
      tailLinesOnFailure: DIAGNOSTIC_TAIL_LINES,
    };
  });
  recordPhaseResult(summaryPath, "step8", "PASS", {
    diagnosticsDir,
    tailLinesOnFailure: DIAGNOSTIC_TAIL_LINES,
  });
}

async function main(): Promise<void> {
  installManagedProcessSignalHandlers();
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const config = getConfig();
  printConfigSummary(config);
  let phase = "step4.deploy_runtime_wiring";
  let result: DeploymentRuntimeResult | null = null;

  try {
    result = await deployContractsAndWriteRuntimeConfig(config);
    console.log(`[full-lifecycle-e2e] operator=${result.operator.toString()}`);
    console.log(`[full-lifecycle-e2e] user=${result.user.toString()}`);
    console.log(
      `[full-lifecycle-e2e] other_user=${result.otherUser.toString()}`,
    );
    console.log(
      `[full-lifecycle-e2e] token=${result.token.address.toString()}`,
    );
    console.log(`[full-lifecycle-e2e] fpc=${result.fpc.address.toString()}`);
    console.log(
      `[full-lifecycle-e2e] topup_threshold_wei=${result.topupThresholdWei}`,
    );
    console.log(
      `[full-lifecycle-e2e] topup_amount_wei=${result.topupAmountWei}`,
    );
    console.log(
      `[full-lifecycle-e2e] attestation_config=${result.attestationConfigPath}`,
    );
    console.log(`[full-lifecycle-e2e] topup_config=${result.topupConfigPath}`);
    console.log(`[full-lifecycle-e2e] run_summary=${result.summaryPath}`);

    recordPhaseResult(result.summaryPath, "step4", "PASS", {
      runDir: result.runDir,
      attestationConfigPath: result.attestationConfigPath,
      topupConfigPath: result.topupConfigPath,
    });
    console.log(
      "[full-lifecycle-e2e] PASS: step4 deployment and runtime wiring complete",
    );

    phase = "step5_to_step7.orchestration";
    const orchestration = await orchestrateServicesAndAssertBridgeCycles(
      config,
      result,
    );
    writeStep5Summary(result.summaryPath, orchestration);

    console.log(
      `[full-lifecycle-e2e] PASS: step5 service orchestration and bridge-cycle assertions passed (confirmed_cycles=${orchestration.observedBridgeConfirmed})`,
    );
    console.log(
      `[full-lifecycle-e2e] PASS: step6 tx invariants and target state deltas passed (tx1_expected_charge=${orchestration.tx1ExpectedCharge}, tx2_expected_charge=${orchestration.tx2ExpectedCharge})`,
    );
    console.log(
      `[full-lifecycle-e2e] PASS: step7 negative scenarios passed (insufficient_fee_juice_budget_wei=${orchestration.step7.insufficientFeeJuiceBudgetWei})`,
    );

    phase = "step8.diagnostics_and_artifacts";
    writeStep8Summary(result.summaryPath, result.runDir);
    console.log(
      "[full-lifecycle-e2e] PASS: step8 diagnostics and artifacts are persisted",
    );
    console.log("[full-lifecycle-e2e] PASS: full lifecycle e2e succeeded");
  } catch (error) {
    if (result !== null) {
      const summary = readSummary(result.summaryPath);
      if (summary.failure === undefined) {
        const diagnostics = persistFailureDiagnostics(
          result.runDir,
          result.summaryPath,
          phase,
          error,
          [],
        );
        throw new Error(
          `[phase=${phase}] ${errorMessage(error)} (diagnostics=${diagnostics.diagnosticsPath})`,
        );
      }
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[full-lifecycle-e2e] FAIL: ${message}`);
  process.exitCode = 1;
});
