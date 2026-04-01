/**
 * Cold-start entrypoint E2E smoke test.
 *
 * Exercises the full cold_start_entrypoint flow: a user claims bridged tokens
 * and pays gas in a single transaction without going through an account
 * entrypoint (msg_sender = None).
 *
 * All configuration is read from environment variables.
 */

import path from "node:path";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";
import type { Hex } from "viem";
import { beforeAll, describe, expect, it } from "#test";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import {
  type AccountData,
  deriveAccount,
  resolveScriptAccounts,
} from "../common/script-credentials.ts";
import {
  setup as commonSetup,
  type L1Infra,
  mintL1Erc20WithRetry,
  setupL1Infrastructure,
} from "../common/setup-helpers.ts";

const HEX_32_BYTE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

type ColdStartConfig = {
  nodeUrl: string;
  l1RpcUrl: string;
  attestationUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  operatorSecretKey: Fr;
  l1DeployerKey: string;
  userL1PrivateKey: string | null;
  claimAmount: bigint;
  aaPaymentAmount: bigint;
  proverEnabled: boolean;
  messageTimeoutSeconds: number;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function readEnvPositiveBigInt(name: string, fallback: string): bigint {
  const raw = process.env[name] ?? fallback;
  const trimmed = raw.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${name}: expected positive integer, got "${raw}"`);
  }
  return BigInt(trimmed);
}

function readEnvNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!DECIMAL_UINT_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${name}: expected non-negative integer, got "${raw}"`);
  }
  return Number(trimmed);
}

function getConfig(): ColdStartConfig {
  const operatorSecretKey = Fr.fromHexString(requireEnv("FPC_OPERATOR_SECRET_KEY"));

  const l1DeployerKey = requireEnv("FPC_L1_DEPLOYER_KEY");
  if (!HEX_32_BYTE_PATTERN.test(l1DeployerKey)) {
    throw new Error("FPC_L1_DEPLOYER_KEY must be a 32-byte 0x-prefixed hex value");
  }

  const userL1PrivateKey = process.env.FPC_L1_USER_KEY?.trim() ?? null;
  if (userL1PrivateKey && !HEX_32_BYTE_PATTERN.test(userL1PrivateKey)) {
    throw new Error("FPC_L1_USER_KEY must be a 32-byte 0x-prefixed hex value");
  }

  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    l1RpcUrl: requireEnv("L1_RPC_URL"),
    attestationUrl: requireEnv("FPC_ATTESTATION_URL"),
    manifestPath: path.resolve(requireEnv("FPC_COLD_START_MANIFEST")),
    testTokenManifestPath: path.resolve(requireEnv("FPC_TEST_TOKEN_MANIFEST")),
    operatorSecretKey,
    l1DeployerKey,
    userL1PrivateKey,
    claimAmount: readEnvPositiveBigInt("FPC_COLD_START_CLAIM_AMOUNT", "10000000000000000"),
    aaPaymentAmount: readEnvPositiveBigInt("FPC_COLD_START_AA_PAYMENT_AMOUNT", "1000000000"),
    proverEnabled:
      process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false",
    messageTimeoutSeconds: readEnvNonNegativeInt("FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS", 120),
  };
}

// Shared test state
let config: ColdStartConfig;
let node: AztecNode;
let wallet: EmbeddedWallet;
let operator: AztecAddress;
let token: Contract;
let counter: Contract;
let fpcAddress: AztecAddress;
let tokenAddress: AztecAddress;
let bridgeAddress: AztecAddress;
let sponsoredFpcAddress: AztecAddress;
let l1Infra: L1Infra;
let fpcClient: FpcClient;

// Happy-path shared state (set during cold-start phase, carried across phases)
let userData: AccountData;
let user: AztecAddress;
let userBalance: PrivateBalanceTracker;
let operatorBalance: PrivateBalanceTracker;

// Tests
describe("cold-start smoke", () => {
  beforeAll(async () => {
    config = getConfig();
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    const {
      testTokenManifest,
      node: n,
      wallet: w,
      operator: op,
      contracts,
      sponsoredFpcAddress: sfpc,
    } = await commonSetup(
      {
        nodeUrl: config.nodeUrl,
        manifestPath: config.manifestPath,
        testTokenManifestPath: config.testTokenManifestPath,
        proverEnabled: config.proverEnabled,
        messageTimeoutSeconds: config.messageTimeoutSeconds,
      },
      repoRoot,
      "cold-start-smoke",
    );

    node = n;
    wallet = w;
    operator = op;
    sponsoredFpcAddress = sfpc;

    const { token: t, fpc, counter: c, bridge } = contracts;

    token = t;
    counter = c;
    fpcAddress = fpc.address;
    tokenAddress = t.address;
    bridgeAddress = bridge.address;

    // Resolve L1 private key
    let l1PrivateKey: Hex;
    if (config.userL1PrivateKey) {
      l1PrivateKey = config.userL1PrivateKey as Hex;
    } else {
      ({ l1PrivateKey } = await resolveScriptAccounts(config.nodeUrl, config.l1RpcUrl, wallet, 0));
    }

    l1Infra = await setupL1Infrastructure({
      l1RpcUrl: config.l1RpcUrl,
      l1PrivateKey,
      l1DeployerKey: config.l1DeployerKey,
      l1PortalAddress: testTokenManifest.l1_contracts.token_portal,
      l1Erc20Address: testTokenManifest.l1_contracts.erc20,
      node,
      loggerName: "cold-start:bridge",
    });

    fpcClient = new FpcClient({
      fpcAddress,
      operator,
      node,
      attestationBaseUrl: config.attestationUrl,
    });

    // Derive a fresh user for the happy-path sequence
    userData = await deriveAccount(Fr.random(), wallet);
    user = userData.address;

    userBalance = await PrivateBalanceTracker.create(token, wallet, userData.secret, "User");
    operatorBalance = await PrivateBalanceTracker.create(
      token,
      wallet,
      config.operatorSecretKey,
      "Operator",
      0n,
      "atLeast",
    );
  });

  // =========================================================================
  // Phase 1: Cold-start — claim bridged tokens + pay FPC fee in one tx
  // =========================================================================

  it("claims bridged tokens via cold-start", async () => {
    const { l1WalletClient, l1Erc20, portalManager } = l1Infra;

    // Bridge tokens L1->L2 for the user (private)
    const l1Account = l1WalletClient.account;
    await mintL1Erc20WithRetry(l1Erc20, l1WalletClient, l1Account.address, config.claimAmount);

    const bridgeClaim = await portalManager.bridgeTokensPrivate(user, config.claimAmount, false);
    const bridgeMsgHash = Fr.fromHexString(bridgeClaim.messageHash as string);
    await waitForL1ToL2MessageReady(node, bridgeMsgHash, {
      timeoutSeconds: config.messageTimeoutSeconds,
    });

    // Execute cold-start via SDK (retries "Message not in state" internally)
    const coldStartResult = await fpcClient.executeColdStart({
      wallet,
      userAddress: user,
      tokenAddress,
      bridgeAddress,
      bridgeClaim,
    });

    // Verify balances after cold-start
    await userBalance.change(config.claimAmount - coldStartResult.aaPaymentAmount);
    await operatorBalance.change(coldStartResult.aaPaymentAmount);
  });

  // =========================================================================
  // Phase 2: Deploy user account contract via FPC fee_entrypoint
  // =========================================================================

  it("deploys user account via FPC", async () => {
    const deployMethod = await userData.accountManager.getDeployMethod();
    const { estimatedGas } = await deployMethod.simulate({
      from: AztecAddress.ZERO,
      fee: { estimateGas: true },
      skipClassPublication: true,
    });

    if (!estimatedGas) {
      throw new Error("Failed to estimate gas for deploy method");
    }

    const paymentMethod = await fpcClient.createPaymentMethod({
      wallet,
      user,
      tokenAddress,
      estimatedGas,
    });

    await deployMethod.send({
      from: AztecAddress.ZERO,
      fee: paymentMethod.fee,
      skipClassPublication: true,
    });

    const deployPayment = BigInt(paymentMethod.quote.aa_payment_amount);
    await userBalance.change(-deployPayment);
    await operatorBalance.change(deployPayment);
  });

  // =========================================================================
  // Phase 3: Increment counter via FPC fee_entrypoint
  // =========================================================================

  it("increments counter via FPC", async () => {
    const counterBefore = BigInt(
      (await counter.methods.get_counter(user).simulate({ from: user })).result.toString(),
    );

    const incrementMethod = counter.methods.increment(user);
    const { estimatedGas } = await incrementMethod.simulate({
      from: user,
      fee: { estimateGas: true },
    });

    if (!estimatedGas) {
      throw new Error("Failed to estimate gas for increment method");
    }

    const paymentMethod = await fpcClient.createPaymentMethod({
      wallet,
      user,
      tokenAddress,
      estimatedGas,
    });

    await incrementMethod.send({
      from: user,
      fee: paymentMethod.fee,
    });

    const counterAfter = BigInt(
      (await counter.methods.get_counter(user).simulate({ from: user })).result.toString(),
    );
    expect(counterAfter).toBe(counterBefore + 1n);

    const incrementPayment = BigInt(paymentMethod.quote.aa_payment_amount);
    await operatorBalance.change(incrementPayment);
    await userBalance.change(-incrementPayment);
  });

  // =========================================================================
  // Phase 4: Transfer tokens to a fresh recipient via sponsored FPC
  // =========================================================================

  it("transfers tokens via sponsored FPC", async () => {
    const sponsoredTransferAmount = config.aaPaymentAmount;
    const recipientBalance = await PrivateBalanceTracker.create(
      token,
      wallet,
      Fr.random(),
      "Sponsored recipient",
    );
    const recipient = recipientBalance.address;

    await token.methods
      .transfer_private_to_private(user, recipient, sponsoredTransferAmount, 0)
      .send({
        from: user,
        fee: {
          paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
        },
      });

    // Sponsored FPC pays gas — user only debited the transfer amount itself
    await operatorBalance.change(0n);
    await userBalance.change(-sponsoredTransferAmount);
    await recipientBalance.change(sponsoredTransferAmount);
  });

  // =========================================================================
  // Phase 5: Transfer tokens to a fresh recipient via FPC fee_entrypoint
  // =========================================================================

  it("transfers tokens via FPC fee_entrypoint", async () => {
    const transferAmount = config.aaPaymentAmount;
    const recipientBalance = await PrivateBalanceTracker.create(
      token,
      wallet,
      Fr.random(),
      "Recipient",
    );
    const recipient = recipientBalance.address;

    const transferMethod = token.methods.transfer_private_to_private(
      user,
      recipient,
      transferAmount,
      0,
    );
    const { estimatedGas } = await transferMethod.simulate({
      from: user,
      fee: { estimateGas: true },
    });

    if (!estimatedGas) {
      throw new Error("Failed to estimate gas for transfer method");
    }

    const paymentMethod = await fpcClient.createPaymentMethod({
      wallet,
      user,
      tokenAddress,
      estimatedGas,
    });
    const feePayment = BigInt(paymentMethod.quote.aa_payment_amount);

    await transferMethod.send({
      from: user,
      fee: paymentMethod.fee,
    });

    await operatorBalance.change(feePayment);
    await userBalance.change(-(feePayment + transferAmount));
    await recipientBalance.change(transferAmount);
  });

  // =========================================================================
  // Negative: claim amount less than fee → rejected by attestation server
  // =========================================================================

  it("rejects insufficient claim amount", async () => {
    const { l1WalletClient, l1Erc20, portalManager } = l1Infra;

    // Fresh user for this negative test
    const negUser = (await deriveAccount(Fr.random(), wallet)).address;

    const tinyClaimAmount = config.aaPaymentAmount - 1n;

    // Mint tiny amount and bridge L1→L2
    const l1Account = l1WalletClient.account;
    await mintL1Erc20WithRetry(l1Erc20, l1WalletClient, l1Account.address, tinyClaimAmount);

    const tinyClaim = await portalManager.bridgeTokensPrivate(negUser, tinyClaimAmount, false);
    const tinyMsgHash = Fr.fromHexString(tinyClaim.messageHash as string);
    await waitForL1ToL2MessageReady(node, tinyMsgHash, {
      timeoutSeconds: config.messageTimeoutSeconds,
    });

    // Attempt cold-start — should fail at quote stage
    await expect(
      fpcClient.executeColdStart({
        wallet,
        userAddress: negUser,
        tokenAddress,
        bridgeAddress,
        bridgeClaim: tinyClaim,
      }),
    ).rejects.toThrow(/claim_amount must be >= aa_payment_amount|claim insufficient to cover fee/);
  });
});
