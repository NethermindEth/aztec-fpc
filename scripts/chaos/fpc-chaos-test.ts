import pino from "pino";

const pinoLogger = pino();

/**
 * FPC Chaos / Adversarial Test Suite
 *
 * Runs adversarial API surface tests against the FPC attestation service.
 * Safe for all environments including production.
 *
 * Quick start:
 *   FPC_CHAOS_ATTESTATION_URL=https://<host> \
 *   FPC_CHAOS_MANIFEST=./deployments/devnet-manifest-v2.json \
 *   bun run scripts/chaos/fpc-chaos-test.ts
 *
 * ENV VARS
 * --------
 * FPC_CHAOS_ATTESTATION_URL      required – base URL of attestation service
 * FPC_CHAOS_MANIFEST             path to devnet-manifest-*.json (fills addresses)
 * FPC_CHAOS_ACCEPTED_ASSET       accepted asset address (if no manifest)
 * FPC_CHAOS_HTTP_TIMEOUT_MS      HTTP timeout ms (default: 15000)
 * FPC_CHAOS_REPORT_PATH          write JSON report to this path
 * FPC_CHAOS_FAIL_FAST            1 = stop on first failure (default: 0)
 * FPC_CHAOS_QUOTE_AUTH_API_KEY   API key for quote auth (if enabled on service)
 * FPC_CHAOS_QUOTE_AUTH_HEADER    trusted header name (if trusted_header mode)
 * FPC_CHAOS_QUOTE_AUTH_VALUE     trusted header value (if trusted_header mode)
 */

import { readFileSync, writeFileSync } from "node:fs";

type ChaosConfig = {
  attestationUrl: string;
  acceptedAsset: string | null;
  httpTimeoutMs: number;
  reportPath: string | null;
  failFast: boolean;
  quoteAuthApiKey: string | null;
  quoteAuthHeader: string | null;
  quoteAuthValue: string | null;
};

type TestStatus = "pass" | "fail" | "skip";

type TestResult = {
  id: string;
  category: string;
  name: string;
  status: TestStatus;
  durationMs: number;
  error?: string;
  details?: Record<string, unknown>;
};

type ChaosReport = {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    generatedAt: string;
  };
  config: {
    attestationUrl: string;
    acceptedAsset: string | null;
  };
  results: TestResult[];
};

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

class ChaosRunner {
  private results: TestResult[] = [];
  private readonly config: ChaosConfig;

  constructor(config: ChaosConfig) {
    this.config = config;
  }

  async run(
    id: string,
    category: string,
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<TestResult> {
    const start = Date.now();
    process.stdout.write(`${DIM}  [${category}]${RESET} ${name} ... `);

    let result: TestResult;
    try {
      const rawDetails = await fn();
      const durationMs = Date.now() - start;
      const details =
        rawDetails != null && typeof rawDetails === "object"
          ? (rawDetails as Record<string, unknown>)
          : undefined;
      result = {
        id,
        category,
        name,
        status: "pass",
        durationMs,
        details,
      };
      pinoLogger.info(`${GREEN}PASS${RESET} ${DIM}(${durationMs}ms)${RESET}`);
    } catch (error) {
      const durationMs = Date.now() - start;
      const msg = error instanceof Error ? error.message : String(error);
      result = {
        id,
        category,
        name,
        status: "fail",
        durationMs,
        error: msg,
      };
      pinoLogger.info(`${RED}FAIL${RESET} ${DIM}(${durationMs}ms)${RESET}`);
      pinoLogger.info(`${RED}    ✗ ${msg}${RESET}`);
    }

    this.results.push(result);

    if (result.status === "fail" && this.config.failFast) {
      throw new Error(`[chaos] fail-fast triggered by: ${name}`);
    }

    return result;
  }

  skip(id: string, category: string, name: string, reason: string): TestResult {
    pinoLogger.info(
      `${DIM}  [${category}]${RESET} ${name} ... ${YELLOW}SKIP${RESET} ${DIM}(${reason})${RESET}`,
    );
    const result: TestResult = {
      id,
      category,
      name,
      status: "skip",
      durationMs: 0,
      details: { reason },
    };
    this.results.push(result);
    return result;
  }

  getResults(): TestResult[] {
    return this.results;
  }

  printSummary(totalMs: number): void {
    const passed = this.results.filter((r) => r.status === "pass").length;
    const failed = this.results.filter((r) => r.status === "fail").length;
    const skipped = this.results.filter((r) => r.status === "skip").length;
    const total = this.results.length;

    pinoLogger.info(`\n${"─".repeat(60)}`);
    pinoLogger.info(
      `${BOLD}Chaos Test Summary${RESET}  ${DIM}(${(totalMs / 1000).toFixed(1)}s)${RESET}`,
    );
    pinoLogger.info(
      `  ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}  ${YELLOW}${skipped} skipped${RESET}  ${DIM}${total} total${RESET}`,
    );

    if (failed > 0) {
      pinoLogger.info(`\n${RED}${BOLD}Failed tests:${RESET}`);
      for (const r of this.results.filter((r) => r.status === "fail")) {
        pinoLogger.info(`  ${RED}✗ [${r.category}] ${r.name}${RESET}`);
        if (r.error) {
          pinoLogger.info(`    ${DIM}${r.error.split("\n")[0]}${RESET}`);
        }
      }
    }
    pinoLogger.info("─".repeat(60));

    const sep = "═".repeat(60);
    const status = failed > 0 ? `${RED}${BOLD}FAIL${RESET}` : `${GREEN}${BOLD}PASS${RESET}`;
    const failedNames = this.results
      .filter((r) => r.status === "fail")
      .map((r) => `  ${RED}✗ [${r.category}] ${r.name}${RESET}`);
    process.stderr.write(
      `${[
        "",
        sep,
        `  Chaos Test Result: ${status}  (${(totalMs / 1000).toFixed(1)}s)`,
        `  ${passed} passed, ${failed} failed, ${skipped} skipped, ${total} total`,
        ...failedNames,
        sep,
        "",
      ].join("\n")}\n`,
    );
  }

  buildReport(config: ChaosConfig, totalMs: number): ChaosReport {
    const passed = this.results.filter((r) => r.status === "pass").length;
    const failed = this.results.filter((r) => r.status === "fail").length;
    const skipped = this.results.filter((r) => r.status === "skip").length;

    return {
      summary: {
        total: this.results.length,
        passed,
        failed,
        skipped,
        durationMs: totalMs,
        generatedAt: new Date().toISOString(),
      },
      config: {
        attestationUrl: config.attestationUrl,
        acceptedAsset: config.acceptedAsset,
      },
      results: this.results,
    };
  }
}

type Manifest = {
  accepted_asset?: string;
  contracts?: { accepted_asset?: string };
};

function readEnvStr(name: string, fallback: string | null = null): string | null {
  const val = process.env[name];
  if (!val || val.trim() === "") return fallback;
  return val.trim();
}

function requireEnvStr(name: string): string {
  const val = readEnvStr(name);
  if (val === null) throw new Error(`Required env var ${name} is not set`);
  return val;
}

function readEnvInt(name: string, fallback: number): number {
  const val = readEnvStr(name);
  if (val === null) return fallback;
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`Env var ${name} must be a positive integer, got: ${val}`);
  return n;
}

function readEnvBool(name: string, fallback: boolean): boolean {
  const val = readEnvStr(name);
  if (val === null) return fallback;
  return val === "1" || val.toLowerCase() === "true";
}

function loadManifest(manifestPath: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (e) {
    throw new Error(`Failed to load manifest at ${manifestPath}: ${(e as Error).message}`);
  }
}

function getConfig(): ChaosConfig {
  const manifestPath = readEnvStr("FPC_CHAOS_MANIFEST");
  let manifest: Manifest | null = null;
  if (manifestPath) {
    manifest = loadManifest(manifestPath);
  }

  const acceptedAsset =
    readEnvStr("FPC_CHAOS_ACCEPTED_ASSET") ??
    manifest?.accepted_asset ??
    manifest?.contracts?.accepted_asset ??
    null;

  const attestationUrl = requireEnvStr("FPC_CHAOS_ATTESTATION_URL").replace(/\/$/, "");

  return {
    attestationUrl,
    acceptedAsset,
    httpTimeoutMs: readEnvInt("FPC_CHAOS_HTTP_TIMEOUT_MS", 15_000),
    reportPath: readEnvStr("FPC_CHAOS_REPORT_PATH"),
    failFast: readEnvBool("FPC_CHAOS_FAIL_FAST", false),
    quoteAuthApiKey: readEnvStr("FPC_CHAOS_QUOTE_AUTH_API_KEY"),
    quoteAuthHeader: readEnvStr("FPC_CHAOS_QUOTE_AUTH_HEADER"),
    quoteAuthValue: readEnvStr("FPC_CHAOS_QUOTE_AUTH_VALUE"),
  };
}

function authHeaders(config: ChaosConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.quoteAuthApiKey) {
    const headerName = config.quoteAuthHeader ?? "x-api-key";
    headers[headerName] = config.quoteAuthApiKey;
  } else if (config.quoteAuthHeader && config.quoteAuthValue) {
    headers[config.quoteAuthHeader] = config.quoteAuthValue;
  }
  return headers;
}

async function httpGet(
  url: string,
  config: ChaosConfig,
  extraHeaders: Record<string, string> = {},
  timeoutMs?: number,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.httpTimeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { ...authHeaders(config), ...extraHeaders },
    });
    const body = await resp.text();
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(status: number, body: string, label: string): void {
  if (status < 200 || status >= 300) {
    throw new Error(`${label}: expected 2xx, got ${status}. body=${body.slice(0, 200)}`);
  }
}

const SENTINEL_USER = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SENTINEL_FJ_AMOUNT = "1000000";

async function runApiTests(runner: ChaosRunner, config: ChaosConfig): Promise<void> {
  const base = config.attestationUrl;

  // Discover the accepted_asset from the running attestation service so API
  // tests always use the value the service actually accepts.  The manifest
  // value (config.acceptedAsset) may be stale if containers were recycled.
  try {
    const { status, body } = await httpGet(`${base}/asset`, config);
    if (status >= 200 && status < 300) {
      const parsed = JSON.parse(body) as { address?: string };
      if (parsed.address) {
        config.acceptedAsset = parsed.address;
      }
    }
  } catch {
    // Will be caught by individual tests
  }

  if (config.quoteAuthApiKey || (config.quoteAuthHeader && config.quoteAuthValue)) {
    await runner.run(
      "quote-auth-no-key-rejected",
      "api-auth",
      "GET /quote without auth header returns 401",
      async () => {
        const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
        // Send with no auth headers
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const resp = await fetch(url, { signal: controller.signal });
          const body = await resp.text();
          if (resp.status !== 401) {
            throw new Error(`Expected 401 without auth, got ${resp.status}: ${body.slice(0, 100)}`);
          }
          return { status: resp.status };
        } finally {
          clearTimeout(timer);
        }
      },
    );

    await runner.run(
      "quote-auth-wrong-key-rejected",
      "api-auth",
      "GET /quote with wrong auth key returns 401",
      async () => {
        const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
        const wrongHeaders: Record<string, string> = {};
        if (config.quoteAuthApiKey) {
          wrongHeaders[config.quoteAuthHeader ?? "x-api-key"] = "WRONG_KEY_FOR_CHAOS_TEST";
        } else if (config.quoteAuthHeader) {
          wrongHeaders[config.quoteAuthHeader] = "WRONG_VALUE_FOR_CHAOS_TEST";
        }
        const { status, body } = await httpGet(url, config, wrongHeaders);
        if (status !== 401) {
          throw new Error(`Expected 401 with wrong key, got ${status}: ${body.slice(0, 100)}`);
        }
        return { status };
      },
    );

    await runner.run(
      "quote-auth-correct-key-accepted",
      "api-auth",
      "GET /quote with correct auth key returns 200",
      async () => {
        const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
        const { status, body } = await httpGet(url, config);
        assertOk(status, body, "/quote auth correct key");
        return { status };
      },
    );
  } else {
    runner.skip(
      "quote-auth-tests",
      "api-auth",
      "Quote auth tests",
      "FPC_CHAOS_QUOTE_AUTH_API_KEY or FPC_CHAOS_QUOTE_AUTH_HEADER+VALUE not set",
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    pinoLogger.info("FPC Chaos Test – see top of fpc-chaos-test.ts for ENV VAR documentation.");
    process.exit(0);
  }

  pinoLogger.info(`\n${BOLD}${CYAN}FPC Chaos / Adversarial Test Suite${RESET}\n`);

  const config = getConfig();

  pinoLogger.info(`${DIM}  attestation=${config.attestationUrl}${RESET}\n`);

  const runner = new ChaosRunner(config);
  const globalStart = Date.now();

  pinoLogger.info(`${BOLD}API surface tests${RESET}`);
  await runApiTests(runner, config);

  const totalMs = Date.now() - globalStart;
  runner.printSummary(totalMs);

  const report = runner.buildReport(config, totalMs);

  if (config.reportPath) {
    writeFileSync(config.reportPath, JSON.stringify(report, null, 2), "utf8");
    pinoLogger.info(`\n${DIM}Report written to ${config.reportPath}${RESET}`);
  }

  const failed = report.summary.failed;
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  pinoLogger.error(`\n${RED}${BOLD}Unhandled error:${RESET}`, err);
  process.exit(1);
});
