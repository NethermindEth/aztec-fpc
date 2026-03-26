import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const pinoLogger = pino();

import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { L2AmountClaim } from "@aztec/aztec.js/ethereum";
import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { createLogger } from "@aztec/foundation/log";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { type Chain, createPublicClient, extractChain, http } from "viem";
import * as viemChains from "viem/chains";

const LOG_PREFIX = "[fund-claimer-l2]";
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, "deployments", "devnet-manifest-v2.json");
const DEFAULT_CLAIM_TIMEOUT_SECONDS = 120;
const DEFAULT_MESSAGE_READY_TIMEOUT_SECONDS = 300;
const DEFAULT_CLAIM_RETRIES = 8;
const DEFAULT_CLAIM_RETRY_DELAY_MS = 15_000;

type CliArgs = {
  amountWei: bigint;
  manifestPath: string;
  nodeUrl: string | null;
  l1RpcUrl: string | null;
  l1PrivateKey: string | null;
  claimerSecretKey: string | null;
  claimerAddress: string | null;
  feePayerSecretKey: string | null;
  skipClaim: boolean;
  claimTimeoutSeconds: number;
  messageReadyTimeoutSeconds: number;
  claimRetries: number;
  claimRetryDelayMs: number;
};

type PartialManifest = {
  network?: {
    node_url?: string;
  };
};

function usage(): string {
  return [
    "Usage:",
    "  bun run --filter @aztec-fpc/topup fund:claimer:l2 -- \\",
    "    --amount-wei <uint> \\",
    "    [--manifest <path.json>] \\",
    "    [--node-url <http(s)://...>] \\",
    "    [--l1-rpc-url <http(s)://...>] \\",
    "    [--l1-private-key <0x...32-byte-hex>] \\",
    "    [--claimer-secret-key <0x...32-byte-hex>] \\",
    "    [--claimer-address <0x...aztec-address>] \\",
    "    [--fee-payer-secret-key <0x...32-byte-hex>] \\",
    "    [--skip-claim] \\",
    "    [--claim-timeout-seconds <uint>] \\",
    "    [--message-ready-timeout-seconds <uint>] \\",
    "    [--claim-retries <uint>] \\",
    "    [--claim-retry-delay-ms <uint>]",
    "",
    "Goal:",
    "  - Bridge FeeJuice from L1 to L2 recipient=claimer address.",
    "  - Claim on L2 with fee_juice payment only (no sponsored payment).",
    "",
    "Defaults / fallbacks:",
    `  --manifest ${DEFAULT_MANIFEST_PATH}`,
    "  --node-url from AZTEC_NODE_URL or manifest.network.node_url",
    "  --l1-rpc-url from L1_RPC_URL",
    "  --l1-private-key from L1_OPERATOR_PRIVATE_KEY",
    "  --claimer-secret-key from TOPUP_AUTOCLAIM_SECRET_KEY, then OPERATOR_SECRET_KEY",
    "  --claimer-address from --claimer-address or derived from claimer secret key",
    "  --fee-payer-secret-key from TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY, else --claimer-secret-key",
    "",
    "Notes:",
    "  - Claim transaction is always sent without sponsored fee payment.",
    "  - The fee payer account must already have L2 Fee Juice.",
  ].join("\n");
}

function parseOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseHex32(name: string, raw: string): string {
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_32_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${name}. Expected 32-byte 0x-prefixed hex.`);
  }
  return normalized;
}

function parseOptionalHex32(name: string, raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  return parseHex32(name, raw);
}

function parseAztecAddress(name: string, raw: string): string {
  try {
    return AztecAddress.fromString(raw).toString();
  } catch {
    throw new Error(`Invalid ${name}. Expected 32-byte Aztec address.`);
  }
}

function parseOptionalAztecAddress(name: string, raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  return parseAztecAddress(name, raw);
}

function parseHttpUrl(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${name}. Expected URL, got "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${name}. Expected http(s) URL, got "${raw}"`);
  }
  return parsed.toString();
}

function parsePositiveInt(name: string, raw: string): number {
  if (!DECIMAL_UINT_PATTERN.test(raw)) {
    throw new Error(`Invalid ${name}. Expected non-negative integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}. Expected positive safe integer.`);
  }
  return parsed;
}

function nextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseCliArgs(argv: string[]): CliArgs {
  let amountWeiRaw = parseOptionalEnv("TOPUP_AUTOCLAIM_FUND_AMOUNT_WEI");
  let manifestPath = parseOptionalEnv("FPC_DEPLOY_MANIFEST") ?? DEFAULT_MANIFEST_PATH;
  let nodeUrl = parseOptionalEnv("AZTEC_NODE_URL");
  let l1RpcUrl = parseOptionalEnv("L1_RPC_URL");
  let l1PrivateKey = parseOptionalHex32(
    "L1_OPERATOR_PRIVATE_KEY",
    parseOptionalEnv("L1_OPERATOR_PRIVATE_KEY"),
  );
  let claimerSecretKey = parseOptionalHex32(
    "TOPUP_AUTOCLAIM_SECRET_KEY",
    parseOptionalEnv("TOPUP_AUTOCLAIM_SECRET_KEY"),
  );
  let claimerAddress = parseOptionalAztecAddress(
    "TOPUP_AUTOCLAIM_CLAIMER_ADDRESS",
    parseOptionalEnv("TOPUP_AUTOCLAIM_CLAIMER_ADDRESS"),
  );
  let feePayerSecretKey = parseOptionalHex32(
    "TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY",
    parseOptionalEnv("TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY"),
  );
  let skipClaim = false;
  let claimTimeoutSeconds = DEFAULT_CLAIM_TIMEOUT_SECONDS;
  let messageReadyTimeoutSeconds = DEFAULT_MESSAGE_READY_TIMEOUT_SECONDS;
  let claimRetries = DEFAULT_CLAIM_RETRIES;
  let claimRetryDelayMs = DEFAULT_CLAIM_RETRY_DELAY_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--amount-wei":
        amountWeiRaw = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--manifest":
        manifestPath = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--node-url":
        nodeUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--l1-rpc-url":
        l1RpcUrl = nextArg(argv, i, arg);
        i += 1;
        break;
      case "--l1-private-key":
        l1PrivateKey = parseHex32(arg, nextArg(argv, i, arg));
        pinoLogger.warn(
          `${LOG_PREFIX} Passing secret keys via CLI arguments exposes them in process listings. Prefer L1_OPERATOR_PRIVATE_KEY env var.`,
        );
        i += 1;
        break;
      case "--claimer-secret-key":
        claimerSecretKey = parseHex32(arg, nextArg(argv, i, arg));
        pinoLogger.warn(
          `${LOG_PREFIX} Passing secret keys via CLI arguments exposes them in process listings. Prefer TOPUP_AUTOCLAIM_SECRET_KEY env var.`,
        );
        i += 1;
        break;
      case "--claimer-address":
        claimerAddress = parseAztecAddress(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--fee-payer-secret-key":
        feePayerSecretKey = parseHex32(arg, nextArg(argv, i, arg));
        pinoLogger.warn(
          `${LOG_PREFIX} Passing secret keys via CLI arguments exposes them in process listings. Prefer TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY env var.`,
        );
        i += 1;
        break;
      case "--skip-claim":
        skipClaim = true;
        break;
      case "--claim-timeout-seconds":
        claimTimeoutSeconds = parsePositiveInt(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--message-ready-timeout-seconds":
        messageReadyTimeoutSeconds = parsePositiveInt(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--claim-retries":
        claimRetries = parsePositiveInt(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--claim-retry-delay-ms":
        claimRetryDelayMs = parsePositiveInt(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--help":
      case "-h":
        pinoLogger.info(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!amountWeiRaw) {
    throw new Error("Missing --amount-wei (or TOPUP_AUTOCLAIM_FUND_AMOUNT_WEI)");
  }
  if (!DECIMAL_UINT_PATTERN.test(amountWeiRaw)) {
    throw new Error("--amount-wei must be a non-negative integer in wei");
  }
  const amountWei = BigInt(amountWeiRaw);
  if (amountWei <= 0n) {
    throw new Error("--amount-wei must be greater than zero");
  }

  return {
    amountWei,
    manifestPath: path.isAbsolute(manifestPath)
      ? manifestPath
      : path.resolve(REPO_ROOT, manifestPath),
    nodeUrl: nodeUrl ? parseHttpUrl("--node-url", nodeUrl) : null,
    l1RpcUrl: l1RpcUrl ? parseHttpUrl("--l1-rpc-url", l1RpcUrl) : null,
    l1PrivateKey,
    claimerSecretKey,
    claimerAddress,
    feePayerSecretKey,
    skipClaim,
    claimTimeoutSeconds,
    messageReadyTimeoutSeconds,
    claimRetries,
    claimRetryDelayMs,
  };
}

function readManifest(manifestPath: string): PartialManifest {
  try {
    const raw = readFileSync(manifestPath, "utf8");
    return JSON.parse(raw) as PartialManifest;
  } catch (error) {
    throw new Error(`Failed to read manifest ${manifestPath}: ${String(error)}`);
  }
}

function deriveAddressFromSecret(secretKey: string): Promise<AztecAddress> {
  const secret = Fr.fromHexString(secretKey);
  return getSchnorrAccountContractAddress(secret, Fr.ZERO);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type TopupNode = ReturnType<typeof createAztecNodeClient>;
type BridgePortalManager = Awaited<ReturnType<typeof L1FeeJuicePortalManager.new>>;
type EmbeddedWalletInstance = Awaited<ReturnType<typeof EmbeddedWallet.create>>;

function resolveNodeUrl(args: CliArgs, manifest: PartialManifest): string {
  const nodeUrlRaw = args.nodeUrl ?? manifest.network?.node_url ?? null;
  if (!nodeUrlRaw) {
    throw new Error(
      "Missing node URL. Set AZTEC_NODE_URL, pass --node-url, or include manifest.network.node_url.",
    );
  }
  return parseHttpUrl("node URL", nodeUrlRaw);
}

function requireL1RpcUrl(args: CliArgs): string {
  if (!args.l1RpcUrl) {
    throw new Error("Missing L1 RPC URL. Set L1_RPC_URL or pass --l1-rpc-url.");
  }
  return args.l1RpcUrl;
}

function requireL1PrivateKey(args: CliArgs): string {
  if (!args.l1PrivateKey) {
    throw new Error(
      "Missing L1 private key. Set L1_OPERATOR_PRIVATE_KEY or pass --l1-private-key.",
    );
  }
  return args.l1PrivateKey;
}

function resolveClaimerSecretKey(args: CliArgs): string | null {
  const fallbackOperatorKey = parseOptionalHex32(
    "OPERATOR_SECRET_KEY",
    parseOptionalEnv("OPERATOR_SECRET_KEY"),
  );
  return args.claimerSecretKey ?? fallbackOperatorKey;
}

function assertClaimerAddressMatchesDerived(
  explicitAddress: string,
  derivedAddress: AztecAddress,
): void {
  const explicit = AztecAddress.fromString(explicitAddress);
  if (explicit.toString().toLowerCase() === derivedAddress.toString().toLowerCase()) {
    return;
  }
  throw new Error(
    `--claimer-address ${explicit.toString()} does not match address derived from claimer secret key ${derivedAddress.toString()}.`,
  );
}

async function resolveClaimerAddress(
  args: CliArgs,
  claimerSecretKey: string | null,
): Promise<AztecAddress> {
  if (claimerSecretKey) {
    const derived = await deriveAddressFromSecret(claimerSecretKey);
    if (args.claimerAddress) {
      assertClaimerAddressMatchesDerived(args.claimerAddress, derived);
    }
    return derived;
  }
  if (args.claimerAddress) {
    return AztecAddress.fromString(args.claimerAddress);
  }
  throw new Error(
    "Could not resolve claimer address. Provide --claimer-address or --claimer-secret-key.",
  );
}

function resolveFeePayerSecretKey(args: CliArgs, claimerSecretKey: string | null): string | null {
  return (
    args.feePayerSecretKey ??
    parseOptionalHex32(
      "TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY",
      parseOptionalEnv("TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY"),
    ) ??
    claimerSecretKey
  );
}

function requireFeePayerSecretKeyForClaim(feePayerSecretKey: string | null): string {
  if (!feePayerSecretKey) {
    throw new Error(
      "Missing fee payer secret key for claim. Set --fee-payer-secret-key, TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY, or provide claimer secret key.",
    );
  }
  return feePayerSecretKey;
}

function logRunConfig(
  args: CliArgs,
  nodeUrl: string,
  l1RpcUrl: string,
  claimerAddress: AztecAddress,
): void {
  pinoLogger.info(`${LOG_PREFIX} node_url=${nodeUrl}`);
  pinoLogger.info(`${LOG_PREFIX} l1_rpc_url=${l1RpcUrl}`);
  pinoLogger.info(`${LOG_PREFIX} claimer_address=${claimerAddress.toString()}`);
  pinoLogger.info(`${LOG_PREFIX} amount_wei=${args.amountWei.toString()}`);
  pinoLogger.info(`${LOG_PREFIX} payment_mode=fee_juice (sponsored disabled)`);
}

function assertPositiveL1ChainId(l1ChainId: number): void {
  if (Number.isInteger(l1ChainId) && l1ChainId > 0) {
    return;
  }
  throw new Error(`Node returned invalid l1ChainId=${String(l1ChainId)}`);
}

async function assertL1ChainIdMatchesRpc(l1RpcUrl: string, l1ChainId: number): Promise<void> {
  const l1Public = createPublicClient({ transport: http(l1RpcUrl) });
  const rpcChainId = await l1Public.getChainId();
  if (rpcChainId !== l1ChainId) {
    throw new Error(`L1 chain mismatch. node l1ChainId=${l1ChainId}, rpc chainId=${rpcChainId}`);
  }
}

function createL1WalletClient(l1RpcUrl: string, l1ChainId: number, l1PrivateKey: string) {
  const l1Chain = extractChain({
    chains: Object.values(viemChains) as readonly Chain[],
    id: l1ChainId,
  });
  return createExtendedL1Client([l1RpcUrl], l1PrivateKey, l1Chain);
}

async function setupBridgePortal(
  nodeUrl: string,
  l1RpcUrl: string,
  l1PrivateKey: string,
): Promise<{ node: TopupNode; portalManager: BridgePortalManager }> {
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();
  const l1ChainId = nodeInfo.l1ChainId;
  assertPositiveL1ChainId(l1ChainId);
  await assertL1ChainIdMatchesRpc(l1RpcUrl, l1ChainId);

  const l1Wallet = createL1WalletClient(l1RpcUrl, l1ChainId, l1PrivateKey);
  const bridgeLogger = createLogger("fund-claimer-l2:bridge");
  const portalManager = await L1FeeJuicePortalManager.new(node, l1Wallet as never, bridgeLogger);
  return { node, portalManager };
}

async function submitBridgeToClaimer(
  portalManager: BridgePortalManager,
  claimerAddress: AztecAddress,
  amountWei: bigint,
): Promise<L2AmountClaim> {
  pinoLogger.info(`${LOG_PREFIX} bridging FeeJuice to claimer...`);
  const bridgeClaim = (await portalManager.bridgeTokensPublic(
    claimerAddress,
    amountWei,
  )) as L2AmountClaim;
  pinoLogger.info(
    `${LOG_PREFIX} bridge submitted message_hash=${bridgeClaim.messageHash} leaf_index=${bridgeClaim.messageLeafIndex} claim_secret_hash=<hidden>`,
  );
  return bridgeClaim;
}

async function waitForBridgeMessageReady(
  node: TopupNode,
  bridgeClaim: L2AmountClaim,
  timeoutSeconds: number,
): Promise<void> {
  const messageHashFr = Fr.fromHexString(bridgeClaim.messageHash);
  pinoLogger.info(`${LOG_PREFIX} waiting for L1->L2 message readiness...`);
  const ready = await waitForL1ToL2MessageReady(node, messageHashFr, {
    timeoutSeconds,
  });
  if (!ready) {
    throw new Error(`Bridge message did not become ready within ${timeoutSeconds}s.`);
  }
}

async function createWalletAccountFromSecret(
  wallet: EmbeddedWalletInstance,
  secretKey: string,
): Promise<AztecAddress> {
  const secret = Fr.fromHexString(secretKey);
  const signingKey = deriveSigningKey(secret);
  const account = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKey);
  return account.address;
}

async function setupClaimWallet(
  node: TopupNode,
  feePayerSecretKey: string,
  claimerSecretKey: string | null,
): Promise<{
  wallet: EmbeddedWalletInstance;
  feePayerAddress: AztecAddress;
  claimerWalletAddress: AztecAddress;
}> {
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true, syncChainTip: "checkpointed" },
  });
  const feePayerAddress = await createWalletAccountFromSecret(wallet, feePayerSecretKey);
  if (!claimerSecretKey || claimerSecretKey === feePayerSecretKey) {
    return { wallet, feePayerAddress, claimerWalletAddress: feePayerAddress };
  }

  const claimerWalletAddress = await createWalletAccountFromSecret(wallet, claimerSecretKey);
  return { wallet, feePayerAddress, claimerWalletAddress };
}

async function readBalances(
  node: TopupNode,
  claimerAddress: AztecAddress,
  feePayerAddress: AztecAddress,
): Promise<{ claimerBalance: bigint; feePayerBalance: bigint }> {
  const claimerBalance = await getFeeJuiceBalance(claimerAddress, node);
  const feePayerBalance = await getFeeJuiceBalance(feePayerAddress, node);
  return { claimerBalance, feePayerBalance };
}

function resolveSelfPayMode(
  feePayerBalance: bigint,
  claimerSecretKey: string | null,
  feePayerAddress: AztecAddress,
): boolean {
  const useSelfPay = feePayerBalance <= 0n && claimerSecretKey != null;
  if (useSelfPay) {
    pinoLogger.info(
      `${LOG_PREFIX} fee payer has no balance — using FeeJuicePaymentMethodWithClaim (self-pay)`,
    );
    return true;
  }
  if (feePayerBalance <= 0n) {
    throw new Error(
      `Fee payer ${feePayerAddress.toString()} has zero L2 FeeJuice. Fund it first or provide --claimer-secret-key for self-pay.`,
    );
  }
  return false;
}

function isInsufficientFeePayerBalanceError(renderedError: string): boolean {
  return (
    renderedError.includes("Insufficient fee payer balance") ||
    renderedError.includes("Invalid tx: Insufficient fee payer balance")
  );
}

interface ClaimWithRetriesArgs {
  feeJuice: ReturnType<typeof FeeJuiceContract.at>;
  claimerAddress: AztecAddress;
  bridgeClaim: L2AmountClaim;
  useSelfPay: boolean;
  claimerWalletAddress: AztecAddress;
  feePayerAddress: AztecAddress;
  claimRetries: number;
  claimTimeoutSeconds: number;
  claimRetryDelayMs: number;
}

function resolveClaimSendContext(args: ClaimWithRetriesArgs): {
  from: AztecAddress;
  fee: { paymentMethod: FeeJuicePaymentMethodWithClaim } | undefined;
} {
  if (!args.useSelfPay) {
    return { from: args.feePayerAddress, fee: undefined };
  }
  return {
    from: args.claimerWalletAddress,
    fee: {
      paymentMethod: new FeeJuicePaymentMethodWithClaim(args.claimerAddress, args.bridgeClaim),
    },
  };
}

async function submitClaimAttempt(args: ClaimWithRetriesArgs): Promise<string> {
  const sendContext = resolveClaimSendContext(args);
  const { receipt } = await args.feeJuice.methods
    .claim(
      args.claimerAddress,
      args.bridgeClaim.claimAmount,
      args.bridgeClaim.claimSecret,
      new Fr(args.bridgeClaim.messageLeafIndex),
    )
    .send({
      from: sendContext.from,
      fee: sendContext.fee,
      wait: { timeout: args.claimTimeoutSeconds },
    });
  return receipt.txHash.toString();
}

async function handleClaimAttemptFailure(
  args: ClaimWithRetriesArgs,
  attempt: number,
  error: unknown,
): Promise<void> {
  const renderedError = String(error);
  if (isInsufficientFeePayerBalanceError(renderedError)) {
    throw new Error(
      `Claim failed due to insufficient fee payer balance for ${args.feePayerAddress.toString()}. Underlying error: ${renderedError}`,
    );
  }
  if (attempt >= args.claimRetries) {
    return;
  }
  pinoLogger.warn(
    `${LOG_PREFIX} claim attempt failed attempt=${attempt}/${args.claimRetries} retry_in_ms=${args.claimRetryDelayMs} error=${renderedError}`,
  );
  await sleep(args.claimRetryDelayMs);
}

async function claimWithRetries(args: ClaimWithRetriesArgs): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= args.claimRetries; attempt += 1) {
    try {
      const txHash = await submitClaimAttempt(args);
      pinoLogger.info(
        `${LOG_PREFIX} claim succeeded tx_hash=${txHash} attempt=${attempt}/${args.claimRetries}`,
      );
      return txHash;
    } catch (error) {
      lastError = error;
      await handleClaimAttemptFailure(args, attempt, error);
    }
  }
  throw new Error(
    `Claim did not succeed after ${args.claimRetries} attempts. Last error: ${String(lastError)}`,
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifestPath);
  const nodeUrl = resolveNodeUrl(args, manifest);
  const l1RpcUrl = requireL1RpcUrl(args);
  const l1PrivateKey = requireL1PrivateKey(args);
  const claimerSecretKey = resolveClaimerSecretKey(args);
  const claimerAddress = await resolveClaimerAddress(args, claimerSecretKey);
  const feePayerSecretKey = resolveFeePayerSecretKey(args, claimerSecretKey);
  logRunConfig(args, nodeUrl, l1RpcUrl, claimerAddress);

  const { node, portalManager } = await setupBridgePortal(nodeUrl, l1RpcUrl, l1PrivateKey);
  const bridgeClaim = await submitBridgeToClaimer(portalManager, claimerAddress, args.amountWei);
  if (args.skipClaim) {
    pinoLogger.info(`${LOG_PREFIX} skip-claim enabled; stopping after bridge submission`);
    return;
  }

  const requiredFeePayerSecretKey = requireFeePayerSecretKeyForClaim(feePayerSecretKey);
  await waitForBridgeMessageReady(node, bridgeClaim, args.messageReadyTimeoutSeconds);
  const { wallet, feePayerAddress, claimerWalletAddress } = await setupClaimWallet(
    node,
    requiredFeePayerSecretKey,
    claimerSecretKey,
  );
  const balancesBefore = await readBalances(node, claimerAddress, feePayerAddress);
  pinoLogger.info(
    `${LOG_PREFIX} pre-claim balances claimer=${balancesBefore.claimerBalance} fee_payer=${balancesBefore.feePayerBalance}`,
  );

  const useSelfPay = resolveSelfPayMode(
    balancesBefore.feePayerBalance,
    claimerSecretKey,
    feePayerAddress,
  );
  const feeJuice = FeeJuiceContract.at(wallet);
  await claimWithRetries({
    feeJuice,
    claimerAddress,
    bridgeClaim,
    useSelfPay,
    claimerWalletAddress,
    feePayerAddress,
    claimRetries: args.claimRetries,
    claimTimeoutSeconds: args.claimTimeoutSeconds,
    claimRetryDelayMs: args.claimRetryDelayMs,
  });

  const balancesAfter = await readBalances(node, claimerAddress, feePayerAddress);
  pinoLogger.info(
    `${LOG_PREFIX} post-claim balances claimer=${balancesAfter.claimerBalance} fee_payer=${balancesAfter.feePayerBalance}`,
  );
  pinoLogger.info(
    `${LOG_PREFIX} success: claimer delta=${balancesAfter.claimerBalance - balancesBefore.claimerBalance} wei`,
  );
}

main().catch((error) => {
  if (error instanceof Error) {
    pinoLogger.error(`${LOG_PREFIX} ERROR: ${error.message}`);
    pinoLogger.error("");
    pinoLogger.error(usage());
  } else {
    pinoLogger.error({ err: error }, `${LOG_PREFIX} Unexpected error:`);
  }
  process.exit(1);
});
