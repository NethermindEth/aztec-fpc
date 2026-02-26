import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import {
  type RuntimeProfile,
  resolveSecret,
  type SecretAdapterRegistry,
  type SecretProvider,
  type SecretSource,
} from "./secret-provider.js";

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const RuntimeProfileSchema = z.enum(["development", "test", "production"]);
const SecretProviderSchema = z.enum(["auto", "env", "config", "kms", "hsm"]);

const PositiveBigIntString = z
  .string()
  .regex(UINT_DECIMAL_PATTERN, "must be an unsigned integer string")
  .refine((value) => BigInt(value) > 0n, "must be greater than zero");

const PrivateKeySchema = z
  .string()
  .regex(PRIVATE_KEY_PATTERN, "must be a 32-byte 0x-prefixed hex private key");

const ConfigSchema = z
  .object({
    runtime_profile: RuntimeProfileSchema.default("development"),
    fpc_address: z
      .string()
      .regex(
        AZTEC_ADDRESS_PATTERN,
        "must be a 32-byte 0x-prefixed hex address",
      ),
    aztec_node_url: z.string().url(),
    l1_rpc_url: z.string().url(),
    /** Secret provider strategy for L1 bridge key. */
    l1_operator_secret_provider: SecretProviderSchema.default("auto"),
    /** Reference used by external secret providers (kms/hsm). */
    l1_operator_secret_ref: z.string().optional(),
    /** Optional when L1_OPERATOR_PRIVATE_KEY is provided via env. */
    l1_operator_private_key: z.string().optional(),
    /** Bridge when FPC balance drops below this (bigint string, wei units). */
    threshold: PositiveBigIntString,
    /** Amount to bridge per top-up (bigint string, wei units). */
    top_up_amount: PositiveBigIntString,
    check_interval_ms: z.number().int().positive().default(60_000),
    confirmation_timeout_ms: z.number().int().positive().default(180_000),
    confirmation_poll_initial_ms: z.number().int().positive().default(1_000),
    confirmation_poll_max_ms: z.number().int().positive().default(15_000),
  })
  .superRefine((config, ctx) => {
    if (config.confirmation_poll_initial_ms > config.confirmation_poll_max_ms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "confirmation_poll_initial_ms must be less than or equal to confirmation_poll_max_ms",
        path: ["confirmation_poll_initial_ms"],
      });
    }

    if (config.confirmation_poll_max_ms > config.confirmation_timeout_ms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "confirmation_poll_max_ms must be less than or equal to confirmation_timeout_ms",
        path: ["confirmation_poll_max_ms"],
      });
    }
  });

type ParsedConfig = z.infer<typeof ConfigSchema>;

export type Config = Omit<ParsedConfig, "l1_operator_private_key"> & {
  runtime_profile: RuntimeProfile;
  l1_operator_private_key: string;
  l1_operator_private_key_source: SecretSource;
  l1_operator_private_key_provider: SecretProvider;
  l1_operator_private_key_dual_source: boolean;
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
    config.l1_operator_secret_provider,
    process.env.L1_OPERATOR_SECRET_PROVIDER,
  );
  const resolvedSecret = resolveSecret({
    secretLabel: "L1 operator private key",
    provider: secretProvider,
    runtimeProfile,
    envVarName: "L1_OPERATOR_PRIVATE_KEY",
    envValue: process.env.L1_OPERATOR_PRIVATE_KEY,
    configValue: config.l1_operator_private_key,
    secretRef:
      process.env.L1_OPERATOR_SECRET_REF ?? config.l1_operator_secret_ref,
    adapters: options.secretAdapters,
  });

  PrivateKeySchema.parse(resolvedSecret.value);

  return {
    ...config,
    runtime_profile: runtimeProfile,
    aztec_node_url: process.env.AZTEC_NODE_URL ?? config.aztec_node_url,
    l1_rpc_url: process.env.L1_RPC_URL ?? config.l1_rpc_url,
    l1_operator_private_key: resolvedSecret.value,
    l1_operator_private_key_source: resolvedSecret.source,
    l1_operator_private_key_provider: resolvedSecret.provider,
    l1_operator_private_key_dual_source: resolvedSecret.dualSource,
  };
}
