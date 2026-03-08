import { createHash, timingSafeEqual } from "node:crypto";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Fr } from "@aztec/aztec.js/fields";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { type AssetPolicyStore, MemoryAssetPolicyStore } from "./asset-policy-store.js";
import {
  type Config,
  computeFinalRate,
  normalizeAztecAddress,
  type SupportedAssetPolicy,
} from "./config.js";
import { AttestationMetrics, type QuoteOutcome } from "./metrics.js";
import type { OperatorTreasuryPort } from "./operator-treasury.js";
import type { ColdStartQuoteParams, QuoteSchnorrSigner } from "./signer.js";
import { signColdStartQuote, signQuote, signRateQuote } from "./signer.js";

function badRequest(message: string) {
  return { error: { code: "BAD_REQUEST", message } };
}

function unauthorized() {
  return { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
}

function conflict(message: string) {
  return { error: { code: "CONFLICT", message } };
}

function serviceUnavailable(message: string) {
  return {
    error: { code: "SERVICE_UNAVAILABLE", message },
  };
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

function isAdminAuthorized(
  config: Config,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!config.admin_auth.enabled) {
    return false;
  }
  return headerMatchesSecret(headers[config.admin_auth.apiKeyHeader], config.admin_auth.apiKey);
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

interface AdminAssetPolicyParams {
  assetAddress: string;
}

interface AdminAssetPolicyBody {
  name?: string;
  market_rate_num?: number;
  market_rate_den?: number;
  fee_bips?: number;
}

interface AdminSweepRequestBody {
  accepted_asset?: string;
  destination?: string;
  amount?: string;
}

interface ColdStartQuoteRequestQuery extends QuoteRequestQuery {
  claim_amount?: string;
  claim_secret_hash?: string;
}

interface ParsedQuoteRequest {
  userAddress: AztecAddress;
  acceptedAsset: AztecAddress;
  selectedAssetPolicy: SupportedAssetPolicy;
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

function resolveSelectedAssetPolicy(
  supportedAssets: SupportedAssetPolicy[],
  selectedAcceptedAssetAddress: string,
): SupportedAssetPolicy | undefined {
  const selectedAddress = normalizeAztecAddress(selectedAcceptedAssetAddress);
  return supportedAssets.find((asset) => asset.address === selectedAddress);
}

function parseQuoteRequest(
  supportedAssets: SupportedAssetPolicy[],
  query: QuoteRequestQuery,
): QuoteRequestParseResult {
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
    supportedAssets,
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

interface ParsedColdStartQuoteRequest extends ParsedQuoteRequest {
  claimAmount: bigint;
  claimSecretHash: string;
}

type ColdStartQuoteRequestParseResult =
  | { ok: true; value: ParsedColdStartQuoteRequest }
  | { ok: false; message: string };

function parseRequiredHexField(
  value: string | undefined,
  label: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { ok: false, message: `Missing required query param: ${label}` };
  }
  if (!/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
    return { ok: false, message: `Invalid ${label}: expected 0x-prefixed hex` };
  }
  return { ok: true, value: trimmed };
}

function parseColdStartQuoteRequest(
  supportedAssets: SupportedAssetPolicy[],
  query: ColdStartQuoteRequestQuery,
): ColdStartQuoteRequestParseResult {
  const baseResult = parseQuoteRequest(supportedAssets, query);
  if (!baseResult.ok) {
    return baseResult;
  }

  const claimAmount = parsePositiveU128Decimal(query.claim_amount);
  if (!claimAmount) {
    return { ok: false, message: "Missing or invalid query param: claim_amount" };
  }

  const parsedClaimSecretHash = parseRequiredHexField(query.claim_secret_hash, "claim_secret_hash");
  if (!parsedClaimSecretHash.ok) {
    return parsedClaimSecretHash;
  }

  return {
    ok: true,
    value: {
      ...baseResult.value,
      claimAmount,
      claimSecretHash: parsedClaimSecretHash.value,
    },
  };
}

function computeQuotePricing(
  selectedAssetPolicy: SupportedAssetPolicy,
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

function signQuoteForRequest(
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
  selectedAssetPolicy: SupportedAssetPolicy,
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

export interface BuildServerDependencies extends QuoteClock {
  assetPolicyStore?: AssetPolicyStore;
  treasury?: OperatorTreasuryPort;
}

type ServerApp = FastifyInstance;
type HeaderMap = Record<string, string | string[] | undefined>;
type AdminAccessResult =
  | { ok: true }
  | { ok: false; statusCode: number; body: ReturnType<typeof unauthorized> }
  | { ok: false; statusCode: number; body: ReturnType<typeof serviceUnavailable> };

interface ServerContext {
  app: ServerApp;
  assetPolicyStore: AssetPolicyStore;
  config: Config;
  fpcAddress: AztecAddress;
  metrics: AttestationMetrics;
  nowUnixSeconds: () => Promise<bigint> | bigint;
  quoteSigner: QuoteSchnorrSigner;
  rateLimiter?: FixedWindowRateLimiter;
  treasury?: OperatorTreasuryPort;
}

interface ParsedAdminSweepRequest {
  acceptedAsset: string;
  amount?: bigint;
  destination: string;
}

function buildSupportedAssetsForDiscovery(assetPolicyStore: AssetPolicyStore) {
  return assetPolicyStore.getAll().map(({ address, name }) => ({
    address,
    name,
  }));
}

function parseAdminAssetPolicy(
  assetAddress: string,
  body: AdminAssetPolicyBody | undefined,
): SupportedAssetPolicy {
  if (!body || typeof body !== "object") {
    throw new Error("Missing request body");
  }

  return {
    address: parseAdminAssetAddress(assetAddress),
    name: parseRequiredTrimmedField(body.name, "name"),
    market_rate_num: parsePositiveIntegerField(body.market_rate_num, "market_rate_num"),
    market_rate_den: parsePositiveIntegerField(body.market_rate_den, "market_rate_den"),
    fee_bips: parseFeeBips(body.fee_bips),
  };
}

function parseAdminAssetAddress(assetAddress: string): string {
  const parsedAddress = parseRequiredNonZeroAztecAddress(
    assetAddress,
    "Missing asset address",
    "Invalid asset address",
  );
  if (!parsedAddress.ok) {
    throw new Error(parsedAddress.message);
  }
  return parsedAddress.value.toString();
}

function parseRequiredTrimmedField(value: string | undefined, fieldName: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required field: ${fieldName}`);
  }
  return trimmed;
}

function parsePositiveIntegerField(value: number | undefined, fieldName: string): number {
  const parsed = value;
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseFeeBips(value: number | undefined): number {
  const parsed = value;
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed > 10000) {
    throw new Error("fee_bips must be an integer in range [0, 10000]");
  }
  return parsed;
}

async function ensureSenderRegistered(
  treasury: OperatorTreasuryPort | undefined,
  userAddress: AztecAddress,
  requestLog: ServerApp["log"],
): Promise<void> {
  if (!treasury) {
    return;
  }

  try {
    await treasury.registerSender(userAddress);
  } catch (error) {
    requestLog.warn(
      {
        err: error,
        user: userAddress.toString(),
      },
      "Failed to register quote sender for operator PXE discovery",
    );
  }
}

function internalErrorBody() {
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  };
}

function requireAdminAccess(config: Config, headers: HeaderMap): AdminAccessResult {
  if (!config.admin_auth.enabled) {
    return {
      ok: false,
      statusCode: 503,
      body: serviceUnavailable("Admin API is disabled"),
    };
  }
  if (!isAdminAuthorized(config, headers)) {
    return {
      ok: false,
      statusCode: 401,
      body: unauthorized(),
    };
  }
  return { ok: true };
}

function validUntilFactory(config: Config) {
  return (nowSeconds: bigint): bigint => nowSeconds + BigInt(config.quote_validity_seconds);
}

function parseAdminSweepRequest(
  config: Config,
  assetPolicyStore: AssetPolicyStore,
  body: AdminSweepRequestBody | undefined,
): ParsedAdminSweepRequest {
  const acceptedAsset = body?.accepted_asset?.trim();
  if (!acceptedAsset) {
    throw new Error("Missing required field: accepted_asset");
  }
  if (!resolveSelectedAssetPolicy(assetPolicyStore.getAll(), acceptedAsset)) {
    throw new Error("Unsupported accepted_asset");
  }

  const destination = body?.destination?.trim() || config.treasury_destination_address || undefined;
  if (!destination) {
    throw new Error("Missing required field: destination");
  }

  const amount = parsePositiveU128Decimal(body?.amount);
  if (body?.amount !== undefined && !amount) {
    throw new Error("Missing or invalid field: amount");
  }

  return {
    acceptedAsset,
    amount,
    destination,
  };
}

function isBadSweepRequestError(message: string): boolean {
  return (
    message === "Missing required field: accepted_asset" ||
    message === "Unsupported accepted_asset" ||
    message === "Missing required field: destination" ||
    message === "Missing or invalid field: amount" ||
    message.includes("exceeds operator private balance") ||
    message.includes("must be greater than zero") ||
    message.includes("destination must be")
  );
}

function replyIfAdminAccessDenied(
  config: Config,
  headers: HeaderMap,
  reply: FastifyReply,
): FastifyReply | undefined {
  const access = requireAdminAccess(config, headers);
  if (!access.ok) {
    return reply.code(access.statusCode).send(access.body);
  }
  return undefined;
}

function replyIfTreasuryUnavailable(
  treasury: OperatorTreasuryPort | undefined,
  reply: FastifyReply,
): FastifyReply | undefined {
  if (treasury) {
    return undefined;
  }
  return reply.code(503).send(serviceUnavailable("Operator treasury wallet is not configured"));
}

function badRequestFromError(error: unknown) {
  return badRequest(error instanceof Error ? error.message : String(error));
}

function mapAssetPolicyRemovalError(message: string) {
  if (message === "Cannot remove the last supported asset") {
    return {
      statusCode: 409,
      body: conflict(message),
    };
  }

  if (message.startsWith("Supported asset not found")) {
    return {
      statusCode: 404,
      body: badRequest(message),
    };
  }

  return {
    statusCode: 400,
    body: badRequest(message),
  };
}

async function handleAdminAssetPolicyDelete(
  req: FastifyRequest<{ Params: AdminAssetPolicyParams }>,
  reply: FastifyReply,
  assetPolicyStore: AssetPolicyStore,
): Promise<unknown> {
  try {
    const removed = await assetPolicyStore.remove(req.params.assetAddress);
    req.log.info(
      {
        event: "asset_policy_removed",
        accepted_asset: removed.address,
      },
      "Removed supported asset policy",
    );
    return removed;
  } catch (error) {
    const mapped = mapAssetPolicyRemovalError(
      error instanceof Error ? error.message : String(error),
    );
    return reply.code(mapped.statusCode).send(mapped.body);
  }
}

async function handleAdminSweep(
  req: FastifyRequest<{ Body: AdminSweepRequestBody }>,
  reply: FastifyReply,
  config: Config,
  assetPolicyStore: AssetPolicyStore,
  treasury: OperatorTreasuryPort,
): Promise<unknown> {
  try {
    const sweepRequest = parseAdminSweepRequest(config, assetPolicyStore, req.body);
    const result = await treasury.sweep(sweepRequest);
    req.log.info(
      {
        event: "operator_treasury_sweep",
        accepted_asset: result.acceptedAsset,
        destination: result.destination,
        swept_amount: result.sweptAmount,
        tx_hash: result.txHash,
      },
      "Swept operator treasury balance",
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBadSweepRequestError(message)) {
      return reply.code(400).send(badRequest(message));
    }
    req.log.error({ err: error }, "Failed to sweep operator treasury balance");
    return reply.code(500).send(internalErrorBody());
  }
}

function registerPublicRoutes(context: ServerContext): void {
  const { app, assetPolicyStore, config, metrics } = context;

  app.get("/.well-known/fpc.json", (req) => ({
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
      cold_start_quote: "/cold-start-quote",
    },
    supported_assets: buildSupportedAssetsForDiscovery(assetPolicyStore),
  }));

  app.get("/health", () => ({ status: "ok" }));

  app.get("/metrics", (_req, reply) =>
    reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.renderPrometheus()),
  );

  app.get("/asset", () => {
    const primaryAsset = assetPolicyStore.getPrimaryAsset();
    return {
      name: primaryAsset.name,
      address: primaryAsset.address,
    };
  });

  app.get("/accepted-assets", () => buildSupportedAssetsForDiscovery(assetPolicyStore));
}

function registerQuoteRoute(context: ServerContext): void {
  const {
    app,
    assetPolicyStore,
    config,
    fpcAddress,
    metrics,
    nowUnixSeconds,
    quoteSigner,
    rateLimiter,
    treasury,
  } = context;
  const validUntil = validUntilFactory(config);

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

    const parsedRequest = parseQuoteRequest(assetPolicyStore.getAll(), req.query);
    if (!parsedRequest.ok) {
      observe("bad_request");
      return reply.code(400).send(badRequest(parsedRequest.message));
    }

    const { acceptedAsset, fjFeeAmount, selectedAssetPolicy, userAddress } = parsedRequest.value;

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

      const { aaPaymentAmount, rateDen, rateNum, validUntil: quoteValidUntil } = quotePricing.value;
      await ensureSenderRegistered(treasury, userAddress, req.log);
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
      return reply.code(500).send(internalErrorBody());
    }
  });
}

function registerAdminRoutes(context: ServerContext): void {
  const { app, assetPolicyStore, config, treasury } = context;

  app.get("/admin/asset-policies", (req, reply) => {
    const deniedReply = replyIfAdminAccessDenied(config, req.headers, reply);
    if (deniedReply) {
      return deniedReply;
    }
    return assetPolicyStore.getAll();
  });

  app.put<{
    Params: AdminAssetPolicyParams;
    Body: AdminAssetPolicyBody;
  }>("/admin/asset-policies/:assetAddress", async (req, reply) => {
    const deniedReply = replyIfAdminAccessDenied(config, req.headers, reply);
    if (deniedReply) {
      return deniedReply;
    }

    try {
      const policy = parseAdminAssetPolicy(req.params.assetAddress, req.body);
      const updated = await assetPolicyStore.upsert(policy);
      req.log.info(
        {
          event: "asset_policy_upserted",
          accepted_asset: updated.address,
          fee_bips: updated.fee_bips,
          market_rate_num: updated.market_rate_num,
          market_rate_den: updated.market_rate_den,
        },
        "Updated supported asset policy",
      );
      return updated;
    } catch (error) {
      return reply.code(400).send(badRequestFromError(error));
    }
  });

  app.delete<{
    Params: AdminAssetPolicyParams;
  }>("/admin/asset-policies/:assetAddress", (req, reply) => {
    const deniedReply = replyIfAdminAccessDenied(config, req.headers, reply);
    if (deniedReply) {
      return deniedReply;
    }
    return handleAdminAssetPolicyDelete(req, reply, assetPolicyStore);
  });

  app.get("/admin/operator-balances", async (req, reply) => {
    const deniedReply = replyIfAdminAccessDenied(config, req.headers, reply);
    if (deniedReply) {
      return deniedReply;
    }
    const treasuryUnavailableReply = replyIfTreasuryUnavailable(treasury, reply);
    if (treasuryUnavailableReply) {
      return treasuryUnavailableReply;
    }
    const activeTreasury = treasury;
    if (!activeTreasury) {
      return reply.code(503).send(serviceUnavailable("Operator treasury wallet is not configured"));
    }

    try {
      const policies = assetPolicyStore.getAll();
      const balances = await activeTreasury.getPrivateBalances(
        policies.map((asset) => asset.address),
      );
      return balances.map((balance) => ({
        accepted_asset: balance.address,
        balance: balance.balance,
        name: policies.find((asset) => asset.address === balance.address)?.name ?? balance.address,
      }));
    } catch (error) {
      req.log.error({ err: error }, "Failed to read operator balances");
      return reply.code(500).send(internalErrorBody());
    }
  });

  app.post<{
    Body: AdminSweepRequestBody;
  }>("/admin/sweeps", (req, reply) => {
    const deniedReply = replyIfAdminAccessDenied(config, req.headers, reply);
    if (deniedReply) {
      return deniedReply;
    }
    const treasuryUnavailableReply = replyIfTreasuryUnavailable(treasury, reply);
    if (treasuryUnavailableReply) {
      return treasuryUnavailableReply;
    }
    const activeTreasury = treasury;
    if (!activeTreasury) {
      return reply.code(503).send(serviceUnavailable("Operator treasury wallet is not configured"));
    }
    return handleAdminSweep(req, reply, config, assetPolicyStore, activeTreasury);
  });
}

export function buildServer(
  config: Config,
  quoteSigner: QuoteSchnorrSigner,
  deps: BuildServerDependencies = {},
) {
  const app = Fastify({ logger: true });
  const context: ServerContext = {
    app,
    assetPolicyStore:
      deps.assetPolicyStore ??
      new MemoryAssetPolicyStore(
        config.supported_assets,
        normalizeAztecAddress(config.accepted_asset_address),
      ),
    config,
    fpcAddress: AztecAddress.fromString(config.fpc_address),
    metrics: new AttestationMetrics(),
    nowUnixSeconds: deps.nowUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000))),
    quoteSigner,
    rateLimiter: config.quote_rate_limit.enabled
      ? new FixedWindowRateLimiter(
          config.quote_rate_limit.maxRequests,
          config.quote_rate_limit.windowSeconds,
          config.quote_rate_limit.maxTrackedKeys,
        )
      : undefined,
    treasury: deps.treasury,
  };

  registerPublicRoutes(context);
  registerQuoteRoute(context);
  registerColdStartQuoteRoute(context);
  registerAdminRoutes(context);

  return app;
}

function registerColdStartQuoteRoute(context: ServerContext): void {
  const {
    app,
    assetPolicyStore,
    config,
    fpcAddress,
    metrics,
    nowUnixSeconds,
    quoteSigner,
    rateLimiter,
  } = context;
  const validUntil = validUntilFactory(config);

  app.get<{
    Querystring: ColdStartQuoteRequestQuery;
  }>("/cold-start-quote", async (req, reply) => {
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
          event: "cold_start_quote_rate_limited",
          identity_kind: rateLimitRejection.identityKind,
          retry_after_seconds: rateLimitRejection.retryAfterSeconds,
        },
        "Rate limited cold-start quote request",
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
          event: "cold_start_quote_auth_rejected",
          mode: config.quote_auth.mode,
        },
        "Rejected unauthorized cold-start quote request",
      );
      observe("unauthorized");
      return reply.code(401).send(unauthorized());
    }

    const parsedRequest = parseColdStartQuoteRequest(assetPolicyStore.getAll(), req.query);
    if (!parsedRequest.ok) {
      observe("bad_request");
      return reply.code(400).send(badRequest(parsedRequest.message));
    }

    const {
      userAddress,
      acceptedAsset,
      selectedAssetPolicy,
      fjFeeAmount,
      claimAmount,
      claimSecretHash,
    } = parsedRequest.value;

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

      const { validUntil: quoteValidUntil, aaPaymentAmount } = quotePricing.value;

      if (claimAmount < aaPaymentAmount) {
        observe("bad_request");
        return reply.code(400).send(badRequest("claim_amount must be >= aa_payment_amount"));
      }

      const coldStartParams: ColdStartQuoteParams = {
        fpcAddress,
        acceptedAsset,
        fjFeeAmount,
        aaPaymentAmount,
        validUntil: quoteValidUntil,
        userAddress,
        claimAmount,
        claimSecretHash: Fr.fromHexString(claimSecretHash),
      };
      const signature = await signColdStartQuote(quoteSigner, coldStartParams);

      req.log.info(
        {
          event: "cold_start_quote_issued",
          user: userAddress.toString(),
          accepted_asset: selectedAssetPolicy.address,
          valid_until: quoteValidUntil.toString(),
          fj_amount: fjFeeAmount.toString(),
          aa_payment_amount: aaPaymentAmount.toString(),
          claim_amount: claimAmount.toString(),
          claim_secret_hash: claimSecretHash,
        },
        "Cold-start quote issued",
      );
      observe("success");

      return {
        accepted_asset: selectedAssetPolicy.address,
        fj_amount: fjFeeAmount.toString(),
        aa_payment_amount: aaPaymentAmount.toString(),
        valid_until: quoteValidUntil.toString(),
        claim_amount: claimAmount.toString(),
        claim_secret_hash: claimSecretHash,
        signature,
      };
    } catch (error) {
      observe("internal_error");
      req.log.error(
        {
          err: error,
          user: userAddress.toString(),
        },
        "Failed to issue cold-start quote",
      );
      return reply.code(500).send(internalErrorBody());
    }
  });
}
