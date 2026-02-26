import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CliArgs = {
  aztecNodeUrl: string;
  l1RpcUrl: string;
  operator: string;
  acceptedAsset: string | null;
  reuse: boolean;
  out: string;
};

type CliParseResult =
  | {
      kind: "help";
    }
  | {
      kind: "args";
      args: CliArgs;
    };

type PreflightOutput = {
  status: "preflight_ok";
  generated_at: string;
  aztec_node_url: string;
  l1_rpc_url: string;
  l1_chain_id: number;
  operator: string;
  accepted_asset: string | null;
  reuse: boolean;
  node_contracts: {
    fee_juice_portal_address: string;
    fee_juice_address: string;
  };
  artifacts: {
    token_contract_artifact: string;
    fpc_artifact: string;
  };
  deployer: {
    source: "aztec_wallet_test_account";
    wallet_alias: string;
    address: string;
    fee_juice_balance_wei: string;
    min_required_fee_juice_wei: string;
    min_required_source:
      | "computed_from_min_fees"
      | "fallback_fee_schedule"
      | "env_override";
  };
  deploy: {
    implemented: false;
    note: string;
  };
};

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: number | string | null;
  error: JsonRpcErrorObject;
};

type BalanceDeps = {
  createAztecNodeClient: (url: string) => unknown;
  getFeeJuiceBalance: (owner: unknown, node: unknown) => Promise<bigint>;
  AztecAddress: {
    fromString: (value: string) => unknown;
  };
};

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_AZTEC_ADDRESS_PATTERN = /^0x0{64}$/i;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const REQUIRED_ARTIFACTS = {
  token: path.join(REPO_ROOT, "target", "token_contract-Token.json"),
  fpc: path.join(REPO_ROOT, "target", "fpc-FPC.json"),
} as const;

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/deploy-fpc-local.ts \\",
    "    --operator <aztec_address> \\",
    "    --out <path.json> \\",
    "    [--aztec-node-url <url>] \\",
    "    [--l1-rpc-url <url>] \\",
    "    [--accepted-asset <aztec_address>] \\",
    "    [--reuse]",
    "",
    "Defaults:",
    "  --aztec-node-url http://127.0.0.1:8080",
    "  --l1-rpc-url     http://127.0.0.1:8545",
    "  --operator       required (or set FPC_LOCAL_OPERATOR)",
    "  --out            required (or set FPC_LOCAL_OUT)",
    "",
    "Notes:",
    "  - Current script performs preflight checks only (no deploy yet).",
    "  - Deployer bootstrap uses `aztec-wallet import-test-accounts`.",
    "  - Optional env overrides: FPC_DEPLOYER_ACCOUNT_INDEX, FPC_DEPLOYER_MIN_FEE_JUICE_WEI, FPC_DEPLOYER_ESTIMATED_DA_GAS, FPC_DEPLOYER_ESTIMATED_L2_GAS, FPC_DEPLOYER_FEE_SAFETY_MULTIPLIER, FPC_DEPLOYER_FEE_BUFFER_WEI, FPC_DEPLOYER_FALLBACK_FEE_PER_DA_GAS, FPC_DEPLOYER_FALLBACK_FEE_PER_L2_GAS, FPC_RPC_RETRIES, FPC_RPC_RETRY_BACKOFF_MS.",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseAztecAddress(value: string, fieldName: string): string {
  if (!AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(
      `Invalid ${fieldName}: expected a 32-byte 0x-prefixed Aztec address, got "${value}"`,
    );
  }
  if (ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: zero address is not allowed`);
  }
  return value;
}

function parseUrl(value: string, fieldName: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError(
        `Invalid ${fieldName}: expected http(s) URL, got "${value}"`,
      );
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Invalid ${fieldName}: expected URL, got "${value}"`);
  }
}

function parseCliArgs(argv: string[]): CliParseResult {
  let aztecNodeUrl = "http://127.0.0.1:8080";
  let l1RpcUrl = "http://127.0.0.1:8545";
  let operatorRaw: string | null = process.env.FPC_LOCAL_OPERATOR ?? null;
  let acceptedAssetRaw: string | null = null;
  let reuse = false;
  let out: string | null = process.env.FPC_LOCAL_OUT ?? null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--aztec-node-url":
        aztecNodeUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--l1-rpc-url":
        l1RpcUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator":
        operatorRaw = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--accepted-asset":
        acceptedAssetRaw = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--out":
        out = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--reuse":
        reuse = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!operatorRaw) {
    throw new CliError(
      "Missing required --operator. Provide --operator <aztec_address> or set FPC_LOCAL_OPERATOR.",
    );
  }
  if (!out) {
    throw new CliError(
      "Missing required --out. Provide --out <path.json> or set FPC_LOCAL_OUT.",
    );
  }

  return {
    kind: "args",
    args: {
      aztecNodeUrl: parseUrl(aztecNodeUrl, "--aztec-node-url"),
      l1RpcUrl: parseUrl(l1RpcUrl, "--l1-rpc-url"),
      operator: parseAztecAddress(operatorRaw, "--operator"),
      acceptedAsset: acceptedAssetRaw
        ? parseAztecAddress(acceptedAssetRaw, "--accepted-asset")
        : null,
      reuse,
      out,
    },
  };
}

function parsePositiveChainId(
  value: unknown,
  fieldName: string,
  expectedKind: "number_or_decimal" | "hex",
): number {
  let chainIdBigInt: bigint;

  if (expectedKind === "hex") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new CliError(
        `${fieldName} returned invalid value ${String(value)}; expected 0x-prefixed hex`,
      );
    }
    chainIdBigInt = BigInt(value);
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new CliError(
        `${fieldName} returned invalid value ${String(value)}; expected integer`,
      );
    }
    chainIdBigInt = BigInt(value);
  } else if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    chainIdBigInt = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    chainIdBigInt = BigInt(value);
  } else {
    throw new CliError(
      `${fieldName} returned invalid value ${String(value)}; expected integer chain-id`,
    );
  }

  if (chainIdBigInt <= 0n) {
    throw new CliError(
      `${fieldName} returned invalid value ${String(value)}; expected chain-id > 0`,
    );
  }

  if (chainIdBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CliError(
      `${fieldName} returned too-large chain-id ${chainIdBigInt.toString()} (exceeds Number.MAX_SAFE_INTEGER)`,
    );
  }

  return Number(chainIdBigInt);
}

function parseEnvPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(
      `Invalid ${name}=${raw}. Expected a positive integer value.`,
    );
  }
  return parsed;
}

function parseEnvNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(
      `Invalid ${name}=${raw}. Expected a non-negative integer value.`,
    );
  }
  return parsed;
}

function parseEnvPositiveBigInt(name: string): bigint | null {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }
  if (!DECIMAL_UINT_PATTERN.test(raw)) {
    throw new CliError(
      `Invalid ${name}=${raw}. Expected an unsigned integer string.`,
    );
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new CliError(`Invalid ${name}=${raw}. Expected value > 0.`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertRequiredArtifactsExist(): {
  tokenArtifactPath: string;
  fpcArtifactPath: string;
} {
  const missing: string[] = [];
  if (!existsSync(REQUIRED_ARTIFACTS.token)) {
    missing.push(REQUIRED_ARTIFACTS.token);
  }
  if (!existsSync(REQUIRED_ARTIFACTS.fpc)) {
    missing.push(REQUIRED_ARTIFACTS.fpc);
  }
  if (missing.length > 0) {
    const formatted = missing.map((entry) => `  - ${entry}`).join("\n");
    throw new CliError(
      `Artifact preflight failed: required compiled contract artifacts are missing.\n${formatted}\nRun 'aztec compile' from repo root and retry.`,
    );
  }
  return {
    tokenArtifactPath: REQUIRED_ARTIFACTS.token,
    fpcArtifactPath: REQUIRED_ARTIFACTS.fpc,
  };
}

function runAztecWalletCommand(
  nodeUrl: string,
  args: string[],
  description: string,
): string {
  const walletBin = process.env.AZTEC_WALLET_BIN ?? "aztec-wallet";
  const commandArgs = ["--node-url", nodeUrl, ...args];
  try {
    return execFileSync(walletBin, commandArgs, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stderr" in error &&
      "stdout" in error
    ) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      throw new CliError(
        `Failed to ${description} via '${walletBin} ${commandArgs.join(" ")}'.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    throw new CliError(
      `Failed to ${description}: ${String(error)} (wallet binary: ${walletBin})`,
    );
  }
}

function parseWalletTestAccounts(output: string): Map<number, string> {
  const accounts = new Map<number, string>();
  const sanitized = stripAnsi(output).replace(/\r\n/g, "\n");
  const regex = /^\s*accounts:test(\d+)\s*->\s*(0x[0-9a-fA-F]{64})\s*$/gim;
  let match = regex.exec(sanitized);
  while (match) {
    const index = Number(match[1]);
    const address = match[2];
    accounts.set(index, address);
    match = regex.exec(sanitized);
  }
  return accounts;
}

function stripAnsi(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "\u001B") {
      result += char;
      continue;
    }
    if (value[i + 1] !== "[") {
      continue;
    }
    i += 2;
    while (i < value.length && !/[A-Za-z]/.test(value[i])) {
      i += 1;
    }
  }
  return result;
}

function bootstrapDeployerFromWallet(aztecNodeUrl: string): {
  alias: string;
  address: string;
} {
  runAztecWalletCommand(
    aztecNodeUrl,
    ["import-test-accounts"],
    "bootstrap deployer wallet (import test accounts)",
  );
  const aliases = runAztecWalletCommand(
    aztecNodeUrl,
    ["get-alias"],
    "read wallet aliases after test-account import",
  );
  const testAccounts = parseWalletTestAccounts(aliases);

  const deployerIndex = parseEnvNonNegativeNumber(
    "FPC_DEPLOYER_ACCOUNT_INDEX",
    0,
  );
  if (!testAccounts.has(deployerIndex)) {
    const available = [...testAccounts.keys()].sort((a, b) => a - b);
    throw new CliError(
      `Deployer bootstrap failed: FPC_DEPLOYER_ACCOUNT_INDEX=${deployerIndex} not found in wallet aliases. Available test account indices: ${available.length > 0 ? available.join(", ") : "<none>"}`,
    );
  }

  const alias = `test${deployerIndex}`;
  const address = testAccounts.get(deployerIndex);
  if (!address) {
    throw new CliError(
      `Deployer bootstrap failed: missing address for wallet alias ${alias}`,
    );
  }

  return { alias, address };
}

async function importWithWorkspaceFallback(
  moduleId: string,
): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  try {
    return (await import(moduleId)) as Record<string, unknown>;
  } catch (error) {
    errors.push(`direct import failed: ${String(error)}`);
  }

  const fallbackPackageJsons = [
    path.join(REPO_ROOT, "services", "attestation", "package.json"),
    path.join(REPO_ROOT, "services", "topup", "package.json"),
  ];

  for (const packageJsonPath of fallbackPackageJsons) {
    try {
      const requireFromWorkspace = createRequire(packageJsonPath);
      const resolved = requireFromWorkspace.resolve(moduleId);
      return (await import(pathToFileURL(resolved).href)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      errors.push(
        `workspace import failed via ${packageJsonPath}: ${String(error)}`,
      );
    }
  }

  throw new CliError(
    `Failed to load ${moduleId} for deployer fee preflight.\n${errors.join("\n")}`,
  );
}

async function loadBalanceDeps(): Promise<BalanceDeps> {
  const [nodeApi, utilsApi, addressesApi] = await Promise.all([
    importWithWorkspaceFallback("@aztec/aztec.js/node"),
    importWithWorkspaceFallback("@aztec/aztec.js/utils"),
    importWithWorkspaceFallback("@aztec/aztec.js/addresses"),
  ]);

  const createAztecNodeClient = nodeApi.createAztecNodeClient;
  const getFeeJuiceBalance = utilsApi.getFeeJuiceBalance;
  const AztecAddress = addressesApi.AztecAddress;

  if (typeof createAztecNodeClient !== "function") {
    throw new CliError(
      "Loaded @aztec/aztec.js/node, but createAztecNodeClient is not available",
    );
  }
  if (typeof getFeeJuiceBalance !== "function") {
    throw new CliError(
      "Loaded @aztec/aztec.js/utils, but getFeeJuiceBalance is not available",
    );
  }
  if (!AztecAddress || typeof AztecAddress !== "function") {
    throw new CliError(
      "Loaded @aztec/aztec.js/addresses, but AztecAddress is not available",
    );
  }

  return {
    createAztecNodeClient: createAztecNodeClient as (url: string) => unknown,
    getFeeJuiceBalance: getFeeJuiceBalance as (
      owner: unknown,
      node: unknown,
    ) => Promise<bigint>,
    AztecAddress: AztecAddress as { fromString: (value: string) => unknown },
  };
}

async function getDeployerFeeJuiceBalance(
  aztecNodeUrl: string,
  deployerAddress: string,
): Promise<bigint> {
  const deps = await loadBalanceDeps();
  const node = deps.createAztecNodeClient(aztecNodeUrl);
  const owner = deps.AztecAddress.fromString(deployerAddress);
  const balance = await deps.getFeeJuiceBalance(owner, node);
  if (typeof balance !== "bigint") {
    throw new CliError(
      `Deployer balance check failed: expected bigint from getFeeJuiceBalance, got ${String(balance)}`,
    );
  }
  return balance;
}

function parseGasFeeComponent(value: unknown, fieldName: string): bigint {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (DECIMAL_UINT_PATTERN.test(normalized)) {
      return BigInt(normalized);
    }
    if (/^0x[0-9a-fA-F]+$/.test(normalized)) {
      return BigInt(normalized);
    }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value;
  }
  throw new CliError(
    `node_getCurrentMinFees returned invalid ${fieldName}=${String(value)}`,
  );
}

async function resolveMinimumDeployerFeeJuice(aztecNodeUrl: string): Promise<{
  minRequired: bigint;
  source: "computed_from_min_fees" | "fallback_fee_schedule" | "env_override";
}> {
  const explicitMinimum = parseEnvPositiveBigInt(
    "FPC_DEPLOYER_MIN_FEE_JUICE_WEI",
  );
  if (explicitMinimum !== null) {
    return {
      minRequired: explicitMinimum,
      source: "env_override",
    };
  }

  const estimatedDaGas = BigInt(
    parseEnvPositiveNumber("FPC_DEPLOYER_ESTIMATED_DA_GAS", 1_000_000),
  );
  const estimatedL2Gas = BigInt(
    parseEnvPositiveNumber("FPC_DEPLOYER_ESTIMATED_L2_GAS", 1_000_000),
  );
  const safetyMultiplier = BigInt(
    parseEnvPositiveNumber("FPC_DEPLOYER_FEE_SAFETY_MULTIPLIER", 5),
  );
  const fixedBuffer = BigInt(
    parseEnvPositiveNumber("FPC_DEPLOYER_FEE_BUFFER_WEI", 1_000_000),
  );

  let feePerDaGas: bigint;
  let feePerL2Gas: bigint;
  let source: "computed_from_min_fees" | "fallback_fee_schedule" =
    "computed_from_min_fees";

  try {
    const rawMinFees = await rpcCall<{
      feePerDaGas?: unknown;
      feePerL2Gas?: unknown;
    }>(aztecNodeUrl, "node_getCurrentMinFees", []);
    if (!rawMinFees || typeof rawMinFees !== "object") {
      throw new CliError(
        "node_getCurrentMinFees returned invalid non-object payload",
      );
    }
    feePerDaGas = parseGasFeeComponent(rawMinFees.feePerDaGas, "feePerDaGas");
    feePerL2Gas = parseGasFeeComponent(rawMinFees.feePerL2Gas, "feePerL2Gas");
  } catch (error) {
    const fallbackFeePerDaGas = BigInt(
      parseEnvNonNegativeNumber("FPC_DEPLOYER_FALLBACK_FEE_PER_DA_GAS", 0),
    );
    const fallbackFeePerL2Gas = BigInt(
      parseEnvNonNegativeNumber(
        "FPC_DEPLOYER_FALLBACK_FEE_PER_L2_GAS",
        30_000_000,
      ),
    );
    source = "fallback_fee_schedule";
    feePerDaGas = fallbackFeePerDaGas;
    feePerL2Gas = fallbackFeePerL2Gas;
    console.warn(
      `[deploy-fpc-local] WARN: failed to query node_getCurrentMinFees (${String(error)}). Falling back to fee schedule feePerDaGas=${feePerDaGas.toString()} feePerL2Gas=${feePerL2Gas.toString()}`,
    );
  }

  const baseCost =
    estimatedDaGas * feePerDaGas + estimatedL2Gas * feePerL2Gas + fixedBuffer;
  const minRequired = baseCost * safetyMultiplier;
  if (minRequired <= 0n) {
    throw new CliError(
      `Computed deployer minimum fee requirement is invalid (${minRequired.toString()})`,
    );
  }

  return {
    minRequired,
    source,
  };
}

async function assertAztecNodeReachable(args: CliArgs): Promise<{
  l1ChainId: number;
  feeJuicePortalAddress: string;
  feeJuiceAddress: string;
}> {
  const ready = await rpcCall<boolean>(args.aztecNodeUrl, "node_isReady", []);
  if (!ready) {
    throw new CliError(
      `Aztec node preflight failed: ${args.aztecNodeUrl} responded but node_isReady=false`,
    );
  }

  let nodeInfo: unknown;
  try {
    nodeInfo = await rpcCall<unknown>(
      args.aztecNodeUrl,
      "node_getNodeInfo",
      [],
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(String(error));
  }

  if (!nodeInfo || typeof nodeInfo !== "object") {
    throw new CliError(
      "Aztec node preflight failed: node_getNodeInfo returned non-object payload",
    );
  }

  const raw = nodeInfo as {
    l1ChainId?: unknown;
    l1ContractAddresses?: {
      feeJuicePortalAddress?: unknown;
      feeJuiceAddress?: unknown;
    };
  };

  const l1ChainId = parsePositiveChainId(
    raw.l1ChainId,
    "Aztec node preflight failed: node_getNodeInfo.l1ChainId",
    "number_or_decimal",
  );

  const contractAddresses = raw.l1ContractAddresses;
  if (!contractAddresses || typeof contractAddresses !== "object") {
    throw new CliError(
      "Aztec node preflight failed: node_getNodeInfo.l1ContractAddresses missing or invalid",
    );
  }

  const feeJuicePortalAddress = contractAddresses.feeJuicePortalAddress;
  const feeJuiceAddress = contractAddresses.feeJuiceAddress;
  if (
    !isL1Address(feeJuicePortalAddress) ||
    isZeroL1Address(feeJuicePortalAddress)
  ) {
    throw new CliError(
      `Aztec node preflight failed: invalid feeJuicePortalAddress=${String(feeJuicePortalAddress)}`,
    );
  }
  if (!isL1Address(feeJuiceAddress) || isZeroL1Address(feeJuiceAddress)) {
    throw new CliError(
      `Aztec node preflight failed: invalid feeJuiceAddress=${String(feeJuiceAddress)}`,
    );
  }

  return {
    l1ChainId,
    feeJuicePortalAddress: feeJuicePortalAddress.toString(),
    feeJuiceAddress: feeJuiceAddress.toString(),
  };
}

async function assertL1RpcReachable(args: CliArgs): Promise<number> {
  try {
    const chainIdHex = await rpcCall<string>(args.l1RpcUrl, "eth_chainId", []);
    return parsePositiveChainId(
      chainIdHex,
      "L1 RPC preflight failed: eth_chainId",
      "hex",
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      `L1 RPC preflight failed: could not reach ${args.l1RpcUrl}. Ensure Anvil is running on this URL. Underlying error: ${String(error)}`,
    );
  }
}

function isL1Address(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isZeroL1Address(value: string): boolean {
  return /^0x0{40}$/i.test(value);
}

function isJsonRpcFailure(payload: unknown): payload is JsonRpcFailure {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return "error" in payload;
}

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const retries = parseEnvPositiveNumber("FPC_RPC_RETRIES", 3);
  const backoffMs = parseEnvPositiveNumber("FPC_RPC_RETRY_BACKOFF_MS", 250);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      lastError = new CliError(
        `RPC request failed for method ${method} at ${url}: ${String(error)}`,
      );
      if (attempt < retries) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const error = new CliError(
        `RPC request failed for method ${method} at ${url}: HTTP ${response.status} ${response.statusText}`,
      );
      lastError = error;
      if (response.status >= 500 && attempt < retries) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw error;
    }

    let payload: JsonRpcSuccess<T> | JsonRpcFailure;
    try {
      payload = (await response.json()) as JsonRpcSuccess<T> | JsonRpcFailure;
    } catch (error) {
      lastError = new CliError(
        `RPC response for method ${method} at ${url} is not valid JSON: ${String(error)}`,
      );
      if (attempt < retries) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw lastError;
    }

    if (isJsonRpcFailure(payload)) {
      throw new CliError(
        `RPC method ${method} failed at ${url}: code=${payload.error.code} message="${payload.error.message}"`,
      );
    }

    return payload.result;
  }

  throw (
    lastError ??
    new CliError(
      `RPC request failed for method ${method} at ${url}: exhausted retries`,
    )
  );
}

function writePreflightOutput(outPath: string, data: PreflightOutput): void {
  const absolute = path.resolve(outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const parseResult = parseCliArgs(process.argv.slice(2));
  if (parseResult.kind === "help") {
    return;
  }
  const args = parseResult.args;

  console.log("[deploy-fpc-local] starting preflight checks");
  console.log(`[deploy-fpc-local] aztec_node_url=${args.aztecNodeUrl}`);
  console.log(`[deploy-fpc-local] l1_rpc_url=${args.l1RpcUrl}`);
  console.log(`[deploy-fpc-local] operator=${args.operator}`);
  console.log(
    `[deploy-fpc-local] accepted_asset=${args.acceptedAsset ?? "<auto-deploy in follow-up issue>"}`,
  );
  console.log(`[deploy-fpc-local] reuse=${String(args.reuse)}`);

  const nodeState = await assertAztecNodeReachable(args);
  console.log(
    `[deploy-fpc-local] aztec node reachable, expected l1_chain_id=${nodeState.l1ChainId}`,
  );

  const rpcChainId = await assertL1RpcReachable(args);
  console.log(
    `[deploy-fpc-local] l1 rpc reachable, reported l1_chain_id=${rpcChainId}`,
  );

  if (rpcChainId !== nodeState.l1ChainId) {
    throw new CliError(
      `Chain-id sanity check failed: aztec node expects l1_chain_id=${nodeState.l1ChainId}, but L1 RPC reports l1_chain_id=${rpcChainId}`,
    );
  }
  console.log("[deploy-fpc-local] chain-id sanity check passed");

  const artifacts = assertRequiredArtifactsExist();
  console.log(
    `[deploy-fpc-local] artifact preflight passed. token=${artifacts.tokenArtifactPath} fpc=${artifacts.fpcArtifactPath}`,
  );

  const deployer = bootstrapDeployerFromWallet(args.aztecNodeUrl);
  console.log(
    `[deploy-fpc-local] deployer wallet bootstrap passed. alias=${deployer.alias} address=${deployer.address}`,
  );

  const [deployerFeeJuiceBalance, minimumFeeJuice] = await Promise.all([
    getDeployerFeeJuiceBalance(args.aztecNodeUrl, deployer.address),
    resolveMinimumDeployerFeeJuice(args.aztecNodeUrl),
  ]);

  if (deployerFeeJuiceBalance < minimumFeeJuice.minRequired) {
    throw new CliError(
      `Deployer fee balance too low: deployer=${deployer.address} balance=${deployerFeeJuiceBalance.toString()} required_min=${minimumFeeJuice.minRequired.toString()} (source=${minimumFeeJuice.source}). Fund the deployer or lower the threshold via FPC_DEPLOYER_MIN_FEE_JUICE_WEI.`,
    );
  }
  console.log(
    `[deploy-fpc-local] deployer fee balance preflight passed. balance=${deployerFeeJuiceBalance.toString()} required_min=${minimumFeeJuice.minRequired.toString()} source=${minimumFeeJuice.source}`,
  );

  const output: PreflightOutput = {
    status: "preflight_ok",
    generated_at: new Date().toISOString(),
    aztec_node_url: args.aztecNodeUrl,
    l1_rpc_url: args.l1RpcUrl,
    l1_chain_id: nodeState.l1ChainId,
    operator: args.operator,
    accepted_asset: args.acceptedAsset ?? null,
    reuse: args.reuse,
    node_contracts: {
      fee_juice_portal_address: nodeState.feeJuicePortalAddress,
      fee_juice_address: nodeState.feeJuiceAddress,
    },
    artifacts: {
      token_contract_artifact: artifacts.tokenArtifactPath,
      fpc_artifact: artifacts.fpcArtifactPath,
    },
    deployer: {
      source: "aztec_wallet_test_account",
      wallet_alias: deployer.alias,
      address: deployer.address,
      fee_juice_balance_wei: deployerFeeJuiceBalance.toString(),
      min_required_fee_juice_wei: minimumFeeJuice.minRequired.toString(),
      min_required_source: minimumFeeJuice.source,
    },
    deploy: {
      implemented: false,
      note: "Deployment flow intentionally deferred; this script currently performs preflight checks only.",
    },
  };
  writePreflightOutput(args.out, output);
  console.log(
    `[deploy-fpc-local] preflight checks passed. Wrote output to ${path.resolve(args.out)}`,
  );
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`[deploy-fpc-local] ERROR: ${error.message}`);
    console.error("");
    console.error(usage());
  } else {
    console.error("[deploy-fpc-local] Unexpected error:", error);
  }
  process.exit(1);
});
