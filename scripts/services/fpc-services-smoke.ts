import { existsSync, readFileSync } from "node:fs";
import pino from "pino";

const pinoLogger = pino();

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeInnerAuthWitHash } from "@aztec/aztec.js/authorization";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { Point } from "@aztec/foundation/curves/grumpkin";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SmokeConfig = {
  nodeUrl: string;
  attestationBaseUrl: string;
  topupOpsBaseUrl: string;
  manifestPath: string;
  httpTimeoutMs: number;
  messageTimeoutSeconds: number;
  daGasLimit: number;
  l2GasLimit: number;
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env var ${name}=${value}`);
  }
  return parsed;
}

function getConfig(): SmokeConfig {
  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    attestationBaseUrl: requireEnvOrThrow("FPC_ATTESTATION_URL").replace(/\/$/, ""),
    topupOpsBaseUrl: requireEnvOrThrow("FPC_TOPUP_OPS_URL").replace(/\/$/, ""),
    manifestPath: requireEnvOrThrow("FPC_COLD_START_MANIFEST"),
    httpTimeoutMs: readEnvNumber("FPC_SMOKE_HTTP_TIMEOUT_MS", 30_000),
    messageTimeoutSeconds: readEnvNumber("FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS", 120),
    daGasLimit: readEnvNumber("FPC_SMOKE_DA_GAS_LIMIT", 200_000),
    l2GasLimit: readEnvNumber("FPC_SMOKE_L2_GAS_LIMIT", 1_000_000),
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health at ${url}. Last error: ${lastError}`);
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

// ---------------------------------------------------------------------------
// HTTP fetch helpers (with retry)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prometheus metrics parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schnorr signature verification
// ---------------------------------------------------------------------------

async function verifyAttestationAmountQuoteSignature(
  schnorr: Schnorr,
  operatorPubKey: Point,
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

// ---------------------------------------------------------------------------
// Service scenario: attestation + topup HTTP endpoint tests
// ---------------------------------------------------------------------------

async function runServiceScenario(
  config: SmokeConfig,
  node: ReturnType<typeof createAztecNodeClient>,
  tokenAddress: AztecAddress,
  fpcAddress: AztecAddress,
  schnorr: Schnorr,
  operatorPubKey: Point,
  user: AztecAddress,
  quoteFjAmount: bigint,
): Promise<void> {
  const scenarioPrefix = "[services-smoke:fpc]";
  const { attestationBaseUrl, topupOpsBaseUrl, httpTimeoutMs } = config;

  // -- Attestation: health --
  await waitForHealth(`${attestationBaseUrl}/health`, httpTimeoutMs);
  pinoLogger.info(`${scenarioPrefix} PASS: attestation service health endpoint`);

  // -- Attestation: bad quote request → 400 --
  const badQuoteResponse = await fetch(`${attestationBaseUrl}/quote`);
  if (badQuoteResponse.status !== 400) {
    throw new Error(
      `${scenarioPrefix} expected bad quote request to return 400, got ${badQuoteResponse.status}`,
    );
  }
  pinoLogger.info(`${scenarioPrefix} PASS: attestation bad quote request`);

  // -- Attestation: asset endpoint --
  const asset = await fetchAsset(`${attestationBaseUrl}/asset`, httpTimeoutMs);
  if (!asset.name || asset.name.trim().length === 0) {
    throw new Error(`${scenarioPrefix} asset name is empty`);
  }
  if (asset.address.toLowerCase() !== tokenAddress.toString().toLowerCase()) {
    throw new Error(
      `${scenarioPrefix} asset address mismatch. expected=${tokenAddress.toString()} got=${asset.address}`,
    );
  }
  pinoLogger.info(
    `${scenarioPrefix} PASS: asset endpoint matches deployed token (name=${asset.name})`,
  );

  // -- Attestation: valid quote with signature verification --
  const chainNowBeforeQuote = await getCurrentChainUnixSeconds(node);
  const quote = await fetchQuote(
    `${attestationBaseUrl}/quote?user=${user.toString()}&accepted_asset=${tokenAddress.toString()}&fj_amount=${quoteFjAmount.toString()}`,
    httpTimeoutMs,
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
    throw new Error(`${scenarioPrefix} attestation quote returned non-positive aa_payment_amount`);
  }
  if (quote.accepted_asset.toLowerCase() !== tokenAddress.toString().toLowerCase()) {
    throw new Error(
      `${scenarioPrefix} quote accepted_asset mismatch. expected=${tokenAddress.toString()} got=${quote.accepted_asset}`,
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
    fpcAddress,
    tokenAddress,
    user,
    fjAmount,
    aaPaymentAmount,
    validUntil,
    quoteSigBytes,
    scenarioPrefix,
  );
  pinoLogger.info(`${scenarioPrefix} PASS: quote signature verification`);

  // -- Attestation: validity window --
  // Verify valid_until is in the future and not unreasonably far out (< 24h).
  // We no longer control the attestation config, so we cannot assert the exact
  // quote_validity_seconds — the Schnorr signature already covers valid_until.
  const chainNowMax =
    chainNowBeforeQuote > chainNowAfterQuote ? chainNowBeforeQuote : chainNowAfterQuote;
  const maxReasonableValidUntil = chainNowMax + 86_400n;
  if (validUntil <= chainNowMax) {
    throw new Error(
      `${scenarioPrefix} quote valid_until is not in the future. chain_now=${chainNowMax} valid_until=${validUntil}`,
    );
  }
  if (validUntil > maxReasonableValidUntil) {
    throw new Error(
      `${scenarioPrefix} quote valid_until is unreasonably far in the future. chain_now=${chainNowMax} valid_until=${validUntil} max=${maxReasonableValidUntil}`,
    );
  }

  // -- Attestation: metrics --
  const attestationMetrics = await fetchMetrics(`${attestationBaseUrl}/metrics`, httpTimeoutMs);
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
    throw new Error(`${scenarioPrefix} attestation metrics missing non-zero success latency count`);
  }
  pinoLogger.info(`${scenarioPrefix} PASS: attestation metrics`);

  // -- Topup: health --
  await waitForHealth(`${topupOpsBaseUrl}/health`, httpTimeoutMs);
  pinoLogger.info(`${scenarioPrefix} PASS: topup service health endpoint`);

  // -- Topup: ready --
  await waitForHealth(`${topupOpsBaseUrl}/ready`, httpTimeoutMs);
  pinoLogger.info(`${scenarioPrefix} PASS: topup service readiness endpoint`);

  // -- Topup: metrics --
  const topupMetrics = await fetchMetrics(`${topupOpsBaseUrl}/metrics`, httpTimeoutMs);
  const topupSubmittedCount = getPrometheusMetricValue(topupMetrics, "topup_bridge_events_total", {
    event: "submitted",
  });
  if ((topupSubmittedCount ?? 0) < 1) {
    throw new Error(`${scenarioPrefix} topup metrics missing non-zero submitted bridge count`);
  }
  pinoLogger.info(`${scenarioPrefix} PASS: topup service metrics`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = getConfig();

  pinoLogger.info("[services-smoke] starting");
  pinoLogger.info(`[services-smoke] node_url=${config.nodeUrl}`);
  pinoLogger.info(`[services-smoke] attestation_url=${config.attestationBaseUrl}`);
  pinoLogger.info(`[services-smoke] topup_ops_url=${config.topupOpsBaseUrl}`);
  pinoLogger.info(`[services-smoke] manifest=${config.manifestPath}`);

  // 1. Read manifest
  if (!existsSync(config.manifestPath)) {
    throw new Error(`Manifest not found: ${config.manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8")) as DevnetDeployManifest;

  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);

  pinoLogger.info(
    `[services-smoke] manifest loaded. fpc=${manifest.contracts.fpc} token=${manifest.contracts.accepted_asset}`,
  );

  // 2. Connect to node
  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);

  // 3. Read operator address and pubkey from manifest
  const operator = AztecAddress.fromString(manifest.operator.address);
  const operatorPubKey = new Point(
    Fr.fromHexString(manifest.operator.pubkey_x),
    Fr.fromHexString(manifest.operator.pubkey_y),
    false,
  );
  pinoLogger.info(`[services-smoke] operator=${operator.toString()}`);

  // 4. Wait for FPC FeeJuice balance > 0 (proves topup service has bridged)
  pinoLogger.info("[services-smoke] waiting for FPC FeeJuice balance > 0 (via topup service)");
  const fjTimeoutMs = config.messageTimeoutSeconds * 1_000;
  const fjBalance = await waitForPositiveFeeJuiceBalance(node, fpcAddress, fjTimeoutMs, 2_000);
  pinoLogger.info(`[services-smoke] FPC FeeJuice balance=${fjBalance}`);

  // 5. Compute gas cost for quote request
  const minFees = await node.getCurrentMinFees();
  const maxGasCostNoTeardown =
    BigInt(config.daGasLimit) * minFees.feePerDaGas +
    BigInt(config.l2GasLimit) * minFees.feePerL2Gas;

  // 6. Run service HTTP endpoint tests
  const schnorr = new Schnorr();
  await runServiceScenario(
    config,
    node,
    tokenAddress,
    fpcAddress,
    schnorr,
    operatorPubKey,
    operator,
    maxGasCostNoTeardown,
  );
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
