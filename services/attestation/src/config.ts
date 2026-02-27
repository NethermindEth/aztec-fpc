import { readFileSync } from "node:fs";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { parse } from "yaml";
import { z } from "zod";
import {
  type RuntimeProfile,
  resolveSecret,
  type SecretAdapterRegistry,
  type SecretProvider,
  type SecretSource,
} from "./secret-provider.js";

export const MAX_QUOTE_VALIDITY_SECONDS = 3600;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QUOTE_RATE_LIMIT_MAX_WINDOW_SECONDS = 3600;
const QUOTE_RATE_LIMIT_MAX_REQUESTS = 1_000_000;
const QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS = 1_000_000;
const OperatorSecretKeySchema = z
  .string()
  .regex(PRIVATE_KEY_PATTERN, "must be a 32-byte 0x-prefixed hex private key");
const RuntimeProfileSchema = z.enum(["development", "test", "production"]);
const SecretProviderSchema = z.enum(["auto", "env", "config", "kms", "hsm"]);
const QuoteAuthModeSchema = z.enum([
  "disabled",
  "api_key",
  "trusted_header",
  "api_key_or_trusted_header",
  "api_key_and_trusted_header",
]);
const AztecNodeUrlSchema = z.string().url();
const AztecAddressSchema = z
  .string()
  .trim()
  .superRefine((value, context) => {
    let parsed: AztecAddress;
    try {
      parsed = AztecAddress.fromString(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a valid Aztec address",
      });
      return;
    }

    if (parsed.isZero()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a non-zero Aztec address",
      });
    }
  });

const ConfigSchema = z.object({
  runtime_profile: RuntimeProfileSchema.default("development"),
  fpc_address: AztecAddressSchema,
  aztec_node_url: AztecNodeUrlSchema,
  quote_validity_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_QUOTE_VALIDITY_SECONDS)
    .default(300),
  port: z.number().int().positive().default(3000),
  /** The single token contract address this FPC accepts. Must match accepted_asset in the deployed contract. */
  accepted_asset_address: AztecAddressSchema,
  accepted_asset_name: z.string(),
  /** Baseline exchange rate: accepted_asset units per 1 FeeJuice. */
  market_rate_num: z.number().int().positive(),
  market_rate_den: z.number().int().positive(),
  /** Operator margin in basis points (100 = 1%). Applied on top of market rate. */
  fee_bips: z.number().int().min(0).max(10000),
  /** Secret provider strategy for operator key. */
  operator_secret_provider: SecretProviderSchema.default("auto"),
  /** Reference used by external secret providers (kms/hsm). */
  operator_secret_ref: z.string().optional(),
  /** Optional explicit operator account address (needed if account salt is non-zero). */
  operator_address: AztecAddressSchema.optional(),
  /** Optional when OPERATOR_SECRET_KEY is provided via env. */
  operator_secret_key: z.string().optional(),
  /** Quote endpoint access control mode. */
  quote_auth_mode: QuoteAuthModeSchema.default("disabled"),
  /** Shared API key value for /quote when mode includes api_key. */
  quote_auth_api_key: z.string().optional(),
  /** Header name containing the API key. */
  quote_auth_api_key_header: z.string().default("x-api-key"),
  /** Trusted upstream marker header name when mode includes trusted_header. */
  quote_auth_trusted_header_name: z.string().optional(),
  /** Expected trusted upstream marker header value. */
  quote_auth_trusted_header_value: z.string().optional(),
  /** Optional directory for local PXE persistent state (LMDB).
   *  When set, the service spins up a local PXE so it can call
   *  registerSender() and discover private fee-payment notes. */
  pxe_data_directory: z.string().optional(),
  /** Enable/disable /quote rate limiting. */
  quote_rate_limit_enabled: z.boolean().default(true),
  /** Max /quote requests allowed per identity per fixed window. */
  quote_rate_limit_max_requests: z
    .number()
    .int()
    .positive()
    .max(QUOTE_RATE_LIMIT_MAX_REQUESTS)
    .default(60),
  /** Fixed window size in seconds. */
  quote_rate_limit_window_seconds: z
    .number()
    .int()
    .positive()
    .max(QUOTE_RATE_LIMIT_MAX_WINDOW_SECONDS)
    .default(60),
  /** Maximum number of tracked rate-limit identities in memory. */
  quote_rate_limit_max_tracked_keys: z
    .number()
    .int()
    .positive()
    .max(QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS)
    .default(10_000),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;
export type QuoteAuthMode = z.infer<typeof QuoteAuthModeSchema>;

export interface QuoteAuthConfig {
  mode: QuoteAuthMode;
  apiKey?: string;
  apiKeyHeader: string;
  trustedHeaderName?: string;
  trustedHeaderValue?: string;
}

export interface QuoteRateLimitConfig {
  enabled: boolean;
  maxRequests: number;
  windowSeconds: number;
  maxTrackedKeys: number;
}

export type Config = Omit<
  ParsedConfig,
  | "operator_secret_key"
  | "quote_auth_mode"
  | "quote_auth_api_key"
  | "quote_auth_api_key_header"
  | "quote_auth_trusted_header_name"
  | "quote_auth_trusted_header_value"
  | "quote_rate_limit_enabled"
  | "quote_rate_limit_max_requests"
  | "quote_rate_limit_window_seconds"
  | "quote_rate_limit_max_tracked_keys"
> & {
  runtime_profile: RuntimeProfile;
  operator_secret_key: string;
  operator_secret_key_source: SecretSource;
  operator_secret_key_provider: SecretProvider;
  operator_secret_key_dual_source: boolean;
  quote_auth: QuoteAuthConfig;
  quote_rate_limit: QuoteRateLimitConfig;
};

export interface LoadConfigOptions {
  secretAdapters?: SecretAdapterRegistry;
}

function parseRuntimeProfile(
  configValue: RuntimeProfile,
  envOverride: string | undefined,
): RuntimeProfile {
  if (!envOverride) {
    return configValue;
  }
  return RuntimeProfileSchema.parse(envOverride.trim());
}

function parseSecretProvider(
  configValue: SecretProvider,
  envOverride: string | undefined,
): SecretProvider {
  if (!envOverride) {
    return configValue;
  }
  return SecretProviderSchema.parse(envOverride.trim());
}

function parseQuoteAuthMode(
  configValue: QuoteAuthMode,
  envOverride: string | undefined,
): QuoteAuthMode {
  if (!envOverride) {
    return configValue;
  }
  return QuoteAuthModeSchema.parse(envOverride.trim());
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanOverride(
  configValue: boolean,
  envOverride: string | undefined,
  envName: string,
): boolean {
  if (envOverride === undefined) {
    return configValue;
  }

  const normalized = envOverride.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(
    `Invalid ${envName}: expected boolean value (true/false, 1/0, yes/no, on/off)`,
  );
}

function parseIntegerOverride(
  configValue: number,
  envOverride: string | undefined,
  envName: string,
  min: number,
  max: number,
): number {
  if (envOverride === undefined) {
    return configValue;
  }

  const parsed = Number(envOverride.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid ${envName}: expected integer in range [${min}, ${max}]`,
    );
  }
  return parsed;
}

function normalizeHeaderName(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error(`${label} header name must be non-empty`);
  }
  if (!HTTP_HEADER_NAME_PATTERN.test(normalized)) {
    throw new Error(`${label} header name contains invalid characters`);
  }
  return normalized;
}

function modeNeedsApiKey(mode: QuoteAuthMode): boolean {
  return (
    mode === "api_key" ||
    mode === "api_key_or_trusted_header" ||
    mode === "api_key_and_trusted_header"
  );
}

function modeNeedsTrustedHeader(mode: QuoteAuthMode): boolean {
  return (
    mode === "trusted_header" ||
    mode === "api_key_or_trusted_header" ||
    mode === "api_key_and_trusted_header"
  );
}

function resolveQuoteAuthConfig(
  config: ParsedConfig,
  runtimeProfile: RuntimeProfile,
): QuoteAuthConfig {
  const mode = parseQuoteAuthMode(
    config.quote_auth_mode,
    process.env.QUOTE_AUTH_MODE,
  );
  const apiKey = normalizeOptional(
    process.env.QUOTE_AUTH_API_KEY ?? config.quote_auth_api_key,
  );
  const apiKeyHeader = normalizeHeaderName(
    process.env.QUOTE_AUTH_API_KEY_HEADER ?? config.quote_auth_api_key_header,
    "quote auth api key",
  );
  const trustedHeaderNameRaw = normalizeOptional(
    process.env.QUOTE_AUTH_TRUSTED_HEADER_NAME ??
      config.quote_auth_trusted_header_name,
  );
  const trustedHeaderValue = normalizeOptional(
    process.env.QUOTE_AUTH_TRUSTED_HEADER_VALUE ??
      config.quote_auth_trusted_header_value,
  );
  const trustedHeaderName = trustedHeaderNameRaw
    ? normalizeHeaderName(trustedHeaderNameRaw, "quote auth trusted upstream")
    : undefined;

  if (runtimeProfile === "production" && mode === "disabled") {
    throw new Error(
      "Insecure quote auth configuration: quote_auth_mode must not be disabled when runtime_profile=production",
    );
  }

  const requiresApiKey = modeNeedsApiKey(mode);
  const requiresTrustedHeader = modeNeedsTrustedHeader(mode);

  if (requiresApiKey && !apiKey) {
    throw new Error(
      `Missing quote auth API key: set quote_auth_api_key (or QUOTE_AUTH_API_KEY) when quote_auth_mode=${mode}`,
    );
  }
  if (!requiresApiKey && apiKey) {
    throw new Error(
      `Unexpected quote auth API key: quote_auth_mode=${mode} does not use API key auth`,
    );
  }

  if (requiresTrustedHeader) {
    if (!trustedHeaderName || !trustedHeaderValue) {
      throw new Error(
        `Missing trusted upstream auth header config: set quote_auth_trusted_header_name and quote_auth_trusted_header_value (or env overrides) when quote_auth_mode=${mode}`,
      );
    }
    if (
      mode === "api_key_and_trusted_header" &&
      trustedHeaderName === apiKeyHeader
    ) {
      throw new Error(
        "Invalid quote auth header config: quote_auth_api_key_header and quote_auth_trusted_header_name must differ when quote_auth_mode=api_key_and_trusted_header",
      );
    }
  } else if (trustedHeaderName || trustedHeaderValue) {
    throw new Error(
      `Unexpected trusted upstream auth config: quote_auth_mode=${mode} does not use trusted header auth`,
    );
  }

  return {
    mode,
    apiKey,
    apiKeyHeader,
    trustedHeaderName,
    trustedHeaderValue,
  };
}

function resolveQuoteRateLimitConfig(
  config: ParsedConfig,
): QuoteRateLimitConfig {
  const enabled = parseBooleanOverride(
    config.quote_rate_limit_enabled,
    process.env.QUOTE_RATE_LIMIT_ENABLED,
    "QUOTE_RATE_LIMIT_ENABLED",
  );
  const maxRequests = parseIntegerOverride(
    config.quote_rate_limit_max_requests,
    process.env.QUOTE_RATE_LIMIT_MAX_REQUESTS,
    "QUOTE_RATE_LIMIT_MAX_REQUESTS",
    1,
    QUOTE_RATE_LIMIT_MAX_REQUESTS,
  );
  const windowSeconds = parseIntegerOverride(
    config.quote_rate_limit_window_seconds,
    process.env.QUOTE_RATE_LIMIT_WINDOW_SECONDS,
    "QUOTE_RATE_LIMIT_WINDOW_SECONDS",
    1,
    QUOTE_RATE_LIMIT_MAX_WINDOW_SECONDS,
  );
  const maxTrackedKeys = parseIntegerOverride(
    config.quote_rate_limit_max_tracked_keys,
    process.env.QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS,
    "QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS",
    1,
    QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS,
  );

  return {
    enabled,
    maxRequests,
    windowSeconds,
    maxTrackedKeys,
  };
}

export function loadConfig(
  path: string,
  options: LoadConfigOptions = {},
): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  const config = ConfigSchema.parse(parsed);

  const runtimeProfile = parseRuntimeProfile(
    config.runtime_profile,
    process.env.FPC_RUNTIME_PROFILE,
  );
  const secretProvider = parseSecretProvider(
    config.operator_secret_provider,
    process.env.OPERATOR_SECRET_PROVIDER,
  );
  const resolvedSecret = resolveSecret({
    secretLabel: "operator secret key",
    provider: secretProvider,
    runtimeProfile,
    envVarName: "OPERATOR_SECRET_KEY",
    envValue: process.env.OPERATOR_SECRET_KEY,
    configValue: config.operator_secret_key,
    secretRef: process.env.OPERATOR_SECRET_REF ?? config.operator_secret_ref,
    adapters: options.secretAdapters,
  });

  OperatorSecretKeySchema.parse(resolvedSecret.value);
  const aztecNodeUrl = AztecNodeUrlSchema.parse(
    process.env.AZTEC_NODE_URL ?? config.aztec_node_url,
  );
  const quoteAuth = resolveQuoteAuthConfig(config, runtimeProfile);
  const quoteRateLimit = resolveQuoteRateLimitConfig(config);
  const {
    operator_secret_key: _configuredOperatorSecretKey,
    quote_auth_mode: _quoteAuthMode,
    quote_auth_api_key: _quoteAuthApiKey,
    quote_auth_api_key_header: _quoteAuthApiKeyHeader,
    quote_auth_trusted_header_name: _quoteAuthTrustedHeaderName,
    quote_auth_trusted_header_value: _quoteAuthTrustedHeaderValue,
    quote_rate_limit_enabled: _quoteRateLimitEnabled,
    quote_rate_limit_max_requests: _quoteRateLimitMaxRequests,
    quote_rate_limit_window_seconds: _quoteRateLimitWindowSeconds,
    quote_rate_limit_max_tracked_keys: _quoteRateLimitMaxTrackedKeys,
    ...restConfig
  } = config;

  return {
    ...restConfig,
    runtime_profile: runtimeProfile,
    aztec_node_url: aztecNodeUrl,
    operator_secret_key: resolvedSecret.value,
    operator_secret_key_source: resolvedSecret.source,
    operator_secret_key_provider: resolvedSecret.provider,
    operator_secret_key_dual_source: resolvedSecret.dualSource,
    quote_auth: quoteAuth,
    quote_rate_limit: quoteRateLimit,
  };
}

/** Compute the final exchange rate incorporating the operator margin.
 *
 * final_rate = market_rate * (10000 + fee_bips) / 10000
 *
 * Kept as a fraction (num, den) to avoid floating point. The contract
 * ceiling-divides, so the operator is guaranteed to collect at least
 * fee_bips of margin.
 */
export function computeFinalRate(config: Config): {
  rate_num: bigint;
  rate_den: bigint;
} {
  const rate_num =
    BigInt(config.market_rate_num) * BigInt(10000 + config.fee_bips);
  const rate_den = BigInt(config.market_rate_den) * BigInt(10000);
  return { rate_num, rate_den };
}
