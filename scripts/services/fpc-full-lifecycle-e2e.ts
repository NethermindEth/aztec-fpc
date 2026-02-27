type FullE2EMode = "fpc";
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

type FullE2EConfig = {
  mode: FullE2EMode;
  nodeUrl: string;
  l1RpcUrl: string;
  relayAdvanceBlocks: number;
  requiredTopupCycles: 1 | 2;
  topupCheckIntervalMs: number;
  topupWei: bigint | null;
  thresholdWei: bigint | null;
};

function printHelp(): void {
  console.log(`Usage: bun run e2e:full-lifecycle [--help]

Config env vars:
- FPC_FULL_E2E_MODE=fpc
- FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS (default: 2, must be >=2)
- FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES (default: 2, allowed: 1|2)
- FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS (default: 2000)
- FPC_FULL_E2E_TOPUP_WEI (optional bigint > 0)
- FPC_FULL_E2E_THRESHOLD_WEI (optional bigint > 0)
- FPC_FULL_E2E_NODE_HOST/FPC_FULL_E2E_NODE_PORT (default: 127.0.0.1:8080)
- FPC_FULL_E2E_L1_HOST/FPC_FULL_E2E_L1_PORT (default: 127.0.0.1:8545)
- AZTEC_NODE_URL or FPC_FULL_E2E_NODE_URL overrides node host/port
- FPC_FULL_E2E_L1_RPC_URL overrides l1 host/port
`);
}

function parseMode(value: string | undefined): FullE2EMode {
  const normalized = (value ?? "fpc").trim().toLowerCase();
  if (normalized === "fpc") {
    return "fpc";
  }
  throw new Error(
    `Invalid FPC_FULL_E2E_MODE=${value}. This runner is FPC-only and accepts: fpc`,
  );
}

function readEnvPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid integer env var ${name}: value cannot be empty`);
  }
  if (!POSITIVE_INTEGER_PATTERN.test(normalized)) {
    throw new Error(`Invalid integer env var ${name}=${value}`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid integer env var ${name}=${value} (out of safe integer range)`,
    );
  }
  return parsed;
}

function readEnvString(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid env var ${name}: value cannot be empty`);
  }
  return normalized;
}

function readOptionalEnvString(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid env var ${name}: value cannot be empty`);
  }
  return normalized;
}

function readOptionalEnvUrl(name: string): string | null {
  const value = readOptionalEnvString(name);
  if (value === null) return null;
  try {
    // Validate that the URL is absolute and syntactically valid.
    new URL(value);
  } catch {
    throw new Error(`Invalid URL env var ${name}=${value}`);
  }
  return value;
}

function readOptionalEnvBigInt(name: string): bigint | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid bigint env var ${name}: value cannot be empty`);
  }

  let parsed: bigint;
  try {
    parsed = BigInt(normalized);
  } catch {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  if (parsed <= 0n) {
    throw new Error(`Invalid bigint env var ${name}=${value}`);
  }
  return parsed;
}

function getConfig(): FullE2EConfig {
  const mode = parseMode(process.env.FPC_FULL_E2E_MODE);
  const relayAdvanceBlocks = readEnvPositiveInteger(
    "FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS",
    2,
  );
  const requiredTopupCyclesRaw = readEnvPositiveInteger(
    "FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES",
    2,
  );
  const nodeHost = readEnvString("FPC_FULL_E2E_NODE_HOST", "127.0.0.1");
  const nodePort = readEnvPositiveInteger("FPC_FULL_E2E_NODE_PORT", 8080);
  const l1Host = readEnvString("FPC_FULL_E2E_L1_HOST", "127.0.0.1");
  const l1Port = readEnvPositiveInteger("FPC_FULL_E2E_L1_PORT", 8545);
  const nodeUrlFromAztecEnv = readOptionalEnvUrl("AZTEC_NODE_URL");
  const nodeUrlFromFpcEnv = readOptionalEnvUrl("FPC_FULL_E2E_NODE_URL");
  const l1RpcUrlOverride = readOptionalEnvUrl("FPC_FULL_E2E_L1_RPC_URL");

  if (relayAdvanceBlocks < 2) {
    throw new Error(
      `FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS must be an integer >= 2, got ${relayAdvanceBlocks}`,
    );
  }
  if (requiredTopupCyclesRaw !== 1 && requiredTopupCyclesRaw !== 2) {
    throw new Error(
      `FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES must be 1 or 2, got ${requiredTopupCyclesRaw}`,
    );
  }

  return {
    mode,
    nodeUrl:
      nodeUrlFromAztecEnv ??
      nodeUrlFromFpcEnv ??
      `http://${nodeHost}:${nodePort}`,
    l1RpcUrl: l1RpcUrlOverride ?? `http://${l1Host}:${l1Port}`,
    relayAdvanceBlocks,
    requiredTopupCycles: requiredTopupCyclesRaw,
    topupCheckIntervalMs: readEnvPositiveInteger(
      "FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS",
      2_000,
    ),
    topupWei: readOptionalEnvBigInt("FPC_FULL_E2E_TOPUP_WEI"),
    thresholdWei: readOptionalEnvBigInt("FPC_FULL_E2E_THRESHOLD_WEI"),
  };
}

function printConfigSummary(config: FullE2EConfig): void {
  console.log(
    `[full-lifecycle-e2e] Config loaded: mode=${config.mode}, nodeUrl=${config.nodeUrl}, l1RpcUrl=${config.l1RpcUrl}, relayAdvanceBlocks=${config.relayAdvanceBlocks}, requiredTopupCycles=${config.requiredTopupCycles}, topupCheckIntervalMs=${config.topupCheckIntervalMs}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const config = getConfig();
  printConfigSummary(config);

  throw new Error(
    "Issue #85 plan step 3 completed: config model is implemented. Runner execution is pending later steps.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[full-lifecycle-e2e] ERROR: ${message}`);
  process.exitCode = 1;
});
