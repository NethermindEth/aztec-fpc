import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract, type DeployOptions } from "@aztec/aztec.js/contracts";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import {
  TestERC20Abi,
  TestERC20Bytecode,
  TokenPortalAbi,
  TokenPortalBytecode,
} from "@aztec/l1-artifacts";
import { loadContractArtifact, loadContractArtifactForPublic } from "@aztec/stdlib/abi";
import { deriveKeys, deriveSigningKey } from "@aztec/stdlib/keys";
import type { NoirCompiledContract } from "@aztec/stdlib/noir";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { type Chain, extractChain, type Hex } from "viem";
import * as viemChains from "viem/chains";
import { deployContract } from "./deploy-utils.js";
import { writeDevnetDeployManifest } from "./devnet-manifest.js";

const pinoLogger = pino();

type FpcArtifactName = "FPC" | "FPCMultiAsset";

type CliArgs = {
  nodeUrl: string;
  l1RpcUrl: string | null;
  validateTopupPath: boolean;
  sponsoredFpcAddress: string | null;
  deployerSecretKey: string | null;
  deployerSecretKeyRef: string | null;
  operatorSecretKey: string | null;
  operatorSecretKeyRef: string | null;
  operator: string | null;
  acceptedAsset: string | null;
  l1DeployerKey: string | null;
  fpcArtifact: string;
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

type OperatorIdentity = {
  address: string;
  pubkeyX: string;
  pubkeyY: string;
};

type FpcArtifactSelection = {
  artifactPath: string;
  name: FpcArtifactName;
};

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_AZTEC_ADDRESS_PATTERN = /^0x0{64}$/i;
const L1_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_L1_ADDRESS_PATTERN = /^0x0{40}$/i;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const HEX_FIELD_PATTERN = /^0x[0-9a-fA-F]+$/;

const DEVNET_DEFAULT_NODE_URL = "https://v4-devnet-2.aztec-labs.com/";
const DEVNET_DEFAULT_DATA_DIR = "./deployments";
const DEVNET_DEFAULT_TEST_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
// Keep the legacy FPC artifact only as a non-default compatibility fallback.
const FPC_ARTIFACT_PATH_CANDIDATES = [
  path.join(REPO_ROOT, "target", "fpc-FPCMultiAsset.json"),
  path.join(REPO_ROOT, "target", "fpc-FPC.json"),
] as const;
const REQUIRED_ARTIFACTS = {
  token: path.join(REPO_ROOT, "target", "token_contract-Token.json"),
  tokenBridge: path.join(REPO_ROOT, "target", "token_bridge_contract-TokenBridge.json"),
  faucet: path.join(REPO_ROOT, "target", "faucet-Faucet.json"),
  counter: path.join(REPO_ROOT, "target", "mock_counter-Counter.json"),
} as const;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
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

function usage(): string {
  return [
    "Usage:",
    "  bun run contract-deployment/dist/index.js [options]",
    "",
    "All arguments are optional. CLI args take precedence over env vars.",
    "",
    "Credentials (prefer env vars to avoid leaking secrets in shell history):",
    "  --deployer-secret-key <hex32>   Deployer secret key (default: devnet test key) [env: FPC_DEPLOYER_SECRET_KEY]",
    "  --deployer-secret-key-ref <ref> Deployer key reference [env: FPC_DEPLOYER_SECRET_KEY_REF]",
    "  --operator-secret-key <hex32>    Operator secret key (default: deployer key) [env: FPC_OPERATOR_SECRET_KEY]",
    "  --operator-secret-key-ref <ref>  Operator key reference [env: FPC_OPERATOR_SECRET_KEY_REF]",
    "  --l1-deployer-key <hex32>        L1 deployer private key for bridge contracts [env: FPC_L1_DEPLOYER_KEY]",
    "",
    "Network:",
    `  --node-url <url>                 Aztec node URL (default: ${DEVNET_DEFAULT_NODE_URL}) [env: AZTEC_NODE_URL]`,
    "  --l1-rpc-url <url>               L1 RPC URL [env: L1_RPC_URL]",
    "",
    "Options:",
    "  --operator <aztec_address>       Operator address (default: derived from key) [env: FPC_OPERATOR]",
    "  --fpc-artifact <path>            Path to FPC artifact JSON (default: auto-detected) [env: FPC_ARTIFACT]",
    "  --sponsored-fpc-address <addr>   Use sponsored FPC payment mode [env: FPC_SPONSORED_FPC_ADDRESS]",
    "  --accepted-asset <addr>          Reuse existing token [env: FPC_ACCEPTED_ASSET]",
    "  --validate-topup-path            Enforce L1 chain-id matching [env: FPC_VALIDATE_TOPUP_PATH=1]",
    "  --preflight-only                 Run checks only, do not deploy [env: FPC_PREFLIGHT_ONLY=1]",
    "",
    "Outputs:",
    `  --data-dir <dir>                 Data directory for artifacts (default: ${DEVNET_DEFAULT_DATA_DIR}) [env: FPC_DATA_DIR]`,
    "  --out <path.json>                Output manifest path (default: $FPC_DATA_DIR/manifest.json) [env: FPC_OUT]",
    "",
    "  --help, -h                       Show this help",
    "",
    "Notes:",
    "  - --sponsored-fpc-address determines payment mode: if provided, contracts are deployed with",
    "    sponsored FPC payment; if absent, deployer account uses --register-only and",
    "    contracts are deployed with fee juice payment.",
    "  - --operator is optional; if omitted, the operator address is derived from --operator-secret-key.",
    "    If both are provided, they must match.",
    "  - --validate-topup-path requires --l1-rpc-url and enforces L1 chain-id matching.",
  ].join("\n");
}

function resolveDefaultFpcArtifactPath(): string {
  for (const candidatePath of FPC_ARTIFACT_PATH_CANDIDATES) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return FPC_ARTIFACT_PATH_CANDIDATES[0];
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
      throw new CliError(`Invalid ${fieldName}: expected http(s) URL, got "${value}"`);
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
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed Aztec address`);
  }
  if (ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: zero address is not allowed`);
  }
  return value;
}

function parseHex32(value: string, fieldName: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed hex value`);
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
    throw new CliError(`Ambiguous key input: provide only one of ${valueFlag} or ${refFlag}`);
  }
  return {
    value: rawValue,
    ref: rawRef,
  };
}

function parseCliArgs(argv: string[]): CliParseResult {
  let nodeUrl: string = process.env.AZTEC_NODE_URL ?? DEVNET_DEFAULT_NODE_URL;
  let l1RpcUrl: string | null = process.env.L1_RPC_URL ?? null;
  let validateTopupPath = process.env.FPC_VALIDATE_TOPUP_PATH === "1";
  let sponsoredFpcAddress: string | null = process.env.FPC_SPONSORED_FPC_ADDRESS ?? null;
  let deployerSecretKey: string | null = process.env.FPC_DEPLOYER_SECRET_KEY ?? null;
  let deployerSecretKeyRef: string | null = process.env.FPC_DEPLOYER_SECRET_KEY_REF ?? null;
  let operatorSecretKey: string | null = process.env.FPC_OPERATOR_SECRET_KEY ?? null;
  let operatorSecretKeyRef: string | null = process.env.FPC_OPERATOR_SECRET_KEY_REF ?? null;
  let operator: string | null = process.env.FPC_OPERATOR ?? null;
  let l1DeployerKey: string | null = process.env.FPC_L1_DEPLOYER_KEY ?? null;
  let acceptedAsset: string | null = process.env.FPC_ACCEPTED_ASSET ?? null;
  let fpcArtifact: string = process.env.FPC_ARTIFACT ?? resolveDefaultFpcArtifactPath();
  let dataDir: string = process.env.FPC_DATA_DIR ?? DEVNET_DEFAULT_DATA_DIR;
  let outExplicit = !!process.env.FPC_OUT;
  let out: string = process.env.FPC_OUT ?? path.join(dataDir, "manifest.json");
  let preflightOnly = process.env.FPC_PREFLIGHT_ONLY === "1";

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
      case "--l1-deployer-key":
        l1DeployerKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--validate-topup-path":
        validateTopupPath = true;
        break;
      case "--sponsored-fpc-address":
        sponsoredFpcAddress = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-secret-key":
        deployerSecretKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--deployer-secret-key-ref":
        deployerSecretKeyRef = nextArg(argv, i, arg);
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
      case "--operator":
        operator = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--accepted-asset":
        acceptedAsset = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--fpc-artifact":
        fpcArtifact = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--data-dir":
        dataDir = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--out":
        out = nextArg(argv, i, arg);
        outExplicit = true;
        i += 1;
        break;
      case "--preflight-only":
        preflightOnly = true;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!outExplicit) {
    out = path.join(dataDir, "manifest.json");
  }

  if (validateTopupPath && !l1RpcUrl) {
    throw new CliError("Topup-path validation requested, but --l1-rpc-url is missing");
  }

  const parsedDeployer = parseSecretPair(
    deployerSecretKey,
    deployerSecretKeyRef,
    "--deployer-secret-key",
    "--deployer-secret-key-ref",
  );
  const parsedOperatorSecret = parseSecretPair(
    operatorSecretKey,
    operatorSecretKeyRef,
    "--operator-secret-key",
    "--operator-secret-key-ref",
  );

  if (!parsedDeployer.value && !parsedDeployer.ref) {
    pinoLogger.warn("WARN: No deployer key provided. Using default devnet test key.");
    parsedDeployer.value = DEVNET_DEFAULT_TEST_KEY;
  }
  if (!parsedOperatorSecret.value && !parsedOperatorSecret.ref) {
    parsedOperatorSecret.value = parsedDeployer.value ?? DEVNET_DEFAULT_TEST_KEY;
    pinoLogger.warn(
      "WARN: No operator key provided. Using deployer key as operator key for devnet.",
    );
  }

  const parsedNodeUrl = parseHttpUrl(nodeUrl, "--node-url");
  const parsedL1Rpc = l1RpcUrl ? parseHttpUrl(l1RpcUrl, "--l1-rpc-url") : null;
  const parsedOperator = operator !== null ? parseAztecAddress(operator, "--operator") : null;

  return {
    kind: "args",
    args: {
      nodeUrl: parsedNodeUrl,
      l1RpcUrl: parsedL1Rpc,
      validateTopupPath,
      sponsoredFpcAddress: sponsoredFpcAddress
        ? parseAztecAddress(sponsoredFpcAddress, "--sponsored-fpc-address")
        : null,
      deployerSecretKey: parsedDeployer.value
        ? parseHex32(parsedDeployer.value, "--deployer-secret-key")
        : null,
      deployerSecretKeyRef: parsedDeployer.ref
        ? parseNonEmptyString(parsedDeployer.ref, "--deployer-secret-key-ref")
        : null,
      operatorSecretKey: parsedOperatorSecret.value
        ? parseHex32(parsedOperatorSecret.value, "--operator-secret-key")
        : null,
      operatorSecretKeyRef: parsedOperatorSecret.ref
        ? parseNonEmptyString(parsedOperatorSecret.ref, "--operator-secret-key-ref")
        : null,
      operator: parsedOperator,
      acceptedAsset: acceptedAsset ? parseAztecAddress(acceptedAsset, "--accepted-asset") : null,
      l1DeployerKey: l1DeployerKey ? parseHex32(l1DeployerKey, "--l1-deployer-key") : null,
      fpcArtifact: parseNonEmptyString(fpcArtifact, "--fpc-artifact"),
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
    throw new CliError(`Invalid ${name}=${raw}. Expected a positive integer value.`);
  }
  return parsed;
}

function parseEnvPositiveBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!DECIMAL_UINT_PATTERN.test(trimmed) && !HEX_FIELD_PATTERN.test(trimmed)) {
    throw new CliError(`Invalid ${name}=${raw}. Expected a positive integer value.`);
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
    throw new CliError(`Invalid ${name}=${raw}. Must be positive.`);
  }
  return parsed;
}

function readFaucetEnvConfig(): {
  dripAmount: bigint;
  cooldownSeconds: number;
  initialSupply: bigint;
} {
  const dripAmount = parseEnvPositiveBigInt(
    "FPC_FAUCET_DRIP_AMOUNT",
    1_000_000_000_000_000_000n, // 1 token (18 decimals)
  );

  const cooldownRaw = process.env.FPC_FAUCET_COOLDOWN_SECONDS;
  const cooldownSeconds = cooldownRaw
    ? ((): number => {
        const parsed = Number(cooldownRaw.trim());
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new CliError(
            `FPC_FAUCET_COOLDOWN_SECONDS must be a non-negative integer, got ${cooldownRaw}`,
          );
        }
        return parsed;
      })()
    : 0;

  const initialSupply = process.env.FPC_FAUCET_INITIAL_SUPPLY
    ? parseEnvPositiveBigInt("FPC_FAUCET_INITIAL_SUPPLY", 0n)
    : dripAmount * 100n; // fund for 100 drips by default

  return { dripAmount, cooldownSeconds, initialSupply };
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

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
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
    new CliError(`RPC request failed for method ${method} at ${url}: exhausted retries`)
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
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  // Some local-network builds report empty nodeVersion while otherwise healthy.
  // Treat version as best-effort metadata instead of blocking deployment preflight.
  return "unknown";
}

function parseNonZeroL1Address(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !L1_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Aztec node preflight failed: invalid ${fieldName}=${String(value)}`);
  }
  if (ZERO_L1_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Aztec node preflight failed: ${fieldName} is zero-address`);
  }
  return value;
}

function parseNonZeroAztecAddress(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Aztec node preflight failed: invalid ${fieldName}=${String(value)}`);
  }
  if (ZERO_AZTEC_ADDRESS_PATTERN.test(value)) {
    throw new CliError(`Aztec node preflight failed: ${fieldName} is zero-address`);
  }
  return value;
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

async function deriveOperatorIdentity(operatorSecretKey: string): Promise<OperatorIdentity> {
  const secretKeyFr = Fr.fromHexString(operatorSecretKey);
  const signingKey = deriveSigningKey(secretKeyFr);
  const schnorr = new Schnorr();
  const pubkey = await schnorr.computePublicKey(signingKey);
  const operatorAddressRaw = await getSchnorrAccountContractAddress(secretKeyFr, Fr.ZERO);

  const address = parseNonZeroAztecAddress(
    stringifyWithToString(operatorAddressRaw, "operator address derivation"),
    "operator address derivation",
  );
  const pubkeyX = parseFieldValueString(pubkey.x, "operator pubkey x");
  const pubkeyY = parseFieldValueString(pubkey.y, "operator pubkey y");

  return { address, pubkeyX, pubkeyY };
}

async function assertAztecNodePreflight(nodeUrl: string): Promise<NodePreflightState> {
  const ready = await rpcCall<boolean>(nodeUrl, "node_isReady", []);
  if (!ready) {
    throw new CliError(`Aztec node preflight failed: ${nodeUrl} responded but node_isReady=false`);
  }

  const nodeInfo = await rpcCall<unknown>(nodeUrl, "node_getNodeInfo", []);
  if (!nodeInfo || typeof nodeInfo !== "object") {
    throw new CliError("Aztec node preflight failed: node_getNodeInfo returned non-object payload");
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
    return parsePositiveInteger(chainIdHex, "L1 RPC preflight failed: eth_chainId", "hex");
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      `L1 RPC preflight failed: could not reach ${l1RpcUrl}. Underlying error: ${String(error)}`,
    );
  }
}

function loadFpcArtifactSelection(artifactPathInput: string): FpcArtifactSelection {
  const artifactPath = path.resolve(artifactPathInput);
  if (!existsSync(artifactPath)) {
    throw new CliError(
      `FPC artifact not found: ${artifactPath}. Run 'aztec compile --workspace --force' and retry.`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(artifactPath, "utf8");
  } catch (error) {
    throw new CliError(`Failed to read --fpc-artifact at ${artifactPath}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError(`FPC artifact at ${artifactPath} is not valid JSON: ${String(error)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("name" in parsed) ||
    typeof (parsed as { name?: unknown }).name !== "string"
  ) {
    throw new CliError(
      `Invalid --fpc-artifact at ${artifactPath}: expected JSON artifact with string "name"`,
    );
  }
  const name = (parsed as { name: string }).name;
  if (name !== "FPC" && name !== "FPCMultiAsset") {
    throw new CliError(
      `Invalid --fpc-artifact at ${artifactPath}: unsupported contract name "${name}". Expected "FPC" or "FPCMultiAsset".`,
    );
  }
  const transpiledValue = (parsed as { transpiled?: unknown }).transpiled;
  if (transpiledValue !== true) {
    const renderedValue =
      transpiledValue === undefined ? "<missing>" : JSON.stringify(transpiledValue);
    throw new CliError(
      `Invalid --fpc-artifact at ${artifactPath}: contract artifact is not transpiled (transpiled=${renderedValue}). Run 'aztec compile --workspace --force' and retry.`,
    );
  }
  return { artifactPath, name };
}

function assertRequiredArtifactsExistForDevnet(
  selection: FpcArtifactSelection,
  deployFaucet: boolean,
): void {
  const missing: string[] = [];
  if (!existsSync(REQUIRED_ARTIFACTS.token)) {
    missing.push(REQUIRED_ARTIFACTS.token);
  }
  if (!existsSync(REQUIRED_ARTIFACTS.tokenBridge)) {
    missing.push(REQUIRED_ARTIFACTS.tokenBridge);
  }
  if (!existsSync(selection.artifactPath)) {
    missing.push(selection.artifactPath);
  }
  if (deployFaucet && !existsSync(REQUIRED_ARTIFACTS.faucet)) {
    missing.push(REQUIRED_ARTIFACTS.faucet);
  }
  if (!existsSync(REQUIRED_ARTIFACTS.counter)) {
    missing.push(REQUIRED_ARTIFACTS.counter);
  }
  if (missing.length > 0) {
    const formatted = missing.map((entry) => `  - ${entry}`).join("\n");
    throw new CliError(
      `Artifact preflight failed: required compiled artifacts are missing.\n${formatted}\nRun 'aztec compile --workspace --force' and retry.`,
    );
  }
}

type TestTokenEcosystem = {
  acceptedAssetAddress: string;
  bridgeAddress: string;
  counterAddress: string;
  l1TokenPortalAddress: string;
  l1Erc20Address: string;
  faucetAddress: string;
  faucetConfig: ReturnType<typeof readFaucetEnvConfig>;
};

/**
 * Deploy a full test token ecosystem: L1 ERC20 + TokenPortal, L2 TokenBridge +
 * Token + Faucet, and fund the faucet via the L1→L2 bridge.
 *
 * This is only used for testing/devnet — production deployments should provide
 * an existing --accepted-asset instead.
 */
async function deployTestTokenEcosystem(opts: {
  l1DeployerKey: string;
  l1RpcUrl: string;
  l1ChainId: number;
  l1RegistryAddress: string;
  wallet: EmbeddedWallet;
  node: ReturnType<typeof createAztecNodeClient>;
  tokenArtifact: ContractArtifact;
  operatorAddress: AztecAddress;
  operatorIdentityAddress: string;
  deployOpts: DeployOptions;
}): Promise<TestTokenEcosystem> {
  const l1WalletClient = createExtendedL1Client(
    [opts.l1RpcUrl],
    opts.l1DeployerKey as Hex,
    extractChain({ chains: Object.values(viemChains) as readonly Chain[], id: opts.l1ChainId }),
  );

  // ── Phase 0: Pre-compute all L2 addresses ──────────────────────────
  pinoLogger.info("[deploy-fpc-devnet] pre-computing L2 contract addresses");

  const bridgeArtifact = loadArtifact(REQUIRED_ARTIFACTS.tokenBridge);
  const bridgeDeploy = Contract.deploy(opts.wallet, bridgeArtifact, []);
  const bridgeInstance = await bridgeDeploy.getInstance();
  const bridgeAddress = bridgeInstance.address;

  const tokenDeploy = Contract.deploy(
    opts.wallet,
    opts.tokenArtifact,
    ["FpcAcceptedAsset", "FPCA", 18, bridgeAddress, opts.operatorAddress],
    "constructor_with_minter",
  );
  const tokenInstance = await tokenDeploy.getInstance();
  const tokenAddress = tokenInstance.address;

  const faucetConfig = readFaucetEnvConfig();
  const faucetArtifact = loadArtifact(REQUIRED_ARTIFACTS.faucet);
  const faucetDeploy = Contract.deploy(opts.wallet, faucetArtifact, [
    tokenAddress,
    opts.operatorAddress,
    faucetConfig.dripAmount,
    faucetConfig.cooldownSeconds,
  ]);
  const faucetInstance = await faucetDeploy.getInstance();
  const faucetAddress = faucetInstance.address;

  const counterArtifact = loadArtifact(REQUIRED_ARTIFACTS.counter);
  const counterDeploy = Contract.deploy(
    opts.wallet,
    counterArtifact,
    [0, opts.operatorAddress],
    "initialize",
  );
  const counterInstance = await counterDeploy.getInstance();
  const counterAddress = counterInstance.address;

  pinoLogger.info(
    `[deploy-fpc-devnet] pre-computed: bridge=${bridgeAddress} token=${tokenAddress} faucet=${faucetAddress} counter=${counterAddress}`,
  );

  // ── Phase 1: L1 sequential (uses pre-computed addresses) ───────────

  // 1. Deploy L1 TestERC20
  const l1Erc20Hash = await l1WalletClient.deployContract({
    abi: TestERC20Abi,
    bytecode: TestERC20Bytecode as Hex,
    args: ["TestToken", "TST", l1WalletClient.account.address],
  });
  const l1Erc20Receipt = await l1WalletClient.waitForTransactionReceipt({ hash: l1Erc20Hash });
  if (!l1Erc20Receipt.contractAddress) {
    throw new CliError("L1 TestERC20 deployment failed: no contract address in receipt");
  }
  const l1Erc20Address = l1Erc20Receipt.contractAddress;
  pinoLogger.info(`[deploy-fpc-devnet] l1_erc20 deployed. address=${l1Erc20Address}`);

  // 2. Deploy L1 TokenPortal
  const l1PortalHash = await l1WalletClient.deployContract({
    abi: TokenPortalAbi,
    bytecode: TokenPortalBytecode as Hex,
    args: [],
  });
  const l1PortalReceipt = await l1WalletClient.waitForTransactionReceipt({
    hash: l1PortalHash,
  });
  if (!l1PortalReceipt.contractAddress) {
    throw new CliError("L1 TokenPortal deployment failed: no contract address in receipt");
  }
  const l1TokenPortalAddress = l1PortalReceipt.contractAddress;
  pinoLogger.info(`[deploy-fpc-devnet] l1_token_portal deployed. address=${l1TokenPortalAddress}`);

  // 3. Initialize L1 TokenPortal (uses pre-computed bridge address)
  const initHash = await l1WalletClient.writeContract({
    address: l1TokenPortalAddress as Hex,
    abi: TokenPortalAbi,
    functionName: "initialize",
    args: [opts.l1RegistryAddress as Hex, l1Erc20Address as Hex, bridgeAddress.toString() as Hex],
  });
  await l1WalletClient.waitForTransactionReceipt({ hash: initHash });
  pinoLogger.info("[deploy-fpc-devnet] l1 token portal initialized");

  // 4. Mint L1 ERC20
  const l1MintHash = await l1WalletClient.writeContract({
    address: l1Erc20Address as Hex,
    abi: TestERC20Abi,
    functionName: "mint",
    args: [l1WalletClient.account.address, faucetConfig.initialSupply],
  });
  await l1WalletClient.waitForTransactionReceipt({ hash: l1MintHash });

  // 5. Bridge tokens to L2 (uses pre-computed faucet address)
  pinoLogger.info(
    `[deploy-fpc-devnet] bridging tokens: bridgeTokensPublic(${faucetAddress}, ${faucetConfig.initialSupply})`,
  );
  const portalManager = new L1ToL2TokenPortalManager(
    EthAddress.fromString(l1TokenPortalAddress),
    EthAddress.fromString(l1Erc20Address),
    undefined,
    l1WalletClient,
    createLogger("deploy:bridge"),
  );
  const faucetBridgeClaim = await portalManager.bridgeTokensPublic(
    faucetAddress,
    faucetConfig.initialSupply,
  );

  // ── Phase 2: L2 batch 1 — bridge deploy + set_config (4 units) ────
  const bridgeContract = Contract.at(bridgeAddress, bridgeArtifact, opts.wallet);
  await deployContract(opts.wallet, bridgeArtifact, bridgeDeploy, opts.deployOpts, [
    bridgeContract.methods.set_config(tokenAddress, EthAddress.fromString(l1TokenPortalAddress)),
  ]);
  pinoLogger.info("[deploy-fpc-devnet] L2 batch 1 completed (bridge deploy + set_config)");

  // ── Phase 3: L2 batch 2 — token deploy ─────────────────────────────
  await deployContract(opts.wallet, opts.tokenArtifact, tokenDeploy, opts.deployOpts);
  pinoLogger.info("[deploy-fpc-devnet] L2 batch 2 completed (token deploy)");

  // ── Phase 4: L2 batch 3 — counter deploy ───────────────────────────
  await deployContract(opts.wallet, counterArtifact, counterDeploy, opts.deployOpts);
  pinoLogger.info("[deploy-fpc-devnet] L2 batch 3 completed (counter deploy)");

  // ── Phase 5: Wait for L1→L2 message ───────────────────────────────
  const faucetMsgHash = Fr.fromHexString(faucetBridgeClaim.messageHash);
  await waitForL1ToL2MessageReady(opts.node, faucetMsgHash, {
    timeoutSeconds: parseEnvPositiveNumber("FPC_BRIDGE_TIMEOUT_SECONDS", 120),
  });
  pinoLogger.info("[deploy-fpc-devnet] L1→L2 message ready");

  // ── Phase 6: L2 batch 4 — faucet deploy + claim_public (4 units) ──
  await deployContract(opts.wallet, faucetArtifact, faucetDeploy, opts.deployOpts, [
    bridgeContract.methods.claim_public(
      faucetAddress,
      faucetBridgeClaim.claimAmount,
      faucetBridgeClaim.claimSecret,
      faucetBridgeClaim.messageLeafIndex,
    ),
  ]);
  pinoLogger.info(
    `[deploy-fpc-devnet] L2 batch 4 completed (faucet deploy + claim_public, ${faucetConfig.initialSupply} tokens)`,
  );

  return {
    acceptedAssetAddress: tokenAddress.toString(),
    bridgeAddress: bridgeAddress.toString(),
    counterAddress: counterAddress.toString(),
    l1TokenPortalAddress,
    l1Erc20Address,
    faucetAddress: faucetAddress.toString(),
    faucetConfig,
  };
}

async function main(): Promise<void> {
  const parseResult = parseCliArgs(process.argv.slice(2));
  if (parseResult.kind === "help") {
    return;
  }
  const args = parseResult.args;
  const fpcSelection = loadFpcArtifactSelection(args.fpcArtifact);

  pinoLogger.info("[deploy-fpc-devnet] starting preflight checks");
  pinoLogger.info(`[deploy-fpc-devnet] node_url=${args.nodeUrl}`);
  pinoLogger.info(`[deploy-fpc-devnet] l1_rpc_url=${args.l1RpcUrl ?? "<not provided>"}`);
  pinoLogger.info(
    `[deploy-fpc-devnet] sponsored_fpc_address=${args.sponsoredFpcAddress ?? "<none — fee juice payment>"}`,
  );
  pinoLogger.info(`[deploy-fpc-devnet] accepted_asset=${args.acceptedAsset ?? "<deploy token>"}`);
  pinoLogger.info(
    `[deploy-fpc-devnet] fpc_artifact=${fpcSelection.artifactPath} variant=${fpcSelection.name}`,
  );
  pinoLogger.info(`[deploy-fpc-devnet] output_manifest_path=${path.resolve(args.out)}`);

  assertRequiredArtifactsExistForDevnet(fpcSelection, !args.acceptedAsset);
  pinoLogger.info("[deploy-fpc-devnet] artifact preflight passed");

  const nodeState = await assertAztecNodePreflight(args.nodeUrl);
  pinoLogger.info(
    `[deploy-fpc-devnet] node preflight passed. node_version=${nodeState.nodeVersion} l1_chain_id=${nodeState.l1ChainId} l2_chain_id=${nodeState.l2ChainId} rollup_version=${nodeState.rollupVersion}`,
  );

  if (args.validateTopupPath || args.l1RpcUrl) {
    if (!args.l1RpcUrl) {
      throw new CliError("L1 RPC preflight requested, but --l1-rpc-url was not provided");
    }
    const l1RpcChainId = await assertL1RpcReachable(args.l1RpcUrl);
    if (l1RpcChainId !== nodeState.l1ChainId) {
      throw new CliError(
        `L1 preflight failed: node_getNodeInfo.l1ChainId=${nodeState.l1ChainId} does not match eth_chainId=${l1RpcChainId} from ${args.l1RpcUrl}`,
      );
    }
    pinoLogger.info(`[deploy-fpc-devnet] l1 rpc preflight passed. chain_id=${l1RpcChainId}`);
  } else {
    pinoLogger.info("[deploy-fpc-devnet] l1 rpc preflight skipped (deployment-only path)");
  }

  if (args.sponsoredFpcAddress) {
    pinoLogger.info(
      `[deploy-fpc-devnet] using sponsored FPC payment. address=${args.sponsoredFpcAddress}`,
    );
  } else {
    pinoLogger.info(
      "[deploy-fpc-devnet] no sponsored FPC address provided; using fee juice payment mode",
    );
  }

  if (!args.deployerSecretKey) {
    throw new CliError(
      "Contract deployment requires --deployer-secret-key (inline key). The provided --deployer-secret-key-ref cannot be resolved by this script yet.",
    );
  }

  if (!args.operatorSecretKey) {
    if (args.preflightOnly) {
      pinoLogger.info(
        "[deploy-fpc-devnet] operator secret key reference detected; pubkey derivation is deferred in preflight-only mode",
      );
      pinoLogger.info("[deploy-fpc-devnet] step 3 preflight checks passed");
      pinoLogger.info("[deploy-fpc-devnet] preflight-only requested; exiting");
      return;
    }
    throw new CliError(
      "Operator pubkey derivation requires --operator-secret-key. The provided --operator-secret-key-ref cannot be resolved by this script yet.",
    );
  }

  const operatorIdentity = await deriveOperatorIdentity(args.operatorSecretKey);
  if (args.operator && args.operator.toLowerCase() !== operatorIdentity.address.toLowerCase()) {
    throw new CliError(
      `--operator ${args.operator} does not match address derived from --operator-secret-key: ${operatorIdentity.address}. Remove --operator to use the derived address, or provide the matching secret key.`,
    );
  }
  pinoLogger.info(
    `[deploy-fpc-devnet] operator identity derived. address=${operatorIdentity.address} pubkey_x=${operatorIdentity.pubkeyX} pubkey_y=${operatorIdentity.pubkeyY}`,
  );
  pinoLogger.info("[deploy-fpc-devnet] step 3 account resolution checks passed");

  if (args.preflightOnly) {
    pinoLogger.info("[deploy-fpc-devnet] preflight-only requested; exiting");
    return;
  }

  const paymentMode = args.sponsoredFpcAddress ? "fpc-sponsored" : "fee_juice";

  // --- JS API wallet setup for contract deployments ---
  const node = createAztecNodeClient(args.nodeUrl);
  const wallet = await EmbeddedWallet.create(node, {
    pxeConfig: { proverEnabled: true },
  });

  const deployerSecretFr = Fr.fromHexString(args.deployerSecretKey);
  const deployerSigningKey = deriveSigningKey(deployerSecretFr);
  const deployerAccount = await wallet.createSchnorrAccount(
    deployerSecretFr,
    Fr.ZERO,
    deployerSigningKey,
  );
  const deployerAddress = deployerAccount.address;
  const operatorAddress = AztecAddress.fromString(operatorIdentity.address);

  if (!operatorAddress.equals(deployerAddress)) {
    const operatorSecretFr = Fr.fromHexString(args.operatorSecretKey);
    const operatorSigningKey = deriveSigningKey(operatorSecretFr);
    await wallet.createSchnorrAccount(operatorSecretFr, Fr.ZERO, operatorSigningKey);
  }

  pinoLogger.info(
    `[deploy-fpc-devnet] embedded wallet ready. deployer=${deployerAddress.toString()}`,
  );

  let deployOpts: DeployOptions;
  if (args.sponsoredFpcAddress) {
    const { SponsoredFeePaymentMethod } = await import("@aztec/aztec.js/fee");
    deployOpts = {
      from: deployerAddress,
      fee: {
        paymentMethod: new SponsoredFeePaymentMethod(
          AztecAddress.fromString(args.sponsoredFpcAddress),
        ),
      },
    };
  } else {
    deployOpts = { from: deployerAddress };
  }

  const tokenArtifact = loadArtifact(REQUIRED_ARTIFACTS.token);

  let acceptedAssetAddress: string;
  let bridgeAddress: string | undefined;
  let counterAddress: string | undefined;
  let l1TokenPortalAddress: string | undefined;
  let l1Erc20Address: string | undefined;
  let faucetAddress: string | undefined;
  let faucetConfig: ReturnType<typeof readFaucetEnvConfig> | undefined;

  if (args.acceptedAsset) {
    acceptedAssetAddress = args.acceptedAsset;
    pinoLogger.info(
      `[deploy-fpc-devnet] accepted_asset provided; skipping token deployment. accepted_asset=${acceptedAssetAddress}`,
    );
  } else {
    if (!args.l1DeployerKey || !args.l1RpcUrl) {
      throw new CliError(
        "Token deployment requires --l1-deployer-key and --l1-rpc-url for L1 bridge contracts.",
      );
    }
    const ecosystem = await deployTestTokenEcosystem({
      l1DeployerKey: args.l1DeployerKey,
      l1RpcUrl: args.l1RpcUrl,
      l1ChainId: nodeState.l1ChainId,
      l1RegistryAddress: nodeState.l1ContractAddresses.registryAddress,
      wallet,
      node,
      tokenArtifact,
      operatorAddress,
      operatorIdentityAddress: operatorIdentity.address,
      deployOpts,
    });
    acceptedAssetAddress = ecosystem.acceptedAssetAddress;
    bridgeAddress = ecosystem.bridgeAddress;
    counterAddress = ecosystem.counterAddress;
    l1TokenPortalAddress = ecosystem.l1TokenPortalAddress;
    l1Erc20Address = ecosystem.l1Erc20Address;
    faucetAddress = ecosystem.faucetAddress;
    faucetConfig = ecosystem.faucetConfig;
  }

  pinoLogger.info(
    `[deploy-fpc-devnet] deploying ${fpcSelection.name} contract from ${fpcSelection.artifactPath}`,
  );
  const fpcArtifact = loadArtifact(fpcSelection.artifactPath);

  const { publicKeys: fpcPublicKeys } = await deriveKeys(Fr.ZERO);
  const fpcDeployMethod = Contract.deployWithPublicKeys(fpcPublicKeys, wallet, fpcArtifact, [
    operatorAddress,
    operatorIdentity.pubkeyX,
    operatorIdentity.pubkeyY,
  ]);
  const fpcAddress = (await fpcDeployMethod.getInstance()).address.toString();
  await deployContract(wallet, fpcArtifact, fpcDeployMethod, deployOpts);
  pinoLogger.info(`[deploy-fpc-devnet] fpc deployed. address=${fpcAddress}`);

  const manifest = writeDevnetDeployManifest(args.out, {
    status: "deploy_ok",
    generated_at: new Date().toISOString(),
    network: {
      node_url: args.nodeUrl,
      node_version: nodeState.nodeVersion,
      l1_chain_id: nodeState.l1ChainId,
      rollup_version: nodeState.rollupVersion,
    },
    aztec_required_addresses: {
      l1_contract_addresses: {
        registryAddress: nodeState.l1ContractAddresses.registryAddress,
        rollupAddress: nodeState.l1ContractAddresses.rollupAddress,
        inboxAddress: nodeState.l1ContractAddresses.inboxAddress,
        outboxAddress: nodeState.l1ContractAddresses.outboxAddress,
        feeJuiceAddress: nodeState.l1ContractAddresses.feeJuiceAddress,
        feeJuicePortalAddress: nodeState.l1ContractAddresses.feeJuicePortalAddress,
        feeAssetHandlerAddress: nodeState.l1ContractAddresses.feeAssetHandlerAddress,
      },
      protocol_contract_addresses: {
        instanceRegistry: nodeState.protocolContractAddresses.instanceRegistry,
        classRegistry: nodeState.protocolContractAddresses.classRegistry,
        multiCallEntrypoint: nodeState.protocolContractAddresses.multiCallEntrypoint,
        feeJuice: nodeState.protocolContractAddresses.feeJuice,
      },
      ...(args.sponsoredFpcAddress ? { sponsored_fpc_address: args.sponsoredFpcAddress } : {}),
    },
    deployment_accounts: {
      l2_deployer: {
        alias: "deployer",
        address: deployerAddress.toString(),
        ...(args.deployerSecretKey
          ? { private_key: args.deployerSecretKey }
          : { private_key_ref: args.deployerSecretKeyRef }),
      },
    },
    contracts: {
      accepted_asset: acceptedAssetAddress,
      fpc: fpcAddress,
      ...(faucetAddress ? { faucet: faucetAddress } : {}),
      ...(counterAddress ? { counter: counterAddress } : {}),
      ...(bridgeAddress ? { bridge: bridgeAddress } : {}),
    },
    ...(l1TokenPortalAddress && l1Erc20Address
      ? {
          l1_contracts: {
            token_portal: l1TokenPortalAddress,
            erc20: l1Erc20Address,
          },
        }
      : {}),
    fpc_artifact: {
      name: fpcSelection.name,
      path: fpcSelection.artifactPath,
    },
    operator: {
      address: operatorIdentity.address,
      pubkey_x: operatorIdentity.pubkeyX,
      pubkey_y: operatorIdentity.pubkeyY,
    },
    tx_hashes: {
      accepted_asset_deploy: null,
      fpc_deploy: null,
      counter_deploy: null,
      bridge_deploy: null,
    },

    ...(faucetConfig
      ? {
          faucet_config: {
            drip_amount: faucetConfig.dripAmount.toString(),
            cooldown_seconds: faucetConfig.cooldownSeconds,
            initial_supply: faucetConfig.initialSupply.toString(),
          },
        }
      : {}),
    payment_mode: paymentMode,
  });

  pinoLogger.info(
    `[deploy-fpc-devnet] deployment completed. wrote manifest to ${path.resolve(args.out)}`,
  );
  pinoLogger.info(
    `[deploy-fpc-devnet] output contracts: accepted_asset=${manifest.contracts.accepted_asset} fpc=${manifest.contracts.fpc} faucet=${manifest.contracts.faucet ?? "n/a"} counter=${manifest.contracts.counter ?? "n/a"} bridge=${manifest.contracts.bridge ?? "n/a"} variant=${fpcSelection.name}`,
  );

  process.exit(0);
}

main().catch((error) => {
  if (error instanceof CliError) {
    pinoLogger.error(`[deploy-fpc-devnet] ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error(
      `[deploy-fpc-devnet] Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exit(1);
});
