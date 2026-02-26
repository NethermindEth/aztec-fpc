import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import {
  resolveSecret,
  type RuntimeProfile,
  type SecretAdapterRegistry,
  type SecretProvider,
  type SecretSource,
} from "./secret-provider.js";

export const MAX_QUOTE_VALIDITY_SECONDS = 3600;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const OperatorSecretKeySchema = z
  .string()
  .regex(PRIVATE_KEY_PATTERN, "must be a 32-byte 0x-prefixed hex private key");
const RuntimeProfileSchema = z.enum(["development", "test", "production"]);
const SecretProviderSchema = z.enum(["auto", "env", "config", "kms", "hsm"]);

const ConfigSchema = z.object({
  runtime_profile: RuntimeProfileSchema.default("development"),
  fpc_address: z.string(),
  aztec_node_url: z.string().url(),
  quote_validity_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_QUOTE_VALIDITY_SECONDS)
    .default(300),
  port: z.number().int().positive().default(3000),
  /** The single token contract address this FPC accepts. Must match accepted_asset in the deployed contract. */
  accepted_asset_address: z.string(),
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
  /** Optional when OPERATOR_SECRET_KEY is provided via env. */
  operator_secret_key: z.string().optional(),
  /** Optional directory for local PXE persistent state (LMDB).
   *  When set, the service spins up a local PXE so it can call
   *  registerSender() and discover private fee-payment notes. */
  pxe_data_directory: z.string().optional(),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;

export type Config = Omit<ParsedConfig, "operator_secret_key"> & {
  runtime_profile: RuntimeProfile;
  operator_secret_key: string;
  operator_secret_key_source: SecretSource;
  operator_secret_key_provider: SecretProvider;
  operator_secret_key_dual_source: boolean;
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

  return {
    ...config,
    runtime_profile: runtimeProfile,
    operator_secret_key: resolvedSecret.value,
    operator_secret_key_source: resolvedSecret.source,
    operator_secret_key_provider: resolvedSecret.provider,
    operator_secret_key_dual_source: resolvedSecret.dualSource,
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
