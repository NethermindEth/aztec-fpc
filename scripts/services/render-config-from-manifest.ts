import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DevnetDeployManifest,
  validateDevnetDeployManifest,
} from "../contract/devnet-manifest.ts";

type RuntimeProfile = "development" | "test" | "production";
type SecretProvider = "auto" | "env" | "config" | "kms" | "hsm";

type CliArgs = {
  manifestPath: string;
  attestationOutPath: string;
  topupOutPath: string;
  runtimeProfile: RuntimeProfile;
  l1RpcUrl: string;
  acceptedAssetName: string;
  marketRateNum: number;
  marketRateDen: number;
  feeBips: number;
  quoteValiditySeconds: number;
  attestationPort: number;
  operatorSecretProvider: SecretProvider;
  operatorSecretKey: string | null;
  operatorSecretRef: string | null;
  threshold: string;
  topUpAmount: string;
  bridgeStatePath: string;
  topupOpsPort: number;
  topupCheckIntervalMs: number;
  topupConfirmTimeoutMs: number;
  topupConfirmPollInitialMs: number;
  topupConfirmPollMaxMs: number;
  l1OperatorSecretProvider: SecretProvider;
  l1OperatorPrivateKey: string | null;
  l1OperatorSecretRef: string | null;
};

type CliParseResult =
  | {
      kind: "help";
    }
  | {
      kind: "args";
      args: CliArgs;
    };

type SecretMaterial = {
  privateKey: string | null;
  secretRef: string | null;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "deployments",
  "devnet-manifest-v2.json",
);
const DEFAULT_ATTESTATION_OUT_PATH = path.join(
  REPO_ROOT,
  "services",
  "attestation",
  "config.yaml",
);
const DEFAULT_TOPUP_OUT_PATH = path.join(
  REPO_ROOT,
  "services",
  "topup",
  "config.yaml",
);

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const RUNTIME_PROFILES = new Set<RuntimeProfile>([
  "development",
  "test",
  "production",
]);
const SECRET_PROVIDERS = new Set<SecretProvider>([
  "auto",
  "env",
  "config",
  "kms",
  "hsm",
]);

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/services/render-config-from-manifest.ts \\",
    "    [--manifest <path.json>] \\",
    "    --l1-rpc-url <http(s)-url> \\",
    "    [--attestation-out <path.yaml>] \\",
    "    [--topup-out <path.yaml>] \\",
    "    [--runtime-profile <development|test|production>] \\",
    "    [--accepted-asset-name <name>] \\",
    "    [--market-rate-num <positive_integer>] \\",
    "    [--market-rate-den <positive_integer>] \\",
    "    [--fee-bips <0..10000>] \\",
    "    [--quote-validity-seconds <positive_integer>] \\",
    "    [--attestation-port <1..65535>] \\",
    "    [--operator-secret-provider <auto|env|config|kms|hsm>] \\",
    "    [--operator-secret-key <hex32> | --operator-secret-ref <ref>] \\",
    "    [--threshold <uint_string>] \\",
    "    [--top-up-amount <uint_string>] \\",
    "    [--bridge-state-path <path>] \\",
    "    [--topup-ops-port <1..65535>] \\",
    "    [--topup-check-interval-ms <positive_integer>] \\",
    "    [--topup-confirm-timeout-ms <positive_integer>] \\",
    "    [--topup-confirm-poll-initial-ms <positive_integer>] \\",
    "    [--topup-confirm-poll-max-ms <positive_integer>] \\",
    "    [--l1-operator-secret-provider <auto|env|config|kms|hsm>] \\",
    "    [--l1-operator-private-key <hex32> | --l1-operator-secret-ref <ref>]",
    "",
    "Defaults:",
    `  --manifest ${DEFAULT_MANIFEST_PATH}`,
    `  --attestation-out ${DEFAULT_ATTESTATION_OUT_PATH}`,
    `  --topup-out ${DEFAULT_TOPUP_OUT_PATH}`,
    "  --runtime-profile development",
    "  --accepted-asset-name FpcAcceptedAsset",
    "  --market-rate-num 1",
    "  --market-rate-den 1000",
    "  --fee-bips 200",
    "  --quote-validity-seconds 300",
    "  --attestation-port 3000",
    "  --operator-secret-provider auto",
    "  --threshold 1000000000000000000",
    "  --top-up-amount 10000000000000000000",
    "  --bridge-state-path .topup-bridge-state.json",
    "  --topup-ops-port 3001",
    "  --topup-check-interval-ms 60000",
    "  --topup-confirm-timeout-ms 180000",
    "  --topup-confirm-poll-initial-ms 1000",
    "  --topup-confirm-poll-max-ms 15000",
    "  --l1-operator-secret-provider auto",
    "",
    "Environment fallbacks:",
    "  FPC_DEVNET_RENDER_MANIFEST",
    "  FPC_DEVNET_RENDER_ATTESTATION_OUT",
    "  FPC_DEVNET_RENDER_TOPUP_OUT",
    "  FPC_RUNTIME_PROFILE",
    "  FPC_DEVNET_L1_RPC_URL (or L1_RPC_URL)",
    "  FPC_DEVNET_ACCEPTED_ASSET_NAME",
    "  FPC_DEVNET_MARKET_RATE_NUM",
    "  FPC_DEVNET_MARKET_RATE_DEN",
    "  FPC_DEVNET_FEE_BIPS",
    "  FPC_DEVNET_QUOTE_VALIDITY_SECONDS",
    "  FPC_DEVNET_ATTESTATION_PORT",
    "  OPERATOR_SECRET_PROVIDER",
    "  OPERATOR_SECRET_KEY",
    "  OPERATOR_SECRET_REF",
    "  FPC_DEVNET_TOPUP_THRESHOLD",
    "  FPC_DEVNET_TOPUP_AMOUNT",
    "  TOPUP_BRIDGE_STATE_PATH",
    "  TOPUP_OPS_PORT",
    "  FPC_DEVNET_TOPUP_CHECK_INTERVAL_MS",
    "  FPC_DEVNET_TOPUP_CONFIRM_TIMEOUT_MS",
    "  FPC_DEVNET_TOPUP_CONFIRM_POLL_INITIAL_MS",
    "  FPC_DEVNET_TOPUP_CONFIRM_POLL_MAX_MS",
    "  L1_OPERATOR_SECRET_PROVIDER",
    "  L1_OPERATOR_PRIVATE_KEY",
    "  L1_OPERATOR_SECRET_REF",
    "",
    "Secret behavior:",
    "  - If operator key/ref is not provided, the script reuses l2_deployer key material from the manifest when operator.address == l2_deployer.address.",
    "  - If L1 topup operator key/ref is not provided, the script reuses deployment_accounts.l1_topup_operator key material from the manifest.",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseRuntimeProfile(value: string, fieldName: string): RuntimeProfile {
  if (!RUNTIME_PROFILES.has(value as RuntimeProfile)) {
    throw new CliError(
      `Invalid ${fieldName}: expected one of development, test, production`,
    );
  }
  return value as RuntimeProfile;
}

function parseSecretProvider(value: string, fieldName: string): SecretProvider {
  if (!SECRET_PROVIDERS.has(value as SecretProvider)) {
    throw new CliError(
      `Invalid ${fieldName}: expected one of auto, env, config, kms, hsm`,
    );
  }
  return value as SecretProvider;
}

function parseHttpUrl(value: string, fieldName: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError(`Invalid ${fieldName}: expected http(s) URL`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Invalid ${fieldName}: expected URL`);
  }
}

function parseNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new CliError(`Invalid ${fieldName}: expected non-empty string`);
  }
  return normalized;
}

function parseUnsignedIntegerString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!UINT_DECIMAL_PATTERN.test(normalized)) {
    throw new CliError(`Invalid ${fieldName}: expected unsigned integer`);
  }
  if (BigInt(normalized) <= 0n) {
    throw new CliError(`Invalid ${fieldName}: expected value > 0`);
  }
  return normalized;
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const normalized = value.trim();
  if (!UINT_DECIMAL_PATTERN.test(normalized)) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  return parsed;
}

function parsePort(value: string, fieldName: string): number {
  const parsed = parsePositiveInteger(value, fieldName);
  if (parsed > 65535) {
    throw new CliError(
      `Invalid ${fieldName}: expected value in range 1..65535`,
    );
  }
  return parsed;
}

function parseFeeBips(value: string, fieldName: string): number {
  const normalized = value.trim();
  if (!UINT_DECIMAL_PATTERN.test(normalized)) {
    throw new CliError(
      `Invalid ${fieldName}: expected integer in range 0..10000`,
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10000) {
    throw new CliError(
      `Invalid ${fieldName}: expected integer in range 0..10000`,
    );
  }
  return parsed;
}

function parsePrivateKey(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!PRIVATE_KEY_PATTERN.test(normalized)) {
    throw new CliError(
      `Invalid ${fieldName}: expected 32-byte 0x-prefixed private key`,
    );
  }
  return normalized;
}

function readEnvString(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseCliArgs(argv: string[]): CliParseResult {
  let manifestPath =
    readEnvString("FPC_DEVNET_RENDER_MANIFEST") ?? DEFAULT_MANIFEST_PATH;
  let attestationOutPath =
    readEnvString("FPC_DEVNET_RENDER_ATTESTATION_OUT") ??
    DEFAULT_ATTESTATION_OUT_PATH;
  let topupOutPath =
    readEnvString("FPC_DEVNET_RENDER_TOPUP_OUT") ?? DEFAULT_TOPUP_OUT_PATH;
  let runtimeProfile = parseRuntimeProfile(
    readEnvString("FPC_RUNTIME_PROFILE") ?? "development",
    "FPC_RUNTIME_PROFILE",
  );
  const l1RpcUrlEnv =
    readEnvString("FPC_DEVNET_L1_RPC_URL") ?? readEnvString("L1_RPC_URL");
  let l1RpcUrl = l1RpcUrlEnv ? parseHttpUrl(l1RpcUrlEnv, "L1_RPC_URL") : null;
  let acceptedAssetName =
    readEnvString("FPC_DEVNET_ACCEPTED_ASSET_NAME") ?? "FpcAcceptedAsset";
  let marketRateNum = parsePositiveInteger(
    readEnvString("FPC_DEVNET_MARKET_RATE_NUM") ?? "1",
    "FPC_DEVNET_MARKET_RATE_NUM",
  );
  let marketRateDen = parsePositiveInteger(
    readEnvString("FPC_DEVNET_MARKET_RATE_DEN") ?? "1000",
    "FPC_DEVNET_MARKET_RATE_DEN",
  );
  let feeBips = parseFeeBips(
    readEnvString("FPC_DEVNET_FEE_BIPS") ?? "200",
    "FPC_DEVNET_FEE_BIPS",
  );
  let quoteValiditySeconds = parsePositiveInteger(
    readEnvString("FPC_DEVNET_QUOTE_VALIDITY_SECONDS") ?? "300",
    "FPC_DEVNET_QUOTE_VALIDITY_SECONDS",
  );
  let attestationPort = parsePort(
    readEnvString("FPC_DEVNET_ATTESTATION_PORT") ?? "3000",
    "FPC_DEVNET_ATTESTATION_PORT",
  );
  let operatorSecretProvider = parseSecretProvider(
    readEnvString("OPERATOR_SECRET_PROVIDER") ?? "auto",
    "OPERATOR_SECRET_PROVIDER",
  );
  let operatorSecretKey = readEnvString("OPERATOR_SECRET_KEY");
  let operatorSecretRef = readEnvString("OPERATOR_SECRET_REF");
  let threshold = parseUnsignedIntegerString(
    readEnvString("FPC_DEVNET_TOPUP_THRESHOLD") ?? "1000000000000000000",
    "FPC_DEVNET_TOPUP_THRESHOLD",
  );
  let topUpAmount = parseUnsignedIntegerString(
    readEnvString("FPC_DEVNET_TOPUP_AMOUNT") ?? "10000000000000000000",
    "FPC_DEVNET_TOPUP_AMOUNT",
  );
  let bridgeStatePath =
    readEnvString("TOPUP_BRIDGE_STATE_PATH") ?? ".topup-bridge-state.json";
  let topupOpsPort = parsePort(
    readEnvString("TOPUP_OPS_PORT") ?? "3001",
    "TOPUP_OPS_PORT",
  );
  let topupCheckIntervalMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_TOPUP_CHECK_INTERVAL_MS") ?? "60000",
    "FPC_DEVNET_TOPUP_CHECK_INTERVAL_MS",
  );
  let topupConfirmTimeoutMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_TOPUP_CONFIRM_TIMEOUT_MS") ?? "180000",
    "FPC_DEVNET_TOPUP_CONFIRM_TIMEOUT_MS",
  );
  let topupConfirmPollInitialMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_TOPUP_CONFIRM_POLL_INITIAL_MS") ?? "1000",
    "FPC_DEVNET_TOPUP_CONFIRM_POLL_INITIAL_MS",
  );
  let topupConfirmPollMaxMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_TOPUP_CONFIRM_POLL_MAX_MS") ?? "15000",
    "FPC_DEVNET_TOPUP_CONFIRM_POLL_MAX_MS",
  );
  let l1OperatorSecretProvider = parseSecretProvider(
    readEnvString("L1_OPERATOR_SECRET_PROVIDER") ?? "auto",
    "L1_OPERATOR_SECRET_PROVIDER",
  );
  let l1OperatorPrivateKey = readEnvString("L1_OPERATOR_PRIVATE_KEY");
  let l1OperatorSecretRef = readEnvString("L1_OPERATOR_SECRET_REF");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--manifest":
        manifestPath = path.resolve(nextArg(argv, i, arg));
        i += 1;
        break;
      case "--attestation-out":
        attestationOutPath = path.resolve(nextArg(argv, i, arg));
        i += 1;
        break;
      case "--topup-out":
        topupOutPath = path.resolve(nextArg(argv, i, arg));
        i += 1;
        break;
      case "--runtime-profile":
        runtimeProfile = parseRuntimeProfile(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--l1-rpc-url":
        l1RpcUrl = parseHttpUrl(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--accepted-asset-name":
        acceptedAssetName = parseNonEmptyString(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--market-rate-num":
        marketRateNum = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--market-rate-den":
        marketRateDen = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--fee-bips":
        feeBips = parseFeeBips(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--quote-validity-seconds":
        quoteValiditySeconds = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--attestation-port":
        attestationPort = parsePort(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--operator-secret-provider":
        operatorSecretProvider = parseSecretProvider(
          nextArg(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--operator-secret-key":
        operatorSecretKey = parsePrivateKey(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--operator-secret-ref":
        operatorSecretRef = parseNonEmptyString(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--threshold":
        threshold = parseUnsignedIntegerString(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--top-up-amount":
        topUpAmount = parseUnsignedIntegerString(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--bridge-state-path":
        bridgeStatePath = parseNonEmptyString(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--topup-ops-port":
        topupOpsPort = parsePort(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--topup-check-interval-ms":
        topupCheckIntervalMs = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--topup-confirm-timeout-ms":
        topupConfirmTimeoutMs = parsePositiveInteger(
          nextArg(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--topup-confirm-poll-initial-ms":
        topupConfirmPollInitialMs = parsePositiveInteger(
          nextArg(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--topup-confirm-poll-max-ms":
        topupConfirmPollMaxMs = parsePositiveInteger(
          nextArg(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--l1-operator-secret-provider":
        l1OperatorSecretProvider = parseSecretProvider(
          nextArg(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--l1-operator-private-key":
        l1OperatorPrivateKey = parsePrivateKey(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--l1-operator-secret-ref":
        l1OperatorSecretRef = parseNonEmptyString(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!l1RpcUrl) {
    throw new CliError(
      "Missing L1 RPC URL. Provide --l1-rpc-url or set FPC_DEVNET_L1_RPC_URL (or L1_RPC_URL).",
    );
  }

  if (topupConfirmPollInitialMs > topupConfirmPollMaxMs) {
    throw new CliError(
      "Invalid topup polling config: topup-confirm-poll-initial-ms must be <= topup-confirm-poll-max-ms",
    );
  }
  if (topupConfirmPollMaxMs > topupConfirmTimeoutMs) {
    throw new CliError(
      "Invalid topup polling config: topup-confirm-poll-max-ms must be <= topup-confirm-timeout-ms",
    );
  }

  return {
    kind: "args",
    args: {
      manifestPath: path.resolve(manifestPath),
      attestationOutPath: path.resolve(attestationOutPath),
      topupOutPath: path.resolve(topupOutPath),
      runtimeProfile,
      l1RpcUrl,
      acceptedAssetName,
      marketRateNum,
      marketRateDen,
      feeBips,
      quoteValiditySeconds,
      attestationPort,
      operatorSecretProvider,
      operatorSecretKey,
      operatorSecretRef,
      threshold,
      topUpAmount,
      bridgeStatePath,
      topupOpsPort,
      topupCheckIntervalMs,
      topupConfirmTimeoutMs,
      topupConfirmPollInitialMs,
      topupConfirmPollMaxMs,
      l1OperatorSecretProvider,
      l1OperatorPrivateKey,
      l1OperatorSecretRef,
    },
  };
}

function readManifestFromDisk(manifestPath: string): DevnetDeployManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new CliError(
      `Failed to read manifest at ${manifestPath}: ${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError(
      `Manifest at ${manifestPath} is not valid JSON: ${String(error)}`,
    );
  }

  try {
    return validateDevnetDeployManifest(parsed);
  } catch (error) {
    throw new CliError(
      `Manifest validation failed for ${manifestPath}: ${String(error)}`,
    );
  }
}

function resolveSingleSecretMaterial(
  overrides: SecretMaterial,
  fallback: SecretMaterial,
  errorContext: string,
): SecretMaterial {
  if (overrides.privateKey && overrides.secretRef) {
    throw new CliError(
      `Ambiguous ${errorContext}: provide only one of private key or secret ref override`,
    );
  }
  if (fallback.privateKey && fallback.secretRef) {
    throw new CliError(
      `Invalid manifest ${errorContext}: both private_key and private_key_ref are set`,
    );
  }

  if (overrides.privateKey || overrides.secretRef) {
    return overrides;
  }
  if (fallback.privateKey || fallback.secretRef) {
    return fallback;
  }

  throw new CliError(
    `Missing ${errorContext}. Provide a CLI override or include key material in the deployment manifest.`,
  );
}

function resolveAttestationSecretMaterial(
  manifest: DevnetDeployManifest,
  args: CliArgs,
): SecretMaterial {
  const operatorMatchesDeployer =
    manifest.operator.address.toLowerCase() ===
    manifest.deployment_accounts.l2_deployer.address.toLowerCase();

  const fallback: SecretMaterial = operatorMatchesDeployer
    ? {
        privateKey:
          manifest.deployment_accounts.l2_deployer.private_key ?? null,
        secretRef:
          manifest.deployment_accounts.l2_deployer.private_key_ref ?? null,
      }
    : {
        privateKey: null,
        secretRef: null,
      };

  const resolved = resolveSingleSecretMaterial(
    {
      privateKey: args.operatorSecretKey,
      secretRef: args.operatorSecretRef,
    },
    fallback,
    "operator secret",
  );

  if (
    !operatorMatchesDeployer &&
    !args.operatorSecretKey &&
    !args.operatorSecretRef
  ) {
    throw new CliError(
      "Manifest operator address differs from l2_deployer. Provide --operator-secret-key or --operator-secret-ref explicitly.",
    );
  }

  return resolved;
}

function resolveTopupSecretMaterial(
  manifest: DevnetDeployManifest,
  args: CliArgs,
): SecretMaterial {
  return resolveSingleSecretMaterial(
    {
      privateKey: args.l1OperatorPrivateKey,
      secretRef: args.l1OperatorSecretRef,
    },
    {
      privateKey:
        manifest.deployment_accounts.l1_topup_operator?.private_key ?? null,
      secretRef:
        manifest.deployment_accounts.l1_topup_operator?.private_key_ref ?? null,
    },
    "L1 topup operator secret",
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderAttestationYaml(params: {
  manifest: DevnetDeployManifest;
  args: CliArgs;
  operatorSecret: SecretMaterial;
}): string {
  const { manifest, args, operatorSecret } = params;
  const lines = [
    "# Generated by scripts/services/render-config-from-manifest.ts",
    `# Source manifest: ${args.manifestPath}`,
    `runtime_profile: ${yamlString(args.runtimeProfile)}`,
    `fpc_address: ${yamlString(manifest.contracts.fpc)}`,
    `aztec_node_url: ${yamlString(manifest.network.node_url)}`,
    `quote_validity_seconds: ${args.quoteValiditySeconds}`,
    `port: ${args.attestationPort}`,
    `accepted_asset_name: ${yamlString(args.acceptedAssetName)}`,
    `accepted_asset_address: ${yamlString(manifest.contracts.accepted_asset)}`,
    `market_rate_num: ${args.marketRateNum}`,
    `market_rate_den: ${args.marketRateDen}`,
    `fee_bips: ${args.feeBips}`,
    `operator_secret_provider: ${yamlString(args.operatorSecretProvider)}`,
    `operator_address: ${yamlString(manifest.operator.address)}`,
  ];

  if (operatorSecret.privateKey) {
    lines.push(`operator_secret_key: ${yamlString(operatorSecret.privateKey)}`);
  } else if (operatorSecret.secretRef) {
    lines.push(`operator_secret_ref: ${yamlString(operatorSecret.secretRef)}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderTopupYaml(params: {
  manifest: DevnetDeployManifest;
  args: CliArgs;
  l1OperatorSecret: SecretMaterial;
}): string {
  const { manifest, args, l1OperatorSecret } = params;
  const lines = [
    "# Generated by scripts/services/render-config-from-manifest.ts",
    `# Source manifest: ${args.manifestPath}`,
    `runtime_profile: ${yamlString(args.runtimeProfile)}`,
    `fpc_address: ${yamlString(manifest.contracts.fpc)}`,
    `aztec_node_url: ${yamlString(manifest.network.node_url)}`,
    `l1_rpc_url: ${yamlString(args.l1RpcUrl)}`,
    `l1_operator_secret_provider: ${yamlString(args.l1OperatorSecretProvider)}`,
    `threshold: ${yamlString(args.threshold)}`,
    `top_up_amount: ${yamlString(args.topUpAmount)}`,
    `bridge_state_path: ${yamlString(args.bridgeStatePath)}`,
    `ops_port: ${args.topupOpsPort}`,
    `check_interval_ms: ${args.topupCheckIntervalMs}`,
    `confirmation_timeout_ms: ${args.topupConfirmTimeoutMs}`,
    `confirmation_poll_initial_ms: ${args.topupConfirmPollInitialMs}`,
    `confirmation_poll_max_ms: ${args.topupConfirmPollMaxMs}`,
  ];

  if (l1OperatorSecret.privateKey) {
    lines.push(
      `l1_operator_private_key: ${yamlString(l1OperatorSecret.privateKey)}`,
    );
  } else if (l1OperatorSecret.secretRef) {
    lines.push(
      `l1_operator_secret_ref: ${yamlString(l1OperatorSecret.secretRef)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function writeOutputFile(targetPath: string, content: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
}

function main(argv: string[]): void {
  const parseResult = parseCliArgs(argv);
  if (parseResult.kind === "help") {
    return;
  }

  const args = parseResult.args;
  const manifest = readManifestFromDisk(args.manifestPath);
  const operatorSecret = resolveAttestationSecretMaterial(manifest, args);
  const l1OperatorSecret = resolveTopupSecretMaterial(manifest, args);

  const attestationYaml = renderAttestationYaml({
    manifest,
    args,
    operatorSecret,
  });
  const topupYaml = renderTopupYaml({
    manifest,
    args,
    l1OperatorSecret,
  });

  writeOutputFile(args.attestationOutPath, attestationYaml);
  writeOutputFile(args.topupOutPath, topupYaml);

  console.log(
    `[render-config-from-manifest] wrote attestation config: ${args.attestationOutPath}`,
  );
  console.log(
    `[render-config-from-manifest] wrote topup config: ${args.topupOutPath}`,
  );
  console.log(
    `[render-config-from-manifest] contracts: accepted_asset=${manifest.contracts.accepted_asset} fpc=${manifest.contracts.fpc} credit_fpc=${manifest.contracts.credit_fpc}`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    console.error(`[render-config-from-manifest] ERROR: ${error.message}`);
    console.error("");
    console.error(usage());
  } else {
    console.error("[render-config-from-manifest] Unexpected error:", error);
  }
  process.exit(1);
}
