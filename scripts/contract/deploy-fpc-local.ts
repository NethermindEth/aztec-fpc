import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_AZTEC_ADDRESS_PATTERN = /^0x0{64}$/i;

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
    throw new CliError(
      `RPC request failed for method ${method} at ${url}: ${String(error)}`,
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new CliError(
      `RPC request failed for method ${method} at ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  let payload: JsonRpcSuccess<T> | JsonRpcFailure;
  try {
    payload = (await response.json()) as JsonRpcSuccess<T> | JsonRpcFailure;
  } catch (error) {
    throw new CliError(
      `RPC response for method ${method} at ${url} is not valid JSON: ${String(error)}`,
    );
  }

  if (isJsonRpcFailure(payload)) {
    throw new CliError(
      `RPC method ${method} failed at ${url}: code=${payload.error.code} message="${payload.error.message}"`,
    );
  }

  return payload.result;
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
