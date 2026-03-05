import { createHash, timingSafeEqual } from "node:crypto";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import Fastify from "fastify";
import type { Config } from "./config.js";
import { computeFinalRate, resolveSelectedAssetPolicy } from "./config.js";
import { AttestationMetrics, type QuoteOutcome } from "./metrics.js";
import type { QuoteSchnorrSigner } from "./signer.js";
import { signQuote, signRateQuote } from "./signer.js";

function badRequest(message: string) {
  return { error: { code: "BAD_REQUEST", message } };
}

function unauthorized() {
  return { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
}

function rateLimited() {
  return {
    error: { code: "RATE_LIMITED", message: "Too many quote requests" },
  };
}

const DISCOVERY_VERSION = "1.0";
const ATTESTATION_API_VERSION = "1.0";
const U128_MAX = (1n << 128n) - 1n;

function isU128(value: bigint): boolean {
  return value >= 0n && value <= U128_MAX;
}

function parsePositiveU128Decimal(value: string | undefined): bigint | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  // Keep parsing bounded and aligned with the on-chain u128 type.
  if (trimmed.length > 39) {
    return undefined;
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n || !isU128(parsed)) {
    return undefined;
  }
  return parsed;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function headerMatchesSecret(
  candidateValue: string | string[] | undefined,
  expectedValue: string | undefined,
): boolean {
  if (!expectedValue || typeof candidateValue !== "string") {
    return false;
  }

  const expectedDigest = createHash("sha256").update(expectedValue, "utf8").digest();
  const candidateDigest = createHash("sha256").update(candidateValue, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function isQuoteAuthorized(
  config: Config,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const mode = config.quote_auth.mode;
  if (mode === "disabled") {
    return true;
  }

  const apiKeyAuthorized = headerMatchesSecret(
    headers[config.quote_auth.apiKeyHeader],
    config.quote_auth.apiKey,
  );
  const trustedHeaderAuthorized = headerMatchesSecret(
    config.quote_auth.trustedHeaderName ? headers[config.quote_auth.trustedHeaderName] : undefined,
    config.quote_auth.trustedHeaderValue,
  );

  switch (mode) {
    case "api_key":
      return apiKeyAuthorized;
    case "trusted_header":
      return trustedHeaderAuthorized;
    case "api_key_or_trusted_header":
      return apiKeyAuthorized || trustedHeaderAuthorized;
    case "api_key_and_trusted_header":
      return apiKeyAuthorized && trustedHeaderAuthorized;
    default:
      return false;
  }
}

function modeUsesApiKey(mode: Config["quote_auth"]["mode"]): boolean {
  return (
    mode === "api_key" ||
    mode === "api_key_or_trusted_header" ||
    mode === "api_key_and_trusted_header"
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function firstCommaSeparatedValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const first = value.split(",", 1)[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function resolveQuoteBaseUrl(
  config: Config,
  headers: Record<string, string | string[] | undefined>,
  fallbackProtocol: string,
): string {
  if (config.quote_base_url) {
    return trimTrailingSlashes(config.quote_base_url);
  }

  const forwardedProto = firstCommaSeparatedValue(firstHeaderValue(headers["x-forwarded-proto"]));
  const protocol = forwardedProto ?? fallbackProtocol ?? "http";
  const host =
    firstCommaSeparatedValue(firstHeaderValue(headers["x-forwarded-host"])) ??
    firstHeaderValue(headers.host);
  if (!host) {
    return `http://127.0.0.1:${config.port}`;
  }

  return `${protocol}://${host}`;
}

interface QuoteRateLimitIdentity {
  cacheKey: string;
  kind: "ip" | "api_key";
}

function resolveQuoteRateLimitIdentity(
  config: Config,
  headers: Record<string, string | string[] | undefined>,
  remoteIp: string,
): QuoteRateLimitIdentity {
  if (modeUsesApiKey(config.quote_auth.mode)) {
    const apiKeyCandidate = firstHeaderValue(headers[config.quote_auth.apiKeyHeader]);
    if (apiKeyCandidate && headerMatchesSecret(apiKeyCandidate, config.quote_auth.apiKey)) {
      const apiKeyDigest = createHash("sha256").update(apiKeyCandidate, "utf8").digest("hex");
      return { cacheKey: `api_key:${apiKeyDigest}`, kind: "api_key" };
    }
  }

  return { cacheKey: `ip:${remoteIp}`, kind: "ip" };
}

interface RateLimitState {
  windowStart: bigint;
  count: number;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: bigint;
}

class FixedWindowRateLimiter {
  private readonly state = new Map<string, RateLimitState>();
  private readonly windowSeconds: bigint;

  constructor(
    private readonly maxRequests: number,
    windowSeconds: number,
    private readonly maxTrackedKeys: number,
  ) {
    this.windowSeconds = BigInt(windowSeconds);
  }

  consume(identity: string, nowSeconds: bigint): RateLimitDecision {
    const windowStart = nowSeconds - (nowSeconds % this.windowSeconds);
    let bucket = this.state.get(identity);

    if (!bucket || bucket.windowStart !== windowStart) {
      if (!bucket) {
        this.ensureCapacity(windowStart);
      }
      bucket = { windowStart, count: 0 };
      this.state.set(identity, bucket);
    }

    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: windowStart + this.windowSeconds - nowSeconds,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: 0n,
    };
  }

  private ensureCapacity(currentWindowStart: bigint): void {
    if (this.state.size < this.maxTrackedKeys) {
      return;
    }

    for (const [key, value] of this.state.entries()) {
      if (value.windowStart < currentWindowStart) {
        this.state.delete(key);
      }
    }

    if (this.state.size < this.maxTrackedKeys) {
      return;
    }

    const oldestKey = this.state.keys().next().value;
    if (oldestKey) {
      this.state.delete(oldestKey);
    }
  }
}

interface QuoteRequestQuery {
  user?: string;
  accepted_asset?: string;
  fj_amount?: string;
}

type SelectedAssetPolicy = NonNullable<ReturnType<typeof resolveSelectedAssetPolicy>>;

interface ParsedQuoteRequest {
  userAddress: AztecAddress;
  acceptedAsset: AztecAddress;
  selectedAssetPolicy: SelectedAssetPolicy;
  fjFeeAmount: bigint;
}

type QuoteRequestParseResult =
  | { ok: true; value: ParsedQuoteRequest }
  | { ok: false; message: string };

interface QuotePricing {
  rateNum: bigint;
  rateDen: bigint;
  validUntil: bigint;
  aaPaymentAmount: bigint;
}

type QuotePricingResult = { ok: true; value: QuotePricing } | { ok: false; message: string };

interface RateLimitRejection {
  identityKind: QuoteRateLimitIdentity["kind"];
  retryAfterSeconds: bigint;
}

function createQuoteObserver(metrics: AttestationMetrics): (outcome: QuoteOutcome) => void {
  const startedAtNs = process.hrtime.bigint();
  let metricsRecorded = false;
  return (outcome: QuoteOutcome): void => {
    if (metricsRecorded) {
      return;
    }
    metricsRecorded = true;
    const durationNs = process.hrtime.bigint() - startedAtNs;
    const durationSeconds = Number(durationNs) / 1_000_000_000;
    metrics.observeQuote(outcome, durationSeconds);
  };
}

function parseRequiredNonZeroAztecAddress(
  value: string | undefined,
  missingMessage: string,
  invalidMessage: string,
): { ok: true; value: AztecAddress } | { ok: false; message: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { ok: false, message: missingMessage };
  }

  let parsedAddress: AztecAddress;
  try {
    parsedAddress = AztecAddress.fromString(trimmed);
  } catch {
    return { ok: false, message: invalidMessage };
  }

  if (parsedAddress.isZero()) {
    return { ok: false, message: invalidMessage };
  }
  return { ok: true, value: parsedAddress };
}

function parseQuoteRequest(config: Config, query: QuoteRequestQuery): QuoteRequestParseResult {
  const parsedUserAddress = parseRequiredNonZeroAztecAddress(
    query.user,
    "Missing required query param: user",
    "Invalid user address",
  );
  if (!parsedUserAddress.ok) {
    return parsedUserAddress;
  }

  const parsedAcceptedAsset = parseRequiredNonZeroAztecAddress(
    query.accepted_asset,
    "Missing required query param: accepted_asset",
    "Invalid accepted_asset address",
  );
  if (!parsedAcceptedAsset.ok) {
    return parsedAcceptedAsset;
  }

  const selectedAssetPolicy = resolveSelectedAssetPolicy(
    config,
    parsedAcceptedAsset.value.toString(),
  );
  if (!selectedAssetPolicy) {
    return { ok: false, message: "Unsupported accepted_asset" };
  }

  const fjFeeAmount = parsePositiveU128Decimal(query.fj_amount);
  if (!fjFeeAmount) {
    return { ok: false, message: "Missing or invalid query param: fj_amount" };
  }

  return {
    ok: true,
    value: {
      userAddress: parsedUserAddress.value,
      acceptedAsset: parsedAcceptedAsset.value,
      selectedAssetPolicy,
      fjFeeAmount,
    },
  };
}

function computeQuotePricing(
  selectedAssetPolicy: SelectedAssetPolicy,
  fjFeeAmount: bigint,
  nowSeconds: bigint,
  validUntil: (nowSeconds: bigint) => bigint,
): QuotePricingResult {
  const { rate_num, rate_den } = computeFinalRate(selectedAssetPolicy);
  const quoteValidUntil = validUntil(nowSeconds);
  const aaPaymentAmount = ceilDiv(fjFeeAmount * rate_num, rate_den);
  if (!isU128(aaPaymentAmount) || aaPaymentAmount <= 0n) {
    return { ok: false, message: "Computed aa_payment_amount does not fit in u128" };
  }

  return {
    ok: true,
    value: {
      rateNum: rate_num,
      rateDen: rate_den,
      validUntil: quoteValidUntil,
      aaPaymentAmount,
    },
  };
}

function consumeQuoteRateLimit(
  rateLimiter: FixedWindowRateLimiter | undefined,
  config: Config,
  headers: Record<string, string | string[] | undefined>,
  remoteIp: string,
  nowSeconds: bigint,
): RateLimitRejection | undefined {
  if (!rateLimiter) {
    return undefined;
  }

  const identity = resolveQuoteRateLimitIdentity(config, headers, remoteIp);
  const decision = rateLimiter.consume(identity.cacheKey, nowSeconds);
  if (decision.allowed) {
    return undefined;
  }

  return {
    identityKind: identity.kind,
    retryAfterSeconds: decision.retryAfterSeconds,
  };
}

async function signQuoteForRequest(
  config: Config,
  quoteSigner: QuoteSchnorrSigner,
  params: {
    fpcAddress: AztecAddress;
    acceptedAsset: AztecAddress;
    userAddress: AztecAddress;
    fjFeeAmount: bigint;
    aaPaymentAmount: bigint;
    validUntil: bigint;
    rateNum: bigint;
    rateDen: bigint;
  },
): Promise<string> {
  if (config.quote_format === "rate_quote") {
    return signRateQuote(quoteSigner, {
      fpcAddress: params.fpcAddress,
      acceptedAsset: params.acceptedAsset,
      rateNum: params.rateNum,
      rateDen: params.rateDen,
      validUntil: params.validUntil,
      userAddress: params.userAddress,
    });
  }

  return signQuote(quoteSigner, {
    fpcAddress: params.fpcAddress,
    acceptedAsset: params.acceptedAsset,
    fjFeeAmount: params.fjFeeAmount,
    aaPaymentAmount: params.aaPaymentAmount,
    validUntil: params.validUntil,
    userAddress: params.userAddress,
  });
}

function buildQuoteResponse(
  config: Config,
  selectedAssetPolicy: SelectedAssetPolicy,
  fjFeeAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  signature: string,
  rateNum: bigint,
  rateDen: bigint,
) {
  const baseResponse = {
    accepted_asset: selectedAssetPolicy.address,
    fj_amount: fjFeeAmount.toString(),
    aa_payment_amount: aaPaymentAmount.toString(),
    valid_until: validUntil.toString(),
    signature,
  };
  if (config.quote_format === "rate_quote") {
    return {
      ...baseResponse,
      rate_num: rateNum.toString(),
      rate_den: rateDen.toString(),
    };
  }
  return baseResponse;
}

export interface QuoteClock {
  nowUnixSeconds?: () => Promise<bigint> | bigint;
}

export function buildServer(
  config: Config,
  quoteSigner: QuoteSchnorrSigner,
  clock: QuoteClock = {},
) {
  const app = Fastify({ logger: true });
  const metrics = new AttestationMetrics();
  const fpcAddress = AztecAddress.fromString(config.fpc_address);
  const supportedAssets = config.supported_assets.map(({ address, name }) => ({
    address,
    name,
  }));

  const nowUnixSeconds = clock.nowUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const rateLimiter = config.quote_rate_limit.enabled
    ? new FixedWindowRateLimiter(
        config.quote_rate_limit.maxRequests,
        config.quote_rate_limit.windowSeconds,
        config.quote_rate_limit.maxTrackedKeys,
      )
    : undefined;

  function validUntil(nowSeconds: bigint): bigint {
    return nowSeconds + BigInt(config.quote_validity_seconds);
  }

  app.get("/.well-known/fpc.json", async (req) => ({
    discovery_version: DISCOVERY_VERSION,
    attestation_api_version: ATTESTATION_API_VERSION,
    network_id: config.network_id,
    fpc_address: config.fpc_address,
    contract_variant: config.contract_variant,
    quote_base_url: resolveQuoteBaseUrl(config, req.headers, req.protocol),
    endpoints: {
      discovery: "/.well-known/fpc.json",
      health: "/health",
      accepted_assets: "/accepted-assets",
      asset: "/asset",
      quote: "/quote",
    },
    supported_assets: supportedAssets,
  }));

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/metrics", async (_req, reply) => {
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.renderPrometheus());
  });

  app.get("/asset", async () => ({
    name: config.accepted_asset_name,
    address: config.accepted_asset_address,
  }));

  app.get("/accepted-assets", async () => supportedAssets);

  app.get<{
    Querystring: QuoteRequestQuery;
  }>("/quote", async (req, reply) => {
    const observe = createQuoteObserver(metrics);
    const nowSeconds = BigInt(await nowUnixSeconds());

    const rateLimitRejection = consumeQuoteRateLimit(
      rateLimiter,
      config,
      req.headers,
      req.ip,
      nowSeconds,
    );
    if (rateLimitRejection) {
      req.log.warn(
        {
          event: "quote_rate_limited",
          identity_kind: rateLimitRejection.identityKind,
          retry_after_seconds: rateLimitRejection.retryAfterSeconds,
        },
        "Rate limited quote request",
      );
      observe("rate_limited");
      return reply
        .header("retry-after", rateLimitRejection.retryAfterSeconds.toString())
        .code(429)
        .send(rateLimited());
    }

    if (!isQuoteAuthorized(config, req.headers)) {
      req.log.warn(
        {
          event: "quote_auth_rejected",
          mode: config.quote_auth.mode,
        },
        "Rejected unauthorized quote request",
      );
      observe("unauthorized");
      return reply.code(401).send(unauthorized());
    }

    const parsedRequest = parseQuoteRequest(config, req.query);
    if (!parsedRequest.ok) {
      observe("bad_request");
      return reply.code(400).send(badRequest(parsedRequest.message));
    }

    const { userAddress, acceptedAsset, selectedAssetPolicy, fjFeeAmount } = parsedRequest.value;
    try {
      const quotePricing = computeQuotePricing(
        selectedAssetPolicy,
        fjFeeAmount,
        nowSeconds,
        validUntil,
      );
      if (!quotePricing.ok) {
        observe("bad_request");
        return reply.code(400).send(badRequest(quotePricing.message));
      }

      const { rateNum, rateDen, validUntil: quoteValidUntil, aaPaymentAmount } = quotePricing.value;
      const signature = await signQuoteForRequest(config, quoteSigner, {
        fpcAddress,
        acceptedAsset,
        userAddress,
        fjFeeAmount,
        aaPaymentAmount,
        validUntil: quoteValidUntil,
        rateNum,
        rateDen,
      });

      req.log.info(
        {
          event: "quote_issued",
          user: userAddress.toString(),
          accepted_asset: selectedAssetPolicy.address,
          valid_until: quoteValidUntil.toString(),
          fj_amount: fjFeeAmount.toString(),
          aa_payment_amount: aaPaymentAmount.toString(),
          rate_num: rateNum.toString(),
          rate_den: rateDen.toString(),
          quote_format: config.quote_format,
        },
        "Quote issued",
      );
      observe("success");

      return buildQuoteResponse(
        config,
        selectedAssetPolicy,
        fjFeeAmount,
        aaPaymentAmount,
        quoteValidUntil,
        signature,
        rateNum,
        rateDen,
      );
    } catch (error) {
      observe("internal_error");
      req.log.error(
        {
          err: error,
          user: userAddress.toString(),
        },
        "Failed to issue quote",
      );
      return reply.code(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      });
    }
  });

  return app;
}
