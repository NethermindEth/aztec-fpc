import { createHash, timingSafeEqual } from "node:crypto";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import Fastify from "fastify";
import type { Config } from "./config.js";
import { computeFinalRate } from "./config.js";
import { AttestationMetrics, type QuoteOutcome } from "./metrics.js";
import type { QuoteSchnorrSigner } from "./signer.js";
import { signQuote } from "./signer.js";

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

function parsePositiveBigIntDecimal(
  value: string | undefined,
): bigint | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
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

  const expectedDigest = createHash("sha256")
    .update(expectedValue, "utf8")
    .digest();
  const candidateDigest = createHash("sha256")
    .update(candidateValue, "utf8")
    .digest();
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
    config.quote_auth.trustedHeaderName
      ? headers[config.quote_auth.trustedHeaderName]
      : undefined,
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

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
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
    const apiKeyCandidate = firstHeaderValue(
      headers[config.quote_auth.apiKeyHeader],
    );
    if (
      apiKeyCandidate &&
      headerMatchesSecret(apiKeyCandidate, config.quote_auth.apiKey)
    ) {
      const apiKeyDigest = createHash("sha256")
        .update(apiKeyCandidate, "utf8")
        .digest("hex");
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
  const acceptedAsset = AztecAddress.fromString(config.accepted_asset_address);

  const nowUnixSeconds =
    clock.nowUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
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

  // ── GET /health ─────────────────────────────────────────────────────────────

  app.get("/health", async () => ({ status: "ok" }));

  // ── GET /metrics ───────────────────────────────────────────────────────────

  app.get("/metrics", async (_req, reply) => {
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.renderPrometheus());
  });

  // ── GET /asset ───────────────────────────────────────────────────────────────

  app.get("/asset", async () => ({
    name: config.accepted_asset_name,
    address: config.accepted_asset_address,
  }));

  // ── GET /quote?user=<address>&fj_amount=<positive_integer> ───────────────

  app.get<{ Querystring: { user?: string; fj_amount?: string } }>(
    "/quote",
    async (req, reply) => {
    const startedAtNs = process.hrtime.bigint();
    let metricsRecorded = false;
    const observe = (outcome: QuoteOutcome): void => {
      if (metricsRecorded) {
        return;
      }
      metricsRecorded = true;
      const durationNs = process.hrtime.bigint() - startedAtNs;
      const durationSeconds = Number(durationNs) / 1_000_000_000;
      metrics.observeQuote(outcome, durationSeconds);
    };

    const nowSeconds = BigInt(await nowUnixSeconds());

    if (rateLimiter) {
      const identity = resolveQuoteRateLimitIdentity(
        config,
        req.headers,
        req.ip,
      );
      const decision = rateLimiter.consume(identity.cacheKey, nowSeconds);
      if (!decision.allowed) {
        req.log.warn(
          {
            event: "quote_rate_limited",
            identity_kind: identity.kind,
            retry_after_seconds: decision.retryAfterSeconds,
          },
          "Rate limited quote request",
        );
        observe("rate_limited");
        return reply
          .header("retry-after", decision.retryAfterSeconds.toString())
          .code(429)
          .send(rateLimited());
      }
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

    const userAddress = req.query.user?.trim();
    if (!userAddress) {
      observe("bad_request");
      return reply
        .code(400)
        .send(badRequest("Missing required query param: user"));
    }
    let parsedUserAddress: AztecAddress;
    try {
      parsedUserAddress = AztecAddress.fromString(userAddress);
    } catch {
      observe("bad_request");
      return reply.code(400).send(badRequest("Invalid user address"));
    }

    const fjFeeAmount = parsePositiveBigIntDecimal(
      req.query.fj_amount,
    );
    if (!fjFeeAmount) {
      observe("bad_request");
      return reply
        .code(400)
        .send(badRequest("Missing or invalid query param: fj_amount"));
    }

    try {
      const { rate_num, rate_den } = computeFinalRate(config);
      const expiry = validUntil(nowSeconds);
      const aaPaymentAmount = ceilDiv(fjFeeAmount * rate_num, rate_den);

      const signature = await signQuote(quoteSigner, {
        fpcAddress,
        acceptedAsset,
        fjFeeAmount,
        aaPaymentAmount,
        validUntil: expiry,
        userAddress: parsedUserAddress,
      });

      req.log.info(
        {
          event: "quote_issued",
          user: parsedUserAddress.toString(),
          valid_until: expiry.toString(),
          fj_amount: fjFeeAmount.toString(),
          aa_payment_amount: aaPaymentAmount.toString(),
        },
        "Quote issued",
      );
      observe("success");

      return {
        accepted_asset: config.accepted_asset_address,
        fj_amount: fjFeeAmount.toString(),
        aa_payment_amount: aaPaymentAmount.toString(),
        valid_until: expiry.toString(),
        signature,
      };
    } catch (error) {
      observe("internal_error");
      req.log.error(
        {
          err: error,
          user: parsedUserAddress.toString(),
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
    },
  );

  return app;
}
