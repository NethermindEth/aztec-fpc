/**
 * CLI types and parsing for always-revert-smoke.
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
  attestationUrl: string;
  manifestPath: string;
  operatorSecretKey: string;
  aaPaymentAmount: bigint;
  daGasLimit: number;
  l2GasLimit: number;
  feePerDaGas: bigint | null;
  feePerL2Gas: bigint | null;
  messageTimeoutSeconds: number;
  iterations: number;
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
    "  bunx tsx scripts/always-revert/always-revert-smoke.ts [options]",
    "",
    "All arguments are optional. CLI args take precedence over env vars.",
    "",
    "Required (via env or CLI):",
    "  --attestation-url <url>          Attestation server base URL [env: FPC_ATTESTATION_URL]",
    "  --manifest <path>                Deployment manifest path [env: FPC_COLD_START_MANIFEST]",
    "  --operator-secret-key <hex32>    Operator secret key [env: FPC_OPERATOR_SECRET_KEY]",
    "",
    "Network:",
    "  --node-url <url>                 Aztec node URL (default: http://localhost:8080) [env: AZTEC_NODE_URL]",
    "",
    "Amounts:",
    "  --aa-payment-amount <uint>       AA payment amount (default: 1000000000) [env: FPC_COLD_START_AA_PAYMENT_AMOUNT]",
    "",
    "Gas:",
    "  --da-gas-limit <uint>            DA gas limit (default: 1000000) [env: FPC_SMOKE_DA_GAS_LIMIT]",
    "  --l2-gas-limit <uint>            L2 gas limit (default: 1000000) [env: FPC_SMOKE_L2_GAS_LIMIT]",
    "  --fee-per-da-gas <uint>          Override fee per DA gas [env: FPC_SMOKE_FEE_PER_DA_GAS]",
    "  --fee-per-l2-gas <uint>          Override fee per L2 gas [env: FPC_SMOKE_FEE_PER_L2_GAS]",
    "",
    "Timing:",
    "  --message-timeout <uint>         FeeJuice balance wait timeout seconds (default: 120) [env: FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS]",
    "",
    "Test:",
    "  --iterations <uint>              Number of always-revert iterations (default: 3) [env: FPC_SMOKE_ITERATIONS]",
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

function parsePositiveInt(value: string, fieldName: string): number {
  const big = parsePositiveBigInt(value, fieldName);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CliError(`Invalid ${fieldName}: exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(big);
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
  let attestationUrl: string | null = process.env.FPC_ATTESTATION_URL ?? null;
  let manifestPath: string | null = process.env.FPC_COLD_START_MANIFEST ?? null;
  let operatorSecretKey: string | null = process.env.FPC_OPERATOR_SECRET_KEY ?? null;
  let aaPaymentAmount: string = process.env.FPC_COLD_START_AA_PAYMENT_AMOUNT ?? "1000000000";
  let daGasLimit: string = process.env.FPC_SMOKE_DA_GAS_LIMIT ?? "1000000";
  let l2GasLimit: string = process.env.FPC_SMOKE_L2_GAS_LIMIT ?? "1000000";
  let feePerDaGas: string | null = process.env.FPC_SMOKE_FEE_PER_DA_GAS ?? null;
  let feePerL2Gas: string | null = process.env.FPC_SMOKE_FEE_PER_L2_GAS ?? null;
  let messageTimeoutSeconds: string = process.env.FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS ?? "120";
  let iterations: string = process.env.FPC_SMOKE_ITERATIONS ?? "3";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--node-url":
        nodeUrl = nextArg(argv, i, arg);
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
      case "--aa-payment-amount":
        aaPaymentAmount = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--da-gas-limit":
        daGasLimit = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--l2-gas-limit":
        l2GasLimit = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--fee-per-da-gas":
        feePerDaGas = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--fee-per-l2-gas":
        feePerL2Gas = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--message-timeout":
        messageTimeoutSeconds = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--iterations":
        iterations = nextArg(argv, i, arg);
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
      attestationUrl: parseHttpUrl(attestationUrl, "--attestation-url"),
      manifestPath: path.resolve(manifestPath),
      operatorSecretKey: parseHex32(operatorSecretKey, "--operator-secret-key"),
      aaPaymentAmount: parsePositiveBigInt(aaPaymentAmount, "--aa-payment-amount"),
      daGasLimit: parsePositiveInt(daGasLimit, "--da-gas-limit"),
      l2GasLimit: parsePositiveInt(l2GasLimit, "--l2-gas-limit"),
      feePerDaGas: feePerDaGas ? parsePositiveBigInt(feePerDaGas, "--fee-per-da-gas") : null,
      feePerL2Gas: feePerL2Gas ? parsePositiveBigInt(feePerL2Gas, "--fee-per-l2-gas") : null,
      messageTimeoutSeconds: parseNonNegativeInt(messageTimeoutSeconds, "--message-timeout"),
      iterations: parsePositiveInt(iterations, "--iterations"),
    },
  };
}
