import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CliArgs = {
  nodeUrl: string;
  l1RpcUrl: string | null;
  validateTopupPath: boolean;
  sponsoredFpcAddress: string;
  deployerAlias: string;
  deployerPrivateKey: string | null;
  deployerPrivateKeyRef: string | null;
  operatorSecretKey: string | null;
  operatorSecretKeyRef: string | null;
  acceptedAsset: string | null;
  out: string;
  preflightOnly: boolean;
};

type CliParseResult =
  | {
      kind: "help";
    }
  | {
      kind: "args";
      args: CliArgs;
    };

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

type NodePreflightState = {
  nodeVersion: string;
  l1ChainId: number;
  l2ChainId: number;
  rollupVersion: number;
  l1ContractAddresses: {
    registryAddress: string;
    rollupAddress: string;
    inboxAddress: string;
    outboxAddress: string;
    feeJuiceAddress: string;
    feeJuicePortalAddress: string;
    feeAssetHandlerAddress: string;
  };
  protocolContractAddresses: {
    instanceRegistry: string;
    classRegistry: string;
    multiCallEntrypoint: string;
    feeJuice: string;
  };
};

type DeployerAccountResolution = {
  alias: string;
  walletAlias: string;
  address: string;
  privateKey: string | null;
  privateKeyRef: string | null;
  source: "existing" | "created" | "imported";
};

type OperatorIdentity = {
  address: string;
  pubkeyX: string;
  pubkeyY: string;
};

type OperatorDerivationDeps = {
  getSchnorrAccountContractAddress: (
    secretKey: unknown,
    salt: unknown,
  ) => Promise<unknown>;
  Fr: {
    fromHexString: (value: string) => unknown;
    ZERO: unknown;
  };
  deriveSigningKey: (secretKey: unknown) => unknown;
  Schnorr: new () => {
    computePublicKey: (signingKey: unknown) => Promise<{
      x: unknown;
      y: unknown;
    }>;
  };
};

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_AZTEC_ADDRESS_PATTERN = /^0x0{64}$/i;
const L1_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_L1_ADDRESS_PATTERN = /^0x0{40}$/i;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const HEX_FIELD_PATTERN = /^0x[0-9a-fA-F]+$/;
const WALLET_ACCOUNT_PREFIX = "accounts:";
const WALLET_CONTRACT_PREFIX = "contracts:";
const WALLET_SPONSORED_FPC_ALIAS = "sponsoredfpc";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const REQUIRED_ARTIFACTS = {
  token: path.join(REPO_ROOT, "target", "token_contract-Token.json"),
  fpc: path.join(REPO_ROOT, "target", "fpc-FPC.json"),
  creditFpc: path.join(REPO_ROOT, "target", "credit_fpc-CreditFPC.json"),
} as const;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/deploy-fpc-devnet.ts \\",
    "    --node-url <url> \\",
    "    --sponsored-fpc-address <aztec_address> \\",
    "    --deployer-alias <alias> \\",
    "    (--deployer-private-key <hex32> | --deployer-private-key-ref <ref>) \\",
    "    (--operator-secret-key <hex32> | --operator-secret-key-ref <ref>) \\",
    "    --out <path.json> \\",
    "    [--l1-rpc-url <url>] \\",
    "    [--validate-topup-path] \\",
    "    [--accepted-asset <aztec_address>] \\",
    "    [--preflight-only]",
    "",
    "Notes:",
    "  - --l1-rpc-url is optional for deployment-only preflight.",
    "  - --validate-topup-path requires --l1-rpc-url and enforces L1 chain-id matching.",
    "  - In preflight mode, the script may register missing wallet aliases but sends no contract deploy txs.",
    "  - Full Token/FPC/CreditFPC deployment will be implemented in step 4.",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new CliError(`Invalid ${fieldName}: expected non-empty string`);
  }
  return value;
}

function parseHttpUrl(value: string, fieldName: string): string {
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

function parseAztecAddress(value: string, fieldName: string): string {
  if (!AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(
      `Invalid ${fieldName}: expected 32-byte 0x-prefixed Aztec address`,
    );
  }
  if (ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: zero address is not allowed`);
  }
  return value;
}

function parseHex32(value: string, fieldName: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new CliError(
      `Invalid ${fieldName}: expected 32-byte 0x-prefixed hex value`,
    );
  }
  return value;
}

function parseSecretPair(
  rawValue: string | null,
  rawRef: string | null,
  valueFlag: string,
  refFlag: string,
): { value: string | null; ref: string | null } {
  if (rawValue && rawRef) {
    throw new CliError(
      `Ambiguous key input: provide only one of ${valueFlag} or ${refFlag}`,
    );
  }
  if (!rawValue && !rawRef) {
    throw new CliError(`Missing required ${valueFlag} or ${refFlag}`);
  }
  return {
    value: rawValue,
    ref: rawRef,
  };
}

function parseCliArgs(argv: string[]): CliParseResult {
  let nodeUrl: string | null = process.env.FPC_DEVNET_NODE_URL ?? null;
  let l1RpcUrl: string | null = process.env.FPC_DEVNET_L1_RPC_URL ?? null;
  let validateTopupPath = process.env.FPC_DEVNET_VALIDATE_TOPUP_PATH === "1";
  let sponsoredFpcAddress: string | null =
    process.env.FPC_DEVNET_SPONSORED_FPC_ADDRESS ?? null;
  let deployerAlias: string | null =
    process.env.FPC_DEVNET_DEPLOYER_ALIAS ?? null;
  let deployerPrivateKey: string | null =
    process.env.FPC_DEVNET_DEPLOYER_PRIVATE_KEY ?? null;
  let deployerPrivateKeyRef: string | null =
    process.env.FPC_DEVNET_DEPLOYER_PRIVATE_KEY_REF ?? null;
  let operatorSecretKey: string | null =
    process.env.FPC_DEVNET_OPERATOR_SECRET_KEY ?? null;
  let operatorSecretKeyRef: string | null =
    process.env.FPC_DEVNET_OPERATOR_SECRET_KEY_REF ?? null;
  let acceptedAsset: string | null =
    process.env.FPC_DEVNET_ACCEPTED_ASSET ?? null;
  let out: string | null = process.env.FPC_DEVNET_OUT ?? null;
  let preflightOnly = false;

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
      case "--validate-topup-path":
        validateTopupPath = true;
        break;
      case "--sponsored-fpc-address":
        sponsoredFpcAddress = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-alias":
        deployerAlias = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-private-key":
        deployerPrivateKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-private-key-ref":
        deployerPrivateKeyRef = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-secret-key":
        operatorSecretKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-secret-key-ref":
        operatorSecretKeyRef = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--accepted-asset":
        acceptedAsset = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--out":
        out = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--preflight-only":
        preflightOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!nodeUrl) {
    throw new CliError("Missing required --node-url");
  }
  if (!sponsoredFpcAddress) {
    throw new CliError("Missing required --sponsored-fpc-address");
  }
  if (!deployerAlias) {
    throw new CliError("Missing required --deployer-alias");
  }
  if (!out) {
    throw new CliError("Missing required --out");
  }
  if (validateTopupPath && !l1RpcUrl) {
    throw new CliError(
      "Topup-path validation requested, but --l1-rpc-url is missing",
    );
  }

  const parsedDeployer = parseSecretPair(
    deployerPrivateKey,
    deployerPrivateKeyRef,
    "--deployer-private-key",
    "--deployer-private-key-ref",
  );
  const parsedOperator = parseSecretPair(
    operatorSecretKey,
    operatorSecretKeyRef,
    "--operator-secret-key",
    "--operator-secret-key-ref",
  );

  return {
    kind: "args",
    args: {
      nodeUrl: parseHttpUrl(nodeUrl, "--node-url"),
      l1RpcUrl: l1RpcUrl ? parseHttpUrl(l1RpcUrl, "--l1-rpc-url") : null,
      validateTopupPath,
      sponsoredFpcAddress: parseAztecAddress(
        sponsoredFpcAddress,
        "--sponsored-fpc-address",
      ),
      deployerAlias: parseNonEmptyString(deployerAlias, "--deployer-alias"),
      deployerPrivateKey: parsedDeployer.value
        ? parseHex32(parsedDeployer.value, "--deployer-private-key")
        : null,
      deployerPrivateKeyRef: parsedDeployer.ref
        ? parseNonEmptyString(parsedDeployer.ref, "--deployer-private-key-ref")
        : null,
      operatorSecretKey: parsedOperator.value
        ? parseHex32(parsedOperator.value, "--operator-secret-key")
        : null,
      operatorSecretKeyRef: parsedOperator.ref
        ? parseNonEmptyString(parsedOperator.ref, "--operator-secret-key-ref")
        : null,
      acceptedAsset: acceptedAsset
        ? parseAztecAddress(acceptedAsset, "--accepted-asset")
        : null,
      out,
      preflightOnly,
    },
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parsePositiveInteger(
  value: unknown,
  fieldName: string,
  expectedKind: "number_or_decimal" | "hex",
): number {
  let parsed: bigint;

  if (expectedKind === "hex") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new CliError(
        `${fieldName} returned invalid value ${String(value)}; expected 0x-prefixed hex`,
      );
    }
    parsed = BigInt(value);
  } else if (typeof value === "number" && Number.isInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && DECIMAL_UINT_PATTERN.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new CliError(
      `${fieldName} returned invalid value ${String(value)}; expected positive integer`,
    );
  }

  if (parsed <= 0n) {
    throw new CliError(`${fieldName} returned invalid value ${String(value)}`);
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CliError(
      `${fieldName} returned too-large value ${parsed.toString()} (exceeds Number.MAX_SAFE_INTEGER)`,
    );
  }
  return Number(parsed);
}

function parseNodeVersion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(
      `Aztec node preflight failed: invalid nodeVersion=${String(value)}`,
    );
  }
  return value;
}

function parseNonZeroL1Address(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !L1_ADDRESS_PATTERN.test(value)) {
    throw new CliError(
      `Aztec node preflight failed: invalid ${fieldName}=${String(value)}`,
    );
  }
  if (ZERO_L1_ADDRESS_PATTERN.test(value)) {
    throw new CliError(
      `Aztec node preflight failed: ${fieldName} is zero-address`,
    );
  }
  return value;
}

function parseNonZeroAztecAddress(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(
      `Aztec node preflight failed: invalid ${fieldName}=${String(value)}`,
    );
  }
  if (ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(
      `Aztec node preflight failed: ${fieldName} is zero-address`,
    );
  }
  return value;
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

function parseWalletAliasMap(output: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const sanitized = stripAnsi(output).replace(/\r\n/g, "\n");
  const regex = /^\s*([A-Za-z0-9:_-]+)\s*->\s*(0x[0-9a-fA-F]{64})\s*$/gim;
  let match = regex.exec(sanitized);
  while (match) {
    aliases.set(match[1], match[2]);
    match = regex.exec(sanitized);
  }
  return aliases;
}

function parseAliasLookupAddress(output: string, alias: string): string | null {
  const sanitized = stripAnsi(output).replace(/\r\n/g, "\n");

  const directAddressMatches = [
    ...sanitized.matchAll(/^\s*(0x[0-9a-fA-F]{64})\s*$/gim),
  ].map((match) => match[1]);
  if (directAddressMatches.length > 0) {
    return directAddressMatches[0];
  }

  const aliases = parseWalletAliasMap(output);
  return aliases.get(alias) ?? null;
}

function normalizeDeployerAlias(alias: string): {
  walletAlias: string;
  bareAlias: string;
} {
  const trimmed = alias.trim();
  if (trimmed.startsWith(WALLET_ACCOUNT_PREFIX)) {
    const bareAlias = trimmed.slice(WALLET_ACCOUNT_PREFIX.length).trim();
    if (bareAlias.length === 0) {
      throw new CliError(
        `Invalid --deployer-alias: "${alias}" has empty account alias suffix`,
      );
    }
    return {
      walletAlias: `${WALLET_ACCOUNT_PREFIX}${bareAlias}`,
      bareAlias,
    };
  }
  if (trimmed.includes(":")) {
    throw new CliError(
      `Invalid --deployer-alias: "${alias}" must be "<alias>" or "accounts:<alias>"`,
    );
  }
  return {
    walletAlias: `${WALLET_ACCOUNT_PREFIX}${trimmed}`,
    bareAlias: trimmed,
  };
}

function tryGetWalletAliasAddress(
  nodeUrl: string,
  alias: string,
): string | null {
  try {
    const output = runAztecWalletCommand(
      nodeUrl,
      ["get-alias", alias],
      `look up wallet alias ${alias}`,
    );
    const resolved = parseAliasLookupAddress(output, alias);
    if (!resolved) {
      throw new CliError(
        `Wallet alias lookup failed for ${alias}: command succeeded but no address was returned.`,
      );
    }
    return parseNonZeroAztecAddress(resolved, `wallet alias ${alias}`);
  } catch (error) {
    if (
      error instanceof CliError &&
      error.message.includes(`Could not find alias ${alias}`)
    ) {
      return null;
    }
    throw error;
  }
}

function ensureSponsoredFpcIsRegistered(
  nodeUrl: string,
  sponsoredFpcAddress: string,
): void {
  const contractAlias = `${WALLET_CONTRACT_PREFIX}${WALLET_SPONSORED_FPC_ALIAS}`;
  const existing = tryGetWalletAliasAddress(nodeUrl, contractAlias);

  if (existing) {
    if (existing.toLowerCase() !== sponsoredFpcAddress.toLowerCase()) {
      throw new CliError(
        `Wallet alias ${contractAlias} points to ${existing}, but --sponsored-fpc-address is ${sponsoredFpcAddress}. Reconcile wallet alias state before continuing.`,
      );
    }
    return;
  }

  runAztecWalletCommand(
    nodeUrl,
    [
      "register-contract",
      "--alias",
      WALLET_SPONSORED_FPC_ALIAS,
      sponsoredFpcAddress,
      "SponsoredFPC",
      "--salt",
      "0",
    ],
    `register sponsored FPC alias ${contractAlias}`,
  );

  const resolved = tryGetWalletAliasAddress(nodeUrl, contractAlias);
  if (!resolved) {
    throw new CliError(
      `Wallet alias registration failed: ${contractAlias} was not persisted.`,
    );
  }
  if (resolved.toLowerCase() !== sponsoredFpcAddress.toLowerCase()) {
    throw new CliError(
      `Wallet alias registration failed: ${contractAlias} resolved to ${resolved}, expected ${sponsoredFpcAddress}.`,
    );
  }
}

function isCreateAccountConflict(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("nullifier conflict") ||
    normalized.includes("already exists") ||
    normalized.includes("already registered")
  );
}

function resolveDeployerAccount(args: CliArgs): DeployerAccountResolution {
  const alias = normalizeDeployerAlias(args.deployerAlias);
  const existing = tryGetWalletAliasAddress(args.nodeUrl, alias.walletAlias);
  if (existing) {
    return {
      alias: alias.bareAlias,
      walletAlias: alias.walletAlias,
      address: existing,
      privateKey: args.deployerPrivateKey,
      privateKeyRef: args.deployerPrivateKeyRef,
      source: "existing",
    };
  }

  if (!args.deployerPrivateKey) {
    throw new CliError(
      `Deployer account alias ${alias.walletAlias} was not found, and --deployer-private-key was not provided. Use --deployer-private-key to create/import the account, or pre-create alias ${alias.walletAlias} before retrying.`,
    );
  }

  if (args.preflightOnly) {
    runAztecWalletCommand(
      args.nodeUrl,
      [
        "create-account",
        "--register-only",
        "--alias",
        alias.bareAlias,
        "--secret-key",
        args.deployerPrivateKey,
      ],
      `register deployer account alias ${alias.walletAlias} in wallet (preflight-only import path)`,
    );
    const imported = tryGetWalletAliasAddress(args.nodeUrl, alias.walletAlias);
    if (!imported) {
      throw new CliError(
        `Deployer account alias import failed: ${alias.walletAlias} remains unresolved after register-only operation.`,
      );
    }
    return {
      alias: alias.bareAlias,
      walletAlias: alias.walletAlias,
      address: imported,
      privateKey: args.deployerPrivateKey,
      privateKeyRef: args.deployerPrivateKeyRef,
      source: "imported",
    };
  }

  try {
    runAztecWalletCommand(
      args.nodeUrl,
      [
        "create-account",
        "--alias",
        alias.bareAlias,
        "--secret-key",
        args.deployerPrivateKey,
        "--payment",
        `method=fpc-sponsored,fpc=${args.sponsoredFpcAddress}`,
      ],
      `create deployer account alias ${alias.walletAlias} with sponsored payment`,
    );
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      !isCreateAccountConflict(error.message)
    ) {
      throw error;
    }

    runAztecWalletCommand(
      args.nodeUrl,
      [
        "create-account",
        "--register-only",
        "--alias",
        alias.bareAlias,
        "--secret-key",
        args.deployerPrivateKey,
      ],
      `import existing deployer account alias ${alias.walletAlias} after create-account conflict`,
    );
  }

  const resolved = tryGetWalletAliasAddress(args.nodeUrl, alias.walletAlias);
  if (!resolved) {
    throw new CliError(
      `Deployer account resolution failed: ${alias.walletAlias} is unresolved after account bootstrap.`,
    );
  }

  return {
    alias: alias.bareAlias,
    walletAlias: alias.walletAlias,
    address: resolved,
    privateKey: args.deployerPrivateKey,
    privateKeyRef: args.deployerPrivateKeyRef,
    source: "created",
  };
}

function stringifyWithToString(value: unknown, context: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return value.toString();
  }
  throw new CliError(
    `${context} returned invalid value ${String(value)} (expected string-like output)`,
  );
}

function parseFieldValueString(value: unknown, context: string): string {
  const raw = stringifyWithToString(value, context).trim();
  if (!DECIMAL_UINT_PATTERN.test(raw) && !HEX_FIELD_PATTERN.test(raw)) {
    throw new CliError(
      `${context} returned invalid field value ${raw}. Expected decimal integer or 0x-prefixed hex.`,
    );
  }
  return raw;
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
    `Failed to load ${moduleId} for operator key derivation.\n${errors.join("\n")}`,
  );
}

async function loadOperatorDerivationDeps(): Promise<OperatorDerivationDeps> {
  const [schnorrAccountApi, fieldApi, schnorrApi, keysApi] = await Promise.all([
    importWithWorkspaceFallback("@aztec/accounts/schnorr"),
    importWithWorkspaceFallback("@aztec/aztec.js/fields"),
    importWithWorkspaceFallback("@aztec/foundation/crypto/schnorr"),
    importWithWorkspaceFallback("@aztec/stdlib/keys"),
  ]);

  const getSchnorrAccountContractAddress =
    schnorrAccountApi.getSchnorrAccountContractAddress;
  const Fr = fieldApi.Fr;
  const Schnorr = schnorrApi.Schnorr;
  const deriveSigningKey = keysApi.deriveSigningKey;

  if (typeof getSchnorrAccountContractAddress !== "function") {
    throw new CliError(
      "Loaded @aztec/accounts/schnorr, but getSchnorrAccountContractAddress is not available",
    );
  }
  if (
    !Fr ||
    typeof Fr !== "function" ||
    typeof (Fr as { fromHexString?: unknown }).fromHexString !== "function" ||
    !("ZERO" in (Fr as object))
  ) {
    throw new CliError(
      "Loaded @aztec/aztec.js/fields, but Fr.fromHexString/Fr.ZERO are not available",
    );
  }
  if (typeof Schnorr !== "function") {
    throw new CliError(
      "Loaded @aztec/foundation/crypto/schnorr, but Schnorr is not available",
    );
  }
  if (typeof deriveSigningKey !== "function") {
    throw new CliError(
      "Loaded @aztec/stdlib/keys, but deriveSigningKey is not available",
    );
  }

  return {
    getSchnorrAccountContractAddress:
      getSchnorrAccountContractAddress as OperatorDerivationDeps["getSchnorrAccountContractAddress"],
    Fr: Fr as OperatorDerivationDeps["Fr"],
    Schnorr: Schnorr as OperatorDerivationDeps["Schnorr"],
    deriveSigningKey:
      deriveSigningKey as OperatorDerivationDeps["deriveSigningKey"],
  };
}

async function deriveOperatorIdentity(
  operatorSecretKey: string,
): Promise<OperatorIdentity> {
  const deps = await loadOperatorDerivationDeps();

  let secretKeyFr: unknown;
  try {
    secretKeyFr = deps.Fr.fromHexString(operatorSecretKey);
  } catch (error) {
    throw new CliError(
      `Operator key derivation failed: invalid operator secret key. Underlying error: ${String(error)}`,
    );
  }

  try {
    const signingKey = deps.deriveSigningKey(secretKeyFr);
    const schnorr = new deps.Schnorr();
    const pubkey = await schnorr.computePublicKey(signingKey);
    const operatorAddressRaw = await deps.getSchnorrAccountContractAddress(
      secretKeyFr,
      deps.Fr.ZERO,
    );

    const address = parseNonZeroAztecAddress(
      stringifyWithToString(operatorAddressRaw, "operator address derivation"),
      "operator address derivation",
    );
    const pubkeyX = parseFieldValueString(pubkey.x, "operator pubkey x");
    const pubkeyY = parseFieldValueString(pubkey.y, "operator pubkey y");

    return {
      address,
      pubkeyX,
      pubkeyY,
    };
  } catch (error) {
    throw new CliError(
      `Operator key derivation failed: could not derive operator address/pubkey. Underlying error: ${String(error)}`,
    );
  }
}

async function assertAztecNodePreflight(
  nodeUrl: string,
): Promise<NodePreflightState> {
  const ready = await rpcCall<boolean>(nodeUrl, "node_isReady", []);
  if (!ready) {
    throw new CliError(
      `Aztec node preflight failed: ${nodeUrl} responded but node_isReady=false`,
    );
  }

  const nodeInfo = await rpcCall<unknown>(nodeUrl, "node_getNodeInfo", []);
  if (!nodeInfo || typeof nodeInfo !== "object") {
    throw new CliError(
      "Aztec node preflight failed: node_getNodeInfo returned non-object payload",
    );
  }

  const info = nodeInfo as {
    nodeVersion?: unknown;
    l1ChainId?: unknown;
    rollupVersion?: unknown;
    l1ContractAddresses?: {
      registryAddress?: unknown;
      rollupAddress?: unknown;
      inboxAddress?: unknown;
      outboxAddress?: unknown;
      feeJuiceAddress?: unknown;
      feeJuicePortalAddress?: unknown;
      feeAssetHandlerAddress?: unknown;
    };
    protocolContractAddresses?: {
      instanceRegistry?: unknown;
      classRegistry?: unknown;
      multiCallEntrypoint?: unknown;
      feeJuice?: unknown;
    };
  };

  const l1Contracts = info.l1ContractAddresses;
  if (!l1Contracts || typeof l1Contracts !== "object") {
    throw new CliError(
      "Aztec node preflight failed: node_getNodeInfo.l1ContractAddresses missing or invalid",
    );
  }

  const protocolContracts = info.protocolContractAddresses;
  if (!protocolContracts || typeof protocolContracts !== "object") {
    throw new CliError(
      "Aztec node preflight failed: node_getNodeInfo.protocolContractAddresses missing or invalid",
    );
  }

  const l2ChainIdRaw = await rpcCall<unknown>(nodeUrl, "node_getChainId", []);

  return {
    nodeVersion: parseNodeVersion(info.nodeVersion),
    l1ChainId: parsePositiveInteger(
      info.l1ChainId,
      "Aztec node preflight failed: node_getNodeInfo.l1ChainId",
      "number_or_decimal",
    ),
    l2ChainId: parsePositiveInteger(
      l2ChainIdRaw,
      "Aztec node preflight failed: node_getChainId",
      "number_or_decimal",
    ),
    rollupVersion: parsePositiveInteger(
      info.rollupVersion,
      "Aztec node preflight failed: node_getNodeInfo.rollupVersion",
      "number_or_decimal",
    ),
    l1ContractAddresses: {
      registryAddress: parseNonZeroL1Address(
        l1Contracts.registryAddress,
        "node_getNodeInfo.l1ContractAddresses.registryAddress",
      ),
      rollupAddress: parseNonZeroL1Address(
        l1Contracts.rollupAddress,
        "node_getNodeInfo.l1ContractAddresses.rollupAddress",
      ),
      inboxAddress: parseNonZeroL1Address(
        l1Contracts.inboxAddress,
        "node_getNodeInfo.l1ContractAddresses.inboxAddress",
      ),
      outboxAddress: parseNonZeroL1Address(
        l1Contracts.outboxAddress,
        "node_getNodeInfo.l1ContractAddresses.outboxAddress",
      ),
      feeJuiceAddress: parseNonZeroL1Address(
        l1Contracts.feeJuiceAddress,
        "node_getNodeInfo.l1ContractAddresses.feeJuiceAddress",
      ),
      feeJuicePortalAddress: parseNonZeroL1Address(
        l1Contracts.feeJuicePortalAddress,
        "node_getNodeInfo.l1ContractAddresses.feeJuicePortalAddress",
      ),
      feeAssetHandlerAddress: parseNonZeroL1Address(
        l1Contracts.feeAssetHandlerAddress,
        "node_getNodeInfo.l1ContractAddresses.feeAssetHandlerAddress",
      ),
    },
    protocolContractAddresses: {
      instanceRegistry: parseNonZeroAztecAddress(
        protocolContracts.instanceRegistry,
        "node_getNodeInfo.protocolContractAddresses.instanceRegistry",
      ),
      classRegistry: parseNonZeroAztecAddress(
        protocolContracts.classRegistry,
        "node_getNodeInfo.protocolContractAddresses.classRegistry",
      ),
      multiCallEntrypoint: parseNonZeroAztecAddress(
        protocolContracts.multiCallEntrypoint,
        "node_getNodeInfo.protocolContractAddresses.multiCallEntrypoint",
      ),
      feeJuice: parseNonZeroAztecAddress(
        protocolContracts.feeJuice,
        "node_getNodeInfo.protocolContractAddresses.feeJuice",
      ),
    },
  };
}

async function assertL1RpcReachable(l1RpcUrl: string): Promise<number> {
  try {
    const chainIdHex = await rpcCall<string>(l1RpcUrl, "eth_chainId", []);
    return parsePositiveInteger(
      chainIdHex,
      "L1 RPC preflight failed: eth_chainId",
      "hex",
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      `L1 RPC preflight failed: could not reach ${l1RpcUrl}. Underlying error: ${String(error)}`,
    );
  }
}

function assertRequiredArtifactsExist(): void {
  const missing: string[] = [];
  if (!existsSync(REQUIRED_ARTIFACTS.token)) {
    missing.push(REQUIRED_ARTIFACTS.token);
  }
  if (!existsSync(REQUIRED_ARTIFACTS.fpc)) {
    missing.push(REQUIRED_ARTIFACTS.fpc);
  }
  if (!existsSync(REQUIRED_ARTIFACTS.creditFpc)) {
    missing.push(REQUIRED_ARTIFACTS.creditFpc);
  }
  if (missing.length > 0) {
    const formatted = missing.map((entry) => `  - ${entry}`).join("\n");
    throw new CliError(
      `Artifact preflight failed: required compiled artifacts are missing.\n${formatted}\nRun 'aztec compile --workspace --force' and retry.`,
    );
  }
}

async function main(): Promise<void> {
  const parseResult = parseCliArgs(process.argv.slice(2));
  if (parseResult.kind === "help") {
    return;
  }
  const args = parseResult.args;

  console.log("[deploy-fpc-devnet] starting preflight checks");
  console.log(`[deploy-fpc-devnet] node_url=${args.nodeUrl}`);
  console.log(
    `[deploy-fpc-devnet] l1_rpc_url=${args.l1RpcUrl ?? "<not provided>"}`,
  );
  console.log(
    `[deploy-fpc-devnet] sponsored_fpc_address=${args.sponsoredFpcAddress}`,
  );
  console.log(`[deploy-fpc-devnet] deployer_alias=${args.deployerAlias}`);
  console.log(
    `[deploy-fpc-devnet] accepted_asset=${args.acceptedAsset ?? "<deploy token>"}`,
  );
  console.log(
    `[deploy-fpc-devnet] output_manifest_path=${path.resolve(args.out)}`,
  );

  assertRequiredArtifactsExist();
  console.log("[deploy-fpc-devnet] artifact preflight passed");

  const nodeState = await assertAztecNodePreflight(args.nodeUrl);
  console.log(
    `[deploy-fpc-devnet] node preflight passed. node_version=${nodeState.nodeVersion} l1_chain_id=${nodeState.l1ChainId} l2_chain_id=${nodeState.l2ChainId} rollup_version=${nodeState.rollupVersion}`,
  );

  if (args.validateTopupPath || args.l1RpcUrl) {
    if (!args.l1RpcUrl) {
      throw new CliError(
        "L1 RPC preflight requested, but --l1-rpc-url was not provided",
      );
    }
    const l1RpcChainId = await assertL1RpcReachable(args.l1RpcUrl);
    if (l1RpcChainId !== nodeState.l1ChainId) {
      throw new CliError(
        `L1 preflight failed: node_getNodeInfo.l1ChainId=${nodeState.l1ChainId} does not match eth_chainId=${l1RpcChainId} from ${args.l1RpcUrl}`,
      );
    }
    console.log(
      `[deploy-fpc-devnet] l1 rpc preflight passed. chain_id=${l1RpcChainId}`,
    );
  } else {
    console.log(
      "[deploy-fpc-devnet] l1 rpc preflight skipped (deployment-only path)",
    );
  }

  ensureSponsoredFpcIsRegistered(args.nodeUrl, args.sponsoredFpcAddress);
  console.log(
    `[deploy-fpc-devnet] sponsored payment contract is registered in wallet as ${WALLET_CONTRACT_PREFIX}${WALLET_SPONSORED_FPC_ALIAS}`,
  );

  const deployer = resolveDeployerAccount(args);
  console.log(
    `[deploy-fpc-devnet] deployer account resolved. alias=${deployer.alias} wallet_alias=${deployer.walletAlias} address=${deployer.address} source=${deployer.source} key_material=${deployer.privateKey ? "inline" : "ref"}`,
  );

  if (!args.operatorSecretKey) {
    if (args.preflightOnly) {
      console.log(
        `[deploy-fpc-devnet] operator secret key reference detected (${args.operatorSecretKeyRef}); pubkey derivation is deferred in preflight-only mode`,
      );
      console.log("[deploy-fpc-devnet] step 3 preflight checks passed");
      console.log("[deploy-fpc-devnet] preflight-only requested; exiting");
      return;
    }
    throw new CliError(
      `Operator pubkey derivation requires --operator-secret-key. The provided --operator-secret-key-ref (${args.operatorSecretKeyRef}) cannot be resolved by this script yet.`,
    );
  }

  const operatorIdentity = await deriveOperatorIdentity(args.operatorSecretKey);
  console.log(
    `[deploy-fpc-devnet] operator identity derived. address=${operatorIdentity.address} pubkey_x=${operatorIdentity.pubkeyX} pubkey_y=${operatorIdentity.pubkeyY}`,
  );
  console.log("[deploy-fpc-devnet] step 3 account resolution checks passed");

  if (args.preflightOnly) {
    console.log("[deploy-fpc-devnet] preflight-only requested; exiting");
    return;
  }

  throw new CliError(
    "Deployment flow is not implemented yet in step 3. Continue to step 4 implementation for contract deployments + manifest persistence.",
  );
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`[deploy-fpc-devnet] ERROR: ${error.message}`);
    console.error("");
    console.error(usage());
  } else {
    console.error("[deploy-fpc-devnet] Unexpected error:", error);
  }
  process.exit(1);
});
