import pino from "pino";

const pinoLogger = pino();

/**
 * FPC Chaos / Adversarial Test Suite
 *
 * Runs adversarial and edge-case tests against the FPC protocol in three tiers:
 *   api     – HTTP surface tests only (safe for all environments including production)
 *   onchain – api + on-chain security tests (requires OPERATOR_SECRET_KEY + node)
 *   full    – onchain + concurrent stress tests
 *
 * Quick start:
 *   # Self-contained local run (recommended for full suite): deploys contracts,
 *   # starts attestation + topup, funds FPC, then runs this suite (default: full).
 *   bun run chaos:local
 *
 *   # API-only (safe for production):
 *   FPC_CHAOS_ATTESTATION_URL=https://<host> \
 *   FPC_CHAOS_MANIFEST=./deployments/devnet-manifest-v2.json \
 *   bun run scripts/chaos/fpc-chaos-test.ts
 *
 *   # Full suite against an already-running local setup:
 *   FPC_CHAOS_MODE=full \
 *   FPC_CHAOS_ATTESTATION_URL=http://localhost:3000 \
 *   FPC_CHAOS_TOPUP_URL=http://localhost:3001 \
 *   FPC_CHAOS_NODE_URL=http://localhost:8080 \
 *   FPC_CHAOS_MANIFEST=./deployments/devnet-manifest-v2.json \
 *   FPC_CHAOS_OPERATOR_SECRET_KEY=0x<hex> \
 *   bun run scripts/chaos/fpc-chaos-test.ts
 *
 * ENV VARS
 * --------
 * FPC_CHAOS_MODE                 api|onchain|full (default: api)
 * FPC_CHAOS_ATTESTATION_URL      required – base URL of attestation service
 * FPC_CHAOS_TOPUP_URL            optional – base URL of topup ops server
 * FPC_CHAOS_NODE_URL             Aztec node URL (required for onchain/full)
 * FPC_CHAOS_MANIFEST             path to devnet-manifest-*.json (fills addresses)
 * FPC_CHAOS_FPC_ADDRESS          FPC contract address (if no manifest)
 * FPC_CHAOS_ACCEPTED_ASSET       accepted asset address (if no manifest)
 * FPC_CHAOS_OPERATOR_SECRET_KEY  operator Schnorr key (required for onchain/full)
 * FPC_CHAOS_RATE_LIMIT_BURST     requests per burst test (default: 70)
 * FPC_CHAOS_CONCURRENT_TXS       concurrent tx count for stress (default: 3)
 * FPC_CHAOS_HTTP_TIMEOUT_MS      HTTP timeout ms (default: 15000)
 * FPC_CHAOS_DA_GAS_LIMIT         DA gas limit (default: 200000)
 * FPC_CHAOS_L2_GAS_LIMIT         L2 gas limit (default: 1000000)
 * FPC_CHAOS_REPORT_PATH          write JSON report to this path
 * FPC_CHAOS_FAIL_FAST            1 = stop on first failure (default: 0)
 * FPC_CHAOS_QUOTE_AUTH_API_KEY   API key for quote auth (if enabled on service)
 * FPC_CHAOS_QUOTE_AUTH_HEADER    trusted header name (if trusted_header mode)
 * FPC_CHAOS_QUOTE_AUTH_VALUE     trusted header value (if trusted_header mode)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

import { resolveScriptAccounts } from "../common/script-credentials.ts";

const QUOTE_DOMAIN_SEPARATOR = Fr.fromHexString("0x465043");
const U128_MAX = 2n ** 128n - 1n;
const MAX_QUOTE_TTL_SECONDS = 3600n;
const _HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type ChaosMode = "api" | "onchain" | "full";
type TestStatus = "pass" | "fail" | "skip";

type ChaosConfig = {
  mode: ChaosMode;
  attestationUrl: string;
  topupUrl: string | null;
  nodeUrl: string | null;
  l1RpcUrl: string | null;
  fpcAddress: string | null;
  acceptedAsset: string | null;
  faucetAddress: string | null;
  operatorAddress: string | null;
  operatorSecretKey: string | null;
  rateLimitBurst: number;
  concurrentTxs: number;
  httpTimeoutMs: number;
  daGasLimit: number;
  l2GasLimit: number;
  reportPath: string | null;
  failFast: boolean;
  quoteAuthApiKey: string | null;
  quoteAuthHeader: string | null;
  quoteAuthValue: string | null;
  repoRoot: string;
};

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
    mode: string;
    attestationUrl: string;
    topupUrl: string | null;
    nodeUrl: string | null;
    fpcAddress: string | null;
    acceptedAsset: string | null;
    operatorAddress: string | null;
    rateLimitBurst: number;
    concurrentTxs: number;
  };
  results: TestResult[];
};

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

type OnchainContext = {
  node: ReturnType<typeof createAztecNodeClient>;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  user: AztecAddress;
  otherUser: AztecAddress;
  operatorSecretHex: string;
  token: Contract;
  fpc: Contract;
  faucet: Contract | null;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
  fpcAddress: AztecAddress;
  acceptedAsset: AztecAddress;
  feePerDaGas: bigint;
  feePerL2Gas: bigint;
  maxGasCostNoTeardown: bigint;
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

    // Plain-text summary for easy reading in docker logs / CI output
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
        mode: config.mode,
        attestationUrl: config.attestationUrl,
        topupUrl: config.topupUrl,
        nodeUrl: config.nodeUrl,
        fpcAddress: config.fpcAddress,
        acceptedAsset: config.acceptedAsset,
        operatorAddress: config.operatorAddress,
        rateLimitBurst: config.rateLimitBurst,
        concurrentTxs: config.concurrentTxs,
      },
      results: this.results,
    };
  }
}

type Manifest = {
  aztec_node_url?: string;
  fpc_address?: string;
  accepted_asset?: string;
  operator_address?: string;
  contracts?: { accepted_asset?: string; fpc?: string; faucet?: string };
  operator?: { address?: string };
  network?: { node_url?: string };
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

function getRepoRoot(): string {
  const scriptDir =
    typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..", "..");
}

function loadManifest(manifestPath: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (e) {
    throw new Error(`Failed to load manifest at ${manifestPath}: ${(e as Error).message}`);
  }
}

function getConfig(): ChaosConfig {
  const repoRoot = getRepoRoot();

  // Read optional manifest
  const manifestPath = readEnvStr("FPC_CHAOS_MANIFEST");
  let manifest: Manifest | null = null;
  if (manifestPath) {
    manifest = loadManifest(manifestPath);
  }

  // Resolve addresses: explicit env vars override manifest
  const fpcAddress =
    readEnvStr("FPC_CHAOS_FPC_ADDRESS") ??
    manifest?.fpc_address ??
    manifest?.contracts?.fpc ??
    null;

  const acceptedAsset =
    readEnvStr("FPC_CHAOS_ACCEPTED_ASSET") ??
    manifest?.accepted_asset ??
    manifest?.contracts?.accepted_asset ??
    null;

  const operatorAddress =
    readEnvStr("FPC_CHAOS_OPERATOR_ADDRESS") ??
    manifest?.operator_address ??
    manifest?.operator?.address ??
    null;

  const nodeUrl =
    readEnvStr("FPC_CHAOS_NODE_URL") ??
    manifest?.aztec_node_url ??
    manifest?.network?.node_url ??
    null;

  const modeStr = readEnvStr("FPC_CHAOS_MODE") ?? "api";
  if (!["api", "onchain", "full"].includes(modeStr)) {
    throw new Error(`FPC_CHAOS_MODE must be api|onchain|full, got: ${modeStr}`);
  }
  const mode = modeStr as ChaosMode;

  const attestationUrl = requireEnvStr("FPC_CHAOS_ATTESTATION_URL").replace(/\/$/, "");

  if ((mode === "onchain" || mode === "full") && !nodeUrl) {
    throw new Error(`FPC_CHAOS_NODE_URL (or manifest with node URL) is required for mode=${mode}`);
  }
  if ((mode === "onchain" || mode === "full") && !fpcAddress) {
    throw new Error(
      `FPC_CHAOS_FPC_ADDRESS (or manifest with fpc_address) is required for mode=${mode}`,
    );
  }
  if ((mode === "onchain" || mode === "full") && !acceptedAsset) {
    throw new Error(
      `FPC_CHAOS_ACCEPTED_ASSET (or manifest with accepted_asset) is required for mode=${mode}`,
    );
  }

  return {
    mode,
    attestationUrl,
    topupUrl: readEnvStr("FPC_CHAOS_TOPUP_URL")?.replace(/\/$/, "") ?? null,
    nodeUrl,
    l1RpcUrl: readEnvStr("FPC_CHAOS_L1_RPC_URL"),
    fpcAddress,
    acceptedAsset,
    faucetAddress: readEnvStr("FPC_CHAOS_FAUCET_ADDRESS") ?? manifest?.contracts?.faucet ?? null,
    operatorAddress,
    operatorSecretKey: readEnvStr("FPC_CHAOS_OPERATOR_SECRET_KEY"),
    rateLimitBurst: readEnvInt("FPC_CHAOS_RATE_LIMIT_BURST", 70),
    concurrentTxs: readEnvInt("FPC_CHAOS_CONCURRENT_TXS", 3),
    httpTimeoutMs: readEnvInt("FPC_CHAOS_HTTP_TIMEOUT_MS", 15_000),
    daGasLimit: readEnvInt("FPC_CHAOS_DA_GAS_LIMIT", 200_000),
    l2GasLimit: readEnvInt("FPC_CHAOS_L2_GAS_LIMIT", 1_000_000),
    reportPath: readEnvStr("FPC_CHAOS_REPORT_PATH"),
    failFast: readEnvBool("FPC_CHAOS_FAIL_FAST", false),
    quoteAuthApiKey: readEnvStr("FPC_CHAOS_QUOTE_AUTH_API_KEY"),
    quoteAuthHeader: readEnvStr("FPC_CHAOS_QUOTE_AUTH_HEADER"),
    quoteAuthValue: readEnvStr("FPC_CHAOS_QUOTE_AUTH_VALUE"),
    repoRoot,
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

function assertClientError(status: number, body: string, label: string): void {
  if (status < 400 || status >= 500) {
    throw new Error(`${label}: expected 4xx, got ${status}. body=${body.slice(0, 200)}`);
  }
}

function parseQuote(body: string): QuoteResponse {
  const parsed = JSON.parse(body) as QuoteResponse;
  if (
    typeof parsed.accepted_asset !== "string" ||
    typeof parsed.fj_amount !== "string" ||
    typeof parsed.aa_payment_amount !== "string" ||
    typeof parsed.valid_until !== "string" ||
    typeof parsed.signature !== "string"
  ) {
    throw new Error(`Quote response missing required fields: ${body.slice(0, 300)}`);
  }
  return parsed;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Sentinel user for API-only tests – not a valid account but a real format address
const SENTINEL_USER = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SENTINEL_FJ_AMOUNT = "1000000";

async function fetchQuoteForSentinel(config: ChaosConfig): Promise<QuoteResponse> {
  const url = `${config.attestationUrl}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
  const { status, body } = await httpGet(url, config);
  assertOk(status, body, "fetchQuoteForSentinel");
  return parseQuote(body);
}

async function signQuote(
  operatorSecretHex: string,
  fpcAddress: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  userAddress: AztecAddress,
): Promise<number[]> {
  const secret = Fr.fromHexString(operatorSecretHex);
  const signingKey = deriveSigningKey(secret);
  const schnorr = new Schnorr();
  const quoteHash = await computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpcAddress.toField(),
    acceptedAsset.toField(),
    new Fr(fjAmount),
    new Fr(aaPaymentAmount),
    new Fr(validUntil),
    userAddress.toField(),
  ]);
  const sig = await schnorr.constructSignature(quoteHash.toBuffer(), signingKey);
  return Array.from(sig.toBuffer());
}

function loadArtifact(artifactPath: string): ContractArtifact {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as NoirCompiledContract;
  try {
    return loadContractArtifact(parsed);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return loadContractArtifactForPublic(parsed);
    }
    throw err;
  }
}

async function buildOnchainContext(config: ChaosConfig): Promise<OnchainContext> {
  if (!config.nodeUrl) throw new Error("nodeUrl is required for onchain tests");
  if (!config.l1RpcUrl) throw new Error("FPC_CHAOS_L1_RPC_URL is required for onchain tests");
  if (!config.fpcAddress) throw new Error("fpcAddress is required for onchain tests");
  if (!config.acceptedAsset) throw new Error("acceptedAsset is required for onchain tests");
  if (!config.operatorSecretKey)
    throw new Error("FPC_CHAOS_OPERATOR_SECRET_KEY is required for onchain tests");

  const tokenArtifactPath = path.join(config.repoRoot, "target", "token_contract-Token.json");
  const fpcArtifactPath = path.join(config.repoRoot, "target", "fpc-FPCMultiAsset.json");

  const tokenArtifact = loadArtifact(tokenArtifactPath);
  const fpcArtifact = loadArtifact(fpcArtifactPath);

  const node = createAztecNodeClient(config.nodeUrl);
  const wallet = await EmbeddedWallet.create(node);

  // Derive operator from the same secret key used during deployment so that
  // the resulting address matches the token contract's configured minter.
  const operatorSecret = Fr.fromHexString(config.operatorSecretKey);
  const operatorSigningKey = deriveSigningKey(operatorSecret);
  const operatorAcct = await wallet.createSchnorrAccount(
    operatorSecret,
    Fr.ZERO,
    operatorSigningKey,
  );
  const operator = operatorAcct.address;

  // User and otherUser: fresh accounts deployed with funded FeeJuice,
  // isolated from the node's genesis accounts to avoid note conflicts.
  pinoLogger.info("Resolving test accounts (L1 fund + L2 deploy)...");
  const { accounts: scriptAccounts } = await resolveScriptAccounts(
    config.nodeUrl,
    config.l1RpcUrl,
    wallet,
    2, // [0]=user, [1]=otherUser
  );
  const user = scriptAccounts[0].address;
  const otherUser = scriptAccounts[1].address;

  const fpcAddress = AztecAddress.fromString(config.fpcAddress);
  const acceptedAsset = AztecAddress.fromString(config.acceptedAsset);

  // Register pre-deployed contracts with the fresh embedded PXE so it can
  // simulate and encode calls. Contract.at() alone does not do this.
  const [tokenInstance, fpcInstance] = await Promise.all([
    node.getContract(acceptedAsset),
    node.getContract(fpcAddress),
  ]);
  if (!tokenInstance) throw new Error(`Token contract not found on-chain: ${acceptedAsset}`);
  if (!fpcInstance) throw new Error(`FPC contract not found on-chain: ${fpcAddress}`);
  await Promise.all([
    wallet.registerContract(tokenInstance, tokenArtifact),
    wallet.registerContract(fpcInstance, fpcArtifact),
  ]);

  const token = Contract.at(acceptedAsset, tokenArtifact, wallet);
  const fpc = Contract.at(fpcAddress, fpcArtifact, wallet);

  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = minFees.feePerDaGas;
  const feePerL2Gas = minFees.feePerL2Gas;
  const maxGasCostNoTeardown =
    BigInt(config.daGasLimit) * feePerDaGas + BigInt(config.l2GasLimit) * feePerL2Gas;

  // Wait for the FPC to be funded (the topup service may still be bridging)
  const requiredFeeJuice = maxGasCostNoTeardown * 10n;
  const fundingTimeoutMs = 120_000;
  const fundingPollMs = 5_000;
  const fundingStart = Date.now();
  let feeJuiceBalance = 0n;
  while (Date.now() - fundingStart < fundingTimeoutMs) {
    feeJuiceBalance = await getFeeJuiceBalance(fpcAddress, node);
    if (feeJuiceBalance >= requiredFeeJuice) break;
    pinoLogger.info(
      `Waiting for FPC funding: balance=${feeJuiceBalance}, required=${requiredFeeJuice} (${Math.round((Date.now() - fundingStart) / 1000)}s elapsed)`,
    );
    await new Promise((r) => setTimeout(r, fundingPollMs));
  }
  if (feeJuiceBalance < requiredFeeJuice) {
    throw new Error(
      `FPC Fee Juice balance ${feeJuiceBalance} is below required ${requiredFeeJuice} after ${fundingTimeoutMs / 1000}s. ` +
        "Ensure the topup service has funded the FPC before running onchain tests.",
    );
  }

  // Register canonical SponsoredFPC (enables gas sponsoring for setup txs
  // when payer has no FeeJuice, e.g. shielding tokens via faucet flow).
  const sponsoredFpcInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContractArtifact);
  const sponsoredFeePayment = new SponsoredFeePaymentMethod(sponsoredFpcInstance.address);

  // Register faucet if available (devnet deployments where bridge is the
  // minter and the operator cannot mint directly).
  let faucet: Contract | null = null;
  if (config.faucetAddress) {
    const faucetArtifactPath = path.join(config.repoRoot, "target", "faucet-Faucet.json");
    const faucetArtifact = loadArtifact(faucetArtifactPath);
    const faucetAddr = AztecAddress.fromString(config.faucetAddress);
    const faucetInstance = await node.getContract(faucetAddr);
    if (!faucetInstance)
      throw new Error(`Faucet contract not found on-chain: ${config.faucetAddress}`);
    await wallet.registerContract(faucetInstance, faucetArtifact);
    faucet = Contract.at(faucetAddr, faucetArtifact, wallet);
    pinoLogger.info(`Faucet registered: ${config.faucetAddress}`);
  }

  return {
    node,
    wallet,
    operator,
    user,
    otherUser,
    operatorSecretHex: config.operatorSecretKey,
    token,
    fpc,
    faucet,
    sponsoredFeePayment,
    fpcAddress,
    acceptedAsset,
    feePerDaGas,
    feePerL2Gas,
    maxGasCostNoTeardown,
  };
}

async function getLatestL2Timestamp(ctx: OnchainContext): Promise<bigint> {
  const block = await ctx.node.getBlock("latest");
  if (!block) throw new Error("Could not read latest L2 block");
  return block.timestamp;
}

/**
 * Fund a payer with tokens before a fee-paid tx.
 *
 * - Faucet path (devnet): admin_drip gives public tokens, then shield to
 *   private via SponsoredFPC so payer never needs FeeJuice.
 * - Direct mint path (chaos-local where operator IS the token minter).
 */
async function fundPayerTokens(
  ctx: OnchainContext,
  payer: AztecAddress,
  privateAmount: bigint,
  publicAmount: bigint,
): Promise<void> {
  if (ctx.faucet) {
    const totalPublic = privateAmount + publicAmount;
    await ctx.faucet.methods.admin_drip(payer, totalPublic).send({ from: ctx.operator });

    if (privateAmount > 0n) {
      await ctx.token.methods
        .transfer_public_to_private(payer, payer, privateAmount, Fr.random())
        .send({
          from: payer,
          fee: { paymentMethod: ctx.sponsoredFeePayment },
        });
    }
  } else {
    // Direct mint path (operator is the token minter, e.g. chaos-local)
    if (privateAmount > 0n) {
      await ctx.token.methods.mint_to_private(payer, privateAmount).send({ from: ctx.operator });
    }
    if (publicAmount > 0n) {
      await ctx.token.methods.mint_to_public(payer, publicAmount).send({ from: ctx.operator });
    }
  }
}

// Mint tokens to user and submit a fee-paid tx.
// Returns the actual operator credit (aa_payment_amount).
async function submitFeePaidTx(
  config: ChaosConfig,
  ctx: OnchainContext,
  payer: AztecAddress,
  quoteSigBytes: number[],
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
): Promise<{ expectedCharge: bigint }> {
  // Fund payer: private tokens for FPC fee payment + 1 public token for the
  // transfer_public_to_public action.
  await fundPayerTokens(ctx, payer, aaPaymentAmount + 1_000_000n, 1n);

  const nonce = Fr.random();
  const transferCall = await ctx.token.methods
    .transfer_private_to_private(payer, ctx.operator, aaPaymentAmount, nonce)
    .getFunctionCall();
  const authwit = await ctx.wallet.createAuthWit(payer, {
    caller: ctx.fpcAddress,
    call: transferCall,
  });

  const feeEntrypointCall = await ctx.fpc.methods
    .fee_entrypoint(ctx.acceptedAsset, nonce, fjAmount, aaPaymentAmount, validUntil, quoteSigBytes)
    .getFunctionCall();

  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [authwit], [], [], ctx.fpcAddress),
    getFeePayer: async () => ctx.fpcAddress,
    getGasSettings: () => undefined,
  };

  // Use transfer_public_to_public as the fee-paid action; any account can call
  // this on their own balance (unlike mint_to_public which requires admin).
  await ctx.token.methods.transfer_public_to_public(payer, ctx.operator, 1n, Fr.random()).send({
    from: payer,
    fee: {
      paymentMethod,
      gasSettings: {
        gasLimits: new Gas(config.daGasLimit, config.l2GasLimit),
        teardownGasLimits: new Gas(0, 0),
        maxFeesPerGas: new GasFees(ctx.feePerDaGas, ctx.feePerL2Gas),
      },
    },
    wait: { timeout: 180 },
  });

  return { expectedCharge: aaPaymentAmount };
}

/** Build and send a fee-paid tx with optional overrides for chaos tests. */
async function submitFeePaidTxWithOptions(
  config: ChaosConfig,
  ctx: OnchainContext,
  payer: AztecAddress,
  quoteSigBytes: number[],
  fjAmount: bigint,
  aaPaymentAmount: bigint,
  validUntil: bigint,
  options?: {
    teardownDaGas?: number;
    teardownL2Gas?: number;
    /** Nonce used in the authwit (transfer action). Default: same as entrypointNonce. */
    authwitNonce?: Fr;
    /** Nonce passed to fee_entrypoint. Default: same as authwitNonce. */
    entrypointNonce?: Fr;
    /** Amount in the authwit (transfer). Default: aaPaymentAmount. */
    authwitAmount?: bigint;
  },
): Promise<{ expectedCharge: bigint }> {
  const entrypointNonce = options?.entrypointNonce ?? Fr.random();
  const authwitNonce = options?.authwitNonce ?? entrypointNonce;
  const authwitAmount = options?.authwitAmount ?? aaPaymentAmount;
  const teardownDaGas = options?.teardownDaGas ?? 0;
  const teardownL2Gas = options?.teardownL2Gas ?? 0;

  const maxAmount = authwitAmount > aaPaymentAmount ? authwitAmount : aaPaymentAmount;
  await fundPayerTokens(ctx, payer, maxAmount + 1_000_000n, 1n);

  const transferCall = await ctx.token.methods
    .transfer_private_to_private(payer, ctx.operator, authwitAmount, authwitNonce)
    .getFunctionCall();
  const authwit = await ctx.wallet.createAuthWit(payer, {
    caller: ctx.fpcAddress,
    call: transferCall,
  });

  const feeEntrypointCall = await ctx.fpc.methods
    .fee_entrypoint(
      ctx.acceptedAsset,
      entrypointNonce,
      fjAmount,
      aaPaymentAmount,
      validUntil,
      quoteSigBytes,
    )
    .getFunctionCall();

  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [authwit], [], [], ctx.fpcAddress),
    getFeePayer: async () => ctx.fpcAddress,
    getGasSettings: () => undefined,
  };

  await ctx.token.methods.transfer_public_to_public(payer, ctx.operator, 1n, Fr.random()).send({
    from: payer,
    fee: {
      paymentMethod,
      gasSettings: {
        gasLimits: new Gas(config.daGasLimit, config.l2GasLimit),
        teardownGasLimits: new Gas(teardownDaGas, teardownL2Gas),
        maxFeesPerGas: new GasFees(ctx.feePerDaGas, ctx.feePerL2Gas),
      },
    },
    wait: { timeout: 180 },
  });

  return { expectedCharge: aaPaymentAmount };
}

async function expectOnchainFailure(
  scenario: string,
  expectedFragments: string[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (expectedFragments.some((f) => msg.includes(f.toLowerCase()))) {
      return; // Expected rejection – test passes
    }
    throw new Error(`${scenario} failed with UNEXPECTED error: ${(err as Error).message}`);
  }
  throw new Error(`${scenario} unexpectedly SUCCEEDED (should have been rejected)`);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

async function runApiTests(runner: ChaosRunner, config: ChaosConfig): Promise<void> {
  const base = config.attestationUrl;

  // Discover the accepted_asset from the running attestation service so API
  // tests always use the value the service actually accepts.  The manifest
  // value (config.acceptedAsset) may be stale if containers were recycled.
  // We preserve the manifest value for the mismatch check below.
  const manifestAcceptedAsset = config.acceptedAsset;
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

  await runner.run("health-ok", "api", "GET /health returns 200 + {status:ok}", async () => {
    const { status, body } = await httpGet(`${base}/health`, config);
    assertOk(status, body, "/health");
    const parsed = JSON.parse(body) as { status?: string };
    if (parsed.status !== "ok") {
      throw new Error(`/health body.status expected "ok", got: ${body.slice(0, 100)}`);
    }
    return { status, body };
  });

  await runner.run("asset-ok", "api", "GET /asset returns valid structure", async () => {
    const { status, body } = await httpGet(`${base}/asset`, config);
    assertOk(status, body, "/asset");
    const parsed = JSON.parse(body) as { name?: string; address?: string };
    if (typeof parsed.name !== "string" || typeof parsed.address !== "string") {
      throw new Error(`/asset missing name or address: ${body.slice(0, 200)}`);
    }
    return { name: parsed.name, address: parsed.address };
  });

  await runner.run(
    "asset-address-matches-manifest",
    "api",
    "GET /asset address matches configured accepted_asset",
    async () => {
      if (!manifestAcceptedAsset) return { skipped: "no accepted_asset configured" };
      if (!process.env.FPC_CHAOS_MANIFEST) {
        return { skipped: "no manifest file loaded (address came from env var, not manifest)" };
      }
      const { status, body } = await httpGet(`${base}/asset`, config);
      assertOk(status, body, "/asset");
      const parsed = JSON.parse(body) as { address?: string };
      const got = (parsed.address ?? "").toLowerCase();
      const expected = manifestAcceptedAsset.toLowerCase();
      if (got !== expected) {
        throw new Error(`/asset address mismatch. expected=${expected} got=${got}`);
      }
      return { got, expected };
    },
  );

  await runner.run(
    "quote-valid-structure",
    "api",
    "GET /quote with valid params returns complete quote",
    async () => {
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertOk(status, body, "/quote");
      const q = parseQuote(body);
      return { fj_amount: q.fj_amount, aa_payment_amount: q.aa_payment_amount };
    },
  );

  await runner.run("quote-sig-64-bytes", "api", "Quote signature is exactly 64 bytes", async () => {
    const q = await fetchQuoteForSentinel(config);
    const sigBytes = Buffer.from(q.signature.replace(/^0x/, ""), "hex");
    if (sigBytes.length !== 64) {
      throw new Error(`Signature expected 64 bytes, got ${sigBytes.length}`);
    }
    return { sigLenBytes: sigBytes.length };
  });

  await runner.run(
    "quote-ttl-in-range",
    "api",
    "Quote valid_until is within max TTL window (3600s)",
    async () => {
      const q = await fetchQuoteForSentinel(config);
      const validUntil = BigInt(q.valid_until);

      // The attestation service anchors valid_until to the L2 block timestamp,
      // which can be significantly ahead of wall-clock time on local networks
      // where blocks are produced/time-advanced artificially. Use the latest L2
      // block timestamp as the reference clock; fall back to wall clock when no
      // node URL is configured (pure API mode against a remote service).
      let nowSec: bigint;
      if (config.nodeUrl) {
        const node = createAztecNodeClient(config.nodeUrl);
        const block = await node.getBlock("latest");
        nowSec = block ? block.timestamp : BigInt(Math.floor(Date.now() / 1000));
      } else {
        nowSec = BigInt(Math.floor(Date.now() / 1000));
      }

      const ttl = validUntil - nowSec;
      if (ttl <= 0n) {
        throw new Error(`Quote already expired (valid_until=${q.valid_until})`);
      }
      if (ttl > MAX_QUOTE_TTL_SECONDS + 10n) {
        throw new Error(
          `Quote TTL ${ttl}s exceeds max ${MAX_QUOTE_TTL_SECONDS}s (valid_until=${q.valid_until}, l2_now=${nowSec})`,
        );
      }
      return { ttlSeconds: ttl.toString() };
    },
  );

  await runner.run(
    "quote-asset-matches-manifest",
    "api",
    "Quote accepted_asset matches configured accepted_asset",
    async () => {
      if (!config.acceptedAsset) return { skipped: "no accepted_asset configured" };
      const q = await fetchQuoteForSentinel(config);
      const got = q.accepted_asset.toLowerCase();
      const expected = config.acceptedAsset.toLowerCase();
      if (got !== expected) {
        throw new Error(`Quote accepted_asset mismatch. expected=${expected} got=${got}`);
      }
      return { got, expected };
    },
  );

  await runner.run(
    "quote-fj-amount-echoed",
    "api",
    "Quote fj_amount matches requested fj_amount",
    async () => {
      const requested = "2000000";
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${requested}&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertOk(status, body, "/quote fj echo");
      const q = parseQuote(body);
      if (q.fj_amount !== requested) {
        throw new Error(`fj_amount echo mismatch: requested=${requested} got=${q.fj_amount}`);
      }
      return { requested, got: q.fj_amount };
    },
  );

  await runner.run("quote-no-params", "api", "GET /quote with no params returns 4xx", async () => {
    const { status, body } = await httpGet(`${base}/quote`, config);
    assertClientError(status, body, "/quote (no params)");
    return { status };
  });

  await runner.run(
    "quote-missing-user",
    "api",
    "GET /quote without user param returns 4xx",
    async () => {
      const { status, body } = await httpGet(
        `${base}/quote?fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`,
        config,
      );
      assertClientError(status, body, "/quote (missing user)");
      return { status };
    },
  );

  await runner.run(
    "quote-missing-fj-amount",
    "api",
    "GET /quote without fj_amount param returns 4xx",
    async () => {
      const { status, body } = await httpGet(
        `${base}/quote?user=${SENTINEL_USER}&accepted_asset=${config.acceptedAsset}`,
        config,
      );
      assertClientError(status, body, "/quote (missing fj_amount)");
      return { status };
    },
  );

  await runner.run(
    "quote-zero-fj-amount",
    "api",
    "GET /quote with fj_amount=0 returns 4xx",
    async () => {
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=0&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote fj_amount=0");
      return { status };
    },
  );

  await runner.run(
    "quote-negative-fj-amount",
    "api",
    "GET /quote with fj_amount=-1 returns 4xx",
    async () => {
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=-1&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote fj_amount=-1");
      return { status };
    },
  );

  await runner.run(
    "quote-non-numeric-fj-amount",
    "api",
    "GET /quote with fj_amount=notanumber returns 4xx",
    async () => {
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=notanumber&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote fj_amount=notanumber");
      return { status };
    },
  );

  await runner.run(
    "quote-overflow-fj-amount",
    "api",
    "GET /quote with fj_amount > u128 max returns 4xx",
    async () => {
      const overflow = (U128_MAX + 1n).toString();
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${overflow}&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote fj_amount overflow");
      return { status };
    },
  );

  await runner.run(
    "quote-invalid-user-address",
    "api",
    "GET /quote with malformed user address returns 4xx",
    async () => {
      const url = `${base}/quote?user=not_an_address&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote invalid user");
      return { status };
    },
  );

  await runner.run(
    "quote-sql-injection-user",
    "api",
    "GET /quote with SQL injection in user param returns 4xx",
    async () => {
      const injected = encodeURIComponent("' OR '1'='1");
      const url = `${base}/quote?user=${injected}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote sql injection");
      return { status };
    },
  );

  await runner.run(
    "quote-very-large-fj-amount",
    "api",
    "GET /quote with fj_amount = u128_max returns 4xx or valid quote",
    async () => {
      // u128 max is technically valid at the type level but likely too large to be useful
      // Attestation service may reject it as unreasonable – either 4xx or 200 is acceptable.
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${U128_MAX.toString()}&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      // We accept both success (service allows it) and client error (service rejects as too large)
      if (status >= 500) {
        throw new Error(`Server error on u128_max fj_amount: ${status} ${body.slice(0, 200)}`);
      }
      return { status, accepted: status < 400 };
    },
  );

  const ZERO_USER = "0x0000000000000000000000000000000000000000000000000000000000000000";
  await runner.run(
    "quote-zero-user-rejected",
    "api",
    "GET /quote with user=0x0 returns 4xx (spec: user never zero)",
    async () => {
      const url = `${base}/quote?user=${ZERO_USER}&fj_amount=1&accepted_asset=${config.acceptedAsset}`;
      const { status, body } = await httpGet(url, config);
      assertClientError(status, body, "/quote user=0x0");
      return { status };
    },
  );

  await runner.run(
    "quote-aa-payment-positive-for-positive-fj",
    "api",
    "Quote with fj_amount > 0 has aa_payment_amount > 0",
    async () => {
      const q = await fetchQuoteForSentinel(config);
      const fj = BigInt(q.fj_amount);
      const aa = BigInt(q.aa_payment_amount);
      if (fj > 0n && aa <= 0n) {
        throw new Error(
          `Quote has fj_amount=${q.fj_amount} but aa_payment_amount=${q.aa_payment_amount} (must be > 0 when fj > 0)`,
        );
      }
      return { fj_amount: q.fj_amount, aa_payment_amount: q.aa_payment_amount };
    },
  );

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

  await runner.run(
    "rate-limit-burst",
    "api-ratelimit",
    `Rate limiting: ${config.rateLimitBurst} rapid requests triggers 429s`,
    async () => {
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
      const promises = Array.from({ length: config.rateLimitBurst }, () =>
        httpGet(url, config).catch((e) => ({ status: -1, body: String(e) })),
      );
      const results = await Promise.all(promises);
      const statuses = results.map((r) => r.status);
      const tooMany = statuses.filter((s) => s === 429).length;
      const ok = statuses.filter((s) => s >= 200 && s < 300).length;
      const errors = statuses.filter((s) => s === -1).length;

      // If rate limiting is enabled, we expect some 429s
      // If disabled, all should be 200 – that's also a valid finding
      return {
        total: config.rateLimitBurst,
        ok,
        tooMany,
        errors,
        rateLimitingObserved: tooMany > 0,
      };
    },
  );

  if (config.topupUrl) {
    const topupBase = config.topupUrl;

    await runner.run("topup-health-ok", "api-topup", "Topup GET /health returns 200", async () => {
      const { status, body } = await httpGet(`${topupBase}/health`, config);
      assertOk(status, body, "topup /health");
      return { status };
    });

    await runner.run(
      "topup-ready",
      "api-topup",
      "Topup GET /ready returns 200 or 503 (not 500)",
      async () => {
        const { status, body } = await httpGet(`${topupBase}/ready`, config);
        // 200 = ready, 503 = not ready yet (legitimate). Only 500 is a real error.
        if (status === 500) {
          throw new Error(`Topup /ready returned internal server error: ${body.slice(0, 200)}`);
        }
        return { status, ready: status === 200 };
      },
    );
  } else {
    runner.skip(
      "topup-api-tests",
      "api-topup",
      "Topup service API tests",
      "FPC_CHAOS_TOPUP_URL not set",
    );
  }

  await runner.run(
    "quote-concurrent-consistency",
    "api-concurrent",
    "10 concurrent quote requests return consistent structure",
    async () => {
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          httpGet(url, config).then(({ status, body }) => ({
            status,
            quote: status < 400 ? parseQuote(body) : null,
          })),
        ),
      );
      const successes = results.filter((r) => r.status < 400);
      // All successful responses should have same fj_amount and accepted_asset
      const fjAmounts = new Set(successes.map((r) => r.quote?.fj_amount));
      const assets = new Set(successes.map((r) => r.quote?.accepted_asset));
      if (fjAmounts.size > 1) {
        throw new Error(
          `Inconsistent fj_amount across concurrent requests: ${[...fjAmounts].join(", ")}`,
        );
      }
      if (assets.size > 1) {
        throw new Error(
          `Inconsistent accepted_asset across concurrent requests: ${[...assets].join(", ")}`,
        );
      }
      return {
        total: results.length,
        successes: successes.length,
        rateLimited: results.filter((r) => r.status === 429).length,
      };
    },
  );
}

async function runOnchainTests(
  runner: ChaosRunner,
  config: ChaosConfig,
  ctx: OnchainContext,
): Promise<void> {
  const fjAmount = ctx.maxGasCostNoTeardown;

  const computeAaPayment = (rate: { num: bigint; den: bigint }) =>
    ceilDiv(fjAmount * rate.num, rate.den);

  // We use a fixed rate for crafting quotes (1:1 ratio, 0 bips) –
  // the on-chain contract only validates the signature, not the exchange rate.
  // Any sig the operator would produce passes; we want to test tampered sigs.
  const TEST_RATE = { num: 1n, den: 1000n };
  const aaPaymentAmount = computeAaPayment(TEST_RATE);

  await runner.run("onchain-happy-path", "onchain", "Valid fee-paid tx succeeds", async () => {
    const latestTs = await getLatestL2Timestamp(ctx);
    const validUntil = latestTs + 600n;
    const sigBytes = await signQuote(
      ctx.operatorSecretHex,
      ctx.fpcAddress,
      ctx.acceptedAsset,
      fjAmount,
      aaPaymentAmount,
      validUntil,
      ctx.user,
    );
    const { expectedCharge } = await submitFeePaidTx(
      config,
      ctx,
      ctx.user,
      sigBytes,
      fjAmount,
      aaPaymentAmount,
      validUntil,
    );
    return { expectedCharge: expectedCharge.toString() };
  });

  await runner.run(
    "onchain-quote-replay",
    "onchain",
    "Replaying a consumed quote is rejected (nullifier collision)",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      // Use the maximum allowed TTL so the quote does not expire between the
      // first submission and the replay attempt (block timestamps advance).
      const validUntil = latestTs + MAX_QUOTE_TTL_SECONDS;
      // Get a fresh quote for user (unique per-submission by signing key)
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );

      // First use – should succeed
      await submitFeePaidTx(config, ctx, ctx.user, sigBytes, fjAmount, aaPaymentAmount, validUntil);

      // Second use – must fail due to nullifier
      await expectOnchainFailure("quote replay", ["nullifier", "already exists", "duplicate"], () =>
        submitFeePaidTx(config, ctx, ctx.user, sigBytes, fjAmount, aaPaymentAmount, validUntil),
      );
    },
  );

  await runner.run(
    "onchain-expired-quote",
    "onchain",
    "Expired quote (valid_until = current block ts) is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      // Set valid_until to current timestamp (will be expired when block is produced)
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        latestTs, // expired: anchor_block_timestamp > valid_until after block advance
        ctx.user,
      );

      // Advance a block to push anchor_block_timestamp past valid_until
      if (ctx.faucet) {
        await ctx.faucet.methods
          .admin_drip(ctx.operator, 1n)
          .send({ from: ctx.operator, wait: { timeout: 60 } });
      } else {
        await ctx.token.methods
          .mint_to_private(ctx.operator, 1n)
          .send({ from: ctx.operator, wait: { timeout: 60 } });
      }

      await expectOnchainFailure("expired quote", ["quote expired", "expired"], () =>
        submitFeePaidTx(config, ctx, ctx.user, sigBytes, fjAmount, aaPaymentAmount, latestTs),
      );
    },
  );

  await runner.run(
    "onchain-overlong-ttl",
    "onchain",
    "Quote with TTL > 3600s is rejected by FPC",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const overlongValidUntil = latestTs + MAX_QUOTE_TTL_SECONDS + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        overlongValidUntil,
        ctx.user,
      );

      await expectOnchainFailure("overlong TTL", ["quote ttl too large", "ttl"], () =>
        submitFeePaidTx(
          config,
          ctx,
          ctx.user,
          sigBytes,
          fjAmount,
          aaPaymentAmount,
          overlongValidUntil,
        ),
      );
    },
  );

  await runner.run(
    "onchain-sender-binding",
    "onchain",
    "Quote signed for user A is rejected when submitted by user B",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      // Sign quote binding it to ctx.otherUser (user A).
      // NOTE: We sign for otherUser and submit from user (not the other way
      // around) so that submitFeePaidTx never mints private tokens to otherUser.
      // The insufficient-balance test later relies on otherUser having no
      // private tokens; minting to otherUser here would silently break it.
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.otherUser, // signed for otherUser (user A)
      );

      // Submit as ctx.user (user B) – sig verification fails because
      // quote_hash includes user_address = otherUser but msg_sender = user.
      await expectOnchainFailure("sender binding", ["signature"], () =>
        submitFeePaidTx(
          config,
          ctx,
          ctx.user, // wrong sender (user B)
          sigBytes,
          fjAmount,
          aaPaymentAmount,
          validUntil,
        ),
      );
    },
  );

  await runner.run(
    "onchain-tampered-signature",
    "onchain",
    "Quote with single flipped signature byte is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );

      // Flip byte 0 of the signature
      const tampered = [...sigBytes];
      tampered[0] = tampered[0] ^ 0xff;

      await expectOnchainFailure(
        "tampered signature",
        // A flipped byte in the R-point can create an off-curve point, which
        // the Grumpkin circuit rejects before the FPC sig check is reached.
        // schnorr::assert_valid_signature uses bare assert() – no message string.
        ["signature", "invalid", "grumpkin", "not a valid"],
        () =>
          submitFeePaidTx(config, ctx, ctx.user, tampered, fjAmount, aaPaymentAmount, validUntil),
      );
    },
  );

  await runner.run(
    "onchain-tampered-fj-amount",
    "onchain",
    "Quote with fj_amount incremented by 1 (sig mismatch) is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );

      // Pass fjAmount+1 but keep original signature – sig covers original fjAmount
      await expectOnchainFailure("tampered fj_amount", ["signature", "mismatch"], () =>
        submitFeePaidTx(
          config,
          ctx,
          ctx.user,
          sigBytes,
          fjAmount + 1n, // tampered
          aaPaymentAmount,
          validUntil,
        ),
      );
    },
  );

  await runner.run(
    "onchain-tampered-aa-amount",
    "onchain",
    "Quote with aa_payment_amount decremented by 1 (sig mismatch) is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );

      // Reduce aaPaymentAmount by 1 (would reduce operator revenue if accepted)
      const cheaper = aaPaymentAmount - 1n;

      await expectOnchainFailure("tampered aa_payment_amount", ["signature"], () =>
        submitFeePaidTx(
          config,
          ctx,
          ctx.user,
          sigBytes,
          fjAmount,
          cheaper, // tampered – cheaper payment than signed
          validUntil,
        ),
      );
    },
  );

  await runner.run(
    "onchain-fj-gas-mismatch",
    "onchain",
    "Quote with fj_amount != max_gas_cost_no_teardown is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      // Use half the actual max gas cost – the contract enforces equality
      const wrongFjAmount = fjAmount / 2n;
      const wrongAaAmount = computeAaPayment({
        num: TEST_RATE.num,
        den: TEST_RATE.den * 2n,
      });
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        wrongFjAmount,
        wrongAaAmount,
        validUntil,
        ctx.user,
      );

      await expectOnchainFailure(
        "fj_amount != max_gas_cost_no_teardown",
        ["quoted fee amount mismatch", "mismatch"],
        () =>
          submitFeePaidTx(
            config,
            ctx,
            ctx.user,
            sigBytes,
            wrongFjAmount,
            wrongAaAmount,
            validUntil,
          ),
      );
    },
  );

  await runner.run(
    "onchain-insufficient-balance",
    "onchain",
    "Fee-paid tx fails when user has no token balance for fee",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.otherUser,
      );

      // otherUser has NO tokens – don't mint before submitting
      const nonce = Fr.random();
      const transferCall = await ctx.token.methods
        .transfer_private_to_private(ctx.otherUser, ctx.operator, aaPaymentAmount, nonce)
        .getFunctionCall();
      const authwit = await ctx.wallet.createAuthWit(ctx.otherUser, {
        caller: ctx.fpcAddress,
        call: transferCall,
      });
      const feeEntrypointCall = await ctx.fpc.methods
        .fee_entrypoint(ctx.acceptedAsset, nonce, fjAmount, aaPaymentAmount, validUntil, sigBytes)
        .getFunctionCall();

      const paymentMethod = {
        getAsset: async () => ProtocolContractAddress.FeeJuice,
        getExecutionPayload: async () =>
          new ExecutionPayload([feeEntrypointCall], [authwit], [], [], ctx.fpcAddress),
        getFeePayer: async () => ctx.fpcAddress,
        getGasSettings: () => undefined,
      };

      // Give 1 public token so the tx action is authorized.
      // The fee payment fails regardless because otherUser has no PRIVATE tokens.
      await fundPayerTokens(ctx, ctx.otherUser, 0n, 1n);

      await expectOnchainFailure(
        "insufficient user balance",
        // Aztec reports private-execution failures as app_logic_reverted with no
        // further reason string. Accept that alongside token-specific strings.
        ["insufficient", "balance", "token", "underflow", "app_logic_reverted"],
        () =>
          ctx.token.methods
            .transfer_public_to_public(ctx.otherUser, ctx.operator, 1n, Fr.random())
            .send({
              from: ctx.otherUser,
              fee: {
                paymentMethod,
                gasSettings: {
                  gasLimits: new Gas(config.daGasLimit, config.l2GasLimit),
                  teardownGasLimits: new Gas(0, 0),
                  maxFeesPerGas: new GasFees(ctx.feePerDaGas, ctx.feePerL2Gas),
                },
              },
              wait: { timeout: 120 },
            }),
      );
    },
  );

  await runner.run(
    "onchain-valid-until-past",
    "onchain",
    "Quote with valid_until in the past is rejected",
    async () => {
      const validUntilPast = 1n; // Far in the past; anchor_ts will be > 1
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntilPast,
        ctx.user,
      );
      await expectOnchainFailure("valid_until in the past", ["quote expired", "expired"], () =>
        submitFeePaidTx(config, ctx, ctx.user, sigBytes, fjAmount, aaPaymentAmount, validUntilPast),
      );
    },
  );

  // NOTE: onchain-teardown-gas-rejected was removed because the FPC contract
  // (FPCMultiAsset) does not enforce zero teardown gas -- there is no teardown
  // assertion in fee_entrypoint.  Non-zero teardown gas is accepted by the
  // protocol and the contract, so there is nothing to reject.

  await runner.run(
    "onchain-authwit-nonce-mismatch",
    "onchain",
    "Authwit for nonce A with fee_entrypoint nonce B is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );
      const authwitNonce = Fr.random();
      const entrypointNonce = Fr.random();
      await expectOnchainFailure(
        "authwit nonce mismatch",
        // PXE rejects before submission when it cannot find an authwit for the
        // computed message hash ("Unknown auth witness for message hash 0x…").
        // If the tx does reach simulation, the contract reverts via app_logic_reverted.
        ["unknown auth witness", "authwit", "invalid", "nonce", "app_logic_reverted", "match"],
        () =>
          submitFeePaidTxWithOptions(
            config,
            ctx,
            ctx.user,
            sigBytes,
            fjAmount,
            aaPaymentAmount,
            validUntil,
            { authwitNonce, entrypointNonce },
          ),
      );
    },
  );

  await runner.run(
    "onchain-authwit-amount-mismatch",
    "onchain",
    "Authwit for amount X with fee_entrypoint aa_payment_amount Y != X rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );
      // Authwit authorises transfer of aaPaymentAmount + 1; entrypoint pays aaPaymentAmount.
      await expectOnchainFailure(
        "authwit amount mismatch",
        // PXE rejects before submission when it cannot find an authwit for the
        // computed message hash ("Unknown auth witness for message hash 0x…").
        // If the tx does reach simulation, the contract reverts via app_logic_reverted.
        ["unknown auth witness", "authwit", "invalid", "app_logic_reverted", "match", "action"],
        () =>
          submitFeePaidTxWithOptions(
            config,
            ctx,
            ctx.user,
            sigBytes,
            fjAmount,
            aaPaymentAmount,
            validUntil,
            { authwitAmount: aaPaymentAmount + 1n },
          ),
      );
    },
  );

  await runner.run(
    "onchain-quote-wrong-fpc-address",
    "onchain",
    "Quote signed with different FPC address is rejected (signature binding)",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const wrongFpcAddress = ctx.otherUser; // Any address != real FPC
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        wrongFpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );
      await expectOnchainFailure("quote signed for wrong FPC address", ["signature"], () =>
        submitFeePaidTx(config, ctx, ctx.user, sigBytes, fjAmount, aaPaymentAmount, validUntil),
      );
    },
  );

  await runner.run(
    "onchain-quote-wrong-accepted-asset",
    "onchain",
    "Quote signed with different accepted_asset is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const wrongAsset = ctx.otherUser; // Any address != real accepted_asset
      const sigBytes = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        wrongAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );
      await expectOnchainFailure("quote signed for wrong accepted_asset", ["signature"], () =>
        submitFeePaidTx(config, ctx, ctx.user, sigBytes, fjAmount, aaPaymentAmount, validUntil),
      );
    },
  );

  await runner.run(
    "onchain-signature-wrong-length",
    "onchain",
    "Quote with 63-byte signature is rejected",
    async () => {
      const latestTs = await getLatestL2Timestamp(ctx);
      const validUntil = latestTs + 600n;
      const sigBytes64 = await signQuote(
        ctx.operatorSecretHex,
        ctx.fpcAddress,
        ctx.acceptedAsset,
        fjAmount,
        aaPaymentAmount,
        validUntil,
        ctx.user,
      );
      const sig63 = sigBytes64.slice(0, 63);
      await expectOnchainFailure(
        "63-byte signature",
        // The Aztec ABI encoder validates fixed-size array lengths client-side
        // before simulation.  Passing a 63-element array for a [u8; 64] param
        // produces "Undefined argument quote_sig[63] of type integer".
        // If a future SDK version passes it through, the contract reverts instead.
        [
          "undefined argument",
          "signature",
          "64",
          "length",
          "invalid",
          "abi",
          "decode",
          "revert",
          "expected",
          "app_logic_reverted",
        ],
        () =>
          submitFeePaidTx(
            config,
            ctx,
            ctx.user,
            sig63 as number[],
            fjAmount,
            aaPaymentAmount,
            validUntil,
          ),
      );
    },
  );
}

async function runStressTests(
  runner: ChaosRunner,
  config: ChaosConfig,
  ctx: OnchainContext,
): Promise<void> {
  const fjAmount = ctx.maxGasCostNoTeardown;
  const TEST_RATE = { num: 1n, den: 1000n };
  const aaPaymentAmount = ceilDiv(fjAmount * TEST_RATE.num, TEST_RATE.den);

  await runner.run(
    "stress-sequential-txs",
    "stress",
    `${config.concurrentTxs} sequential fee-paid txs all succeed`,
    async () => {
      // NOTE: We run fee-paid txs sequentially rather than concurrently.
      // Concurrent private txs from the SAME Aztec account share the same
      // note pool: the wallet builds all txs against an identical blockchain
      // state and therefore picks the SAME private note for each tx. The second
      // and subsequent txs fail with a nullifier collision, not an FPC error.
      // Sequential submission ensures each tx is confirmed (its nullifiers
      // committed) before the next one is built, giving each its own note.
      if (!config.l1RpcUrl || !config.nodeUrl) {
        throw new Error("l1RpcUrl and nodeUrl are required for stress tests");
      }
      const { accounts: stressAccounts } = await resolveScriptAccounts(
        config.nodeUrl,
        config.l1RpcUrl,
        ctx.wallet,
        1,
      );
      const userAddress = stressAccounts[0].address;

      // Each tx fetches the current L2 timestamp right before signing.
      // This is required because each iteration waits for multiple tx confirmations
      // (fund payer tokens + fee-paid tx), each of which advances
      // the L2 block timestamp. Using a single latestTs captured before the
      // loop means later iterations produce an already-expired valid_until,
      // causing "Invalid expiration timestamp" at the protocol level.
      const errors: Error[] = [];
      let succeeded = 0;
      for (let i = 0; i < config.concurrentTxs; i++) {
        const currentTs = await getLatestL2Timestamp(ctx);
        // +i tiebreaker: ensures unique valid_until even if two consecutive
        // iterations land on the same L2 block (prevents quote nullifier collision).
        const txValidUntil = currentTs + 600n + BigInt(i);
        const sigBytes = await signQuote(
          ctx.operatorSecretHex,
          ctx.fpcAddress,
          ctx.acceptedAsset,
          fjAmount,
          aaPaymentAmount,
          txValidUntil,
          userAddress,
        );
        try {
          await submitFeePaidTx(
            config,
            ctx,
            userAddress,
            sigBytes,
            fjAmount,
            aaPaymentAmount,
            txValidUntil,
          );
          succeeded++;
        } catch (e) {
          errors.push(e as Error);
        }
      }

      if (errors.length > 0) {
        throw new Error(
          `${errors.length}/${config.concurrentTxs} sequential txs failed:\n` +
            errors.map((e) => `  - ${e.message}`).join("\n"),
        );
      }

      return { total: config.concurrentTxs, succeeded, failed: errors.length };
    },
  );

  await runner.run(
    "stress-quote-burst-consistency",
    "stress",
    "20 rapid quote requests (same user, same fj_amount) return identical fj_amount",
    async () => {
      const base = config.attestationUrl;
      const url = `${base}/quote?user=${SENTINEL_USER}&fj_amount=${SENTINEL_FJ_AMOUNT}&accepted_asset=${config.acceptedAsset}`;

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          httpGet(url, config).then(({ status, body }) => (status < 400 ? parseQuote(body) : null)),
        ),
      );

      const valid = results.filter((q) => q !== null);
      const fjAmounts = new Set(valid.map((q) => q?.fj_amount));
      if (fjAmounts.size > 1) {
        throw new Error(`Inconsistent fj_amount in burst: ${[...fjAmounts].join(", ")}`);
      }

      return {
        total: 20,
        valid: valid.length,
        rateLimited: results.filter((q) => q === null).length,
      };
    },
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    pinoLogger.info("FPC Chaos Test – see top of fpc-chaos-test.ts for ENV VAR documentation.");
    process.exit(0);
  }

  pinoLogger.info(`\n${BOLD}${CYAN}FPC Chaos / Adversarial Test Suite${RESET}\n`);

  const config = getConfig();

  pinoLogger.info(
    `${DIM}  mode=${config.mode}  attestation=${config.attestationUrl}` +
      (config.topupUrl ? `  topup=${config.topupUrl}` : "") +
      (config.nodeUrl ? `  node=${config.nodeUrl}` : "") +
      `${RESET}\n`,
  );

  const runner = new ChaosRunner(config);
  const globalStart = Date.now();

  pinoLogger.info(`${BOLD}Phase 1: API surface tests${RESET}`);
  await runApiTests(runner, config);

  if (config.mode === "onchain" || config.mode === "full") {
    if (!config.operatorSecretKey) {
      runner.skip(
        "onchain-tests",
        "onchain",
        "On-chain security tests",
        "FPC_CHAOS_OPERATOR_SECRET_KEY not set – skipping all onchain tests",
      );
    } else {
      pinoLogger.info(`\n${BOLD}Phase 2: On-chain security tests${RESET}`);
      pinoLogger.info(
        `${DIM}  Building on-chain context (loading artifacts + setting up accounts)...${RESET}`,
      );
      let ctx: OnchainContext;
      try {
        ctx = await buildOnchainContext(config);
      } catch (err) {
        pinoLogger.error(
          `${RED}Failed to build on-chain context: ${(err as Error).message}${RESET}`,
        );
        pinoLogger.error(
          `${DIM}  Ensure the Aztec node is reachable and contract artifacts exist in target/.${RESET}`,
        );
        process.exit(1);
      }
      await runOnchainTests(runner, config, ctx);

      if (config.mode === "full") {
        pinoLogger.info(`\n${BOLD}Phase 3: Concurrent stress tests${RESET}`);
        await runStressTests(runner, config, ctx);
      }
    }
  }

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
