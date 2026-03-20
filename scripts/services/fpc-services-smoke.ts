import { beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeInnerAuthWitHash } from "@aztec/aztec.js/authorization";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { Point } from "@aztec/foundation/curves/grumpkin";
import type { DevnetDeployManifest } from "@aztec-fpc/contract-deployment/src/devnet-manifest.ts";
import { sleep } from "../common/managed-process.ts";

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

type SmokeRuntimeResult = {
  config: SmokeConfig;
  node: AztecNode;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  operator: AztecAddress;
  operatorPubKey: Point;
  schnorr: Schnorr;
  quoteFjAmount: bigint;
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

async function waitForHealth(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health at ${url}. Last error: ${lastError}`);
}

async function waitForPositiveFeeJuiceBalance(
  node: AztecNode,
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

async function getCurrentChainUnixSeconds(node: AztecNode): Promise<bigint> {
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

async function verifyQuoteSignature(
  schnorr: Schnorr,
  operatorPubKey: Point,
  feePayerAddress: AztecAddress,
  tokenAddress: AztecAddress,
  user: AztecAddress,
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  quoteSigBytes: number[],
): Promise<boolean> {
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
  return schnorr.verifySignature(quoteHash.toBuffer(), operatorPubKey, signature);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setupFromConfig(config: SmokeConfig): Promise<SmokeRuntimeResult> {
  if (!existsSync(config.manifestPath)) {
    throw new Error(`Manifest not found: ${config.manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8")) as DevnetDeployManifest;

  const fpcAddress = AztecAddress.fromString(manifest.contracts.fpc);
  const tokenAddress = AztecAddress.fromString(manifest.contracts.accepted_asset);

  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);

  const operator = AztecAddress.fromString(manifest.operator.address);
  const operatorPubKey = new Point(
    Fr.fromHexString(manifest.operator.pubkey_x),
    Fr.fromHexString(manifest.operator.pubkey_y),
    false,
  );

  const fjTimeoutMs = config.messageTimeoutSeconds * 1_000;
  await waitForPositiveFeeJuiceBalance(node, fpcAddress, fjTimeoutMs, 2_000);

  const minFees = await node.getCurrentMinFees();
  const quoteFjAmount =
    BigInt(config.daGasLimit) * minFees.feePerDaGas +
    BigInt(config.l2GasLimit) * minFees.feePerL2Gas;

  const schnorr = new Schnorr();

  return {
    config,
    node,
    fpcAddress,
    tokenAddress,
    operator,
    operatorPubKey,
    schnorr,
    quoteFjAmount,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const E2E_TIMEOUT_MS = 300_000;
setDefaultTimeout(E2E_TIMEOUT_MS);

let ctx: SmokeRuntimeResult;

describe("fpc services smoke", () => {
  beforeAll(async () => {
    const config = getConfig();
    ctx = await setupFromConfig(config);
  });

  describe("attestation service", () => {
    it("health endpoint is reachable", async () => {
      const response = await waitForHealth(
        `${ctx.config.attestationBaseUrl}/health`,
        ctx.config.httpTimeoutMs,
      );
      const body = (await response.json()) as { status?: string };
      expect(body.status).toBe("ok");
    });

    it("rejects bad quote request with 400", async () => {
      const response = await fetch(`${ctx.config.attestationBaseUrl}/quote`);
      expect(response.status).toBe(400);
    });

    it("asset endpoint returns matching token address", async () => {
      const asset = await fetchAsset(
        `${ctx.config.attestationBaseUrl}/asset`,
        ctx.config.httpTimeoutMs,
      );
      expect(asset.name.trim().length).toBeGreaterThan(0);
      expect(asset.address.toLowerCase()).toBe(ctx.tokenAddress.toString().toLowerCase());
    });

    it("returns valid quote with correct signature", async () => {
      const chainNowBefore = await getCurrentChainUnixSeconds(ctx.node);
      const quote = await fetchQuote(
        `${ctx.config.attestationBaseUrl}/quote?user=${ctx.operator.toString()}&accepted_asset=${ctx.tokenAddress.toString()}&fj_amount=${ctx.quoteFjAmount.toString()}`,
        ctx.config.httpTimeoutMs,
      );
      const chainNowAfter = await getCurrentChainUnixSeconds(ctx.node);

      const quoteSigBytes = Array.from(Buffer.from(quote.signature.replace("0x", ""), "hex"));
      const fjAmount = BigInt(quote.fj_amount);
      const aaPaymentAmount = BigInt(quote.aa_payment_amount);
      const validUntil = BigInt(quote.valid_until);

      expect(quoteSigBytes).toHaveLength(64);
      expect(fjAmount).toBeGreaterThan(0n);
      expect(aaPaymentAmount).toBeGreaterThan(0n);
      expect(quote.accepted_asset.toLowerCase()).toBe(ctx.tokenAddress.toString().toLowerCase());
      expect(fjAmount).toBe(ctx.quoteFjAmount);

      const isValid = await verifyQuoteSignature(
        ctx.schnorr,
        ctx.operatorPubKey,
        ctx.fpcAddress,
        ctx.tokenAddress,
        ctx.operator,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        quoteSigBytes,
      );
      expect(isValid).toBe(true);

      // Verify valid_until is in the future and within the contract's max TTL (3600s).
      const chainNowMax = chainNowBefore > chainNowAfter ? chainNowBefore : chainNowAfter;
      expect(validUntil).toBeGreaterThan(chainNowMax);
      expect(validUntil).toBeLessThanOrEqual(chainNowMax + 3_610n);
    });

    it("exposes correct prometheus metrics", async () => {
      const metrics = await fetchMetrics(
        `${ctx.config.attestationBaseUrl}/metrics`,
        ctx.config.httpTimeoutMs,
      );

      const successCount = getPrometheusMetricValue(metrics, "attestation_quote_requests_total", {
        outcome: "success",
      });
      expect(successCount ?? 0).toBeGreaterThanOrEqual(1);

      const errorCount = getPrometheusMetricValue(metrics, "attestation_quote_errors_total", {
        error_type: "bad_request",
      });
      expect(errorCount ?? 0).toBeGreaterThanOrEqual(1);

      const latencyCount = getPrometheusMetricValue(
        metrics,
        "attestation_quote_latency_seconds_count",
        { outcome: "success" },
      );
      expect(latencyCount ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  describe("topup service", () => {
    it("health endpoint is reachable", async () => {
      await waitForHealth(`${ctx.config.topupOpsBaseUrl}/health`, ctx.config.httpTimeoutMs);
    });

    it("readiness endpoint is reachable", async () => {
      await waitForHealth(`${ctx.config.topupOpsBaseUrl}/ready`, ctx.config.httpTimeoutMs);
    });

    it("exposes correct prometheus metrics", async () => {
      const metrics = await fetchMetrics(
        `${ctx.config.topupOpsBaseUrl}/metrics`,
        ctx.config.httpTimeoutMs,
      );

      const submittedCount = getPrometheusMetricValue(metrics, "topup_bridge_events_total", {
        event: "submitted",
      });
      expect(submittedCount ?? 0).toBeGreaterThanOrEqual(1);
    });
  });
});
