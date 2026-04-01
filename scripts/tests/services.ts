import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeInnerAuthWitHash } from "@aztec/aztec.js/authorization";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecNode, createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { Schnorr, SchnorrSignature } from "@aztec/foundation/crypto/schnorr";
import { Point } from "@aztec/foundation/curves/grumpkin";
import { readTestTokenManifest } from "@nethermindeth/aztec-fpc-contract-deployment/src/test-token-manifest.ts";
import { beforeAll, describe, expect, it } from "#test";
import { readManifest, waitForFpcFeeJuice } from "../common/setup-helpers.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
const COLD_START_QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x46504373");
const U128_MAX = 2n ** 128n - 1n;
const SENTINEL_USER = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SENTINEL_FJ_AMOUNT = "1000000";
const SENTINEL_CLAIM_AMOUNT = "100000000000000000";
const SENTINEL_CLAIM_SECRET_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000abcdef";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SmokeConfig = {
  nodeUrl: string;
  attestationBaseUrl: string;
  topupOpsBaseUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  httpTimeoutMs: number;
  messageTimeoutSeconds: number;
  daGasLimit: number;
  l2GasLimit: number;
  quoteAuthApiKey: string | null;
  quoteAuthHeader: string | null;
  quoteAuthValue: string | null;
};

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

type ColdStartQuoteResponse = QuoteResponse & {
  claim_amount: string;
  claim_secret_hash: string;
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

function readEnvString(name: string): string | null {
  const value = process.env[name];
  if (!value || value.trim() === "") return null;
  return value.trim();
}

function getConfig(): SmokeConfig {
  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    attestationBaseUrl: requireEnvOrThrow("FPC_ATTESTATION_URL").replace(/\/$/, ""),
    topupOpsBaseUrl: requireEnvOrThrow("FPC_TOPUP_OPS_URL").replace(/\/$/, ""),
    manifestPath: requireEnvOrThrow("FPC_COLD_START_MANIFEST"),
    testTokenManifestPath: requireEnvOrThrow("FPC_TEST_TOKEN_MANIFEST"),
    httpTimeoutMs: readEnvNumber("FPC_SMOKE_HTTP_TIMEOUT_MS", 30_000),
    messageTimeoutSeconds: readEnvNumber("FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS", 120),
    daGasLimit: readEnvNumber("FPC_SMOKE_DA_GAS_LIMIT", 200_000),
    l2GasLimit: readEnvNumber("FPC_SMOKE_L2_GAS_LIMIT", 1_000_000),
    quoteAuthApiKey: readEnvString("FPC_QUOTE_AUTH_API_KEY"),
    quoteAuthHeader: readEnvString("FPC_QUOTE_AUTH_HEADER"),
    quoteAuthValue: readEnvString("FPC_QUOTE_AUTH_VALUE"),
  };
}

function hasQuoteAuth(config: SmokeConfig): boolean {
  return !!(config.quoteAuthApiKey || (config.quoteAuthHeader && config.quoteAuthValue));
}

function buildAuthHeaders(config: SmokeConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.quoteAuthApiKey) {
    const headerName = config.quoteAuthHeader ?? "x-api-key";
    headers[headerName] = config.quoteAuthApiKey;
  } else if (config.quoteAuthHeader && config.quoteAuthValue) {
    headers[config.quoteAuthHeader] = config.quoteAuthValue;
  }
  return headers;
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

async function fetchQuote(
  quoteUrl: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<QuoteResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(quoteUrl, headers ? { headers } : undefined);
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

async function fetchColdStartQuote(
  quoteUrl: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<ColdStartQuoteResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(quoteUrl, headers ? { headers } : undefined);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        const parsed = JSON.parse(bodyText) as ColdStartQuoteResponse;
        if (
          typeof parsed.accepted_asset === "string" &&
          typeof parsed.fj_amount === "string" &&
          typeof parsed.aa_payment_amount === "string" &&
          typeof parsed.valid_until === "string" &&
          typeof parsed.signature === "string" &&
          typeof parsed.claim_amount === "string" &&
          typeof parsed.claim_secret_hash === "string"
        ) {
          return parsed;
        }
        lastError = `Invalid cold-start quote payload: ${bodyText}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(500);
  }

  throw new Error(`Timed out requesting cold-start quote. Last error: ${lastError}`);
}

async function fetchAcceptedAssets(url: string, timeoutMs: number): Promise<AssetResponse[]> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${bodyText}`;
      } else {
        const parsed = JSON.parse(bodyText) as AssetResponse[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
        lastError = `Invalid accepted-assets payload: ${bodyText}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    await sleep(500);
  }

  throw new Error(`Timed out requesting accepted-assets. Last error: ${lastError}`);
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

async function verifyColdStartQuoteSignature(
  schnorr: Schnorr,
  operatorPubKey: Point,
  feePayerAddress: AztecAddress,
  tokenAddress: AztecAddress,
  user: AztecAddress,
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  claimAmount: bigint,
  claimSecretHash: Fr,
  quoteSigBytes: number[],
): Promise<boolean> {
  const quoteHash = await computeInnerAuthWitHash([
    COLD_START_QUOTE_DOMAIN_SEPARATOR,
    feePayerAddress.toField(),
    tokenAddress.toField(),
    new Fr(fjAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    user.toField(),
    new Fr(claimAmount),
    claimSecretHash,
  ]);
  const signature = SchnorrSignature.fromBuffer(Buffer.from(quoteSigBytes));
  return schnorr.verifySignature(quoteHash.toBuffer(), operatorPubKey, signature);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setupFromConfig(config: SmokeConfig): Promise<SmokeRuntimeResult> {
  const manifest = readManifest(config.manifestPath);
  const testTokenManifest = readTestTokenManifest(config.testTokenManifestPath);

  const fpcAddress = manifest.contracts.fpc;
  const tokenAddress = testTokenManifest.contracts.token;

  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);

  const operator = manifest.operator.address;
  const operatorPubKey = new Point(manifest.operator.pubkey_x, manifest.operator.pubkey_y, false);

  await waitForFpcFeeJuice(fpcAddress, node, config.messageTimeoutSeconds, "fpc-services-smoke");

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

    it("accepted-assets endpoint includes configured token", async () => {
      const assets = await fetchAcceptedAssets(
        `${ctx.config.attestationBaseUrl}/accepted-assets`,
        ctx.config.httpTimeoutMs,
      );
      const match = assets.find(
        (a) => a.address.toLowerCase() === ctx.tokenAddress.toString().toLowerCase(),
      );
      expect(match).toBeDefined();
      expect(match?.name.trim().length).toBeGreaterThan(0);
    });

    it("returns valid quote with correct signature", async () => {
      const chainNowBefore = await getCurrentChainUnixSeconds(ctx.node);
      const authHeaders = buildAuthHeaders(ctx.config);
      const quote = await fetchQuote(
        `${ctx.config.attestationBaseUrl}/quote?user=${ctx.operator.toString()}&accepted_asset=${ctx.tokenAddress.toString()}&fj_amount=${ctx.quoteFjAmount.toString()}`,
        ctx.config.httpTimeoutMs,
        authHeaders,
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

    describe("quote input validation", () => {
      function quoteUrl(params: Record<string, string>): string {
        const qs = new URLSearchParams(params).toString();
        return `${ctx.config.attestationBaseUrl}/quote?${qs}`;
      }

      function baseParams(): Record<string, string> {
        return {
          user: SENTINEL_USER,
          fj_amount: SENTINEL_FJ_AMOUNT,
          accepted_asset: ctx.tokenAddress.toString(),
        };
      }

      it("rejects missing user param", async () => {
        const params = baseParams();
        delete params.user;
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects missing fj_amount param", async () => {
        const params = baseParams();
        delete params.fj_amount;
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects fj_amount=0", async () => {
        const params = baseParams();
        params.fj_amount = "0";
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects negative fj_amount", async () => {
        const params = baseParams();
        params.fj_amount = "-1";
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects non-numeric fj_amount", async () => {
        const params = baseParams();
        params.fj_amount = "notanumber";
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects fj_amount exceeding u128 max", async () => {
        const params = baseParams();
        params.fj_amount = (U128_MAX + 1n).toString();
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects malformed user address", async () => {
        const params = baseParams();
        params.user = "not_an_address";
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects SQL injection in user param", async () => {
        const params = baseParams();
        params.user = "' OR '1'='1";
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("does not return 5xx for u128_max fj_amount", async () => {
        const params = baseParams();
        params.fj_amount = U128_MAX.toString();
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeLessThan(500);
      });

      it("rejects zero user address", async () => {
        const params = baseParams();
        params.user = "0x0000000000000000000000000000000000000000000000000000000000000000";
        const response = await fetch(quoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });
    });

    describe("quote concurrency", () => {
      it("20 concurrent requests return no 5xx and consistent quotes", async () => {
        const url = `${ctx.config.attestationBaseUrl}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${ctx.tokenAddress.toString()}`;
        const authHeaders = buildAuthHeaders(ctx.config);
        const fetchOpts =
          Object.keys(authHeaders).length > 0 ? { headers: authHeaders } : undefined;
        const requests = Array.from({ length: 20 }, () =>
          fetch(url, fetchOpts).then(async (r) => ({
            status: r.status,
            body: await r.text(),
          })),
        );
        const results = await Promise.all(requests);

        for (const r of results) {
          expect(r.status).toBeLessThan(500);
        }

        const successes = results.filter((r) => r.status >= 200 && r.status < 400);
        if (successes.length > 1) {
          const parsed = successes.map((r) => JSON.parse(r.body) as QuoteResponse);
          const fjAmounts = new Set(parsed.map((q) => q.fj_amount));
          const assets = new Set(parsed.map((q) => q.accepted_asset));
          expect(fjAmounts.size).toBe(1);
          expect(assets.size).toBe(1);
        }
      });
    });
  });

  describe.skipIf(!hasQuoteAuth(getConfig()))("quote auth", () => {
    function quoteUrlWithDefaults(): string {
      return `${ctx.config.attestationBaseUrl}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${ctx.tokenAddress.toString()}`;
    }

    it("rejects request without auth header with 401", async () => {
      const response = await fetch(quoteUrlWithDefaults());
      expect(response.status).toBe(401);
    });

    it("rejects request with wrong auth key with 401", async () => {
      const wrongHeaders: Record<string, string> = {};
      if (ctx.config.quoteAuthApiKey) {
        wrongHeaders[ctx.config.quoteAuthHeader ?? "x-api-key"] = "WRONG_KEY_FOR_TEST";
      } else if (ctx.config.quoteAuthHeader) {
        wrongHeaders[ctx.config.quoteAuthHeader] = "WRONG_VALUE_FOR_TEST";
      }
      const response = await fetch(quoteUrlWithDefaults(), { headers: wrongHeaders });
      expect(response.status).toBe(401);
    });

    it("accepts request with correct auth key", async () => {
      const response = await fetch(quoteUrlWithDefaults(), {
        headers: buildAuthHeaders(ctx.config),
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
    });
  });

  describe("cold-start quote", () => {
    function coldStartQuoteUrl(params: Record<string, string>): string {
      const qs = new URLSearchParams(params).toString();
      return `${ctx.config.attestationBaseUrl}/cold-start-quote?${qs}`;
    }

    function coldStartBaseParams(): Record<string, string> {
      return {
        user: SENTINEL_USER,
        fj_amount: SENTINEL_FJ_AMOUNT,
        accepted_asset: ctx.tokenAddress.toString(),
        claim_amount: SENTINEL_CLAIM_AMOUNT,
        claim_secret_hash: SENTINEL_CLAIM_SECRET_HASH,
      };
    }

    it("rejects bare /cold-start-quote request with 400", async () => {
      const response = await fetch(`${ctx.config.attestationBaseUrl}/cold-start-quote`);
      expect(response.status).toBe(400);
    });

    it("returns valid cold-start quote with correct signature", async () => {
      const chainNowBefore = await getCurrentChainUnixSeconds(ctx.node);
      const authHeaders = buildAuthHeaders(ctx.config);
      const quote = await fetchColdStartQuote(
        coldStartQuoteUrl({
          user: ctx.operator.toString(),
          accepted_asset: ctx.tokenAddress.toString(),
          fj_amount: ctx.quoteFjAmount.toString(),
          claim_amount: SENTINEL_CLAIM_AMOUNT,
          claim_secret_hash: SENTINEL_CLAIM_SECRET_HASH,
        }),
        ctx.config.httpTimeoutMs,
        authHeaders,
      );
      const chainNowAfter = await getCurrentChainUnixSeconds(ctx.node);

      const quoteSigBytes = Array.from(Buffer.from(quote.signature.replace("0x", ""), "hex"));
      const fjAmount = BigInt(quote.fj_amount);
      const aaPaymentAmount = BigInt(quote.aa_payment_amount);
      const validUntil = BigInt(quote.valid_until);
      const claimAmount = BigInt(quote.claim_amount);

      // Verify all 7 response fields are present and valid.
      expect(quoteSigBytes).toHaveLength(64);
      expect(fjAmount).toBeGreaterThan(0n);
      expect(aaPaymentAmount).toBeGreaterThan(0n);
      expect(quote.accepted_asset.toLowerCase()).toBe(ctx.tokenAddress.toString().toLowerCase());
      expect(fjAmount).toBe(ctx.quoteFjAmount);
      expect(claimAmount).toBe(BigInt(SENTINEL_CLAIM_AMOUNT));
      expect(quote.claim_secret_hash).toBeDefined();

      // Verify cold-start quote signature with the 9-field preimage.
      const isValid = await verifyColdStartQuoteSignature(
        ctx.schnorr,
        ctx.operatorPubKey,
        ctx.fpcAddress,
        ctx.tokenAddress,
        ctx.operator,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        claimAmount,
        Fr.fromHexString(quote.claim_secret_hash),
        quoteSigBytes,
      );
      expect(isValid).toBe(true);

      // Verify valid_until is in the future and within the contract's max TTL (3600s).
      const chainNowMax = chainNowBefore > chainNowAfter ? chainNowBefore : chainNowAfter;
      expect(validUntil).toBeGreaterThan(chainNowMax);
      expect(validUntil).toBeLessThanOrEqual(chainNowMax + 3_610n);
    });

    it("cold-start quote signature fails verification with regular quote domain separator", async () => {
      const authHeaders = buildAuthHeaders(ctx.config);
      const quote = await fetchColdStartQuote(
        coldStartQuoteUrl({
          user: ctx.operator.toString(),
          accepted_asset: ctx.tokenAddress.toString(),
          fj_amount: ctx.quoteFjAmount.toString(),
          claim_amount: SENTINEL_CLAIM_AMOUNT,
          claim_secret_hash: SENTINEL_CLAIM_SECRET_HASH,
        }),
        ctx.config.httpTimeoutMs,
        authHeaders,
      );

      const quoteSigBytes = Array.from(Buffer.from(quote.signature.replace("0x", ""), "hex"));
      const fjAmount = BigInt(quote.fj_amount);
      const aaPaymentAmount = BigInt(quote.aa_payment_amount);
      const validUntil = BigInt(quote.valid_until);

      // Attempt to verify using the regular (non-cold-start) verifier -- should fail.
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
      expect(isValid).toBe(false);
    });

    describe("cold-start quote input validation", () => {
      it("rejects missing claim_amount", async () => {
        const params = coldStartBaseParams();
        delete params.claim_amount;
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects claim_amount=0", async () => {
        const params = coldStartBaseParams();
        params.claim_amount = "0";
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects negative claim_amount", async () => {
        const params = coldStartBaseParams();
        params.claim_amount = "-1";
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects non-numeric claim_amount", async () => {
        const params = coldStartBaseParams();
        params.claim_amount = "notanumber";
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects missing claim_secret_hash", async () => {
        const params = coldStartBaseParams();
        delete params.claim_secret_hash;
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects invalid hex claim_secret_hash", async () => {
        const params = coldStartBaseParams();
        params.claim_secret_hash = "not_valid_hex";
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects claim_amount smaller than fee", async () => {
        // Use a very small claim_amount that will be less than the computed aa_payment_amount.
        const params = coldStartBaseParams();
        params.fj_amount = ctx.quoteFjAmount.toString();
        params.claim_amount = "1";
        const authHeaders = buildAuthHeaders(ctx.config);
        const response = await fetch(coldStartQuoteUrl(params), {
          headers: authHeaders,
        });
        expect(response.status).toBe(400);
        const body = await response.text();
        expect(body).toContain("claim_amount must be >= aa_payment_amount");
      });

      it("rejects missing user param", async () => {
        const params = coldStartBaseParams();
        delete params.user;
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects missing fj_amount param", async () => {
        const params = coldStartBaseParams();
        delete params.fj_amount;
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });

      it("rejects fj_amount=0", async () => {
        const params = coldStartBaseParams();
        params.fj_amount = "0";
        const response = await fetch(coldStartQuoteUrl(params));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      });
    });
  });

  describe.skipIf(!hasQuoteAuth(getConfig()))("cold-start quote auth", () => {
    function coldStartQuoteUrlWithDefaults(): string {
      return coldStartQuoteUrl({
        user: SENTINEL_USER,
        fj_amount: SENTINEL_FJ_AMOUNT,
        accepted_asset: ctx.tokenAddress.toString(),
        claim_amount: SENTINEL_CLAIM_AMOUNT,
        claim_secret_hash: SENTINEL_CLAIM_SECRET_HASH,
      });
    }

    function coldStartQuoteUrl(params: Record<string, string>): string {
      const qs = new URLSearchParams(params).toString();
      return `${ctx.config.attestationBaseUrl}/cold-start-quote?${qs}`;
    }

    it("rejects request without auth header with 401", async () => {
      const response = await fetch(coldStartQuoteUrlWithDefaults());
      expect(response.status).toBe(401);
    });

    it("rejects request with wrong auth key with 401", async () => {
      const wrongHeaders: Record<string, string> = {};
      if (ctx.config.quoteAuthApiKey) {
        wrongHeaders[ctx.config.quoteAuthHeader ?? "x-api-key"] = "WRONG_KEY_FOR_TEST";
      } else if (ctx.config.quoteAuthHeader) {
        wrongHeaders[ctx.config.quoteAuthHeader] = "WRONG_VALUE_FOR_TEST";
      }
      const response = await fetch(coldStartQuoteUrlWithDefaults(), { headers: wrongHeaders });
      expect(response.status).toBe(401);
    });

    it("accepts request with correct auth key", async () => {
      const response = await fetch(coldStartQuoteUrlWithDefaults(), {
        headers: buildAuthHeaders(ctx.config),
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
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
