/**
 * CLI types and parsing for cold-start-smoke.
 *
 * Exports:
 *   - CliArgs        — parsed argument bag
 *   - CliParseResult  — discriminated union (help | args)
 *   - CliError        — thrown on invalid input
 *   - parseCliArgs()  — parse process.argv
 *   - usage()         — help text
 */

import path from "node:path";
import pino from "pino";

const pinoLogger = pino();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CliArgs = {
  nodeUrl: string;
  l1RpcUrl: string;
  attestationUrl: string;
  manifestPath: string;
  operatorSecretKey: string;
  l1DeployerKey: string | null;
  userL1PrivateKey: string | null;
  claimAmount: bigint;
  aaPaymentAmount: bigint;
  quoteTtlSeconds: bigint;
  proverEnabled: boolean;
  messageTimeoutSeconds: number;
};

export type CliParseResult = { kind: "help" } | { kind: "args"; args: CliArgs };

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/cold-start/cold-start-smoke.ts [options]",
    "",
    "All arguments are optional. CLI args take precedence over env vars.",
    "",
    "Required (via env or CLI):",
    "  --l1-rpc-url <url>               L1 RPC URL [env: L1_RPC_URL]",
    "  --attestation-url <url>          Attestation server base URL [env: FPC_ATTESTATION_URL]",
    "  --manifest <path>                Deployment manifest path [env: FPC_COLD_START_MANIFEST]",
    "  --operator-secret-key <hex32>    Operator secret key [env: FPC_OPERATOR_SECRET_KEY]",
    "  --l1-deployer-key <hex32>        L1 deployer private key (ERC20 owner) [env: FPC_L1_DEPLOYER_KEY]",
    "",
    "Optional:",
    "  --user-l1-private-key <hex32>    Pre-funded L1 private key (skips anvil_setBalance) [env: FPC_L1_USER_KEY]",
    "",
    "Network:",
    "  --node-url <url>                 Aztec node URL (default: http://localhost:8080) [env: AZTEC_NODE_URL]",
    "",
    "Amounts:",
    "  --claim-amount <uint>            Claim amount (default: 10000000000000000) [env: FPC_COLD_START_CLAIM_AMOUNT]",
    "  --aa-payment-amount <uint>       AA payment amount (default: 1000000000) [env: FPC_COLD_START_AA_PAYMENT_AMOUNT]",
    "",
    "Timing:",
    "  --quote-ttl-seconds <uint>       Quote TTL in seconds (default: 3600) [env: FPC_SMOKE_QUOTE_TTL_SECONDS]",
    "  --message-timeout <uint>         L1→L2 message wait timeout seconds (default: 120) [env: FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS]",
    "",
    "PXE:",
    "  --pxe-prover-enabled <bool>      Enable PXE prover (default: true) [env: PXE_PROVER_ENABLED]",
    "",
    "  --help, -h                       Show this help",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Private parsing helpers
// ---------------------------------------------------------------------------

const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseHttpUrl(value: string, fieldName: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError(`Invalid ${fieldName}: expected http(s) URL, got "${value}"`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Invalid ${fieldName}: expected URL, got "${value}"`);
  }
}

function parseHex32(value: string, fieldName: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed hex value`);
  }
  return value;
}

function parsePositiveBigInt(value: string, fieldName: string): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_UINT_PATTERN.test(trimmed)) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer, got "${value}"`);
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
    throw new CliError(`Invalid ${fieldName}: must be positive`);
  }
  return parsed;
}

function parseBooleanFlag(value: string, fieldName: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "1" || lower === "true") return true;
  if (lower === "0" || lower === "false") return false;
  throw new CliError(`Invalid ${fieldName}: expected "true", "false", "1", or "0", got "${value}"`);
}

function parseNonNegativeInt(value: string, fieldName: string): number {
  const trimmed = value.trim();
  if (!DECIMAL_UINT_PATTERN.test(trimmed)) {
    throw new CliError(`Invalid ${fieldName}: expected non-negative integer, got "${value}"`);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(`Invalid ${fieldName}: expected non-negative integer, got "${value}"`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseCliArgs(argv: string[]): CliParseResult {
  let nodeUrl: string = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  let l1RpcUrl: string | null = process.env.L1_RPC_URL ?? null;
  let attestationUrl: string | null = process.env.FPC_ATTESTATION_URL ?? null;
  let manifestPath: string | null = process.env.FPC_COLD_START_MANIFEST ?? null;
  let operatorSecretKey: string | null = process.env.FPC_OPERATOR_SECRET_KEY ?? null;
  let l1DeployerKey: string | null = process.env.FPC_L1_DEPLOYER_KEY ?? null;
  let userL1PrivateKey: string | null = process.env.FPC_L1_USER_KEY ?? null;
  let claimAmount: string = process.env.FPC_COLD_START_CLAIM_AMOUNT ?? "10000000000000000";
  let aaPaymentAmount: string = process.env.FPC_COLD_START_AA_PAYMENT_AMOUNT ?? "1000000000";
  let quoteTtlSeconds: string = process.env.FPC_SMOKE_QUOTE_TTL_SECONDS ?? "3600";
  let proverEnabled = process.env.PXE_PROVER_ENABLED
    ? parseBooleanFlag(process.env.PXE_PROVER_ENABLED, "PXE_PROVER_ENABLED")
    : true;
  let messageTimeoutSeconds: string = process.env.FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS ?? "120";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--node-url":
        nodeUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--l1-rpc-url":
        l1RpcUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--attestation-url":
        attestationUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--manifest":
        manifestPath = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-secret-key":
        operatorSecretKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--l1-deployer-key":
        l1DeployerKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--user-l1-private-key":
        userL1PrivateKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--claim-amount":
        claimAmount = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--aa-payment-amount":
        aaPaymentAmount = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--quote-ttl-seconds":
        quoteTtlSeconds = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--message-timeout":
        messageTimeoutSeconds = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--pxe-prover-enabled":
        proverEnabled = parseBooleanFlag(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!l1RpcUrl) {
    throw new CliError("Missing --l1-rpc-url or L1_RPC_URL");
  }
  if (!attestationUrl) {
    throw new CliError("Missing --attestation-url or FPC_ATTESTATION_URL");
  }
  if (!manifestPath) {
    throw new CliError("Missing --manifest or FPC_COLD_START_MANIFEST");
  }
  if (!operatorSecretKey) {
    throw new CliError("Missing --operator-secret-key or FPC_OPERATOR_SECRET_KEY");
  }

  return {
    kind: "args",
    args: {
      nodeUrl: parseHttpUrl(nodeUrl, "--node-url"),
      l1RpcUrl: parseHttpUrl(l1RpcUrl, "--l1-rpc-url"),
      attestationUrl: parseHttpUrl(attestationUrl, "--attestation-url"),
      manifestPath: path.resolve(manifestPath),
      operatorSecretKey: parseHex32(operatorSecretKey, "--operator-secret-key"),
      l1DeployerKey: l1DeployerKey ? parseHex32(l1DeployerKey, "--l1-deployer-key") : null,
      userL1PrivateKey: userL1PrivateKey
        ? parseHex32(userL1PrivateKey, "--user-l1-private-key")
        : null,
      proverEnabled,
      claimAmount: parsePositiveBigInt(claimAmount, "--claim-amount"),
      aaPaymentAmount: parsePositiveBigInt(aaPaymentAmount, "--aa-payment-amount"),
      quoteTtlSeconds: parsePositiveBigInt(quoteTtlSeconds, "--quote-ttl-seconds"),
      messageTimeoutSeconds: parseNonNegativeInt(messageTimeoutSeconds, "--message-timeout"),
    },
  };
}
