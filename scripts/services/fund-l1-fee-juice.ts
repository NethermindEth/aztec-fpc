import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import { type Address, createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const pinoLogger = pino();

type CliArgs = {
  l1RpcUrl: string;
  nodeUrl: string | null;
  manifestPath: string | null;
  operatorPrivateKey: string;
  funderPrivateKey: string;
  recipientAddress: string | null;
  targetBalanceWei: bigint;
  feeJuiceTokenAddress: string | null;
  feeAssetHandlerAddress: string | null;
  dryRun: boolean;
};

type CliParseResult =
  | {
      kind: "help";
    }
  | {
      kind: "args";
      args: CliArgs;
    };

type NodeInfoL1Addresses = {
  feeJuiceAddress?: string;
  feeAssetHandlerAddress?: string;
};

type ResolvedFundingTargets = {
  feeJuiceTokenAddress: Address;
  feeAssetHandlerAddress: Address | null;
  source: "cli" | "node" | "manifest" | "mixed";
};

const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const DEFAULT_TARGET_BALANCE_WEI = "1000000000000000000000";
const DEFAULT_MANIFEST_PATH = "./deployments/devnet-manifest-v2.json";
const MAX_NONCE_RETRY_ATTEMPTS = 3;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const FEE_ASSET_HANDLER_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "_recipient", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "mintAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function isNonceConflictError(error: unknown): boolean {
  const normalized = String(error).toLowerCase();
  return (
    normalized.includes("replacementnotallowed") ||
    normalized.includes("replacement not allowed") ||
    normalized.includes("nonce too low") ||
    normalized.includes("already known")
  );
}

function normalizeNonce(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

async function readPendingNonce(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  accountAddress: Address;
}): Promise<bigint> {
  try {
    const pendingNonce = await params.publicClient.getTransactionCount({
      address: params.accountAddress,
      blockTag: "pending",
    });
    return normalizeNonce(pendingNonce);
  } catch {
    const latestNonce = await params.publicClient.getTransactionCount({
      address: params.accountAddress,
    });
    return normalizeNonce(latestNonce);
  }
}

async function sendWithManagedNonce(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  accountAddress: Address;
  initialNonce?: bigint;
  send: (nonce: bigint) => Promise<`0x${string}`>;
}): Promise<{ hash: `0x${string}`; nextNonce: bigint }> {
  let nonce =
    params.initialNonce ??
    (await readPendingNonce({
      publicClient: params.publicClient,
      accountAddress: params.accountAddress,
    }));

  for (let attempt = 1; attempt <= MAX_NONCE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const hash = await params.send(nonce);
      return { hash, nextNonce: nonce + 1n };
    } catch (error) {
      if (!isNonceConflictError(error) || attempt >= MAX_NONCE_RETRY_ATTEMPTS) {
        throw error;
      }

      const refreshedNonce = await readPendingNonce({
        publicClient: params.publicClient,
        accountAddress: params.accountAddress,
      });
      pinoLogger.warn(
        `[fund-l1-fee-juice] nonce conflict detected; retrying with refreshed_nonce=${refreshedNonce} attempt=${attempt + 1}/${MAX_NONCE_RETRY_ATTEMPTS}`,
      );
      nonce = refreshedNonce;
    }
  }

  throw new CliError("Failed to send transaction after nonce retry attempts");
}

function usage(): string {
  return [
    "Usage:",
    "  bunx tsx scripts/services/fund-l1-fee-juice.ts \\",
    "    --l1-rpc-url <url> \\",
    "    --operator-private-key <hex32> \\",
    "    [--funder-private-key <hex32>] \\",
    "    [--recipient-address <evm_address>] \\",
    "    [--target-balance-wei <uint>] \\",
    "    [--node-url <aztec_node_url>] \\",
    "    [--manifest <path.json>] \\",
    "    [--fee-juice-token-address <evm_address>] \\",
    "    [--fee-asset-handler-address <evm_address>] \\",
    "    [--dry-run]",
    "",
    "Behavior:",
    "  - Ensures recipient has at least target L1 FeeJuice balance.",
    "  - Funds by trying FeeJuice.mint(recipient, deficit) first.",
    "  - If direct mint fails, falls back to FeeAssetHandler.mint(recipient) loops.",
    "  - Does NOT bridge to L2 and does NOT submit L2 claims.",
    "",
    "Address resolution priority:",
    "  - CLI/env override > node_getNodeInfo > deploy manifest",
    "",
    "Env fallbacks:",
    "  L1_RPC_URL",
    "  AZTEC_NODE_URL",
    "  FPC_DEPLOY_MANIFEST",
    "  L1_OPERATOR_PRIVATE_KEY",
    "  L1_FEE_JUICE_FUNDER_PRIVATE_KEY",
    "  L1_FEE_JUICE_RECIPIENT_ADDRESS",
    `  L1_FEE_JUICE_FUND_AMOUNT_WEI (default: ${DEFAULT_TARGET_BALANCE_WEI})`,
    "  L1_FEE_JUICE_TOKEN_ADDRESS",
    "  L1_FEE_ASSET_HANDLER_ADDRESS",
  ].join("\n");
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`Missing value for ${flag}`);
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

function parseHex32(value: string, fieldName: string): string {
  if (!HEX_32_PATTERN.test(value)) {
    throw new CliError(`Invalid ${fieldName}: expected 32-byte 0x-prefixed hex value`);
  }
  return value.toLowerCase();
}

function parseAddress(value: string, fieldName: string): Address {
  if (!isAddress(value)) {
    throw new CliError(`Invalid ${fieldName}: expected EVM address`);
  }
  return value as Address;
}

function parseBigInt(value: string, fieldName: string): bigint {
  const normalized = value.trim();
  if (!UINT_DECIMAL_PATTERN.test(normalized)) {
    throw new CliError(`Invalid ${fieldName}: expected unsigned integer`);
  }
  return BigInt(normalized);
}

function parseOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseCliArgs(argv: string[]): CliParseResult {
  let l1RpcUrl = parseOptionalEnv("L1_RPC_URL");
  let nodeUrl = parseOptionalEnv("AZTEC_NODE_URL");
  let manifestPath = parseOptionalEnv("FPC_DEPLOY_MANIFEST");
  let operatorPrivateKey = parseOptionalEnv("L1_OPERATOR_PRIVATE_KEY");
  let funderPrivateKey = parseOptionalEnv("L1_FEE_JUICE_FUNDER_PRIVATE_KEY");
  let recipientAddress = parseOptionalEnv("L1_FEE_JUICE_RECIPIENT_ADDRESS");
  let targetBalanceWei = parseOptionalEnv("L1_FEE_JUICE_FUND_AMOUNT_WEI");
  let feeJuiceTokenAddress = parseOptionalEnv("L1_FEE_JUICE_TOKEN_ADDRESS");
  let feeAssetHandlerAddress = parseOptionalEnv("L1_FEE_ASSET_HANDLER_ADDRESS");
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--l1-rpc-url":
        l1RpcUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--node-url":
        nodeUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--manifest":
        manifestPath = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--operator-private-key":
        operatorPrivateKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--funder-private-key":
        funderPrivateKey = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--recipient-address":
        recipientAddress = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--target-balance-wei":
        targetBalanceWei = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--fee-juice-token-address":
        feeJuiceTokenAddress = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--fee-asset-handler-address":
        feeAssetHandlerAddress = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        return { kind: "help" };
      default:
        throw new CliError(`Unknown argument: ${arg}`);
    }
  }

  if (!l1RpcUrl) {
    throw new CliError("Missing --l1-rpc-url (or L1_RPC_URL) for L1 funding transactions");
  }
  if (!operatorPrivateKey) {
    throw new CliError("Missing --operator-private-key (or L1_OPERATOR_PRIVATE_KEY)");
  }

  const resolvedManifestPath =
    manifestPath ?? (existsSync(DEFAULT_MANIFEST_PATH) ? DEFAULT_MANIFEST_PATH : null);

  return {
    kind: "args",
    args: {
      l1RpcUrl: parseHttpUrl(l1RpcUrl, "--l1-rpc-url"),
      nodeUrl: nodeUrl ? parseHttpUrl(nodeUrl, "--node-url") : null,
      manifestPath: resolvedManifestPath ? path.resolve(resolvedManifestPath) : null,
      operatorPrivateKey: parseHex32(operatorPrivateKey, "--operator-private-key"),
      funderPrivateKey: parseHex32(funderPrivateKey ?? operatorPrivateKey, "--funder-private-key"),
      recipientAddress: recipientAddress
        ? parseAddress(recipientAddress, "--recipient-address")
        : null,
      targetBalanceWei: parseBigInt(
        targetBalanceWei ?? DEFAULT_TARGET_BALANCE_WEI,
        "--target-balance-wei",
      ),
      feeJuiceTokenAddress: feeJuiceTokenAddress
        ? parseAddress(feeJuiceTokenAddress, "--fee-juice-token-address")
        : null,
      feeAssetHandlerAddress: feeAssetHandlerAddress
        ? parseAddress(feeAssetHandlerAddress, "--fee-asset-handler-address")
        : null,
      dryRun,
    },
  };
}

function extractAddressCandidate(root: Record<string, unknown>, keys: string[]): Address | null {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && isAddress(value)) {
      return value as Address;
    }
  }
  return null;
}

async function loadNodeInfoL1Addresses(nodeUrl: string): Promise<NodeInfoL1Addresses> {
  const response = await fetch(nodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "node_getNodeInfo",
      params: [],
    }),
  });
  if (!response.ok) {
    throw new CliError(`node_getNodeInfo failed for ${nodeUrl}: HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch (error) {
    throw new CliError(`Invalid JSON returned by node_getNodeInfo at ${nodeUrl}: ${String(error)}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("result" in parsed) ||
    !parsed.result ||
    typeof parsed.result !== "object"
  ) {
    throw new CliError(`Invalid JSON-RPC payload from node_getNodeInfo at ${nodeUrl}`);
  }

  const result = parsed.result as Record<string, unknown>;
  if (
    !("l1ContractAddresses" in result) ||
    !result.l1ContractAddresses ||
    typeof result.l1ContractAddresses !== "object"
  ) {
    throw new CliError(`node_getNodeInfo at ${nodeUrl} is missing l1ContractAddresses`);
  }

  const l1 = result.l1ContractAddresses as Record<string, unknown>;
  return {
    feeJuiceAddress: extractAddressCandidate(l1, ["feeJuiceAddress", "feeJuice"]) ?? undefined,
    feeAssetHandlerAddress:
      extractAddressCandidate(l1, ["feeAssetHandlerAddress", "feeAssetHandler"]) ?? undefined,
  };
}

function loadManifestL1Addresses(manifestPath: string): NodeInfoL1Addresses {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new CliError(`Failed to read deploy manifest at ${manifestPath}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError(`Deploy manifest at ${manifestPath} is not valid JSON: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CliError(`Deploy manifest at ${manifestPath} must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;

  const aztecRequired = root.aztec_required_addresses;
  if (!aztecRequired || typeof aztecRequired !== "object") {
    return {};
  }
  const l1 = (aztecRequired as Record<string, unknown>).l1_contract_addresses;
  if (!l1 || typeof l1 !== "object") {
    return {};
  }
  const l1Record = l1 as Record<string, unknown>;

  return {
    feeJuiceAddress:
      extractAddressCandidate(l1Record, ["feeJuiceAddress", "feeJuice"]) ?? undefined,
    feeAssetHandlerAddress:
      extractAddressCandidate(l1Record, ["feeAssetHandlerAddress", "feeAssetHandler"]) ?? undefined,
  };
}

async function resolveFundingTargets(args: CliArgs): Promise<ResolvedFundingTargets> {
  const fromCliToken = args.feeJuiceTokenAddress
    ? parseAddress(args.feeJuiceTokenAddress, "--fee-juice-token-address")
    : null;
  const fromCliHandler = args.feeAssetHandlerAddress
    ? parseAddress(args.feeAssetHandlerAddress, "--fee-asset-handler-address")
    : null;

  let fromNode: NodeInfoL1Addresses = {};
  if (args.nodeUrl) {
    fromNode = await loadNodeInfoL1Addresses(args.nodeUrl);
  }

  let fromManifest: NodeInfoL1Addresses = {};
  if (args.manifestPath && existsSync(args.manifestPath)) {
    fromManifest = loadManifestL1Addresses(args.manifestPath);
  }

  const tokenAddress =
    fromCliToken ??
    (fromNode.feeJuiceAddress
      ? parseAddress(fromNode.feeJuiceAddress, "node_getNodeInfo.feeJuiceAddress")
      : null) ??
    (fromManifest.feeJuiceAddress
      ? parseAddress(
          fromManifest.feeJuiceAddress,
          "manifest.aztec_required_addresses.l1_contract_addresses.feeJuiceAddress",
        )
      : null);

  if (!tokenAddress) {
    throw new CliError(
      "Could not resolve FeeJuice token address. Provide --fee-juice-token-address (or L1_FEE_JUICE_TOKEN_ADDRESS), or provide --node-url / AZTEC_NODE_URL, or a valid deploy manifest.",
    );
  }

  const handlerAddress =
    fromCliHandler ??
    (fromNode.feeAssetHandlerAddress
      ? parseAddress(fromNode.feeAssetHandlerAddress, "node_getNodeInfo.feeAssetHandlerAddress")
      : null) ??
    (fromManifest.feeAssetHandlerAddress
      ? parseAddress(
          fromManifest.feeAssetHandlerAddress,
          "manifest.aztec_required_addresses.l1_contract_addresses.feeAssetHandlerAddress",
        )
      : null);

  const source: ResolvedFundingTargets["source"] =
    fromCliToken || fromCliHandler
      ? fromNode.feeJuiceAddress || fromManifest.feeJuiceAddress
        ? "mixed"
        : "cli"
      : fromNode.feeJuiceAddress
        ? fromManifest.feeJuiceAddress
          ? "mixed"
          : "node"
        : "manifest";

  return {
    feeJuiceTokenAddress: tokenAddress,
    feeAssetHandlerAddress: handlerAddress,
    source,
  };
}

function readFeeJuiceBalance(params: {
  l1RpcUrl: string;
  tokenAddress: Address;
  accountAddress: Address;
}): Promise<bigint> {
  const publicClient = createPublicClient({ transport: http(params.l1RpcUrl) });
  return publicClient.readContract({
    address: params.tokenAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [params.accountAddress],
  });
}

async function tryDirectMint(params: {
  l1RpcUrl: string;
  funderPrivateKey: `0x${string}`;
  tokenAddress: Address;
  recipient: Address;
  amount: bigint;
}): Promise<boolean> {
  const funder = privateKeyToAccount(params.funderPrivateKey);
  const walletClient = createWalletClient({
    account: funder,
    transport: http(params.l1RpcUrl),
  });
  const publicClient = createPublicClient({ transport: http(params.l1RpcUrl) });

  try {
    const { hash } = await sendWithManagedNonce({
      publicClient,
      accountAddress: funder.address,
      send: (nonce) =>
        walletClient.writeContract({
          chain: null,
          address: params.tokenAddress,
          abi: ERC20_MINT_ABI,
          functionName: "mint",
          args: [params.recipient, params.amount],
          nonce,
        }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new CliError(`Direct mint transaction reverted: tx_hash=${receipt.transactionHash}`);
    }
    pinoLogger.info(
      `[fund-l1-fee-juice] direct token mint succeeded tx_hash=${receipt.transactionHash}`,
    );
    return true;
  } catch (error) {
    pinoLogger.warn(
      `[fund-l1-fee-juice] direct token mint unavailable (${String(error)}); will try fee asset handler fallback`,
    );
    return false;
  }
}

async function mintViaFeeAssetHandler(params: {
  l1RpcUrl: string;
  funderPrivateKey: `0x${string}`;
  tokenAddress: Address;
  handlerAddress: Address;
  recipient: Address;
  targetBalanceWei: bigint;
}): Promise<void> {
  const funder = privateKeyToAccount(params.funderPrivateKey);
  const walletClient = createWalletClient({
    account: funder,
    transport: http(params.l1RpcUrl),
  });
  const publicClient = createPublicClient({ transport: http(params.l1RpcUrl) });

  const mintAmount = await publicClient.readContract({
    address: params.handlerAddress,
    abi: FEE_ASSET_HANDLER_ABI,
    functionName: "mintAmount",
  });
  if (mintAmount <= 0n) {
    throw new CliError(
      `FeeAssetHandler mintAmount must be positive (address=${params.handlerAddress})`,
    );
  }

  let balance = await readFeeJuiceBalance({
    l1RpcUrl: params.l1RpcUrl,
    tokenAddress: params.tokenAddress,
    accountAddress: params.recipient,
  });

  let mintCount = 0;
  let nextNonce: bigint | undefined;
  while (balance < params.targetBalanceWei) {
    const mintTx = await sendWithManagedNonce({
      publicClient,
      accountAddress: funder.address,
      initialNonce: nextNonce,
      send: (nonce) =>
        walletClient.writeContract({
          chain: null,
          address: params.handlerAddress,
          abi: FEE_ASSET_HANDLER_ABI,
          functionName: "mint",
          args: [params.recipient],
          nonce,
        }),
    });
    nextNonce = mintTx.nextNonce;
    const hash = mintTx.hash;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new CliError(`FeeAssetHandler mint reverted: tx_hash=${receipt.transactionHash}`);
    }
    mintCount += 1;
    balance = await readFeeJuiceBalance({
      l1RpcUrl: params.l1RpcUrl,
      tokenAddress: params.tokenAddress,
      accountAddress: params.recipient,
    });
    pinoLogger.info(
      `[fund-l1-fee-juice] faucet mint #${mintCount} tx_hash=${receipt.transactionHash} balance=${balance}`,
    );
  }
}

async function main(): Promise<void> {
  const parseResult = parseCliArgs(process.argv.slice(2));
  if (parseResult.kind === "help") {
    return;
  }
  const args = parseResult.args;

  const operatorAccount = privateKeyToAccount(args.operatorPrivateKey as `0x${string}`);
  const recipient = args.recipientAddress
    ? parseAddress(args.recipientAddress, "--recipient-address")
    : operatorAccount.address;

  const targets = await resolveFundingTargets(args);
  const beforeBalance = await readFeeJuiceBalance({
    l1RpcUrl: args.l1RpcUrl,
    tokenAddress: targets.feeJuiceTokenAddress,
    accountAddress: recipient,
  });

  pinoLogger.info(`[fund-l1-fee-juice] l1_rpc_url=${args.l1RpcUrl}`);
  pinoLogger.info(`[fund-l1-fee-juice] node_url=${args.nodeUrl ?? "<not provided>"}`);
  pinoLogger.info(`[fund-l1-fee-juice] manifest_path=${args.manifestPath ?? "<not provided>"}`);
  pinoLogger.info(
    `[fund-l1-fee-juice] fee_juice_token=${targets.feeJuiceTokenAddress} fee_asset_handler=${targets.feeAssetHandlerAddress ?? "<none>"} source=${targets.source}`,
  );
  pinoLogger.info(`[fund-l1-fee-juice] recipient=${recipient}`);
  pinoLogger.info(
    `[fund-l1-fee-juice] target_balance_wei=${args.targetBalanceWei} current_balance_wei=${beforeBalance}`,
  );

  if (beforeBalance >= args.targetBalanceWei) {
    pinoLogger.info("[fund-l1-fee-juice] recipient already has enough L1 FeeJuice; no mint needed");
    return;
  }

  if (args.dryRun) {
    pinoLogger.info(
      `[fund-l1-fee-juice] dry-run: would mint deficit_wei=${args.targetBalanceWei - beforeBalance}`,
    );
    return;
  }

  const deficit = args.targetBalanceWei - beforeBalance;
  const directMintWorked = await tryDirectMint({
    l1RpcUrl: args.l1RpcUrl,
    funderPrivateKey: args.funderPrivateKey as `0x${string}`,
    tokenAddress: targets.feeJuiceTokenAddress,
    recipient,
    amount: deficit,
  });

  let finalBalance = await readFeeJuiceBalance({
    l1RpcUrl: args.l1RpcUrl,
    tokenAddress: targets.feeJuiceTokenAddress,
    accountAddress: recipient,
  });

  if (!directMintWorked && finalBalance < args.targetBalanceWei) {
    if (!targets.feeAssetHandlerAddress) {
      throw new CliError(
        "Direct token mint failed and no FeeAssetHandler address is available for faucet mint fallback",
      );
    }
    await mintViaFeeAssetHandler({
      l1RpcUrl: args.l1RpcUrl,
      funderPrivateKey: args.funderPrivateKey as `0x${string}`,
      tokenAddress: targets.feeJuiceTokenAddress,
      handlerAddress: targets.feeAssetHandlerAddress,
      recipient,
      targetBalanceWei: args.targetBalanceWei,
    });
    finalBalance = await readFeeJuiceBalance({
      l1RpcUrl: args.l1RpcUrl,
      tokenAddress: targets.feeJuiceTokenAddress,
      accountAddress: recipient,
    });
  }

  if (finalBalance < args.targetBalanceWei) {
    throw new CliError(
      `Funding incomplete: final L1 FeeJuice balance=${finalBalance}, target=${args.targetBalanceWei}`,
    );
  }

  pinoLogger.info(
    `[fund-l1-fee-juice] success: recipient funded on L1. final_balance_wei=${finalBalance}`,
  );
}

main().catch((error) => {
  if (error instanceof CliError) {
    pinoLogger.error(`[fund-l1-fee-juice] ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error("[fund-l1-fee-juice] Unexpected error:", error);
  }
  process.exit(1);
});
