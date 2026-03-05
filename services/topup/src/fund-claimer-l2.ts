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
import { createLogger } from "@aztec/foundation/log";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { Chain, Hex } from "viem";
import { createPublicClient, createWalletClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  deployment_accounts?: {
    l2_deployer?: {
      private_key?: string;
      address?: string;
    };
  };
};

type BridgeClaim = L2AmountClaim;

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
    "  --claimer-secret-key from TOPUP_AUTOCLAIM_SECRET_KEY, then OPERATOR_SECRET_KEY, then manifest.deployment_accounts.l2_deployer.private_key",
    "  --claimer-address from --claimer-address or derived from claimer secret key or manifest.deployment_accounts.l2_deployer.address",
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
        i += 1;
        break;
      case "--claimer-secret-key":
        claimerSecretKey = parseHex32(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--claimer-address":
        claimerAddress = parseAztecAddress(arg, nextArg(argv, i, arg));
        i += 1;
        break;
      case "--fee-payer-secret-key":
        feePayerSecretKey = parseHex32(arg, nextArg(argv, i, arg));
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

async function deriveAddressFromSecret(secretKey: string): Promise<AztecAddress> {
  const secret = Fr.fromHexString(secretKey);
  return getSchnorrAccountContractAddress(secret, Fr.ZERO);
}

function isChain(value: unknown): value is Chain {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    name?: unknown;
    nativeCurrency?: unknown;
    rpcUrls?: unknown;
  };
  return (
    typeof candidate.id === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.nativeCurrency === "object" &&
    typeof candidate.rpcUrls === "object"
  );
}

function resolveL1Chain(chainId: number, l1RpcUrl: string): Chain {
  const known = Object.values(viemChains)
    .filter(isChain)
    .find((chain) => chain.id === chainId);
  if (known) {
    return {
      ...known,
      rpcUrls: {
        ...known.rpcUrls,
        default: { http: [l1RpcUrl] },
        public: { http: [l1RpcUrl] },
      },
    };
  }
  return defineChain({
    id: chainId,
    name: `L1 Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [l1RpcUrl] },
      public: { http: [l1RpcUrl] },
    },
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifestPath);

  const nodeUrlRaw = args.nodeUrl ?? manifest.network?.node_url ?? null;
  if (!nodeUrlRaw) {
    throw new Error(
      "Missing node URL. Set AZTEC_NODE_URL, pass --node-url, or include manifest.network.node_url.",
    );
  }
  const nodeUrl = parseHttpUrl("node URL", nodeUrlRaw);

  const l1RpcUrl = args.l1RpcUrl;
  if (!l1RpcUrl) {
    throw new Error("Missing L1 RPC URL. Set L1_RPC_URL or pass --l1-rpc-url.");
  }

  const l1PrivateKey = args.l1PrivateKey;
  if (!l1PrivateKey) {
    throw new Error(
      "Missing L1 private key. Set L1_OPERATOR_PRIVATE_KEY or pass --l1-private-key.",
    );
  }

  const manifestDeployerKey = parseOptionalHex32(
    "manifest.deployment_accounts.l2_deployer.private_key",
    manifest.deployment_accounts?.l2_deployer?.private_key ?? null,
  );
  const fallbackOperatorKey = parseOptionalHex32(
    "OPERATOR_SECRET_KEY",
    parseOptionalEnv("OPERATOR_SECRET_KEY"),
  );
  const claimerSecretKey = args.claimerSecretKey ?? fallbackOperatorKey ?? manifestDeployerKey;

  const manifestDeployerAddress = parseOptionalAztecAddress(
    "manifest.deployment_accounts.l2_deployer.address",
    manifest.deployment_accounts?.l2_deployer?.address ?? null,
  );

  let claimerAddress: AztecAddress;
  if (claimerSecretKey) {
    const derived = await deriveAddressFromSecret(claimerSecretKey);
    if (args.claimerAddress) {
      const explicit = AztecAddress.fromString(args.claimerAddress);
      if (explicit.toString().toLowerCase() !== derived.toString().toLowerCase()) {
        throw new Error(
          `--claimer-address ${explicit.toString()} does not match address derived from claimer secret key ${derived.toString()}.`,
        );
      }
    }
    claimerAddress = derived;
  } else if (args.claimerAddress) {
    claimerAddress = AztecAddress.fromString(args.claimerAddress);
  } else if (manifestDeployerAddress) {
    claimerAddress = AztecAddress.fromString(manifestDeployerAddress);
  } else {
    throw new Error(
      "Could not resolve claimer address. Provide --claimer-address or --claimer-secret-key, or include deployment_accounts.l2_deployer in manifest.",
    );
  }

  const feePayerSecretKey =
    args.feePayerSecretKey ??
    parseOptionalHex32(
      "TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY",
      parseOptionalEnv("TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY"),
    ) ??
    claimerSecretKey;
  if (!args.skipClaim && !feePayerSecretKey) {
    throw new Error(
      "Missing fee payer secret key for claim. Set --fee-payer-secret-key, TOPUP_AUTOCLAIM_FEE_PAYER_SECRET_KEY, or provide claimer secret key.",
    );
  }

  pinoLogger.info(`${LOG_PREFIX} node_url=${nodeUrl}`);
  pinoLogger.info(`${LOG_PREFIX} l1_rpc_url=${l1RpcUrl}`);
  pinoLogger.info(`${LOG_PREFIX} claimer_address=${claimerAddress.toString()}`);
  pinoLogger.info(`${LOG_PREFIX} amount_wei=${args.amountWei.toString()}`);
  pinoLogger.info(`${LOG_PREFIX} payment_mode=fee_juice (sponsored disabled)`);

  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();
  const l1ChainId = nodeInfo.l1ChainId;
  if (!Number.isInteger(l1ChainId) || l1ChainId <= 0) {
    throw new Error(`Node returned invalid l1ChainId=${String(l1ChainId)}`);
  }

  const l1Public = createPublicClient({ transport: http(l1RpcUrl) });
  const rpcChainId = await l1Public.getChainId();
  if (rpcChainId !== l1ChainId) {
    throw new Error(`L1 chain mismatch. node l1ChainId=${l1ChainId}, rpc chainId=${rpcChainId}`);
  }

  const l1Chain = resolveL1Chain(l1ChainId, l1RpcUrl);
  const l1Account = privateKeyToAccount(l1PrivateKey as Hex);
  const l1Wallet = createWalletClient({
    account: l1Account,
    chain: l1Chain,
    transport: http(l1RpcUrl),
  }).extend(publicActions);

  const bridgeLogger = createLogger("fund-claimer-l2:bridge");
  const portalManager = await L1FeeJuicePortalManager.new(node, l1Wallet as never, bridgeLogger);

  pinoLogger.info(`${LOG_PREFIX} bridging FeeJuice to claimer...`);
  const bridgeClaim = (await portalManager.bridgeTokensPublic(
    claimerAddress,
    args.amountWei,
  )) as BridgeClaim;

  pinoLogger.info(
    `${LOG_PREFIX} bridge submitted message_hash=${bridgeClaim.messageHash} leaf_index=${bridgeClaim.messageLeafIndex} claim_secret_hash=<hidden>`,
  );

  if (args.skipClaim) {
    pinoLogger.info(`${LOG_PREFIX} skip-claim enabled; stopping after bridge submission`);
    return;
  }

  const messageHashFr = Fr.fromHexString(bridgeClaim.messageHash);
  pinoLogger.info(`${LOG_PREFIX} waiting for L1->L2 message readiness...`);
  const ready = await waitForL1ToL2MessageReady(node, messageHashFr, {
    timeoutSeconds: args.messageReadyTimeoutSeconds,
    forPublicConsumption: false,
  });
  if (!ready) {
    throw new Error(
      `Bridge message did not become ready within ${args.messageReadyTimeoutSeconds}s.`,
    );
  }

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });
  const feePayerSecret = Fr.fromHexString(feePayerSecretKey as string);
  const feePayerSigningKey = deriveSigningKey(feePayerSecret);
  const feePayerAccount = await wallet.createSchnorrAccount(
    feePayerSecret,
    Fr.ZERO,
    feePayerSigningKey,
  );
  const feePayerAddress = feePayerAccount.address;

  // Register claimer account in wallet for self-pay fallback when fee payer has no balance.
  let claimerWalletAddress = feePayerAddress;
  if (claimerSecretKey && claimerSecretKey !== feePayerSecretKey) {
    const claimerSecret = Fr.fromHexString(claimerSecretKey);
    const claimerSigningKey = deriveSigningKey(claimerSecret);
    const claimerAccount = await wallet.createSchnorrAccount(
      claimerSecret,
      Fr.ZERO,
      claimerSigningKey,
    );
    claimerWalletAddress = claimerAccount.address;
  }

  const claimerBalanceBefore = await getFeeJuiceBalance(claimerAddress, node);
  const feePayerBalanceBefore = await getFeeJuiceBalance(feePayerAddress, node);
  pinoLogger.info(
    `${LOG_PREFIX} pre-claim balances claimer=${claimerBalanceBefore} fee_payer=${feePayerBalanceBefore}`,
  );

  // Self-pay with the claim when fee payer has no balance and we have the claimer key.
  const useSelfPay = feePayerBalanceBefore <= 0n && claimerSecretKey != null;
  if (useSelfPay) {
    pinoLogger.info(
      `${LOG_PREFIX} fee payer has no balance — using FeeJuicePaymentMethodWithClaim (self-pay)`,
    );
  } else if (feePayerBalanceBefore <= 0n) {
    throw new Error(
      `Fee payer ${feePayerAddress.toString()} has zero L2 FeeJuice. Fund it first or provide --claimer-secret-key for self-pay.`,
    );
  }

  const feeJuice = FeeJuiceContract.at(wallet);
  let lastError: unknown = null;
  let txHash: string | null = null;

  for (let attempt = 1; attempt <= args.claimRetries; attempt += 1) {
    try {
      const sendFrom = useSelfPay ? claimerWalletAddress : feePayerAddress;
      const sendFee = useSelfPay
        ? {
            paymentMethod: new FeeJuicePaymentMethodWithClaim(claimerAddress, bridgeClaim),
          }
        : undefined;
      const receipt = await feeJuice.methods
        .claim(
          claimerAddress,
          bridgeClaim.claimAmount,
          bridgeClaim.claimSecret,
          new Fr(bridgeClaim.messageLeafIndex),
        )
        .send({
          from: sendFrom,
          fee: sendFee,
          wait: { timeout: args.claimTimeoutSeconds },
        });

      txHash = receipt.txHash.toString();
      pinoLogger.info(
        `${LOG_PREFIX} claim succeeded tx_hash=${txHash} attempt=${attempt}/${args.claimRetries}`,
      );
      break;
    } catch (error) {
      lastError = error;
      const rendered = String(error);
      if (
        rendered.includes("Insufficient fee payer balance") ||
        rendered.includes("Invalid tx: Insufficient fee payer balance")
      ) {
        throw new Error(
          `Claim failed due to insufficient fee payer balance for ${feePayerAddress.toString()}. Underlying error: ${rendered}`,
        );
      }
      if (attempt >= args.claimRetries) {
        break;
      }
      pinoLogger.warn(
        `${LOG_PREFIX} claim attempt failed attempt=${attempt}/${args.claimRetries} retry_in_ms=${args.claimRetryDelayMs} error=${rendered}`,
      );
      await sleep(args.claimRetryDelayMs);
    }
  }

  if (!txHash) {
    throw new Error(
      `Claim did not succeed after ${args.claimRetries} attempts. Last error: ${String(lastError)}`,
    );
  }

  const claimerBalanceAfter = await getFeeJuiceBalance(claimerAddress, node);
  const feePayerBalanceAfter = await getFeeJuiceBalance(feePayerAddress, node);
  pinoLogger.info(
    `${LOG_PREFIX} post-claim balances claimer=${claimerBalanceAfter} fee_payer=${feePayerBalanceAfter}`,
  );
  pinoLogger.info(
    `${LOG_PREFIX} success: claimer delta=${claimerBalanceAfter - claimerBalanceBefore} wei`,
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
