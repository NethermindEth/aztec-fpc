import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DeployManifest,
  readDeployManifest,
} from "@aztec-fpc/contract-deployment/src/manifest.ts";
import { readTestTokenManifest } from "@aztec-fpc/contract-deployment/src/test-token-manifest.ts";
import pino from "pino";

const pinoLogger = pino();

type CliArgs = {
  manifestPath: string;
  testTokenManifestPath: string;
  l1RpcUrl: string;
  operatorSecretKey: string | null;
  l1OperatorPrivateKey: string | null;
  nodeReadyTimeoutMs: number;
  bridgeWaitTimeoutMs: number;
  bridgePollMs: number;
  quoteTtlSeconds: bigint;
  daGasLimit: number;
  l2GasLimit: number;
  topupSafetyMultiplier: bigint;
  fpcRateNum: bigint;
  fpcRateDen: bigint;
  fpcTopupWeiOverride: bigint | null;
};

type CliParseResult =
  | { kind: "help" }
  | {
      kind: "args";
      args: CliArgs;
    };

type AztecAddressLike = {
  toString: () => string;
  toField: () => unknown;
};

type ContractMethodLike = {
  send: (opts: unknown) => Promise<unknown>;
  simulate: (opts: unknown) => Promise<unknown>;
  getFunctionCall: () => Promise<unknown>;
};

type ContractLike = {
  address: AztecAddressLike;
  methods: Record<string, (...args: unknown[]) => ContractMethodLike>;
};

type WalletLike = {
  createSchnorrAccount: (
    secret: unknown,
    salt: unknown,
    signingKey: unknown,
  ) => Promise<{ address: AztecAddressLike }>;
  createAuthWit: (authorizer: AztecAddressLike, intent: unknown) => Promise<unknown>;
  registerContract: (instance: unknown, artifact?: unknown) => Promise<unknown>;
};

type NodeLike = {
  getNodeInfo: () => Promise<{ l1ContractAddresses: Record<string, unknown> }>;
  getCurrentMinFees: () => Promise<{
    feePerDaGas: bigint;
    feePerL2Gas: bigint;
  }>;
  getBlock: (blockTag: string) => Promise<{ timestamp: bigint } | null>;
  getContract: (address: AztecAddressLike) => Promise<unknown | undefined>;
};

type L1PublicClientLike = {
  getChainId: () => Promise<number>;
  waitForTransactionReceipt: (args: { hash: string }) => Promise<unknown>;
};

type L1WalletClientLike = {
  writeContract: (args: unknown) => Promise<string>;
};

type SchnorrLike = {
  computePublicKey: (signingKey: unknown) => Promise<{
    x: { toString: () => string };
    y: { toString: () => string };
  }>;
  constructSignature: (
    payload: Uint8Array,
    signingKey: unknown,
  ) => Promise<{ toBuffer: () => Uint8Array }>;
};

type FrLike = {
  toString: () => string;
  toBuffer: () => Buffer;
};

type FrFactory = {
  new (value: unknown): FrLike;
  ZERO: FrLike;
  random: () => FrLike;
  fromHexString: (value: string) => FrLike;
};

type AztecDeps = {
  createAztecNodeClient: (url: string) => NodeLike;
  waitForNode: (node: NodeLike) => Promise<void>;
  waitForL1ToL2MessageReady: (
    node: NodeLike,
    messageHash: unknown,
    opts: { timeoutSeconds: number },
  ) => Promise<void>;
  AztecAddress: { fromString: (value: string) => AztecAddressLike };
  Contract: {
    at: (address: AztecAddressLike, artifact: unknown, wallet: WalletLike) => ContractLike;
  };
  Fr: FrFactory;
  computeInnerAuthWitHash: (values: unknown[]) => Promise<FrLike>;
  FeeJuiceContract: { at: (wallet: WalletLike) => ContractLike };
  ProtocolContractAddress: { FeeJuice: unknown };
  getFeeJuiceBalance: (address: AztecAddressLike, node: NodeLike) => Promise<bigint>;
  Schnorr: new () => SchnorrLike;
  loadContractArtifact: (compiled: unknown) => unknown;
  loadContractArtifactForPublic: (compiled: unknown) => unknown;
  computeSecretHash: (secret: FrLike) => Promise<FrLike>;
  deriveSigningKey: (secret: FrLike) => unknown;
  ExecutionPayload: new (...args: unknown[]) => unknown;
  EmbeddedWallet: { create: (node: NodeLike) => Promise<WalletLike> };
  createPublicClient: (config: { transport: unknown }) => L1PublicClientLike;
  createExtendedL1Client: (
    rpcUrls: string[],
    account: unknown,
    chain?: unknown,
  ) => L1WalletClientLike & L1PublicClientLike;
  decodeEventLog: (config: { abi: unknown; data: string; topics: string[] }) => unknown;
  http: (url: string) => unknown;
  parseAbi: (abi: string[]) => unknown;
  extractChain: (args: { chains: unknown[]; id: number }) => unknown;
  viemChains: unknown[];
};

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

class FundingRuntimeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingRuntimeFailure";
  }
}

class OperatorKeyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorKeyMismatchError";
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, "deployments", "manifest.json");
const DEFAULT_LOCAL_L1_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FPC_ARTIFACT_PATH = path.join(REPO_ROOT, "target", "fpc-FPCMultiAsset.json");
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DEC_PATTERN = /^(0|[1-9][0-9]*)$/;
const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ETH_ADDRESS_PATTERN = /^0x0{40}$/i;

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/devnet-postdeploy-smoke.ts \\",
    "    [--manifest <path.json>] \\",
    "    [--l1-rpc-url <http(s)-url>] \\",
    "    [--operator-secret-key <hex32>] \\",
    "    [--l1-operator-private-key <hex32>] \\",
    "    [--node-ready-timeout-ms <positive_integer>] \\",
    "    [--bridge-wait-timeout-ms <positive_integer>] \\",
    "    [--bridge-poll-ms <positive_integer>] \\",
    "    [--quote-ttl-seconds <positive_integer>] \\",
    "    [--da-gas-limit <positive_integer>] \\",
    "    [--l2-gas-limit <positive_integer>] \\",
    "    [--topup-safety-multiplier <positive_integer>] \\",
    "    [--fpc-rate-num <positive_integer>] \\",
    "    [--fpc-rate-den <positive_integer>] \\",
    "    [--fpc-topup-wei <positive_integer>]",
    "",
    "Defaults:",
    `  --manifest ${DEFAULT_MANIFEST_PATH}`,
    "  --node-ready-timeout-ms 45000",
    "  --bridge-wait-timeout-ms 240000",
    "  --bridge-poll-ms 2000",
    "  --quote-ttl-seconds 3600",
    "  --da-gas-limit 200000",
    "  --l2-gas-limit 1000000",
    "  --topup-safety-multiplier 5",
    "  --fpc-rate-num 10200",
    "  --fpc-rate-den 10000000",
    "",
    "Environment fallbacks:",
    "  FPC_DEVNET_SMOKE_MANIFEST",
    "  FPC_DEVNET_L1_RPC_URL (or L1_RPC_URL)",
    "  FPC_OPERATOR_SECRET_KEY",
    "  L1_OPERATOR_PRIVATE_KEY",
    "  FPC_DEVNET_SMOKE_* for numeric options",
    "",
    "Failure classification:",
    "  - funding_runtime_failure: FeeJuice/L1 bridge/topup runtime problems",
    "  - operator_key_drift: operator key does not match manifest operator/pubkeys",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function readEnvString(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseHttpUrl(value: string, fieldName: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError(`Invalid ${fieldName}: expected http(s) URL`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Invalid ${fieldName}: expected URL`);
  }
}

function parsePositiveInteger(value: string, fieldName: string): number {
  if (!UINT_DEC_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  return parsed;
}

function parsePositiveBigInt(value: string, fieldName: string): bigint {
  const normalized = value.trim();
  if (!UINT_DEC_PATTERN.test(normalized)) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n) {
    throw new CliError(`Invalid ${fieldName}: expected value > 0`);
  }
  return parsed;
}

function parseHex32(value: string, fieldName: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed hex value`);
  }
  return value;
}

function parseCliArgs(argv: string[]): CliParseResult {
  let manifestPath = readEnvString("FPC_DEVNET_SMOKE_MANIFEST") ?? DEFAULT_MANIFEST_PATH;
  const testTokenManifestPath =
    readEnvString("FPC_TEST_TOKEN_MANIFEST") ??
    path.join(path.dirname(manifestPath), "test-token-manifest.json");
  let l1RpcUrlRaw =
    readEnvString("FPC_DEVNET_L1_RPC_URL") ??
    readEnvString("L1_RPC_URL") ??
    "http://127.0.0.1:8545";
  let operatorSecretKey = readEnvString("FPC_OPERATOR_SECRET_KEY");
  let l1OperatorPrivateKey = readEnvString("L1_OPERATOR_PRIVATE_KEY");

  let nodeReadyTimeoutMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_SMOKE_NODE_READY_TIMEOUT_MS") ?? "45000",
    "FPC_DEVNET_SMOKE_NODE_READY_TIMEOUT_MS",
  );
  let bridgeWaitTimeoutMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_SMOKE_BRIDGE_WAIT_TIMEOUT_MS") ?? "240000",
    "FPC_DEVNET_SMOKE_BRIDGE_WAIT_TIMEOUT_MS",
  );
  let bridgePollMs = parsePositiveInteger(
    readEnvString("FPC_DEVNET_SMOKE_BRIDGE_POLL_MS") ?? "2000",
    "FPC_DEVNET_SMOKE_BRIDGE_POLL_MS",
  );
  let quoteTtlSeconds = parsePositiveBigInt(
    readEnvString("FPC_DEVNET_SMOKE_QUOTE_TTL_SECONDS") ?? "3600",
    "FPC_DEVNET_SMOKE_QUOTE_TTL_SECONDS",
  );
  let daGasLimit = parsePositiveInteger(
    readEnvString("FPC_DEVNET_SMOKE_DA_GAS_LIMIT") ?? "200000",
    "FPC_DEVNET_SMOKE_DA_GAS_LIMIT",
  );
  let l2GasLimit = parsePositiveInteger(
    readEnvString("FPC_DEVNET_SMOKE_L2_GAS_LIMIT") ?? "1000000",
    "FPC_DEVNET_SMOKE_L2_GAS_LIMIT",
  );
  let topupSafetyMultiplier = parsePositiveBigInt(
    readEnvString("FPC_DEVNET_SMOKE_TOPUP_SAFETY_MULTIPLIER") ?? "5",
    "FPC_DEVNET_SMOKE_TOPUP_SAFETY_MULTIPLIER",
  );
  let fpcRateNum = parsePositiveBigInt(
    readEnvString("FPC_DEVNET_SMOKE_FPC_RATE_NUM") ?? "10200",
    "FPC_DEVNET_SMOKE_FPC_RATE_NUM",
  );
  let fpcRateDen = parsePositiveBigInt(
    readEnvString("FPC_DEVNET_SMOKE_FPC_RATE_DEN") ?? "10000000",
    "FPC_DEVNET_SMOKE_FPC_RATE_DEN",
  );
  let fpcTopupWeiOverrideRaw = readEnvString("FPC_DEVNET_SMOKE_FPC_TOPUP_WEI");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--manifest":
        manifestPath = path.resolve(nextArg(argv, i, arg));
        i += 1;
        break;
      case "--l1-rpc-url":
        l1RpcUrlRaw = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-secret-key":
        operatorSecretKey = parseHex32(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--l1-operator-private-key":
        l1OperatorPrivateKey = parseHex32(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--node-ready-timeout-ms":
        nodeReadyTimeoutMs = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--bridge-wait-timeout-ms":
        bridgeWaitTimeoutMs = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--bridge-poll-ms":
        bridgePollMs = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--quote-ttl-seconds":
        quoteTtlSeconds = parsePositiveBigInt(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--da-gas-limit":
        daGasLimit = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--l2-gas-limit":
        l2GasLimit = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--topup-safety-multiplier":
        topupSafetyMultiplier = parsePositiveBigInt(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--fpc-rate-num":
        fpcRateNum = parsePositiveBigInt(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--fpc-rate-den":
        fpcRateDen = parsePositiveBigInt(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--fpc-topup-wei":
        fpcTopupWeiOverrideRaw = nextArg(argv, i, arg);
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

  if (fpcRateDen === 0n) {
    throw new CliError("Rate denominator cannot be zero");
  }

  return {
    kind: "args",
    args: {
      manifestPath: path.resolve(manifestPath),
      testTokenManifestPath: path.resolve(testTokenManifestPath),
      l1RpcUrl: parseHttpUrl(l1RpcUrlRaw, "l1-rpc-url"),
      operatorSecretKey: operatorSecretKey
        ? parseHex32(operatorSecretKey, "operator-secret-key")
        : null,
      l1OperatorPrivateKey: l1OperatorPrivateKey
        ? parseHex32(l1OperatorPrivateKey, "l1-operator-private-key")
        : null,
      nodeReadyTimeoutMs,
      bridgeWaitTimeoutMs,
      bridgePollMs,
      quoteTtlSeconds,
      daGasLimit,
      l2GasLimit,
      topupSafetyMultiplier,
      fpcRateNum,
      fpcRateDen,
      fpcTopupWeiOverride: fpcTopupWeiOverrideRaw
        ? parsePositiveBigInt(fpcTopupWeiOverrideRaw, "fpc-topup-wei")
        : null,
    },
  };
}

function parseManifestFromDisk(manifestPath: string): DeployManifest {
  try {
    return readDeployManifest(manifestPath);
  } catch (error) {
    throw new CliError(`Failed to load manifest at ${manifestPath}: ${String(error)}`);
  }
}

async function importWithWorkspaceFallback(moduleId: string): Promise<Record<string, unknown>> {
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
      return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    } catch (error) {
      errors.push(`workspace import failed via ${packageJsonPath}: ${String(error)}`);
    }
  }

  throw new CliError(`Failed to load ${moduleId}.\n${errors.join("\n")}`);
}

async function loadDeps(): Promise<AztecDeps> {
  const [
    nodeApi,
    messagingApi,
    addressApi,
    contractsApi,
    fieldsApi,
    authorizationApi,
    protocolApi,
    utilsApi,
    schnorrApi,
    abiApi,
    hashApi,
    keysApi,
    txApi,
    embeddedApi,
    ethereumClientApi,
    viemApi,
    viemChainsApi,
  ] = await Promise.all([
    importWithWorkspaceFallback("@aztec/aztec.js/node"),
    importWithWorkspaceFallback("@aztec/aztec.js/messaging"),
    importWithWorkspaceFallback("@aztec/aztec.js/addresses"),
    importWithWorkspaceFallback("@aztec/aztec.js/contracts"),
    importWithWorkspaceFallback("@aztec/aztec.js/fields"),
    importWithWorkspaceFallback("@aztec/aztec.js/authorization"),
    importWithWorkspaceFallback("@aztec/aztec.js/protocol"),
    importWithWorkspaceFallback("@aztec/aztec.js/utils"),
    importWithWorkspaceFallback("@aztec/foundation/crypto/schnorr"),
    importWithWorkspaceFallback("@aztec/stdlib/abi"),
    importWithWorkspaceFallback("@aztec/stdlib/hash"),
    importWithWorkspaceFallback("@aztec/stdlib/keys"),
    importWithWorkspaceFallback("@aztec/stdlib/tx"),
    importWithWorkspaceFallback("@aztec/wallets/embedded"),
    importWithWorkspaceFallback("@aztec/ethereum/client"),
    importWithWorkspaceFallback("viem"),
    importWithWorkspaceFallback("viem/chains"),
  ]);

  const deps: AztecDeps = {
    createAztecNodeClient: nodeApi.createAztecNodeClient as AztecDeps["createAztecNodeClient"],
    waitForNode: nodeApi.waitForNode as AztecDeps["waitForNode"],
    waitForL1ToL2MessageReady:
      messagingApi.waitForL1ToL2MessageReady as AztecDeps["waitForL1ToL2MessageReady"],
    AztecAddress: addressApi.AztecAddress as AztecDeps["AztecAddress"],
    Contract: contractsApi.Contract as AztecDeps["Contract"],
    Fr: fieldsApi.Fr as AztecDeps["Fr"],
    computeInnerAuthWitHash:
      authorizationApi.computeInnerAuthWitHash as AztecDeps["computeInnerAuthWitHash"],
    FeeJuiceContract: protocolApi.FeeJuiceContract as AztecDeps["FeeJuiceContract"],
    ProtocolContractAddress:
      protocolApi.ProtocolContractAddress as AztecDeps["ProtocolContractAddress"],
    getFeeJuiceBalance: utilsApi.getFeeJuiceBalance as AztecDeps["getFeeJuiceBalance"],
    Schnorr: schnorrApi.Schnorr as AztecDeps["Schnorr"],
    loadContractArtifact: abiApi.loadContractArtifact as AztecDeps["loadContractArtifact"],
    loadContractArtifactForPublic:
      abiApi.loadContractArtifactForPublic as AztecDeps["loadContractArtifactForPublic"],
    computeSecretHash: hashApi.computeSecretHash as AztecDeps["computeSecretHash"],
    deriveSigningKey: keysApi.deriveSigningKey as AztecDeps["deriveSigningKey"],
    ExecutionPayload: txApi.ExecutionPayload as AztecDeps["ExecutionPayload"],
    EmbeddedWallet: embeddedApi.EmbeddedWallet as AztecDeps["EmbeddedWallet"],
    createPublicClient: viemApi.createPublicClient as AztecDeps["createPublicClient"],
    createExtendedL1Client:
      ethereumClientApi.createExtendedL1Client as AztecDeps["createExtendedL1Client"],
    decodeEventLog: viemApi.decodeEventLog as AztecDeps["decodeEventLog"],
    http: viemApi.http as AztecDeps["http"],
    parseAbi: viemApi.parseAbi as AztecDeps["parseAbi"],
    extractChain: viemApi.extractChain as AztecDeps["extractChain"],
    viemChains: Object.values(viemChainsApi),
  };

  const requiredFunctions: Array<[string, unknown]> = [
    ["createAztecNodeClient", deps.createAztecNodeClient],
    ["waitForNode", deps.waitForNode],
    ["waitForL1ToL2MessageReady", deps.waitForL1ToL2MessageReady],
    ["computeInnerAuthWitHash", deps.computeInnerAuthWitHash],
    ["getFeeJuiceBalance", deps.getFeeJuiceBalance],
    ["computeSecretHash", deps.computeSecretHash],
    ["deriveSigningKey", deps.deriveSigningKey],
    ["createPublicClient", deps.createPublicClient],
    ["createExtendedL1Client", deps.createExtendedL1Client],
    ["decodeEventLog", deps.decodeEventLog],
    ["http", deps.http],
    ["parseAbi", deps.parseAbi],
  ];
  for (const [name, value] of requiredFunctions) {
    if (typeof value !== "function") {
      throw new CliError(`Loaded dependency missing function ${name}`);
    }
  }

  return deps;
}

function loadArtifact(deps: AztecDeps, artifactPath: string): unknown {
  const raw = readFileSync(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  try {
    return deps.loadContractArtifact(parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Contract's public bytecode has not been transpiled")
    ) {
      return deps.loadContractArtifactForPublic(parsed);
    }
    throw error;
  }
}

function resolveOperatorSecretKey(args: CliArgs): string {
  if (args.operatorSecretKey) {
    return args.operatorSecretKey;
  }
  throw new CliError("Missing operator key. Provide --operator-secret-key.");
}

function resolveL1OperatorPrivateKey(args: CliArgs): string {
  return args.l1OperatorPrivateKey ?? DEFAULT_LOCAL_L1_PRIVATE_KEY;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEthAddress(value: unknown, fieldName: string): string {
  let candidate: string;
  if (typeof value === "string") {
    candidate = value;
  } else if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString: unknown }).toString === "function"
  ) {
    candidate = (value as { toString: () => string }).toString();
  } else {
    throw new FundingRuntimeFailure(`Invalid L1 address in node info for ${fieldName}`);
  }

  if (!ETH_ADDRESS_PATTERN.test(candidate) || ZERO_ETH_ADDRESS_PATTERN.test(candidate)) {
    throw new FundingRuntimeFailure(
      `Invalid L1 address in node info for ${fieldName}: ${candidate}`,
    );
  }
  return candidate;
}

async function waitForFeeJuiceBalanceAtLeast(
  deps: AztecDeps,
  node: NodeLike,
  feePayerAddress: AztecAddressLike,
  minimum: bigint,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let latest = 0n;
  while (Date.now() <= deadline) {
    const balance = await deps.getFeeJuiceBalance(feePayerAddress, node);
    latest = balance;
    if (balance >= minimum) {
      return balance;
    }
    await sleep(pollMs);
  }
  throw new FundingRuntimeFailure(
    `Timed out waiting for FeeJuice balance on ${feePayerAddress.toString()} to reach ${minimum.toString()} (latest=${latest.toString()})`,
  );
}

async function topUpFeePayer(params: {
  deps: AztecDeps;
  args: CliArgs;
  node: NodeLike;
  wallet: WalletLike;
  operatorAddress: AztecAddressLike;
  l1PublicClient: L1PublicClientLike;
  l1WalletClient: L1WalletClientLike;
  feePayerAddress: AztecAddressLike;
  amount: bigint;
  label: string;
}): Promise<bigint> {
  const {
    deps,
    args,
    node,
    wallet,
    operatorAddress,
    l1PublicClient,
    l1WalletClient,
    feePayerAddress,
    amount,
    label,
  } = params;

  const ERC20_ABI = deps.parseAbi([
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);
  const FEE_JUICE_PORTAL_ABI = deps.parseAbi([
    "function depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash) returns (bytes32, uint256)",
    "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
  ]);

  const nodeInfo = await node.getNodeInfo();
  const l1Addresses = nodeInfo.l1ContractAddresses as Record<string, unknown>;
  const feeJuiceAddressRaw = l1Addresses.feeJuiceAddress ?? l1Addresses.feeJuice;
  const feeJuicePortalAddressRaw = l1Addresses.feeJuicePortalAddress ?? l1Addresses.feeJuicePortal;
  if (!feeJuiceAddressRaw || !feeJuicePortalAddressRaw) {
    throw new FundingRuntimeFailure(
      "node_getNodeInfo missing feeJuiceAddress or feeJuicePortalAddress",
    );
  }

  const feeJuiceAddress = normalizeEthAddress(feeJuiceAddressRaw, "feeJuiceAddress");
  const feeJuicePortalAddress = normalizeEthAddress(
    feeJuicePortalAddressRaw,
    "feeJuicePortalAddress",
  );

  const initialBalance = await deps.getFeeJuiceBalance(feePayerAddress, node);
  const claimSecret = deps.Fr.random();
  const claimSecretHash = await deps.computeSecretHash(claimSecret);

  try {
    const approveTxHash = await l1WalletClient.writeContract({
      address: feeJuiceAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [feeJuicePortalAddress, amount],
    });
    await l1PublicClient.waitForTransactionReceipt({ hash: approveTxHash });
    pinoLogger.info(
      `[devnet-postdeploy-smoke] ${label} approve_tx=${approveTxHash} amount=${amount}`,
    );

    const recipientBytes32 = `0x${feePayerAddress.toString().replace("0x", "").padStart(64, "0")}`;
    const bridgeTxHash = await l1WalletClient.writeContract({
      address: feeJuicePortalAddress,
      abi: FEE_JUICE_PORTAL_ABI,
      functionName: "depositToAztecPublic",
      args: [recipientBytes32, amount, claimSecretHash.toString()],
    });
    const bridgeReceipt = await l1PublicClient.waitForTransactionReceipt({
      hash: bridgeTxHash,
    });
    pinoLogger.info(`[devnet-postdeploy-smoke] ${label} bridge_tx=${bridgeTxHash}`);

    let messageLeafIndex: bigint | undefined;
    let l1ToL2MessageHash: unknown | undefined;
    for (const log of bridgeReceipt.logs) {
      if (log.address.toLowerCase() !== feeJuicePortalAddress.toLowerCase()) {
        continue;
      }
      try {
        const decoded = deps.decodeEventLog({
          abi: FEE_JUICE_PORTAL_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== "DepositToAztecPublic") {
          continue;
        }
        messageLeafIndex = decoded.args.index as bigint;
        l1ToL2MessageHash = deps.Fr.fromHexString(decoded.args.key as string);
        break;
      } catch {
        // Ignore non-matching logs.
      }
    }
    if (messageLeafIndex === undefined || !l1ToL2MessageHash) {
      throw new FundingRuntimeFailure(
        `Could not decode DepositToAztecPublic event for ${label} bridge`,
      );
    }

    await deps.waitForL1ToL2MessageReady(node, l1ToL2MessageHash, {
      timeoutSeconds: Math.max(1, Math.floor(args.bridgeWaitTimeoutMs / 1000)),
    });

    const feeJuice = deps.FeeJuiceContract.at(wallet);
    await feeJuice.methods
      .claim(feePayerAddress, amount, claimSecret, new deps.Fr(messageLeafIndex))
      .send({ from: operatorAddress, wait: { timeout: 180 } });

    return waitForFeeJuiceBalanceAtLeast(
      deps,
      node,
      feePayerAddress,
      initialBalance + amount,
      args.bridgeWaitTimeoutMs,
      args.bridgePollMs,
    );
  } catch (error) {
    if (error instanceof FundingRuntimeFailure) {
      throw error;
    }
    throw new FundingRuntimeFailure(`${label} topup/bridge flow failed: ${String(error)}`);
  }
}

async function runSmoke(args: CliArgs): Promise<void> {
  const deps = await loadDeps();
  const manifest = parseManifestFromDisk(args.manifestPath);
  const testTokenManifest = readTestTokenManifest(args.testTokenManifestPath);

  if (!existsSync(FPC_ARTIFACT_PATH)) {
    throw new CliError(`FPC artifact not found: ${FPC_ARTIFACT_PATH}`);
  }

  const operatorSecretKeyHex = resolveOperatorSecretKey(args);
  const l1OperatorPrivateKeyHex = resolveL1OperatorPrivateKey(args);
  const operatorSecret = deps.Fr.fromHexString(operatorSecretKeyHex);
  const operatorSigningKey = deps.deriveSigningKey(operatorSecret);

  const schnorr = new deps.Schnorr();
  const derivedPubkey = await schnorr.computePublicKey(operatorSigningKey);
  const derivedX = BigInt(derivedPubkey.x.toString());
  const derivedY = BigInt(derivedPubkey.y.toString());
  const manifestX = manifest.operator.pubkey_x.toBigInt();
  const manifestY = manifest.operator.pubkey_y.toBigInt();
  const shouldValidateOperatorPubkey = manifestX !== 0n || manifestY !== 0n;
  if (shouldValidateOperatorPubkey && (derivedX !== manifestX || derivedY !== manifestY)) {
    throw new OperatorKeyMismatchError(
      "operator pubkey mismatch between supplied key and manifest operator pubkeys",
    );
  }

  const node = deps.createAztecNodeClient(manifest.network.node_url);
  await Promise.race([
    deps.waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new FundingRuntimeFailure(
              `Timed out waiting for Aztec node at ${manifest.network.node_url}`,
            ),
          ),
        args.nodeReadyTimeoutMs,
      ),
    ),
  ]);
  const wallet = await deps.EmbeddedWallet.create(node);
  const operatorAccount = await wallet.createSchnorrAccount(
    operatorSecret,
    deps.Fr.ZERO,
    operatorSigningKey,
  );
  const operatorAddress = deps.AztecAddress.fromString(operatorAccount.address.toString());
  if (
    operatorAddress.toString().toLowerCase() !== manifest.operator.address.toString().toLowerCase()
  ) {
    throw new OperatorKeyMismatchError(
      `operator address mismatch. manifest=${manifest.operator.address.toString()} derived=${operatorAddress.toString()}`,
    );
  }

  const l1PublicClient = deps.createPublicClient({
    transport: deps.http(args.l1RpcUrl),
  });
  const l1ChainId = await l1PublicClient.getChainId();
  if (l1ChainId !== manifest.network.l1_chain_id) {
    throw new CliError(
      `L1 chain-id mismatch: manifest=${manifest.network.l1_chain_id} rpc=${l1ChainId}`,
    );
  }

  const l1Chain = deps.extractChain({ chains: deps.viemChains, id: l1ChainId });
  const l1WalletClient = deps.createExtendedL1Client(
    [args.l1RpcUrl],
    l1OperatorPrivateKeyHex,
    l1Chain,
  );

  const tokenArtifact = loadArtifact(
    deps,
    path.join(REPO_ROOT, "target", "token_contract-Token.json"),
  );
  const selectedFpcArtifact = loadArtifact(deps, FPC_ARTIFACT_PATH);

  const tokenAddress = manifest.contracts.accepted_asset;
  const fpcAddress = manifest.contracts.fpc;

  // Contract.at() no longer auto-registers with PXE (SDK breaking change).
  // Fetch on-chain instances and register explicitly before use.
  const tokenInstance = await node.getContract(tokenAddress);
  if (!tokenInstance) {
    throw new CliError(`Token contract not found on node at ${manifest.contracts.accepted_asset}`);
  }
  await wallet.registerContract(tokenInstance, tokenArtifact);

  const fpcInstance = await node.getContract(fpcAddress);
  if (!fpcInstance) {
    throw new CliError(`FPC contract not found on node at ${manifest.contracts.fpc}`);
  }
  await wallet.registerContract(fpcInstance, selectedFpcArtifact);

  const token = deps.Contract.at(tokenAddress, tokenArtifact, wallet);
  const fpc = deps.Contract.at(fpcAddress, selectedFpcArtifact, wallet);

  // Register faucet contract for dripping tokens (bridge is the minter, not operator)
  const faucetAddress = testTokenManifest.contracts.faucet;
  const faucetArtifact = loadArtifact(deps, path.join(REPO_ROOT, "target", "faucet-Faucet.json"));
  const faucetInstance = await node.getContract(faucetAddress);
  if (!faucetInstance) {
    throw new CliError(`Faucet contract not found on node at ${faucetAddress}`);
  }
  await wallet.registerContract(faucetInstance, faucetArtifact);
  const faucet = deps.Contract.at(faucetAddress, faucetArtifact, wallet);

  const minFees = await node.getCurrentMinFees();
  const feePerDaGas = minFees.feePerDaGas as bigint;
  const feePerL2Gas = minFees.feePerL2Gas as bigint;
  const maxGasCostNoTeardown =
    BigInt(args.daGasLimit) * feePerDaGas + BigInt(args.l2GasLimit) * feePerL2Gas;

  const fpcMinTopup = maxGasCostNoTeardown * args.topupSafetyMultiplier + 1_000_000n;
  const fpcTopupAmount = args.fpcTopupWeiOverride ?? fpcMinTopup;
  if (args.fpcTopupWeiOverride && args.fpcTopupWeiOverride < fpcMinTopup) {
    throw new CliError(`fpc-topup-wei override is below minimum ${fpcMinTopup.toString()}`);
  }

  pinoLogger.info(
    `[devnet-postdeploy-smoke] manifest=${args.manifestPath} node_url=${manifest.network.node_url}`,
  );
  pinoLogger.info(
    `[devnet-postdeploy-smoke] contracts accepted_asset=${manifest.contracts.accepted_asset} fpc=${manifest.contracts.fpc} variant=${"FPCMultiAsset"}`,
  );
  pinoLogger.info(`[devnet-postdeploy-smoke] topup target fpc=${fpcTopupAmount}`);

  const fpcFeeJuiceBalance = await topUpFeePayer({
    deps,
    args,
    node,
    wallet,
    operatorAddress,
    l1PublicClient,
    l1WalletClient,
    feePayerAddress: fpc.address,
    amount: fpcTopupAmount,
    label: "FPCMultiAsset".toLowerCase(),
  });
  pinoLogger.info(`[devnet-postdeploy-smoke] fpc_fee_juice_balance=${fpcFeeJuiceBalance}`);

  const QUOTE_DOMAIN_SEPARATOR = deps.Fr.fromHexString("0x465043");
  const fpcExpectedCharge = ceilDiv(maxGasCostNoTeardown * args.fpcRateNum, args.fpcRateDen);
  const fpcFjAmount = maxGasCostNoTeardown;
  const fpcAaAmount = fpcExpectedCharge;

  // Fund operator via faucet drip (public) then shield to private.
  // The bridge is the token minter, so we use the faucet instead of mint_to_*.
  pinoLogger.info("[devnet-postdeploy-smoke] dripping tokens from faucet to operator");
  await faucet.methods
    .drip(operatorAddress)
    .send({ from: operatorAddress, wait: { timeout: 180 } });
  pinoLogger.info("[devnet-postdeploy-smoke] shielding tokens to private balance");
  await token.methods
    .transfer_public_to_private(operatorAddress, operatorAddress, fpcExpectedCharge + 1_000_000n, 0)
    .send({ from: operatorAddress, wait: { timeout: 180 } });

  const latestBlock = await node.getBlock("latest");
  if (!latestBlock) {
    throw new Error("Could not read latest block while creating FPC quote");
  }
  const fpcValidUntil = latestBlock.timestamp + args.quoteTtlSeconds;
  const fpcQuoteHash = await deps.computeInnerAuthWitHash([
    QUOTE_DOMAIN_SEPARATOR,
    fpc.address.toField(),
    token.address.toField(),
    new deps.Fr(fpcFjAmount),
    new deps.Fr(fpcAaAmount),
    new deps.Fr(fpcValidUntil),
    operatorAddress.toField(),
  ]);
  const fpcQuoteSig = await schnorr.constructSignature(fpcQuoteHash.toBuffer(), operatorSigningKey);
  const fpcQuoteSigBytes = Array.from(fpcQuoteSig.toBuffer());
  const fpcAuthwitNonce = deps.Fr.random();
  const fpcTransferCall = token.methods.transfer_private_to_private(
    operatorAddress,
    operatorAddress,
    fpcAaAmount,
    fpcAuthwitNonce,
  );
  const fpcTransferAuthwit = await wallet.createAuthWit(operatorAddress, {
    caller: fpc.address,
    action: fpcTransferCall,
  });
  const fpcFeeEntrypointCall = await fpc.methods
    .fee_entrypoint(
      token.address,
      fpcAuthwitNonce,
      fpcFjAmount,
      fpcAaAmount,
      fpcValidUntil,
      fpcQuoteSigBytes,
    )
    .getFunctionCall();
  const fpcPaymentMethod = {
    getAsset: async () => deps.ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new deps.ExecutionPayload([fpcFeeEntrypointCall], [fpcTransferAuthwit], [], [], fpc.address),
    getFeePayer: async () => fpc.address,
    getGasSettings: () => undefined,
  };
  const fpcReceipt = await token.methods
    .transfer_public_to_public(operatorAddress, operatorAddress, 1n, deps.Fr.random())
    .send({
      from: operatorAddress,
      fee: {
        paymentMethod: fpcPaymentMethod,
        gasSettings: {
          gasLimits: { daGas: args.daGasLimit, l2Gas: args.l2GasLimit },
          teardownGasLimits: { daGas: 0, l2Gas: 0 },
          maxFeesPerGas: { feePerDaGas, feePerL2Gas },
        },
      },
      wait: { timeout: 180 },
    });
  pinoLogger.info(
    `[devnet-postdeploy-smoke] fpc_fee_path_tx_fee_juice=${fpcReceipt.transactionFee} expected_charge=${fpcExpectedCharge}`,
  );
  pinoLogger.info(`[devnet-postdeploy-smoke] PASS variant=${"FPCMultiAsset"} successful_txs=1`);
}

async function main(argv: string[]): Promise<void> {
  const parseResult = parseCliArgs(argv);
  if (parseResult.kind === "help") {
    return;
  }
  await runSmoke(parseResult.args);
}

void (async () => {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      pinoLogger.error(`[devnet-postdeploy-smoke] ERROR: ${error.message}`);
      pinoLogger.error("");
      pinoLogger.error(usage());
      process.exit(1);
    }
    if (error instanceof OperatorKeyMismatchError) {
      pinoLogger.error(
        `[devnet-postdeploy-smoke] FAIL classification=operator_key_drift message=${error.message}`,
      );
      process.exit(1);
    }
    if (error instanceof FundingRuntimeFailure) {
      pinoLogger.error(
        `[devnet-postdeploy-smoke] FAIL classification=funding_runtime_failure message=${error.message}`,
      );
      process.exit(1);
    }
    pinoLogger.error(
      `[devnet-postdeploy-smoke] FAIL classification=unknown message=${String(error)}`,
    );
    process.exit(1);
  }
})();
