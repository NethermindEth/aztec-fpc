/**
 * Shared credential utility for parallel script execution.
 *
 * Each invocation generates a fresh random L1 account (funded via
 * `anvil_setBalance`) and deterministically derived L2 accounts
 * (operator, user, otherUser). FeeJuice is bridged L1→L2 and the
 * accounts are deployed on-chain.
 *
 * Usage — replace `getInitialTestAccountsData()` with `resolveScriptAccounts()`:
 *
 *   const { accounts, l1PrivateKey } =
 *     await resolveScriptAccounts(nodeUrl, l1RpcUrl, wallet);
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1FeeJuicePortalManager, type L2AmountClaim } from "@aztec/aztec.js/ethereum";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { type Fq, Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { createLogger } from "@aztec/foundation/log";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { createWalletClient, fallback, type Hex, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pinoLogger = pino();

/** Timeout for L1→L2 message readiness. */
const L1_TO_L2_MESSAGE_TIMEOUT_SECONDS = 120;

// ---------------------------------------------------------------------------
// L2 account derivation
// ---------------------------------------------------------------------------

export type AccountData = {
  secret: Fr;
  salt: Fr;
  signingKey: Fq;
};

export type ScriptEnvironment = {
  /** Randomly generated L1 private key, funded via anvil_setBalance. */
  l1PrivateKey: Hex;
  /** Account data in indexed order: [0]=operator, [1]=user, [2]=otherUser. */
  accounts: AccountData[];
};

type AccountManager = Awaited<ReturnType<EmbeddedWallet["createSchnorrAccount"]>>;

function deriveAccount(): AccountData {
  const secret = Fr.random();
  const signingKey = deriveSigningKey(secret);
  return { secret, salt: Fr.ZERO, signingKey };
}

/**
 * Generate fresh L1 + L2 accounts, fund L1 via `anvil_setBalance`,
 * bridge FeeJuice L1→L2, and deploy L2 accounts.
 */
export async function resolveScriptAccounts(
  nodeUrl: string,
  l1RpcUrl: string,
  wallet: EmbeddedWallet,
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

  const roles = ["operator", "user", "otherUser"];

  // Register accounts and bridge FeeJuice L1→L2 — sequentially.
  const preResults: PreClaimResult[] = [];
  for (let i = 0; i < roles.length; i++) {
    preResults.push(await preClaim(i, roles[i], wallet, portal));
  }

  // Mint additional L1 FeeJuice so the L1 account retains a balance.
  await portal.getTokenManager().mint(l1Account.address);
  pinoLogger.info(`minted L1 FeeJuice for ${l1Account.address}`);

  // Wait for L1→L2 messages, then deploy accounts with claimed FeeJuice.
  for (let i = 0; i < preResults.length; i++) {
    const r = preResults[i];
    await deployWithClaim(i, r.l2Address, r.accountManager, node, r.pendingClaim);
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
// Pre-claim: create account and bridge FeeJuice (per account)
// ---------------------------------------------------------------------------

type PendingClaim = {
  claim: L2AmountClaim;
  messageHash: Fr;
};

type PreClaimResult = {
  account: AccountData;
  accountManager: AccountManager;
  l2Address: AztecAddress;
  pendingClaim: PendingClaim;
};

async function preClaim(
  index: number,
  role: string,
  wallet: EmbeddedWallet,
  portal: L1FeeJuicePortalManager,
): Promise<PreClaimResult> {
  // 1. Derive and register account locally.
  const account = deriveAccount();
  const accountManager = await wallet.createSchnorrAccount(
    account.secret,
    account.salt,
    account.signingKey,
  );
  const l2Address = accountManager.address;
  pinoLogger.info(`registered L2 account ${role}=${l2Address.toString()}`);

  // 2. Bridge FeeJuice L1→L2 for this account.
  const l2Claim = await portal.bridgeTokensPublic(l2Address, undefined, true);
  const messageHash = Fr.fromHexString(l2Claim.messageHash as string);
  pinoLogger.info(`bridged FeeJuice L1→L2 for account[${index}]=${l2Address.toString()}`);

  return {
    account,
    accountManager,
    l2Address,
    pendingClaim: { claim: l2Claim, messageHash },
  };
}

// ---------------------------------------------------------------------------
// Deploy with claim: wait for L1→L2 message, then deploy account paying
// the fee with the claimed FeeJuice in a single transaction.
// ---------------------------------------------------------------------------

async function deployWithClaim(
  index: number,
  l2Address: AztecAddress,
  accountManager: AccountManager,
  node: ReturnType<typeof createAztecNodeClient>,
  pending: PendingClaim,
): Promise<void> {
  await waitForL1ToL2MessageReady(node, pending.messageHash, {
    timeoutSeconds: L1_TO_L2_MESSAGE_TIMEOUT_SECONDS,
    forPublicConsumption: false,
  });
  pinoLogger.info(`L1→L2 message ready for account[${index}]`);

  const feePayment = new FeeJuicePaymentMethodWithClaim(l2Address, pending.claim);
  const deployMethod = await accountManager.getDeployMethod();
  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: { paymentMethod: feePayment },
    skipClassPublication: true,
    skipInstancePublication: false,
  });
  pinoLogger.info(`deployed L2 account[${index}]=${l2Address.toString()}`);
}
