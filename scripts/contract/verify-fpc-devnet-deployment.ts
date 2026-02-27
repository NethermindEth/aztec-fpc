import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FpcImmutableVerificationError,
  verifyFpcImmutablesOnStartup,
} from "../../services/attestation/src/fpc-immutables.ts";
import {
  type DevnetDeployManifest,
  validateDevnetDeployManifest,
} from "./devnet-manifest.ts";

type CliArgs = {
  manifestPath: string;
  maxAttempts: number;
  pollMs: number;
  nodeReadyTimeoutMs: number;
};

type CliParseResult =
  | {
      kind: "help";
    }
  | {
      kind: "args";
      args: CliArgs;
    };

type AztecDeps = {
  createAztecNodeClient: (url: string) => {
    getContract: (address: unknown) => Promise<unknown>;
    getContractClass: (classId: unknown) => Promise<unknown>;
  };
  waitForNode: (node: unknown) => Promise<void>;
  AztecAddress: {
    fromString: (value: string) => unknown;
  };
  Fr: {
    fromString: (value: string) => unknown;
    fromHexString: (value: string) => unknown;
  };
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "deployments",
  "devnet-manifest-v2.json",
);

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/contract/verify-fpc-devnet-deployment.ts \\",
    "    --manifest <path.json> \\",
    "    [--max-attempts <positive_integer>] \\",
    "    [--poll-ms <positive_integer>] \\",
    "    [--node-ready-timeout-ms <positive_integer>]",
    "",
    "Environment fallbacks:",
    `  FPC_DEVNET_VERIFY_MANIFEST (default: ${DEFAULT_MANIFEST_PATH})`,
    "  FPC_DEVNET_VERIFY_MAX_ATTEMPTS (default: 20)",
    "  FPC_DEVNET_VERIFY_POLL_MS (default: 3000)",
    "  FPC_DEVNET_VERIFY_NODE_READY_TIMEOUT_MS (default: 45000)",
    "",
    "Checks performed:",
    "  1) Contract existence on node for accepted_asset, fpc, credit_fpc",
    "  2) FPC immutable initialization hash verification",
    "  3) Contract instance readiness (published + non-zero initialization hash)",
    "  4) Contract class readiness (class publicly registered)",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value: string, fieldName: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${fieldName}: expected positive integer`);
  }
  return parsed;
}

function readEnvPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return parsePositiveInteger(raw, name);
}

function parseCliArgs(argv: string[]): CliParseResult {
  let manifestPath = process.env.FPC_DEVNET_VERIFY_MANIFEST
    ? path.resolve(process.env.FPC_DEVNET_VERIFY_MANIFEST)
    : DEFAULT_MANIFEST_PATH;
  let maxAttempts = readEnvPositiveInteger(
    "FPC_DEVNET_VERIFY_MAX_ATTEMPTS",
    20,
  );
  let pollMs = readEnvPositiveInteger("FPC_DEVNET_VERIFY_POLL_MS", 3_000);
  let nodeReadyTimeoutMs = readEnvPositiveInteger(
    "FPC_DEVNET_VERIFY_NODE_READY_TIMEOUT_MS",
    45_000,
  );

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--manifest":
        manifestPath = path.resolve(nextArg(argv, i, arg));
        i += 1;
        break;
      case "--max-attempts":
        maxAttempts = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--poll-ms":
        pollMs = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--node-ready-timeout-ms":
        nodeReadyTimeoutMs = parsePositiveInteger(nextArg(argv, i, arg), arg);
        i += 1;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  return {
    kind: "args",
    args: {
      manifestPath,
      maxAttempts,
      pollMs,
      nodeReadyTimeoutMs,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readManifestFromDisk(manifestPath: string): DevnetDeployManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new CliError(
      `Failed to read manifest at ${manifestPath}: ${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError(
      `Manifest at ${manifestPath} is not valid JSON: ${String(error)}`,
    );
  }

  try {
    return validateDevnetDeployManifest(parsed);
  } catch (error) {
    throw new CliError(
      `Manifest validation failed for ${manifestPath}: ${String(error)}`,
    );
  }
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

  throw new CliError(`Failed to load ${moduleId}.\n${errors.join("\n")}`);
}

async function loadAztecDeps(): Promise<AztecDeps> {
  const [nodeApi, addressApi, fieldsApi] = await Promise.all([
    importWithWorkspaceFallback("@aztec/aztec.js/node"),
    importWithWorkspaceFallback("@aztec/aztec.js/addresses"),
    importWithWorkspaceFallback("@aztec/aztec.js/fields"),
  ]);

  const createAztecNodeClient = nodeApi.createAztecNodeClient;
  const waitForNode = nodeApi.waitForNode;
  const AztecAddress = addressApi.AztecAddress;
  const Fr = fieldsApi.Fr;

  if (typeof createAztecNodeClient !== "function") {
    throw new CliError(
      "Loaded @aztec/aztec.js/node, but createAztecNodeClient is unavailable",
    );
  }
  if (typeof waitForNode !== "function") {
    throw new CliError(
      "Loaded @aztec/aztec.js/node, but waitForNode is unavailable",
    );
  }
  if (
    !AztecAddress ||
    typeof AztecAddress !== "function" ||
    typeof (AztecAddress as { fromString?: unknown }).fromString !== "function"
  ) {
    throw new CliError(
      "Loaded @aztec/aztec.js/addresses, but AztecAddress.fromString is unavailable",
    );
  }
  if (
    !Fr ||
    typeof Fr !== "function" ||
    typeof (Fr as { fromString?: unknown }).fromString !== "function" ||
    typeof (Fr as { fromHexString?: unknown }).fromHexString !== "function"
  ) {
    throw new CliError(
      "Loaded @aztec/aztec.js/fields, but Fr.fromString/fromHexString are unavailable",
    );
  }

  return {
    createAztecNodeClient:
      createAztecNodeClient as AztecDeps["createAztecNodeClient"],
    waitForNode: waitForNode as AztecDeps["waitForNode"],
    AztecAddress: AztecAddress as AztecDeps["AztecAddress"],
    Fr: Fr as AztecDeps["Fr"],
  };
}

function formatCheckIssues(issues: string[]): string {
  if (issues.length === 0) {
    return "<none>";
  }
  return issues.map((issue) => `  - ${issue}`).join("\n");
}

function isRetryableVerificationError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    (message.includes("block") && message.includes("not found")) ||
    message.includes("reorg") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
}

function parseFieldToFr(
  rawField: string,
  FrApi: AztecDeps["Fr"],
  fieldName: string,
): unknown {
  try {
    if (rawField.startsWith("0x") || rawField.startsWith("0X")) {
      return FrApi.fromHexString(rawField);
    }
    return FrApi.fromString(rawField);
  } catch (error) {
    throw new CliError(
      `Invalid ${fieldName} in manifest: ${rawField}. Underlying error: ${String(error)}`,
    );
  }
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

function isZeroFieldLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/^0x0+$/i.test(trimmed)) {
    return true;
  }
  if (/^0+$/.test(trimmed)) {
    return true;
  }
  return false;
}

async function verifyAttempt(params: {
  manifest: DevnetDeployManifest;
  deps: AztecDeps;
  node: {
    getContract: (address: unknown) => Promise<unknown>;
    getContractClass: (classId: unknown) => Promise<unknown>;
  };
}): Promise<string[]> {
  const { manifest, deps, node } = params;
  const issues: string[] = [];
  const AztecAddressApi = deps.AztecAddress;

  const contracts = [
    {
      key: "accepted_asset",
      address: manifest.contracts.accepted_asset,
    },
    {
      key: "fpc",
      address: manifest.contracts.fpc,
    },
    {
      key: "credit_fpc",
      address: manifest.contracts.credit_fpc,
    },
  ] as const;

  const parsedAddresses = new Map<string, unknown>();
  for (const contract of contracts) {
    parsedAddresses.set(
      contract.key,
      AztecAddressApi.fromString(contract.address),
    );
  }

  for (const contract of contracts) {
    const address = parsedAddresses.get(contract.key);
    if (!address) {
      issues.push(`address parsing failed for ${contract.key}`);
      continue;
    }

    const deployed = await node.getContract(address);
    if (!deployed) {
      issues.push(
        `on-chain contract missing: ${contract.key} at ${contract.address}`,
      );
      continue;
    }

    const deployedRecord = asObjectRecord(deployed);
    if (!deployedRecord) {
      issues.push(
        `invalid on-chain contract payload for ${contract.key} at ${contract.address}`,
      );
      continue;
    }

    const initializationHashRaw = deployedRecord.initializationHash;
    if (!initializationHashRaw) {
      issues.push(`missing initialization hash for ${contract.key}`);
    } else {
      const initializationHash = stringifyWithToString(
        initializationHashRaw,
        `${contract.key} initialization hash`,
      );
      if (isZeroFieldLike(initializationHash)) {
        issues.push(
          `contract appears uninitialized (zero initialization hash): ${contract.key}`,
        );
      }
    }

    const classId = deployedRecord.currentContractClassId;
    if (!classId) {
      issues.push(`missing current contract class id for ${contract.key}`);
      continue;
    }
    const classPayload = await node.getContractClass(classId);
    if (!classPayload) {
      issues.push(`contract class not publicly registered: ${contract.key}`);
    }
  }

  try {
    await verifyFpcImmutablesOnStartup(node, {
      fpcAddress: parsedAddresses.get("fpc") as never,
      acceptedAsset: parsedAddresses.get("accepted_asset") as never,
      operatorAddress: AztecAddressApi.fromString(
        manifest.operator.address,
      ) as never,
      operatorPubkeyX: parseFieldToFr(
        manifest.operator.pubkey_x,
        deps.Fr,
        "operator.pubkey_x",
      ) as never,
      operatorPubkeyY: parseFieldToFr(
        manifest.operator.pubkey_y,
        deps.Fr,
        "operator.pubkey_y",
      ) as never,
    });
  } catch (error) {
    if (
      error instanceof FpcImmutableVerificationError &&
      error.reason === "IMMUTABLE_MISMATCH"
    ) {
      throw new CliError(
        `[verify-fpc-devnet] FPC immutable mismatch detected and will not recover with retries: ${error.message}`,
      );
    }
    issues.push(`fpc immutable verification pending: ${String(error)}`);
  }

  return issues;
}

async function main(): Promise<void> {
  const parseResult = parseCliArgs(process.argv.slice(2));
  if (parseResult.kind === "help") {
    return;
  }
  const args = parseResult.args;

  console.log(
    `[verify-fpc-devnet] manifest=${path.resolve(args.manifestPath)} max_attempts=${args.maxAttempts} poll_ms=${args.pollMs}`,
  );
  const manifest = readManifestFromDisk(args.manifestPath);
  console.log(
    `[verify-fpc-devnet] loaded manifest for node=${manifest.network.node_url} fpc=${manifest.contracts.fpc} credit_fpc=${manifest.contracts.credit_fpc}`,
  );

  const deps = await loadAztecDeps();
  const node = deps.createAztecNodeClient(manifest.network.node_url);

  await Promise.race([
    deps.waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new CliError(
              `Timed out waiting for node readiness at ${manifest.network.node_url}`,
            ),
          ),
        args.nodeReadyTimeoutMs,
      ),
    ),
  ]);
  console.log("[verify-fpc-devnet] node connectivity check passed");

  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    try {
      lastIssues = await verifyAttempt({
        manifest,
        deps,
        node,
      });
    } catch (error) {
      if (!isRetryableVerificationError(error) || attempt >= args.maxAttempts) {
        throw error;
      }
      const delayMs = args.pollMs;
      console.warn(
        `[verify-fpc-devnet] transient verification error on attempt ${attempt}/${args.maxAttempts}: ${String(error)}`,
      );
      console.warn(
        `[verify-fpc-devnet] retrying in ${delayMs}ms after transient error`,
      );
      await sleep(delayMs);
      continue;
    }

    if (lastIssues.length === 0) {
      console.log(
        `[verify-fpc-devnet] verification passed on attempt ${attempt}/${args.maxAttempts}`,
      );
      console.log(
        `[verify-fpc-devnet] contracts ready: accepted_asset=${manifest.contracts.accepted_asset} fpc=${manifest.contracts.fpc} credit_fpc=${manifest.contracts.credit_fpc}`,
      );
      return;
    }

    if (attempt < args.maxAttempts) {
      const delayMs = args.pollMs;
      console.warn(
        `[verify-fpc-devnet] verification pending on attempt ${attempt}/${args.maxAttempts}:\n${formatCheckIssues(lastIssues)}`,
      );
      console.warn(
        `[verify-fpc-devnet] retrying in ${delayMs}ms while metadata/state settles`,
      );
      await sleep(delayMs);
    }
  }

  throw new CliError(
    `[verify-fpc-devnet] verification failed after ${args.maxAttempts} attempts:\n${formatCheckIssues(lastIssues)}`,
  );
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`[verify-fpc-devnet] ERROR: ${error.message}`);
    console.error("");
    console.error(usage());
  } else {
    console.error("[verify-fpc-devnet] Unexpected error:", error);
  }
  process.exit(1);
});
