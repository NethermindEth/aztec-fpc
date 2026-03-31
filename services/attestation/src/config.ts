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
const FIELD_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const OperatorSecretKeySchema = z
  .string()
  .regex(PRIVATE_KEY_PATTERN, "must be a 32-byte 0x-prefixed hex private key");
const FrHexSchema = z.string().regex(FIELD_HEX_PATTERN, "must be a 32-byte 0x-prefixed hex field");
const RuntimeProfileSchema = z.enum(["development", "test", "production"]);
const SecretProviderSchema = z.enum(["auto", "env", "config", "kms", "hsm"]);
const QuoteAuthModeSchema = z.enum([
  "disabled",
  "api_key",
  "trusted_header",
  "api_key_or_trusted_header",
  "api_key_and_trusted_header",
]);
const QuoteFormatSchema = z.enum(["amount_quote", "rate_quote"]);
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
const SupportedAssetSchema = z.object({
  address: AztecAddressSchema,
  name: z.string().trim().min(1),
  market_rate_num: z.number().int().positive(),
  market_rate_den: z.number().int().positive(),
  fee_bips: z.number().int().min(0).max(10000),
});
const AdminApiKeySchema = z.string().trim().min(1);

const ConfigSchema = z.object({
  runtime_profile: RuntimeProfileSchema.default("development"),
  /** Aztec network identifier exposed in wallet discovery metadata. */
  network_id: z.string().trim().min(1).default("aztec-alpha-local"),
  fpc_address: AztecAddressSchema,
  /** Contract flavor identifier exposed in wallet discovery metadata. */
  contract_variant: z.string().trim().min(1).default("fpc-v1"),
  /** Optional externally reachable base URL override for discovery clients. */
  quote_base_url: z.string().url().optional(),
  aztec_node_url: AztecNodeUrlSchema.optional(),
  quote_validity_seconds: z.number().int().positive().max(MAX_QUOTE_VALIDITY_SECONDS).default(300),
  port: z.number().int().positive().default(3000),
  /** Supported asset list. Each entry defines an accepted token with pricing. */
  supported_assets: z.array(SupportedAssetSchema).optional(),
  /** Quote preimage format used for signature generation. */
  quote_format: QuoteFormatSchema.default("amount_quote"),
  /** Secret provider strategy for operator key. */
  operator_secret_provider: SecretProviderSchema.default("auto"),
  /** Reference used by external secret providers (kms/hsm). */
  operator_secret_ref: z.string().optional(),
  /** Optional explicit operator account address (needed if account salt is non-zero). */
  operator_address: AztecAddressSchema.optional(),
  /** Operator account salt required when reconstructing the deployed operator wallet. */
  operator_account_salt: FrHexSchema.optional(),
  /** Shared API key for authenticated admin asset/sweep endpoints — set via ADMIN_API_KEY env var. */
  /** Header name carrying the admin API key. */
  admin_api_key_header: z.string().default("x-admin-api-key"),
  /** Durable LMDB directory storing the effective supported asset policy set. */
  asset_policy_state_path: z.string().min(1).default(".attestation-asset-policies"),
  /** Default recipient for manual treasury sweeps. */
  treasury_destination_address: AztecAddressSchema.optional(),
  /** Quote endpoint access control mode. */
  quote_auth_mode: QuoteAuthModeSchema.default("disabled"),
  /** Shared API key value for /quote — set via QUOTE_AUTH_API_KEY env var. */
  /** Header name containing the API key. */
  quote_auth_api_key_header: z.string().default("x-api-key"),
  /** Trusted upstream marker header name when mode includes trusted_header. */
  quote_auth_trusted_header_name: z.string().optional(),
  /** Expected trusted upstream marker header value — set via QUOTE_AUTH_TRUSTED_HEADER_VALUE env var. */
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

export interface SupportedAssetPolicy {
  address: string;
  name: string;
  market_rate_num: number;
  market_rate_den: number;
  fee_bips: number;
}

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

export interface AdminAuthConfig {
  enabled: boolean;
  apiKey?: string;
  apiKeyHeader: string;
}

export interface RatePolicy {
  market_rate_num: number;
  market_rate_den: number;
  fee_bips: number;
}

export type Config = Omit<
  ParsedConfig,
  | "aztec_node_url"
  | "supported_assets"
  | "admin_api_key_header"
  | "quote_auth_mode"
  | "quote_auth_api_key_header"
  | "quote_auth_trusted_header_name"
  | "quote_rate_limit_enabled"
  | "quote_rate_limit_max_requests"
  | "quote_rate_limit_window_seconds"
  | "quote_rate_limit_max_tracked_keys"
> & {
  runtime_profile: RuntimeProfile;
  aztec_node_url: string;
  operator_secret_key: string;
  operator_secret_key_source: SecretSource;
  operator_secret_key_provider: SecretProvider;
  operator_secret_key_dual_source: boolean;
  admin_auth: AdminAuthConfig;
  supported_assets: SupportedAssetPolicy[];
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

  throw new Error(`Invalid ${envName}: expected boolean value (true/false, 1/0, yes/no, on/off)`);
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
    throw new Error(`Invalid ${envName}: expected integer in range [${min}, ${max}]`);
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

export function modeNeedsApiKey(mode: QuoteAuthMode): boolean {
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

interface QuoteAuthInputs {
  mode: QuoteAuthMode;
  apiKey?: string;
  apiKeyHeader: string;
  trustedHeaderName?: string;
  trustedHeaderValue?: string;
}

function resolveQuoteAuthInputs(config: ParsedConfig): QuoteAuthInputs {
  const mode = parseQuoteAuthMode(config.quote_auth_mode, process.env.QUOTE_AUTH_MODE);
  const apiKey = normalizeOptional(process.env.QUOTE_AUTH_API_KEY);
  const apiKeyHeader = normalizeHeaderName(
    process.env.QUOTE_AUTH_API_KEY_HEADER ?? config.quote_auth_api_key_header,
    "quote auth api key",
  );
  const trustedHeaderNameRaw = normalizeOptional(
    process.env.QUOTE_AUTH_TRUSTED_HEADER_NAME ?? config.quote_auth_trusted_header_name,
  );
  const trustedHeaderValue = normalizeOptional(process.env.QUOTE_AUTH_TRUSTED_HEADER_VALUE);
  const trustedHeaderName = trustedHeaderNameRaw
    ? normalizeHeaderName(trustedHeaderNameRaw, "quote auth trusted upstream")
    : undefined;

  return {
    mode,
    apiKey,
    apiKeyHeader,
    trustedHeaderName,
    trustedHeaderValue,
  };
}

function validateQuoteAuthMode(mode: QuoteAuthMode, runtimeProfile: RuntimeProfile): void {
  if (runtimeProfile !== "production" || mode !== "disabled") {
    return;
  }
  throw new Error(
    "Insecure quote auth configuration: quote_auth_mode must not be disabled when runtime_profile=production",
  );
}

function validateQuoteAuthApiKey(mode: QuoteAuthMode, apiKey: string | undefined): void {
  const requiresApiKey = modeNeedsApiKey(mode);
  if (requiresApiKey === Boolean(apiKey)) {
    return;
  }
  if (requiresApiKey) {
    throw new Error(
      `Missing quote auth API key: set quote_auth_api_key (or QUOTE_AUTH_API_KEY) when quote_auth_mode=${mode}`,
    );
  }
  throw new Error(
    `Unexpected quote auth API key: quote_auth_mode=${mode} does not use API key auth`,
  );
}

function validateQuoteAuthTrustedHeader(
  mode: QuoteAuthMode,
  trustedHeaderName: string | undefined,
  trustedHeaderValue: string | undefined,
  apiKeyHeader: string,
): void {
  const requiresTrustedHeader = modeNeedsTrustedHeader(mode);
  if (!requiresTrustedHeader) {
    if (!trustedHeaderName && !trustedHeaderValue) {
      return;
    }
    throw new Error(
      `Unexpected trusted upstream auth config: quote_auth_mode=${mode} does not use trusted header auth`,
    );
  }

  if (!trustedHeaderName || !trustedHeaderValue) {
    throw new Error(
      `Missing trusted upstream auth header config: set quote_auth_trusted_header_name and quote_auth_trusted_header_value (or env overrides) when quote_auth_mode=${mode}`,
    );
  }
  if (mode === "api_key_and_trusted_header" && trustedHeaderName === apiKeyHeader) {
    throw new Error(
      "Invalid quote auth header config: quote_auth_api_key_header and quote_auth_trusted_header_name must differ when quote_auth_mode=api_key_and_trusted_header",
    );
  }
}

function resolveQuoteAuthConfig(
  config: ParsedConfig,
  runtimeProfile: RuntimeProfile,
): QuoteAuthConfig {
  const { mode, apiKey, apiKeyHeader, trustedHeaderName, trustedHeaderValue } =
    resolveQuoteAuthInputs(config);

  validateQuoteAuthMode(mode, runtimeProfile);
  validateQuoteAuthApiKey(mode, apiKey);
  validateQuoteAuthTrustedHeader(mode, trustedHeaderName, trustedHeaderValue, apiKeyHeader);

  return {
    mode,
    apiKey,
    apiKeyHeader,
    trustedHeaderName,
    trustedHeaderValue,
  };
}

function resolveQuoteRateLimitConfig(config: ParsedConfig): QuoteRateLimitConfig {
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

function normalizeAddress(value: string): string {
  return AztecAddress.fromString(value).toString().toLowerCase();
}

export function normalizeAztecAddress(value: string): string {
  return normalizeAddress(value);
}

function resolveAdminAuthConfig(config: ParsedConfig): AdminAuthConfig {
  const apiKey = normalizeOptional(process.env.ADMIN_API_KEY);
  const apiKeyHeader = normalizeHeaderName(
    process.env.ADMIN_API_KEY_HEADER ?? config.admin_api_key_header,
    "admin api key",
  );

  if (!apiKey) {
    return {
      enabled: false,
      apiKey: undefined,
      apiKeyHeader,
    };
  }

  AdminApiKeySchema.parse(apiKey);
  return {
    enabled: true,
    apiKey,
    apiKeyHeader,
  };
}

function resolveSupportedAssets(config: ParsedConfig): SupportedAssetPolicy[] {
  if (!config.supported_assets) {
    return [];
  }

  const resolvedAssets: SupportedAssetPolicy[] = [];
  const seenAddresses = new Set<string>();

  for (const asset of config.supported_assets) {
    const normalizedAddress = normalizeAddress(asset.address);
    if (seenAddresses.has(normalizedAddress)) {
      throw new Error(`Duplicate supported asset address in config: ${normalizedAddress}`);
    }
    seenAddresses.add(normalizedAddress);

    resolvedAssets.push({
      address: normalizedAddress,
      name: asset.name,
      market_rate_num: asset.market_rate_num,
      market_rate_den: asset.market_rate_den,
      fee_bips: asset.fee_bips,
    });
  }

  return resolvedAssets;
}

export function loadConfig(path: string, options: LoadConfigOptions = {}): Config {
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
    configValue: undefined,
    secretRef: process.env.OPERATOR_SECRET_REF ?? config.operator_secret_ref,
    adapters: options.secretAdapters,
  });

  OperatorSecretKeySchema.parse(resolvedSecret.value);
  const aztecNodeUrl = AztecNodeUrlSchema.parse(
    process.env.AZTEC_NODE_URL ?? config.aztec_node_url,
  );
  const supportedAssets = resolveSupportedAssets(config);
  const adminAuth = resolveAdminAuthConfig(config);
  const quoteAuth = resolveQuoteAuthConfig(config, runtimeProfile);
  const quoteRateLimit = resolveQuoteRateLimitConfig(config);
  const {
    admin_api_key_header: _adminApiKeyHeader,
    quote_auth_mode: _quoteAuthMode,
    quote_auth_api_key_header: _quoteAuthApiKeyHeader,
    quote_auth_trusted_header_name: _quoteAuthTrustedHeaderName,
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
    supported_assets: supportedAssets,
    operator_secret_key: resolvedSecret.value,
    operator_secret_key_source: resolvedSecret.source,
    operator_secret_key_provider: resolvedSecret.provider,
    operator_secret_key_dual_source: resolvedSecret.dualSource,
    operator_account_salt:
      process.env.OPERATOR_ACCOUNT_SALT?.trim() || config.operator_account_salt || undefined,
    asset_policy_state_path:
      process.env.ATTESTATION_ASSET_POLICY_STATE_PATH ?? config.asset_policy_state_path,
    treasury_destination_address:
      process.env.TREASURY_DESTINATION_ADDRESS ?? config.treasury_destination_address,
    admin_auth: adminAuth,
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
export function computeFinalRate(config: RatePolicy): {
  rate_num: bigint;
  rate_den: bigint;
} {
  const rate_num = BigInt(config.market_rate_num) * BigInt(10000 + config.fee_bips);
  const rate_den = BigInt(config.market_rate_den) * BigInt(10000);
  return { rate_num, rate_den };
}
