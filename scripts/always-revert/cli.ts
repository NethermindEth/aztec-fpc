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
      messageTimeoutSeconds: parseNonNegativeInt(messageTimeoutSeconds, "--message-timeout"),
      iterations: parsePositiveInt(iterations, "--iterations"),
    },
  };
}
