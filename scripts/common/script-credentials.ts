/**
 * Shared credential utility for parallel script execution.
 *
 * Each invocation generates a fresh random L1 account (funded via
 * `anvil_setBalance`) and the requested number of L2 accounts.
 * FeeJuice is bridged L1→L2 and the accounts are deployed on-chain.
 *
 * Usage — replace `getInitialTestAccountsData()` with `resolveScriptAccounts()`:
 *
 *   const { accounts, l1PrivateKey } =
 *     await resolveScriptAccounts(nodeUrl, l1RpcUrl, wallet, 3);
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1FeeJuicePortalManager, type L2AmountClaim } from "@aztec/aztec.js/ethereum";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { type Fq, Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import type { AccountManager } from "@aztec/aztec.js/wallet";
import { createLogger } from "@aztec/foundation/log";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { createWalletClient, fallback, type Hex, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pinoLogger = pino();

/** Timeout for L1→L2 message readiness. */
const L1_TO_L2_MESSAGE_TIMEOUT_SECONDS = 120;

/** Maximum number of retry attempts for bridgeTokensPublic. */
const BRIDGE_RETRY_ATTEMPTS = 3;

/** Delay between retry attempts in milliseconds. */
const BRIDGE_RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// L2 account derivation
// ---------------------------------------------------------------------------

export type AccountData = {
  secret: Fr;
  salt: Fr;
  signingKey: Fq;
  address: AztecAddress;
  accountManager: AccountManager;
};

export type ScriptEnvironment = {
  /** Randomly generated L1 private key, funded via anvil_setBalance. */
  l1PrivateKey: Hex;
  /** Account data in indexed order: [0]=operator, [1]=user, [2]=otherUser. */
  accounts: AccountData[];
};

export async function deriveAccount(secret: Fr, wallet: EmbeddedWallet): Promise<AccountData> {
  const signingKey = deriveSigningKey(secret);
  const salt = Fr.ZERO;
  const accountManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  return { secret, salt, signingKey, address: accountManager.address, accountManager };
}

/**
 * Generate fresh L1 + L2 accounts, fund L1 via `anvil_setBalance`,
 * bridge FeeJuice L1→L2, and deploy L2 accounts.
 */
export async function resolveScriptAccounts(
  nodeUrl: string,
  l1RpcUrl: string,
  wallet: EmbeddedWallet,
  accountCount: number,
): Promise<ScriptEnvironment> {
  // Generate a random L1 account and fund it via Anvil.
  const l1Key = generatePrivateKey();
  const l1Account = privateKeyToAccount(l1Key);
  pinoLogger.info(`generated L1 account ${l1Account.address}`);

  await fundL1Account(l1RpcUrl, l1Account.address);

  const node = createAztecNodeClient(nodeUrl);

  // Set up L1 portal for bridging FeeJuice.
  const l1WalletClient = createWalletClient({
    account: l1Account,
    transport: fallback([http(l1RpcUrl)]),
  }).extend(publicActions);
  const portal = await L1FeeJuicePortalManager.new(
    node,
    l1WalletClient,
    createLogger("script-credentials:bridge"),
  );

  // Register accounts and bridge FeeJuice L1→L2 — sequentially.
  const preResults: PreClaimResult[] = [];
  for (let i = 0; i < accountCount; i++) {
    preResults.push(await preClaim(i, `account[${i}]`, wallet, portal));
  }

  // Mint additional L1 FeeJuice so the L1 account retains a balance.
  await portal.getTokenManager().mint(l1Account.address);
  pinoLogger.info(`minted L1 FeeJuice for ${l1Account.address}`);

  // Wait for L1→L2 messages, then deploy accounts with claimed FeeJuice.
  for (let i = 0; i < preResults.length; i++) {
    const r = preResults[i];
    await deployWithClaim(i, r.account, node, r.pendingClaim);
  }

  return {
    l1PrivateKey: l1Key,
    accounts: preResults.map((r) => r.account),
  };
}

// ---------------------------------------------------------------------------
// L1 funding via anvil_setBalance
// ---------------------------------------------------------------------------

async function fundL1Account(l1RpcUrl: string, address: string): Promise<void> {
  const response = await fetch(l1RpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [address, "0xDE0B6B3A7640000"],
    }),
  });
  if (!response.ok) {
    throw new Error(`anvil_setBalance failed: HTTP ${response.status} ${response.statusText}`);
  }
  const result = (await response.json()) as { error?: { message: string } };
  if (result.error) {
    throw new Error(`anvil_setBalance RPC error: ${result.error.message}`);
  }
  pinoLogger.info(`funded L1 account ${address} with 1 ETH`);
}

// ---------------------------------------------------------------------------
// Bridge with retry
// ---------------------------------------------------------------------------

async function bridgeWithRetry(portal: L1FeeJuicePortalManager, l2Address: AztecAddress) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await portal.bridgeTokensPublic(l2Address, undefined, true);
    } catch (error) {
      const isRetryable =
        error instanceof Error &&
        error.message.toLowerCase().includes("failed to find matching event");
      if (!isRetryable || attempt === BRIDGE_RETRY_ATTEMPTS) {
        throw error;
      }
      pinoLogger.warn(
        `bridgeTokensPublic attempt ${attempt}/${BRIDGE_RETRY_ATTEMPTS} failed. Retrying in ${BRIDGE_RETRY_DELAY_MS}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_RETRY_DELAY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-claim: create account and bridge FeeJuice (per account)
// ---------------------------------------------------------------------------

type PendingClaim = {
  claim: L2AmountClaim;
  messageHash: Fr;
};

type PreClaimResult = {
  account: AccountData;
  pendingClaim: PendingClaim;
};

async function preClaim(
  index: number,
  role: string,
  wallet: EmbeddedWallet,
  portal: L1FeeJuicePortalManager,
): Promise<PreClaimResult> {
  // 1. Derive and register account locally.
  const account = await deriveAccount(Fr.random(), wallet);
  pinoLogger.info(`registered L2 account ${role}=${account.address.toString()}`);

  // 2. Bridge FeeJuice L1→L2 for this account (with retries).
  const l2Claim = await bridgeWithRetry(portal, account.address);
  const messageHash = Fr.fromHexString(l2Claim.messageHash as string);
  pinoLogger.info(`bridged FeeJuice L1→L2 for account[${index}]=${account.address.toString()}`);

  return {
    account,
    pendingClaim: { claim: l2Claim, messageHash },
  };
}

// ---------------------------------------------------------------------------
// Deploy with claim: wait for L1→L2 message, then deploy account paying
// the fee with the claimed FeeJuice in a single transaction.
// ---------------------------------------------------------------------------

async function deployWithClaim(
  index: number,
  account: AccountData,
  node: ReturnType<typeof createAztecNodeClient>,
  pending: PendingClaim,
): Promise<void> {
  await waitForL1ToL2MessageReady(node, pending.messageHash, {
    timeoutSeconds: L1_TO_L2_MESSAGE_TIMEOUT_SECONDS,
  });
  pinoLogger.info(`L1→L2 message ready for account[${index}]`);

  const feePayment = new FeeJuicePaymentMethodWithClaim(account.address, pending.claim);
  const deployMethod = await account.accountManager.getDeployMethod();
  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: { paymentMethod: feePayment },
    skipClassPublication: true,
    skipInstancePublication: false,
  });
  pinoLogger.info(`deployed L2 account[${index}]=${account.address.toString()}`);
}
