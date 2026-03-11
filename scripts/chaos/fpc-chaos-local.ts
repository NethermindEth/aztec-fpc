import pino from "pino";

const pinoLogger = pino();

/**
 * FPC Chaos Local Orchestrator
 *
 * Fully self-contained: deploys contracts, starts services, waits for the FPC
 * to be funded via the topup bridge cycle, then runs the complete chaos test
 * suite against the live local setup.
 *
 * Usage (after `aztec start --local-network` is running):
 *   bun run chaos:local
 *
 * Or via the shell wrapper which also handles network startup:
 *   bash scripts/chaos/fpc-chaos-local.sh
 *
 * Key env vars (all optional):
 *   FPC_CHAOS_LOCAL_NODE_URL           default: http://127.0.0.1:8080
 *   FPC_CHAOS_LOCAL_L1_RPC_URL         default: http://127.0.0.1:8545
 *   FPC_CHAOS_LOCAL_L1_PRIVATE_KEY     default: Anvil account #0
 *   FPC_CHAOS_LOCAL_ATTESTATION_PORT   default: 3300
 *   FPC_CHAOS_LOCAL_TOPUP_OPS_PORT     default: 3401
 *   FPC_CHAOS_LOCAL_TOPUP_WAIT_MS      default: 300000
 *   FPC_CHAOS_LOCAL_HTTP_TIMEOUT_MS    default: 30000
 *   FPC_CHAOS_LOCAL_NODE_TIMEOUT_MS    default: 60000
 *   FPC_CHAOS_LOCAL_CHAOS_MODE         default: full
 *   FPC_CHAOS_LOCAL_REPORT_PATH        write JSON report here
 *   FPC_CHAOS_LOCAL_CONCURRENT_TXS     default: 3
 *   FPC_CHAOS_LOCAL_RATE_LIMIT_BURST   default: 70
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { createPublicClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  installManagedProcessSignalHandlers,
  type ManagedProcess,
  sleep,
  startManagedProcess,
  stopManagedProcess,
  waitForHealth,
  waitForNodeReady,
} from "../common/managed-process.ts";

const DEFAULT_L1_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const BRIDGE_SUBMISSION_RE =
  /Bridge submitted\. l1_to_l2_message_hash=(0x[0-9a-fA-F]+) leaf_index=(\d+)/;

type LocalConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  l1PrivateKey: string;
  attestationPort: number;
  topupOpsPort: number;
  topupWaitMs: number;
  httpTimeoutMs: number;
  nodeTimeoutMs: number;
  chaosMode: string;
  reportPath: string | null;
  concurrentTxs: number;
  rateLimitBurst: number;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  quoteValiditySeconds: number;
  daGasLimit: number;
  l2GasLimit: number;
  topupCheckIntervalMs: number;
  topupConfirmTimeoutMs: number;
  topupConfirmPollInitialMs: number;
  topupConfirmPollMaxMs: number;
  repoRoot: string;
  runDir: string;
};

function readEnvStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v?.trim() ? v.trim() : fallback;
}

function readEnvInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || !v.trim()) return fallback;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer, got: ${v}`);
  return n;
}

function getRepoRoot(): string {
  const dir =
    typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "..", "..");
}

function getConfig(): LocalConfig {
  const repoRoot = getRepoRoot();
  const artifactsRoot = path.join(repoRoot, "tmp");
  mkdirSync(artifactsRoot, { recursive: true });
  const runDir = mkdtempSync(path.join(artifactsRoot, "fpc-chaos-local-"));

  return {
    nodeUrl: readEnvStr("FPC_CHAOS_LOCAL_NODE_URL", "http://127.0.0.1:8080"),
    l1RpcUrl: readEnvStr("FPC_CHAOS_LOCAL_L1_RPC_URL", "http://127.0.0.1:8545"),
    l1PrivateKey: readEnvStr("FPC_CHAOS_LOCAL_L1_PRIVATE_KEY", DEFAULT_L1_PRIVATE_KEY),
    attestationPort: readEnvInt("FPC_CHAOS_LOCAL_ATTESTATION_PORT", 3300),
    topupOpsPort: readEnvInt("FPC_CHAOS_LOCAL_TOPUP_OPS_PORT", 3401),
    topupWaitMs: readEnvInt("FPC_CHAOS_LOCAL_TOPUP_WAIT_MS", 300_000),
    httpTimeoutMs: readEnvInt("FPC_CHAOS_LOCAL_HTTP_TIMEOUT_MS", 30_000),
    nodeTimeoutMs: readEnvInt("FPC_CHAOS_LOCAL_NODE_TIMEOUT_MS", 60_000),
    chaosMode: readEnvStr("FPC_CHAOS_LOCAL_CHAOS_MODE", "full"),
    reportPath: process.env.FPC_CHAOS_LOCAL_REPORT_PATH?.trim() || null,
    concurrentTxs: readEnvInt("FPC_CHAOS_LOCAL_CONCURRENT_TXS", 3),
    rateLimitBurst: readEnvInt("FPC_CHAOS_LOCAL_RATE_LIMIT_BURST", 70),
    marketRateNum: readEnvInt("FPC_CHAOS_LOCAL_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvInt("FPC_CHAOS_LOCAL_MARKET_RATE_DEN", 1000),
    feeBips: readEnvInt("FPC_CHAOS_LOCAL_FEE_BIPS", 200),
    quoteValiditySeconds: readEnvInt("FPC_CHAOS_LOCAL_QUOTE_VALIDITY_SECONDS", 3600),
    daGasLimit: readEnvInt("FPC_CHAOS_LOCAL_DA_GAS_LIMIT", 1_000_000),
    l2GasLimit: readEnvInt("FPC_CHAOS_LOCAL_L2_GAS_LIMIT", 1_000_000),
    topupCheckIntervalMs: readEnvInt("FPC_CHAOS_LOCAL_TOPUP_CHECK_INTERVAL_MS", 3_000),
    topupConfirmTimeoutMs: readEnvInt("FPC_CHAOS_LOCAL_TOPUP_CONFIRM_TIMEOUT_MS", 180_000),
    topupConfirmPollInitialMs: readEnvInt("FPC_CHAOS_LOCAL_TOPUP_CONFIRM_POLL_INITIAL_MS", 1_000),
    topupConfirmPollMaxMs: readEnvInt("FPC_CHAOS_LOCAL_TOPUP_CONFIRM_POLL_MAX_MS", 15_000),
    repoRoot,
    runDir,
  };
}

function loadArtifact(p: string): ContractArtifact {
  const raw = readFileSync(p, "utf8");
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

function parseBridgeSubmission(logs: string): {
  messageHash: string;
  leafIndex: bigint;
} | null {
  const m = BRIDGE_SUBMISSION_RE.exec(logs);
  if (!m) return null;
  return {
    messageHash: m[1],
    leafIndex: BigInt(m[2]),
  };
}

function hasBridgeConfirmed(logs: string): boolean {
  return logs.includes("Bridge confirmation outcome=confirmed");
}

async function waitForBridgeSubmission(
  proc: ManagedProcess,
  timeoutMs: number,
): Promise<{
  messageHash: string;
  leafIndex: bigint;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sub = parseBridgeSubmission(proc.getLogs());
    if (sub) return sub;
    if (proc.process.exitCode !== null) {
      throw new Error(
        `${proc.name} exited (code=${proc.process.exitCode}) before bridge submission.\n${proc.getLogs().slice(-3000)}`,
      );
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out waiting for bridge submission from ${proc.name}.\n${proc.getLogs().slice(-3000)}`,
  );
}

async function waitForPositiveFeeJuiceBalance(
  node: ReturnType<typeof createAztecNodeClient>,
  fpcAddress: AztecAddress,
  timeoutMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const balance = await getFeeJuiceBalance(fpcAddress, node);
    if (balance > 0n) {
      return balance;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for positive Fee Juice balance on ${fpcAddress.toString()}`);
}

async function waitForBridgeConfirmed(proc: ManagedProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasBridgeConfirmed(proc.getLogs())) return;
    if (proc.process.exitCode !== null) {
      throw new Error(
        `${proc.name} exited (code=${proc.process.exitCode}) before bridge confirmed.\n${proc.getLogs().slice(-3000)}`,
      );
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out waiting for bridge confirmation from ${proc.name}.\n${proc.getLogs().slice(-3000)}`,
  );
}

/** Wait for chaos test process to exit; returns exit code. */
async function waitForProcessExit(proc: ManagedProcess, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) return proc.process.exitCode;
    await sleep(300);
  }
  throw new Error(`${proc.name} did not exit within ${timeoutMs}ms`);
}

type SetupResult = {
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  operatorSecretHex: string;
  token: Contract;
  operator: AztecAddress;
  user: AztecAddress;
  wallet: EmbeddedWallet;
  attestationConfigPath: string;
  topupConfigPath: string;
  topupBridgeStatePath: string;
  topupAmountWei: bigint;
};

async function deployAndConfigure(config: LocalConfig): Promise<SetupResult> {
  const tokenArtifactPath = path.join(config.repoRoot, "target", "token_contract-Token.json");
  const fpcArtifactPath = path.join(config.repoRoot, "target", "fpc-FPCMultiAsset.json");

  if (!existsSync(tokenArtifactPath) || !existsSync(fpcArtifactPath)) {
    throw new Error(
      "Contract artifacts not found. Run `aztec compile --workspace --force` first.\n" +
        `  Expected: ${tokenArtifactPath}\n  Expected: ${fpcArtifactPath}`,
    );
  }

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  pinoLogger.info(`[chaos-local] Connecting to Aztec node: ${config.nodeUrl}`);
  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNodeReady(node, config.nodeTimeoutMs);

  const wallet = await EmbeddedWallet.create(node);
  const testAccounts = await getInitialTestAccountsData();

  const [opData, userData] = [testAccounts.at(0), testAccounts.at(1)];
  if (!opData || !userData) {
    throw new Error("Need at least 2 initial test accounts");
  }

  const [operator, user] = await Promise.all([
    wallet
      .createSchnorrAccount(opData.secret, opData.salt, opData.signingKey)
      .then((a) => a.address),
    wallet
      .createSchnorrAccount(userData.secret, userData.salt, userData.signingKey)
      .then((a) => a.address),
  ]);

  const operatorSecretHex = opData.secret.toString();
  pinoLogger.info(`[chaos-local] Operator: ${operator.toString()}`);

  // Derive operator Schnorr signing public key (embedded in FPC contract)
  const schnorr = new Schnorr();
  const signingKey = opData.signingKey ?? deriveSigningKey(opData.secret);
  const operatorPubKey = await schnorr.computePublicKey(signingKey);

  pinoLogger.info("[chaos-local] Deploying Token contract...");
  const token = await Contract.deploy(
    wallet,
    tokenArtifact,
    ["ChaosToken", "CTK", 18, operator, operator],
    "constructor_with_minter",
  ).send({ from: operator });
  pinoLogger.info(`[chaos-local] Token deployed at ${token.contract.address.toString()}`);

  pinoLogger.info("[chaos-local] Deploying FPC contract...");
  const fpc = await Contract.deploy(wallet, fpcArtifact, [
    operator,
    operatorPubKey.x,
    operatorPubKey.y,
  ]).send({ from: operator });
  pinoLogger.info(`[chaos-local] FPC deployed at ${fpc.contract.address.toString()}`);

  const [minFees, nodeInfo] = await Promise.all([node.getCurrentMinFees(), node.getNodeInfo()]);
  const maxGasCostPerTx =
    BigInt(config.daGasLimit) * minFees.feePerDaGas +
    BigInt(config.l2GasLimit) * minFees.feePerL2Gas;
  // Target: cover ~40 worst-case fee-paid txs
  const desiredTopupWei = maxGasCostPerTx * 40n + 1_000_000n;

  // Query the actual L1 FeeJuice ERC20 balance so we never try to bridge more
  // than what the operator account holds (which causes ERC20InsufficientBalance).
  const feeJuiceL1Addr = nodeInfo.l1ContractAddresses.feeJuiceAddress.toString() as `0x${string}`;
  const l1OperatorAddr = privateKeyToAccount(config.l1PrivateKey as Hex).address;
  const l1Client = createPublicClient({ transport: http(config.l1RpcUrl) });
  const l1FeeJuiceBalance = await l1Client.readContract({
    address: feeJuiceL1Addr,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
      },
    ] as const,
    functionName: "balanceOf",
    args: [l1OperatorAddr],
  });

  // Cap at 50% of the L1 balance (not 90%). The topup service may attempt a
  // second bridge while the first is still pending (FPC balance = 0 during the
  // L1→L2 relay wait). Capping at 50% leaves enough L1 FeeJuice so that the
  // retry succeeds instead of failing with ERC20InsufficientBalance.
  // 50% of the local devnet's 1 FeeJuice covers ~25 worst-case fee-paid txs,
  // more than enough for the chaos suite (~15-20 fee-paid txs).
  const safeL1Budget = l1FeeJuiceBalance / 2n;
  const topupAmountWei = desiredTopupWei <= safeL1Budget ? desiredTopupWei : safeL1Budget;

  if (topupAmountWei === 0n) {
    throw new Error(
      `L1 FeeJuice balance is 0 for ${l1OperatorAddr}. ` +
        "Start aztec local network and ensure the operator account is pre-funded.",
    );
  }
  pinoLogger.info(
    `[chaos-local] L1 FeeJuice balance: ${l1FeeJuiceBalance}, topup amount: ${topupAmountWei}`,
  );

  // Write attestation config
  const attestationConfigPath = path.join(config.runDir, "attestation.config.yaml");
  writeFileSync(
    attestationConfigPath,
    `${[
      `fpc_address: "${fpc.address.toString()}"`,
      `aztec_node_url: "${config.nodeUrl}"`,
      `quote_validity_seconds: ${config.quoteValiditySeconds}`,
      `port: ${config.attestationPort}`,
      `accepted_asset_name: "ChaosToken"`,
      `accepted_asset_address: "${token.address.toString()}"`,
      `market_rate_num: ${config.marketRateNum}`,
      `market_rate_den: ${config.marketRateDen}`,
      `fee_bips: ${config.feeBips}`,
      "quote_rate_limit_enabled: true",
      "quote_rate_limit_max_requests: 60",
      "quote_rate_limit_window_seconds: 60",
      "quote_rate_limit_max_tracked_keys: 10000",
    ].join("\n")}\n`,
    "utf8",
  );

  // Write topup config
  const topupBridgeStatePath = path.join(config.runDir, "topup.bridge-state.json");
  const topupConfigPath = path.join(config.runDir, "topup.config.yaml");
  writeFileSync(
    topupConfigPath,
    `${[
      `fpc_address: "${fpc.address.toString()}"`,
      `aztec_node_url: "${config.nodeUrl}"`,
      `l1_rpc_url: "${config.l1RpcUrl}"`,
      // Threshold at 10% of the bridge amount so the topup service does not
      // trigger a second bridge cycle after each small fee-paid tx reduces the
      // FPC balance slightly below the top-up amount.
      `threshold: "${topupAmountWei / 10n}"`,
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

  pinoLogger.info(`[chaos-local] Configs written to ${config.runDir}`);

  return {
    fpcAddress: fpc.address,
    tokenAddress: token.address,
    operatorSecretHex,
    token: Contract.at(token.address, tokenArtifact, wallet),
    operator,
    user,
    wallet,
    attestationConfigPath,
    topupConfigPath,
    topupBridgeStatePath,
    topupAmountWei,
  };
}

async function startServicesAndFundFpc(
  config: LocalConfig,
  setup: SetupResult,
): Promise<{ attestation: ManagedProcess; topup: ManagedProcess }> {
  const attestationBaseUrl = `http://127.0.0.1:${config.attestationPort}`;
  const topupOpsBaseUrl = `http://127.0.0.1:${config.topupOpsPort}`;
  const attestationDistPath = path.join(
    config.repoRoot,
    "services",
    "attestation",
    "dist",
    "index.js",
  );
  const topupDistPath = path.join(config.repoRoot, "services", "topup", "dist", "index.js");

  pinoLogger.info("[chaos-local] Starting attestation service...");
  const attestation = startManagedProcess(
    "chaos-attestation",
    "bun",
    ["run", attestationDistPath, "--config", setup.attestationConfigPath],
    {
      cwd: config.repoRoot,
      env: {
        ...process.env,
        OPERATOR_SECRET_KEY: setup.operatorSecretHex,
      },
    },
  );

  await waitForHealth(`${attestationBaseUrl}/health`, config.httpTimeoutMs);
  pinoLogger.info(`[chaos-local] Attestation service ready at ${attestationBaseUrl}`);

  pinoLogger.info("[chaos-local] Starting topup service...");
  const topup = startManagedProcess(
    "chaos-topup",
    "bun",
    ["run", topupDistPath, "--config", setup.topupConfigPath],
    {
      cwd: config.repoRoot,
      env: {
        ...process.env,
        L1_OPERATOR_PRIVATE_KEY: config.l1PrivateKey,
      },
    },
  );

  await waitForHealth(`${topupOpsBaseUrl}/health`, config.httpTimeoutMs);
  pinoLogger.info(`[chaos-local] Topup service ready at ${topupOpsBaseUrl}`);

  // Wait for topup to submit its first L1 bridge transaction
  pinoLogger.info("[chaos-local] Waiting for topup to submit L1→L2 bridge...");
  const bridgeSub = await waitForBridgeSubmission(topup, config.topupWaitMs);
  pinoLogger.info(
    `[chaos-local] Bridge submitted: messageHash=${bridgeSub.messageHash} leafIndex=${bridgeSub.leafIndex}`,
  );

  // Advance L2 blocks to make the L1→L2 message available for claiming
  pinoLogger.info(
    `[chaos-local] Advancing ${config.relayAdvanceBlocks} L2 blocks to relay L1→L2 message...`,
  );
  for (let i = 0; i < config.relayAdvanceBlocks; i++) {
    await setup.token.methods
      .mint_to_private(setup.user, 1n)
      .send({ from: setup.operator, wait: { timeout: 120 } });
    pinoLogger.info(`[chaos-local] relay block ${i + 1}/${config.relayAdvanceBlocks}`);
  }
  const node = createAztecNodeClient(config.nodeUrl);

  // Wait for topup to log a confirmed outcome
  pinoLogger.info("[chaos-local] Waiting for bridge confirmation...");
  await waitForBridgeConfirmed(topup, config.topupWaitMs);

  const feeJuiceBalance = await waitForPositiveFeeJuiceBalance(
    node,
    setup.fpcAddress,
    config.topupWaitMs,
  );

  pinoLogger.info(`[chaos-local] FPC funded: feeJuice=${feeJuiceBalance}`);
  return { attestation, topup };
}

async function runChaosTest(config: LocalConfig, setup: SetupResult): Promise<number> {
  const chaosTestPath = path.join(config.repoRoot, "scripts", "chaos", "fpc-chaos-test.ts");
  const attestationBaseUrl = `http://127.0.0.1:${config.attestationPort}`;
  const topupOpsBaseUrl = `http://127.0.0.1:${config.topupOpsPort}`;

  const reportPath = config.reportPath ?? path.join(config.runDir, "chaos-report.json");

  pinoLogger.info("\n[chaos-local] ──────────────────────────────────────────");
  pinoLogger.info(`[chaos-local] Launching chaos test suite (mode=${config.chaosMode})`);
  pinoLogger.info(`[chaos-local] FPC:    ${setup.fpcAddress.toString()}`);
  pinoLogger.info(`[chaos-local] Token:  ${setup.tokenAddress.toString()}`);
  pinoLogger.info(`[chaos-local] Attest: ${attestationBaseUrl}`);
  pinoLogger.info(`[chaos-local] Topup:  ${topupOpsBaseUrl}`);
  pinoLogger.info(`[chaos-local] Report: ${reportPath}`);
  pinoLogger.info("[chaos-local] ──────────────────────────────────────────\n");

  // Chaos test env – passed directly so no shell inheritance issues
  const chaosEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FPC_CHAOS_MODE: config.chaosMode,
    FPC_CHAOS_ATTESTATION_URL: attestationBaseUrl,
    FPC_CHAOS_TOPUP_URL: topupOpsBaseUrl,
    FPC_CHAOS_NODE_URL: config.nodeUrl,
    FPC_CHAOS_FPC_ADDRESS: setup.fpcAddress.toString(),
    FPC_CHAOS_ACCEPTED_ASSET: setup.tokenAddress.toString(),
    FPC_CHAOS_OPERATOR_SECRET_KEY: setup.operatorSecretHex,
    FPC_CHAOS_REPORT_PATH: reportPath,
    FPC_CHAOS_CONCURRENT_TXS: String(config.concurrentTxs),
    FPC_CHAOS_RATE_LIMIT_BURST: String(config.rateLimitBurst),
    FPC_CHAOS_DA_GAS_LIMIT: String(config.daGasLimit),
    FPC_CHAOS_L2_GAS_LIMIT: String(config.l2GasLimit),
    FPC_CHAOS_HTTP_TIMEOUT_MS: String(config.httpTimeoutMs),
    // Do not set FPC_CHAOS_FAIL_FAST – run all tests and collect results
  };

  const chaosProc = startManagedProcess("chaos-test", "bun", [chaosTestPath], {
    cwd: config.repoRoot,
    env: chaosEnv,
  });

  // 30 min ceiling for the full suite
  const exitCode = await waitForProcessExit(chaosProc, 30 * 60 * 1000);
  pinoLogger.info(`\n[chaos-local] Chaos test process exited with code ${exitCode}`);

  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        summary?: {
          total?: number;
          passed?: number;
          failed?: number;
          skipped?: number;
        };
      };
      const s = report.summary ?? {};
      pinoLogger.info(
        `[chaos-local] Report summary: ${s.total ?? "?"} total, ` +
          `${s.passed ?? "?"} passed, ${s.failed ?? "?"} failed, ${s.skipped ?? "?"} skipped`,
      );
      pinoLogger.info(`[chaos-local] Full report: ${reportPath}`);
    } catch {
      // ignore parse errors – raw file still exists
    }
  }

  return exitCode;
}

async function main(): Promise<void> {
  installManagedProcessSignalHandlers();

  const config = getConfig();
  const managed: ManagedProcess[] = [];

  pinoLogger.info("\n[chaos-local] ════════════════════════════════════════════");
  pinoLogger.info("[chaos-local]  FPC Chaos Local – self-contained test run  ");
  pinoLogger.info("[chaos-local] ════════════════════════════════════════════");
  pinoLogger.info(`[chaos-local] node=${config.nodeUrl}  l1=${config.l1RpcUrl}`);
  pinoLogger.info(`[chaos-local] mode=${config.chaosMode}  runDir=${config.runDir}\n`);

  let exitCode = 0;

  try {
    pinoLogger.info("[chaos-local] Step 1/3: Deploying contracts...");
    const setup = await deployAndConfigure(config);

    pinoLogger.info("\n[chaos-local] Step 2/3: Starting services and funding FPC...");
    const { attestation, topup } = await startServicesAndFundFpc(config, setup);
    managed.push(attestation, topup);

    pinoLogger.info("\n[chaos-local] Step 3/3: Running chaos tests...");
    exitCode = await runChaosTest(config, setup);
  } catch (err) {
    pinoLogger.error("\n[chaos-local] ERROR:", err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    pinoLogger.info("\n[chaos-local] Stopping services...");
    await Promise.allSettled(managed.map(stopManagedProcess));
  }

  process.exit(exitCode);
}

main().catch((err) => {
  pinoLogger.error("[chaos-local] Unhandled error:", err);
  process.exit(1);
});
