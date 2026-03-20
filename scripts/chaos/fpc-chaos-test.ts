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

  if (mode === "full" && !nodeUrl) {
    throw new Error(`FPC_CHAOS_NODE_URL (or manifest with node URL) is required for mode=${mode}`);
  }
  if (mode === "full" && !fpcAddress) {
    throw new Error(
      `FPC_CHAOS_FPC_ADDRESS (or manifest with fpc_address) is required for mode=${mode}`,
    );
  }
  if (mode === "full" && !acceptedAsset) {
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

// Sentinel user for API-only tests – not a valid account but a real format address
const SENTINEL_USER = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SENTINEL_FJ_AMOUNT = "1000000";

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

  // User: fresh account deployed with funded FeeJuice,
  // isolated from the node's genesis accounts to avoid note conflicts.
  pinoLogger.info("Resolving test accounts (L1 fund + L2 deploy)...");
  const { accounts: scriptAccounts } = await resolveScriptAccounts(
    config.nodeUrl,
    config.l1RpcUrl,
    wallet,
    1,
  );
  const user = scriptAccounts[0].address;

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

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

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
      const maxRetries = 2; // per iteration
      for (let i = 0; i < config.concurrentTxs; i++) {
        let ok = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const currentTs = await getLatestL2Timestamp(ctx);
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
            ok = true;
            break;
          } catch (e) {
            if (attempt < maxRetries) {
              const msg = e instanceof Error ? e.message : String(e);
              pinoLogger.warn(
                `Stress tx[${i}] failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.slice(0, 100)}. Retrying...`,
              );
              continue;
            }
            errors.push(e as Error);
          }
        }
        if (ok) succeeded++;
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

  if (config.mode === "full") {
    if (!config.operatorSecretKey) {
      runner.skip(
        "stress-tests",
        "stress",
        "Stress tests",
        "FPC_CHAOS_OPERATOR_SECRET_KEY not set – skipping stress tests",
      );
    } else {
      pinoLogger.info(`\n${BOLD}Stress tests${RESET}`);
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
      await runStressTests(runner, config, ctx);
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
