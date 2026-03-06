import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const pinoLogger = pino();

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeInnerAuthWitHash, lookupValidity } from "@aztec/aztec.js/authorization";
import type { Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { createPublicClient, createWalletClient, type Hex, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployContract } from "../common/deploy-utils.ts";
import {
  installManagedProcessSignalHandlers,
  type ManagedProcess,
  sleep,
  startManagedProcess,
  stopManagedProcess,
  waitForHealth,
  waitForLog,
  waitForNodeReady,
} from "../common/managed-process.ts";
import { resolveScriptAccounts } from "../common/script-credentials.ts";

const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
// Keep the legacy FPC artifact only as a non-default compatibility fallback.
const FPC_ARTIFACT_FILE_CANDIDATES = ["fpc-FPCMultiAsset.json", "fpc-FPC.json"] as const;

type TopupBridgeOutcome = "confirmed" | "timeout" | "failed";
type TopupBridgeSubmission = {
  messageHash: Hex;
  messageLeafIndex: bigint;
};

type SchnorrPoint = Awaited<ReturnType<Schnorr["computePublicKey"]>>;

type SmokeConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  attestationPort: number;
  topupOpsPort: number;
  nodeTimeoutMs: number;
  httpTimeoutMs: number;
  topupWaitTimeoutMs: number;
  topupPollMs: number;
  topupCheckIntervalMs: number;
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

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

type AssetResponse = {
  name: string;
  address: string;
};

type ServiceFlowResult = {
  fjAmount: bigint;
  aaPaymentAmount: bigint;
  rateNum: bigint;
  rateDen: bigint;
  validUntil: bigint;
  quoteSigBytes: number[];
};

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env var ${name}=${value}`);
  }
  return parsed;
}

function readEnvBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return parsed;
}

function readOptionalEnvBigInt(name: string): bigint | null {
  const value = process.env[name];
  return value ? BigInt(value) : null;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
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
  const explicitPath = process.env.FPC_SERVICES_SMOKE_FPC_ARTIFACT ?? process.env.FPC_FPC_ARTIFACT;
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath);
  }

  for (const artifactFile of FPC_ARTIFACT_FILE_CANDIDATES) {
    const candidatePath = path.join(repoRoot, "target", artifactFile);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const searched = FPC_ARTIFACT_FILE_CANDIDATES.map((entry) =>
    path.join(repoRoot, "target", entry),
  ).join(", ");
  throw new Error(
    `FPC artifact not found. Looked for ${searched}. Set FPC_SERVICES_SMOKE_FPC_ARTIFACT or FPC_FPC_ARTIFACT to override.`,
  );
}

function normalizeHexAddress(value: unknown, fieldName: string): Hex {
  if (typeof value === "string") {
    return value as Hex;
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return value.toString() as Hex;
  }
  throw new Error(`Invalid L1 address in node info for ${fieldName}`);
}

async function getFeeJuiceL1Addresses(
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<{ tokenAddress: Hex; portalAddress: Hex }> {
  const nodeInfo = await node.getNodeInfo();
  const l1Addresses = nodeInfo.l1ContractAddresses as Record<string, unknown>;
  const tokenAddressValue = l1Addresses.feeJuiceAddress ?? l1Addresses.feeJuice;
  const portalAddressValue = l1Addresses.feeJuicePortalAddress ?? l1Addresses.feeJuicePortal;
  if (!tokenAddressValue || !portalAddressValue) {
    throw new Error("Node info is missing FeeJuice L1 contract addresses");
  }

  return {
    tokenAddress: normalizeHexAddress(tokenAddressValue, "feeJuiceAddress"),
    portalAddress: normalizeHexAddress(portalAddressValue, "feeJuicePortalAddress"),
  };
}

async function getL1FeeJuiceBalance(
  node: ReturnType<typeof createAztecNodeClient>,
  l1RpcUrl: string,
  l1PrivateKey: Hex,
): Promise<bigint> {
  const { tokenAddress } = await getFeeJuiceL1Addresses(node);
  const account = privateKeyToAccount(l1PrivateKey);
  const publicClient = createPublicClient({ transport: http(l1RpcUrl) });
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  return balance;
}

async function tryMintL1FeeJuice(
  node: ReturnType<typeof createAztecNodeClient>,
  l1RpcUrl: string,
  l1PrivateKey: Hex,
  amount: bigint,
): Promise<{ minted: boolean; resultingBalance: bigint }> {
  if (amount <= 0n) {
    return {
      minted: false,
      resultingBalance: await getL1FeeJuiceBalance(node, l1RpcUrl, l1PrivateKey),
    };
  }

  const { tokenAddress } = await getFeeJuiceL1Addresses(node);
  const account = privateKeyToAccount(l1PrivateKey);
  const walletClient = createWalletClient({
    account,
    transport: http(l1RpcUrl),
  });
  const publicClient = createPublicClient({
    transport: http(l1RpcUrl),
  });

  try {
    const mintTxHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [account.address, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTxHash });
    return {
      minted: true,
      resultingBalance: await getL1FeeJuiceBalance(node, l1RpcUrl, l1PrivateKey),
    };
  } catch {
    return {
      minted: false,
      resultingBalance: await getL1FeeJuiceBalance(node, l1RpcUrl, l1PrivateKey),
    };
  }
}

function getConfig(): SmokeConfig {
  const config: SmokeConfig = {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    l1RpcUrl: process.env.FPC_SERVICES_SMOKE_L1_RPC_URL ?? "http://127.0.0.1:8545",
    attestationPort: readEnvNumber("FPC_SERVICES_SMOKE_ATTESTATION_PORT", 3300),
    topupOpsPort: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_OPS_PORT", 3401),
    nodeTimeoutMs: readEnvNumber("FPC_SERVICES_SMOKE_NODE_TIMEOUT_MS", 45_000),
    httpTimeoutMs: readEnvNumber("FPC_SERVICES_SMOKE_HTTP_TIMEOUT_MS", 30_000),
    topupWaitTimeoutMs: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_WAIT_TIMEOUT_MS", 240_000),
    topupPollMs: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_POLL_MS", 2_000),
    topupCheckIntervalMs: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_CHECK_INTERVAL_MS", 300_000),
    quoteValiditySeconds: readEnvNumber("FPC_SERVICES_SMOKE_QUOTE_VALIDITY_SECONDS", 3600),
    marketRateNum: readEnvNumber("FPC_SERVICES_SMOKE_MARKET_RATE_NUM", 1),
    marketRateDen: readEnvNumber("FPC_SERVICES_SMOKE_MARKET_RATE_DEN", 1000),
    feeBips: readEnvNumber("FPC_SERVICES_SMOKE_FEE_BIPS", 200),
    daGasLimit: readEnvNumber("FPC_SERVICES_SMOKE_DA_GAS_LIMIT", 1_000_000),
    l2GasLimit: readEnvNumber("FPC_SERVICES_SMOKE_L2_GAS_LIMIT", 1_000_000),
    feeJuiceTopupSafetyMultiplier: readEnvBigInt("FPC_SERVICES_SMOKE_TOPUP_SAFETY_MULTIPLIER", 2n),
    topupConfirmTimeoutMs: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_CONFIRM_TIMEOUT_MS", 180_000),
    topupConfirmPollInitialMs: readEnvNumber(
      "FPC_SERVICES_SMOKE_TOPUP_CONFIRM_POLL_INITIAL_MS",
      1_000,
    ),
    topupConfirmPollMaxMs: readEnvNumber("FPC_SERVICES_SMOKE_TOPUP_CONFIRM_POLL_MAX_MS", 15_000),
  };

  return config;
}

async function waitForTopupBridgeOutcome(
  proc: ManagedProcess,
  timeoutMs: number,
): Promise<TopupBridgeOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const logs = proc.getLogs();
    if (logs.includes("Bridge confirmation outcome=confirmed")) {
      return "confirmed";
    }
    if (logs.includes("Bridge confirmation outcome=timeout")) {
      return "timeout";
    }
    if (logs.includes("Bridge confirmation outcome=failed")) {
      return "failed";
    }
    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before bridge confirmation outcome was logged (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${proc.name} bridge confirmation outcome log. Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}

async function waitForTopupBridgeSubmission(
  proc: ManagedProcess,
  timeoutMs: number,
): Promise<TopupBridgeSubmission> {
  const deadline = Date.now() + timeoutMs;
  const submissionPattern =
    /Bridge submitted\. l1_to_l2_message_hash=(0x[0-9a-fA-F]+) leaf_index=(\d+)/;

  while (Date.now() <= deadline) {
    const logs = proc.getLogs();
    const match = submissionPattern.exec(logs);
    if (match) {
      const [, messageHash, leafIndex] = match;
      return {
        messageHash: messageHash as Hex,
        messageLeafIndex: BigInt(leafIndex),
      };
    }
    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before bridge submission was logged (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for ${proc.name} bridge submission log. Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}

async function waitForPositiveFeeJuiceBalance(
  node: ReturnType<typeof createAztecNodeClient>,
  fpcAddress: AztecAddress,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const balance = await getFeeJuiceBalance(fpcAddress, node);
    if (balance > 0n) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for Fee Juice balance on ${fpcAddress}`);
}

async function getCurrentChainUnixSeconds(
  node: ReturnType<typeof createAztecNodeClient>,
): Promise<bigint> {
  const latest = await node.getBlock("latest");
  if (latest) {
    return latest.timestamp;
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

async function fetchQuote(quoteUrl: string, timeoutMs: number): Promise<QuoteResponse> {
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

async function fetchAsset(assetUrl: string, timeoutMs: number): Promise<AssetResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(assetUrl);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        const parsed = JSON.parse(bodyText) as AssetResponse;
        if (typeof parsed.name === "string" && typeof parsed.address === "string") {
          return parsed;
        }
        lastError = `Invalid asset payload: ${bodyText}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(500);
  }

  throw new Error(`Timed out requesting asset metadata. Last error: ${lastError}`);
}

async function fetchMetrics(metricsUrl: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(metricsUrl);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        return bodyText;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(500);
  }

  throw new Error(`Timed out requesting metrics. Last error: ${lastError}`);
}

function parsePrometheusLabelSet(raw: string): Map<string, string> {
  const labels = new Map<string, string>();
  if (!raw.trim()) {
    return labels;
  }

  for (const segment of raw.split(",")) {
    const [rawKey, rawValue] = segment.split("=", 2);
    if (!rawKey || rawValue === undefined) {
      continue;
    }

    const key = rawKey.trim();
    const valueMatch = rawValue.trim().match(/^"((?:\\.|[^"])*)"$/);
    if (!valueMatch) {
      continue;
    }

    labels.set(key, valueMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }

  return labels;
}

function getPrometheusMetricValue(
  metricsText: string,
  metricName: string,
  labels: Record<string, string> = {},
): number | undefined {
  const expectedLabelEntries = Object.entries(labels);

  for (const line of metricsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/,
    );
    if (!match) {
      continue;
    }

    const [, name, labelSetRaw = "", valueRaw] = match;
    if (name !== metricName) {
      continue;
    }

    const actualLabels = parsePrometheusLabelSet(labelSetRaw);
    if (actualLabels.size !== expectedLabelEntries.length) {
      continue;
    }

    let labelsMatch = true;
    for (const [key, value] of expectedLabelEntries) {
      if (actualLabels.get(key) !== value) {
        labelsMatch = false;
        break;
      }
    }
    if (!labelsMatch) {
      continue;
    }

    const parsedValue = Number(valueRaw);
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return undefined;
}

function assertPrivateKeyHex(value: string, fieldName: string): void {
  if (!HEX_32_BYTE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a 32-byte 0x-prefixed private key`);
  }
}

async function verifyAttestationAmountQuoteSignature(
  schnorr: Schnorr,
  operatorPubKey: SchnorrPoint,
  feePayerAddress: AztecAddress,
  tokenAddress: AztecAddress,
  user: AztecAddress,
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  quoteSigBytes: number[],
  scenarioPrefix: string,
): Promise<void> {
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    feePayerAddress.toField(),
    tokenAddress.toField(),
    new Fr(fjAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    user.toField(),
  ]);
  const signature = SchnorrSignature.fromBuffer(Buffer.from(quoteSigBytes));
  const isValid = await schnorr.verifySignature(quoteHash.toBuffer(), operatorPubKey, signature);
  if (!isValid) {
    throw new Error(
      `${scenarioPrefix} quote signature failed Schnorr verification for quoted amount preimage`,
    );
  }
}

async function runServiceScenario(
  config: SmokeConfig,
  repoRoot: string,
  tmpDir: string,
  node: ReturnType<typeof createAztecNodeClient>,
  token: Contract,
  user: AztecAddress,
  feePayerAddress: AztecAddress,
  schnorr: Schnorr,
  operatorPubKey: SchnorrPoint,
  operatorSecretHex: string,
  operator: AztecAddress,
  l1PrivateKey: Hex,
  topupThreshold: bigint,
  topupAmount: bigint,
  quoteFjAmount: bigint,
): Promise<ServiceFlowResult> {
  const scenarioPrefix = "[services-smoke:fpc]";
  const managed: ManagedProcess[] = [];

  try {
    const attestationConfigPath = path.join(tmpDir, "attestation.fpc.config.yaml");
    const topupConfigPath = path.join(tmpDir, "topup.fpc.config.yaml");

    writeFileSync(
      attestationConfigPath,
      `${[
        `fpc_address: "${feePayerAddress.toString()}"`,
        `aztec_node_url: "${config.nodeUrl}"`,
        `quote_validity_seconds: ${config.quoteValiditySeconds}`,
        `port: ${config.attestationPort}`,
        `accepted_asset_name: "SmokeToken"`,
        `accepted_asset_address: "${token.address.toString()}"`,
        `operator_address: "${operator.toString()}"`,
        `market_rate_num: ${config.marketRateNum}`,
        `market_rate_den: ${config.marketRateDen}`,
        `fee_bips: ${config.feeBips}`,
        `quote_format: "amount_quote"`,
      ].join("\n")}\n`,
      "utf8",
    );

    writeFileSync(
      topupConfigPath,
      `${[
        `fpc_address: "${feePayerAddress.toString()}"`,
        `aztec_node_url: "${config.nodeUrl}"`,
        `l1_rpc_url: "${config.l1RpcUrl}"`,
        `threshold: "${topupThreshold}"`,
        `top_up_amount: "${topupAmount}"`,
        `ops_port: ${config.topupOpsPort}`,
        `check_interval_ms: ${config.topupCheckIntervalMs}`,
        `confirmation_timeout_ms: ${config.topupConfirmTimeoutMs}`,
        `confirmation_poll_initial_ms: ${config.topupConfirmPollInitialMs}`,
        `confirmation_poll_max_ms: ${config.topupConfirmPollMaxMs}`,
        // Isolate bridge state per run so stale state from a previous run does
        // not block reconciliation on a fresh local network.
        `bridge_state_path: "${path.join(tmpDir, "topup-bridge-state.json")}"`,
      ].join("\n")}\n`,
      "utf8",
    );

    const attestation = startManagedProcess(
      "attestation-fpc",
      "bun",
      [
        "run",
        path.join(repoRoot, "services", "attestation", "dist", "index.js"),
        "--config",
        attestationConfigPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPERATOR_SECRET_KEY: operatorSecretHex,
        },
      },
    );
    managed.push(attestation);

    const attestationBaseUrl = `http://127.0.0.1:${config.attestationPort}`;
    await waitForHealth(`${attestationBaseUrl}/health`, config.httpTimeoutMs);
    pinoLogger.info(`${scenarioPrefix} PASS: attestation service health endpoint`);
    const badQuoteResponse = await fetch(`${attestationBaseUrl}/quote`);
    if (badQuoteResponse.status !== 400) {
      throw new Error(
        `${scenarioPrefix} expected bad quote request to return 400, got ${badQuoteResponse.status}`,
      );
    }
    pinoLogger.info(`${scenarioPrefix} PASS: attestation bad quote request`);
    const asset = await fetchAsset(`${attestationBaseUrl}/asset`, config.httpTimeoutMs);
    if (asset.name !== "SmokeToken") {
      throw new Error(
        `${scenarioPrefix} asset name mismatch. expected=SmokeToken got=${asset.name}`,
      );
    }
    if (asset.address.toLowerCase() !== token.address.toString().toLowerCase()) {
      throw new Error(
        `${scenarioPrefix} asset address mismatch. expected=${token.address.toString()} got=${asset.address}`,
      );
    }
    pinoLogger.info(`${scenarioPrefix} PASS: asset endpoint matches deployed token`);

    const topup = startManagedProcess(
      "topup-fpc",
      "bun",
      [
        "run",
        path.join(repoRoot, "services", "topup", "dist", "index.js"),
        "--config",
        topupConfigPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          L1_OPERATOR_PRIVATE_KEY: l1PrivateKey,
          // Prevent host env from redirecting smoke top-ups to another address.
          TOPUP_FEE_JUICE_RECIPIENT_ADDRESS: feePayerAddress.toString(),
          // Keep smoke deterministic: use the already deployed local operator
          // account as auto-claim claimer, regardless of host env overrides.
          TOPUP_AUTOCLAIM_SECRET_KEY: operatorSecretHex,
        },
      },
    );
    managed.push(topup);
    const topupOpsBaseUrl = `http://127.0.0.1:${config.topupOpsPort}`;
    await waitForHealth(`${topupOpsBaseUrl}/health`, config.httpTimeoutMs);
    pinoLogger.info(`${scenarioPrefix} PASS: topup service health endpoint`);

    await waitForLog(topup, "Top-up service started", config.httpTimeoutMs);
    await waitForLog(topup, "Top-up target Fee Juice balance:", config.topupWaitTimeoutMs);
    await waitForHealth(`${topupOpsBaseUrl}/ready`, config.topupWaitTimeoutMs);
    pinoLogger.info(`${scenarioPrefix} PASS: topup service readiness endpoint`);
    const bridgeSubmission = await waitForTopupBridgeSubmission(topup, config.topupWaitTimeoutMs);

    const topupOutcome = await waitForTopupBridgeOutcome(topup, config.topupWaitTimeoutMs);
    pinoLogger.info(`${scenarioPrefix} topup_confirmation_outcome=${topupOutcome}`);

    const initialFeeJuiceBalance = await getFeeJuiceBalance(feePayerAddress, node);
    pinoLogger.info(
      `${scenarioPrefix} fee_payer_fee_juice_after_topup_service=${initialFeeJuiceBalance}`,
    );

    let bridgedFeeJuiceBalance = initialFeeJuiceBalance;
    if (bridgedFeeJuiceBalance === 0n) {
      const settleTimeoutMs = Math.max(1_000, Math.floor(config.topupWaitTimeoutMs / 2));
      pinoLogger.info(
        `${scenarioPrefix} topup balance still zero after outcome=${topupOutcome}; waiting ${settleTimeoutMs}ms for relay settlement`,
      );
      try {
        bridgedFeeJuiceBalance = await waitForPositiveFeeJuiceBalance(
          node,
          feePayerAddress,
          settleTimeoutMs,
          config.topupPollMs,
        );
      } catch (settleError) {
        throw new Error(
          `${scenarioPrefix} topup service did not auto-claim bridge submission message_hash=${bridgeSubmission.messageHash} leaf_index=${bridgeSubmission.messageLeafIndex} within ${settleTimeoutMs}ms after outcome=${topupOutcome}: ${(settleError as Error).message}`,
        );
      }
    }
    pinoLogger.info(`${scenarioPrefix} fee_payer_fee_juice_after_topup=${bridgedFeeJuiceBalance}`);

    const chainNowBeforeQuote = await getCurrentChainUnixSeconds(node);
    const quote = await fetchQuote(
      `${attestationBaseUrl}/quote?user=${user.toString()}&accepted_asset=${token.address.toString()}&fj_amount=${quoteFjAmount.toString()}`,
      config.httpTimeoutMs,
    );
    const chainNowAfterQuote = await getCurrentChainUnixSeconds(node);
    const quoteSigBytes = Array.from(Buffer.from(quote.signature.replace("0x", ""), "hex"));
    const fjAmount = BigInt(quote.fj_amount);
    const aaPaymentAmount = BigInt(quote.aa_payment_amount);
    const validUntil = BigInt(quote.valid_until);

    if (quoteSigBytes.length !== 64) {
      throw new Error(
        `${scenarioPrefix} quote signature length must be 64 bytes, got ${quoteSigBytes.length}`,
      );
    }
    if (fjAmount <= 0n) {
      throw new Error(`${scenarioPrefix} attestation quote returned non-positive fj_amount`);
    }
    if (aaPaymentAmount <= 0n) {
      throw new Error(
        `${scenarioPrefix} attestation quote returned non-positive aa_payment_amount`,
      );
    }
    if (quote.accepted_asset.toLowerCase() !== token.address.toString().toLowerCase()) {
      throw new Error(
        `${scenarioPrefix} quote accepted_asset mismatch. expected=${token.address.toString()} got=${quote.accepted_asset}`,
      );
    }

    const expectedRateNum = BigInt(config.marketRateNum) * BigInt(10_000 + config.feeBips);
    const expectedRateDen = BigInt(config.marketRateDen) * 10_000n;
    const expectedAaPaymentAmount = ceilDiv(fjAmount * expectedRateNum, expectedRateDen);
    if (aaPaymentAmount !== expectedAaPaymentAmount) {
      throw new Error(
        `${scenarioPrefix} quote payment mismatch. expected=${expectedAaPaymentAmount} got=${aaPaymentAmount}`,
      );
    }
    if (fjAmount !== quoteFjAmount) {
      throw new Error(
        `${scenarioPrefix} quote fj amount mismatch. expected=${quoteFjAmount} got=${fjAmount}`,
      );
    }
    await verifyAttestationAmountQuoteSignature(
      schnorr,
      operatorPubKey,
      feePayerAddress,
      token.address,
      user,
      fjAmount,
      aaPaymentAmount,
      validUntil,
      quoteSigBytes,
      scenarioPrefix,
    );
    pinoLogger.info(`${scenarioPrefix} PASS: quote signature verification`);

    const chainNowMin =
      chainNowBeforeQuote < chainNowAfterQuote ? chainNowBeforeQuote : chainNowAfterQuote;
    const chainNowMax =
      chainNowBeforeQuote > chainNowAfterQuote ? chainNowBeforeQuote : chainNowAfterQuote;
    const minExpectedValidUntil = chainNowMin + BigInt(config.quoteValiditySeconds);
    const maxExpectedValidUntil = chainNowMax + BigInt(config.quoteValiditySeconds) + 5n;
    if (validUntil < minExpectedValidUntil || validUntil > maxExpectedValidUntil) {
      throw new Error(
        `${scenarioPrefix} quote validity window mismatch. chain_now_before=${chainNowBeforeQuote} chain_now_after=${chainNowAfterQuote} valid_until=${validUntil} expected_range=[${minExpectedValidUntil}, ${maxExpectedValidUntil}]`,
      );
    }

    const attestationLogs = attestation.getLogs();
    if (!attestationLogs.includes("quote_issued")) {
      throw new Error(
        `${scenarioPrefix} attestation service logs did not include quote_issued marker`,
      );
    }
    const topupLogs = topup.getLogs();
    if (
      !topupLogs.includes("Top-up target Fee Juice balance:") &&
      !topupLogs.includes("FPC Fee Juice balance:")
    ) {
      throw new Error(
        `${scenarioPrefix} top-up service logs did not include Fee Juice balance read`,
      );
    }

    const attestationMetrics = await fetchMetrics(
      `${attestationBaseUrl}/metrics`,
      config.httpTimeoutMs,
    );
    const attestationSuccessCount = getPrometheusMetricValue(
      attestationMetrics,
      "attestation_quote_requests_total",
      { outcome: "success" },
    );
    if ((attestationSuccessCount ?? 0) < 1) {
      throw new Error(`${scenarioPrefix} attestation metrics missing non-zero success quote count`);
    }
    const attestationErrorCount = getPrometheusMetricValue(
      attestationMetrics,
      "attestation_quote_errors_total",
      { error_type: "bad_request" },
    );
    if ((attestationErrorCount ?? 0) < 1) {
      throw new Error(
        `${scenarioPrefix} attestation metrics missing non-zero bad_request error count`,
      );
    }
    const attestationLatencyCount = getPrometheusMetricValue(
      attestationMetrics,
      "attestation_quote_latency_seconds_count",
      { outcome: "success" },
    );
    if ((attestationLatencyCount ?? 0) < 1) {
      throw new Error(
        `${scenarioPrefix} attestation metrics missing non-zero success latency count`,
      );
    }
    const topupMetrics = await fetchMetrics(`${topupOpsBaseUrl}/metrics`, config.httpTimeoutMs);
    const topupSubmittedCount = getPrometheusMetricValue(
      topupMetrics,
      "topup_bridge_events_total",
      { event: "submitted" },
    );
    if ((topupSubmittedCount ?? 0) < 1) {
      throw new Error(`${scenarioPrefix} topup metrics missing non-zero submitted bridge count`);
    }
    const topupOutcomeCount = getPrometheusMetricValue(topupMetrics, "topup_bridge_events_total", {
      event: topupOutcome,
    });
    if ((topupOutcomeCount ?? 0) < 1) {
      throw new Error(
        `${scenarioPrefix} topup metrics missing non-zero ${topupOutcome} bridge count`,
      );
    }
    pinoLogger.info(`${scenarioPrefix} PASS: service metrics endpoints`);

    return {
      fjAmount,
      aaPaymentAmount,
      rateNum: expectedRateNum,
      rateDen: expectedRateDen,
      validUntil,
      quoteSigBytes,
    };
  } finally {
    for (const proc of managed.reverse()) {
      await stopManagedProcess(proc);
    }
  }
}

async function runFpcFeeEntrypointScenario(
  config: SmokeConfig,
  wallet: EmbeddedWallet,
  token: Contract,
  fpc: Contract,
  operator: AztecAddress,
  user: AztecAddress,
  maxGasCostNoTeardown: bigint,
  feePerDaGas: bigint,
  feePerL2Gas: bigint,
  quote: ServiceFlowResult,
): Promise<void> {
  const expectedCharge = quote.aaPaymentAmount;
  const quotedFjAmount = quote.fjAmount;
  if (quotedFjAmount !== maxGasCostNoTeardown) {
    throw new Error(
      `[services-smoke:fpc] quote fj amount mismatch. expected=${maxGasCostNoTeardown} got=${quotedFjAmount}`,
    );
  }
  const mintAmount = expectedCharge + 1_000_000n;
  pinoLogger.info(`[services-smoke:fpc] expected_charge=${expectedCharge}`);

  await token.methods.mint_to_private(user, mintAmount).send({ from: operator });
  await token.methods.mint_to_public(user, 2n).send({ from: operator });

  const transferAuthwitNonce = Fr.random();
  const transferCall = token.methods.transfer_private_to_private(
    user,
    operator,
    quote.aaPaymentAmount,
    transferAuthwitNonce,
  );
  const transferAuthwit = await wallet.createAuthWit(user, {
    caller: fpc.address,
    action: transferCall,
  });
  const transferValidity = await lookupValidity(
    wallet,
    user,
    { caller: fpc.address, action: transferCall },
    transferAuthwit,
  );
  pinoLogger.info(
    `[services-smoke:fpc] transfer_authwit_valid_private=${transferValidity.isValidInPrivate} transfer_authwit_valid_public=${transferValidity.isValidInPublic}`,
  );

  const userBefore = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );
  const operatorBefore = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

  const feeEntrypointCall = await fpc.methods
    .fee_entrypoint(
      token.address,
      transferAuthwitNonce,
      quote.fjAmount,
      quote.aaPaymentAmount,
      quote.validUntil,
      quote.quoteSigBytes,
    )
    .getFunctionCall();
  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], fpc.address),
    getFeePayer: async () => fpc.address,
    getGasSettings: () => undefined,
  };

  const receipt = await token.methods.transfer_public_to_public(user, user, 1n, Fr.random()).send({
    from: user,
    fee: {
      paymentMethod,
      gasSettings: {
        gasLimits: { daGas: config.daGasLimit, l2Gas: config.l2GasLimit },
        teardownGasLimits: { daGas: 0, l2Gas: 0 },
        maxFeesPerGas: { feePerDaGas, feePerL2Gas },
      },
    },
    wait: { timeout: 180 },
  });

  const userAfter = BigInt(
    (await token.methods.balance_of_private(user).simulate({ from: user })).toString(),
  );
  const operatorAfter = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

  const userDebited = userBefore - userAfter;
  const operatorCredited = operatorAfter - operatorBefore;
  if (userDebited !== expectedCharge) {
    throw new Error(
      `[services-smoke:fpc] user debit mismatch. expected=${expectedCharge} got=${userDebited}`,
    );
  }
  if (operatorCredited !== expectedCharge) {
    throw new Error(
      `[services-smoke:fpc] operator credit mismatch. expected=${expectedCharge} got=${operatorCredited}`,
    );
  }

  pinoLogger.info(
    `[services-smoke:fpc] tx_fee_juice=${receipt.transactionFee} user_debited=${userDebited} operator_credited=${operatorCredited}`,
  );
  pinoLogger.info("[services-smoke:fpc] PASS: tx accepted with attestation quote + fee_entrypoint");
}

async function main() {
  installManagedProcessSignalHandlers("services-smoke");
  const config = getConfig();
  const scriptDir =
    typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "fpc-services-smoke-"));

  try {
    const tokenArtifactPath = path.join(repoRoot, "target", "token_contract-Token.json");
    const fpcArtifactPath = resolveFpcArtifactPath(repoRoot);
    const tokenArtifact = loadArtifact(tokenArtifactPath);
    const fpcArtifact = loadArtifact(fpcArtifactPath);

    const node = createAztecNodeClient(config.nodeUrl);
    await waitForNodeReady(node, config.nodeTimeoutMs);
    const wallet = await EmbeddedWallet.create(node);

    const { accounts: testAccounts, l1PrivateKey } = await resolveScriptAccounts(
      config.nodeUrl,
      config.l1RpcUrl,
      wallet,
    );

    const minFees = await node.getCurrentMinFees();
    const feePerDaGas = minFees.feePerDaGas;
    const feePerL2Gas = minFees.feePerL2Gas;
    const maxGasCostNoTeardown =
      BigInt(config.daGasLimit) * feePerDaGas + BigInt(config.l2GasLimit) * feePerL2Gas;
    const minimumTopupWei =
      maxGasCostNoTeardown * config.feeJuiceTopupSafetyMultiplier + 1_000_000n;
    const configuredTopupWei = readOptionalEnvBigInt("FPC_SERVICES_SMOKE_TOPUP_WEI");
    const desiredTopupWei = configuredTopupWei ?? minimumTopupWei;

    if (configuredTopupWei !== null && configuredTopupWei < minimumTopupWei) {
      pinoLogger.warn(
        `[services-smoke] configured topup (${configuredTopupWei}) is below computed recommendation (${minimumTopupWei}); continuing with configured value`,
      );
    }

    let l1Balance = await getL1FeeJuiceBalance(node, config.l1RpcUrl, l1PrivateKey as Hex);
    if (l1Balance < desiredTopupWei) {
      const missingWei = desiredTopupWei - l1Balance;
      pinoLogger.warn(
        `[services-smoke] L1 FeeJuice balance (${l1Balance}) is below desired topup budget (${desiredTopupWei}); attempting local mint of ${missingWei}`,
      );
      const mintResult = await tryMintL1FeeJuice(
        node,
        config.l1RpcUrl,
        l1PrivateKey as Hex,
        missingWei,
      );
      l1Balance = mintResult.resultingBalance;
      if (mintResult.minted) {
        pinoLogger.info(
          `[services-smoke] minted additional L1 FeeJuice for smoke budget. new_balance=${l1Balance}`,
        );
      } else {
        pinoLogger.warn(
          `[services-smoke] could not mint additional L1 FeeJuice with the configured operator key. balance=${l1Balance}`,
        );
      }
    }
    pinoLogger.info(`[services-smoke] l1_operator_fee_juice_balance=${l1Balance}`);

    let topupAmount = desiredTopupWei;
    if (l1Balance < desiredTopupWei) {
      if (configuredTopupWei !== null) {
        throw new Error(
          `FPC_SERVICES_SMOKE_TOPUP_WEI=${configuredTopupWei} requires ${desiredTopupWei} L1 FeeJuice, but operator balance is ${l1Balance}`,
        );
      }
      topupAmount = l1Balance;
      if (topupAmount <= 0n) {
        throw new Error(`Insufficient L1 FeeJuice for smoke scenario. balance=${l1Balance}`);
      }
      pinoLogger.warn(
        `[services-smoke] auto-scaling topup amount to fit available L1 FeeJuice. scaled_topup_wei=${topupAmount} desired=${desiredTopupWei}`,
      );
    }

    const thresholdOverride = readOptionalEnvBigInt("FPC_SERVICES_SMOKE_THRESHOLD_WEI");
    const topupThreshold = thresholdOverride ?? topupAmount;
    if (topupThreshold <= 0n) {
      throw new Error("Top-up threshold must be greater than zero");
    }
    if (topupThreshold > topupAmount) {
      throw new Error(
        `Top-up threshold (${topupThreshold}) must be <= top-up amount (${topupAmount}) to prevent repeated bridge loops`,
      );
    }

    const operatorData = testAccounts.at(0);
    const userData = testAccounts.at(1);
    if (!operatorData || !userData) {
      throw new Error("Expected at least 2 initial test accounts");
    }

    const [operatorAccount, userAccount] = await Promise.all([
      wallet.createSchnorrAccount(operatorData.secret, operatorData.salt, operatorData.signingKey),
      wallet.createSchnorrAccount(userData.secret, userData.salt, userData.signingKey),
    ]);
    const operator = operatorAccount.address;
    const user = userAccount.address;

    pinoLogger.info(`[services-smoke] operator=${operator.toString()}`);
    pinoLogger.info(`[services-smoke] user=${user.toString()}`);

    const token = await deployContract(
      wallet,
      tokenArtifact,
      ["SmokeToken", "SMK", 18, operator, operator],
      { from: operator },
      "constructor_with_minter",
    );
    pinoLogger.info(`[services-smoke] token=${token.address.toString()}`);

    // Derive operator signing pubkey for inline Schnorr verification.
    const schnorr = new Schnorr();
    const operatorSigningKey = deriveSigningKey(testAccounts[0].secret);
    const operatorPubKey = await schnorr.computePublicKey(operatorSigningKey);

    const fpc = await deployContract(
      wallet,
      fpcArtifact,
      [operator, operatorPubKey.x, operatorPubKey.y, token.address],
      { from: operator },
    );
    pinoLogger.info(`[services-smoke] fpc=${fpc.address.toString()}`);

    pinoLogger.info(
      `[services-smoke] topup_threshold_wei=${topupThreshold} topup_amount_wei=${topupAmount}`,
    );

    const operatorSecretHex = operatorData.secret.toString();
    assertPrivateKeyHex(operatorSecretHex, "operator secret");
    const publishedOperator = await node.getContract(operator);
    if (!publishedOperator) {
      throw new Error(
        `[services-smoke] operator auto-claim claimer was not publicly deployed (${operator.toString()})`,
      );
    }
    pinoLogger.info(`[services-smoke] operator_account_publicly_deployed=${operator.toString()}`);

    const quote = await runServiceScenario(
      config,
      repoRoot,
      tmpDir,
      node,
      token,
      user,
      fpc.address,
      schnorr,
      operatorPubKey,
      operatorSecretHex,
      operator,
      l1PrivateKey as Hex,
      topupThreshold,
      topupAmount,
      maxGasCostNoTeardown,
    );
    await runFpcFeeEntrypointScenario(
      config,
      wallet,
      token,
      fpc,
      operator,
      user,
      maxGasCostNoTeardown,
      feePerDaGas,
      feePerL2Gas,
      quote,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

void (async () => {
  try {
    await main();
    pinoLogger.info("[services-smoke] PASS: full services smoke flow succeeded");
  } catch (error) {
    pinoLogger.error(`[services-smoke] FAIL: ${(error as Error).message}`);
    process.exit(1);
  }
})();
