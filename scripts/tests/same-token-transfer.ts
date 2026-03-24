import { beforeAll, describe, it, setDefaultTimeout } from "bun:test";
import path from "node:path";

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall, type Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@aztec-fpc/sdk";
import { PrivateBalanceTracker, PublicBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import { setup } from "../common/setup-helpers.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SameTokenTransferConfig = {
  nodeUrl: string;
  attestationUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  operatorSecretKey: Fr;
  pxeProverEnabled: boolean;
  aaPaymentAmount: bigint;
  messageTimeoutSeconds: number;
};

type SetupResult = {
  node: AztecNode;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  fpcClient: FpcClient;
  tokenAddress: AztecAddress;
  token: Contract;
  faucet: Contract;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
  userData: AccountData;
  user: AztecAddress;
  dripAmount: bigint;
};

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function readEnvPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Invalid integer env var ${name}: value cannot be empty`);
  }
  if (!POSITIVE_INTEGER_PATTERN.test(normalized)) {
    throw new Error(`Invalid integer env var ${name}=${value}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid integer env var ${name}=${value} (out of safe integer range)`);
  }
  return parsed;
}

function readEnvPositiveBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid env var ${name}: expected positive integer, got "${value}"`);
  }
  return BigInt(trimmed);
}

function getConfig(): SameTokenTransferConfig {
  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    attestationUrl: requireEnv("FPC_ATTESTATION_URL"),
    manifestPath: requireEnv("FPC_COLD_START_MANIFEST"),
    testTokenManifestPath: requireEnv("FPC_TEST_TOKEN_MANIFEST"),
    operatorSecretKey: Fr.fromHexString(requireEnv("FPC_OPERATOR_SECRET_KEY")),
    pxeProverEnabled:
      process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false",
    aaPaymentAmount: readEnvPositiveBigInt("FPC_COLD_START_AA_PAYMENT_AMOUNT", 1_000_000_000n),
    messageTimeoutSeconds: readEnvPositiveInteger("FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS", 120),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setupFromConfig(config: SameTokenTransferConfig): Promise<SetupResult> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  const { node, wallet, operator, contracts, sponsoredFpcAddress } = await setup(
    {
      nodeUrl: config.nodeUrl,
      manifestPath: config.manifestPath,
      testTokenManifestPath: config.testTokenManifestPath,
      proverEnabled: config.pxeProverEnabled,
      messageTimeoutSeconds: config.messageTimeoutSeconds,
    },
    repoRoot,
    "same-token-transfer",
  );

  const { token, fpc, faucet } = contracts;

  const fpcClient = new FpcClient({
    fpcAddress: fpc.address,
    operator,
    node,
    attestationBaseUrl: config.attestationUrl,
  });

  const userData = await deriveAccount(Fr.random(), wallet);
  const user = userData.address;

  const { result: faucetConfig } = await faucet.methods.get_config().simulate({ from: user });
  const dripAmount = BigInt(faucetConfig.drip_amount.toString());

  return {
    node,
    wallet,
    operator,
    fpcClient,
    tokenAddress: token.address,
    token,
    faucet,
    sponsoredFeePayment: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
    userData,
    user,
    dripAmount,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const E2E_TIMEOUT_MS = 600_000;
setDefaultTimeout(E2E_TIMEOUT_MS);

let config: SameTokenTransferConfig;
let s: SetupResult;

let userPrivBal: PrivateBalanceTracker;
let userPubBal: PublicBalanceTracker;
let operatorPrivBal: PrivateBalanceTracker;
let recipientPrivBal: PrivateBalanceTracker;
let recipientPubBal: PublicBalanceTracker;
let recipient: AztecAddress;

describe("same-token-transfer", () => {
  beforeAll(async () => {
    config = getConfig();
    s = await setupFromConfig(config);
  });

  it("deploys user account via SponsoredFPC", async () => {
    const deployMethod = await s.userData.accountManager.getDeployMethod();
    await deployMethod.send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod: s.sponsoredFeePayment },
      skipClassPublication: true,
    });
  });

  it("faucet drip + shield half of tokens", async () => {
    const shieldAmount = s.dripAmount / 2n;

    const batch = new BatchCall(s.wallet, [
      s.faucet.methods.drip(s.user),
      s.token.methods.transfer_public_to_private(s.user, s.user, shieldAmount, Fr.random()),
    ]);
    await batch.send({
      from: s.user,
      fee: { paymentMethod: s.sponsoredFeePayment },
    });

    const { result: operatorStartBalanceRaw } = await s.token.methods
      .balance_of_private(s.operator)
      .simulate({ from: s.operator });
    const operatorStartBalance = BigInt(operatorStartBalanceRaw.toString());

    userPrivBal = await PrivateBalanceTracker.create(s.token, s.wallet, s.userData.secret, "User");
    await userPrivBal.change(shieldAmount);

    userPubBal = new PublicBalanceTracker(s.token, s.user, "User");
    await userPubBal.change(s.dripAmount - shieldAmount);

    operatorPrivBal = await PrivateBalanceTracker.create(
      s.token,
      s.wallet,
      config.operatorSecretKey,
      "Operator",
      operatorStartBalance,
      "atLeast",
    );

    recipientPrivBal = await PrivateBalanceTracker.create(
      s.token,
      s.wallet,
      Fr.random(),
      "Recipient",
    );
    recipient = recipientPrivBal.address;
    recipientPubBal = new PublicBalanceTracker(s.token, recipient, "Recipient");
  });

  it("transfers private tokens via FPC fee_entrypoint", async () => {
    const privTransferAmount = config.aaPaymentAmount;

    const transferCall = s.token.methods.transfer_private_to_private(
      s.user,
      recipient,
      privTransferAmount,
      Fr.random(),
    );
    const transferSim = await transferCall.simulate({
      from: s.user,
      fee: { estimateGas: true },
    });
    const transferFpc = await s.fpcClient.createPaymentMethod({
      wallet: s.wallet,
      user: s.user,
      tokenAddress: s.tokenAddress,
      estimatedGas: transferSim.estimatedGas,
    });
    const transferFeePayment = BigInt(transferFpc.quote.aa_payment_amount);

    await transferCall.send({
      from: s.user,
      fee: transferFpc.fee,
    });

    await recipientPrivBal.change(privTransferAmount);
    await userPrivBal.change(-privTransferAmount - transferFeePayment);
    await operatorPrivBal.change(transferFeePayment);
  });

  it("transfers public tokens via FPC fee_entrypoint", async () => {
    const pubTransferAmount = config.aaPaymentAmount;

    const publicTransferCall = s.token.methods.transfer_public_to_public(
      s.user,
      recipient,
      pubTransferAmount,
      Fr.random(),
    );
    const publicTransferSim = await publicTransferCall.simulate({
      from: s.user,
      fee: { estimateGas: true },
    });
    const publicTransferFpc = await s.fpcClient.createPaymentMethod({
      wallet: s.wallet,
      user: s.user,
      tokenAddress: s.tokenAddress,
      estimatedGas: publicTransferSim.estimatedGas,
    });
    const publicTransferFeePayment = BigInt(publicTransferFpc.quote.aa_payment_amount);

    await publicTransferCall.send({
      from: s.user,
      fee: publicTransferFpc.fee,
    });

    await recipientPubBal.change(pubTransferAmount);
    await userPubBal.change(-pubTransferAmount);
    await userPrivBal.change(-publicTransferFeePayment);
    await operatorPrivBal.change(publicTransferFeePayment);
  });

  it("batch public_to_private + private_to_public via FPC fee_entrypoint", async () => {
    const batchTransferAmount = config.aaPaymentAmount;

    const pubToPrivCall = s.token.methods.transfer_public_to_private(
      s.user,
      recipient,
      batchTransferAmount,
      Fr.random(),
    );
    const privToPubCall = s.token.methods.transfer_private_to_public(
      s.user,
      recipient,
      batchTransferAmount,
      Fr.random(),
    );

    const { estimatedGas: pubToPrivGas } = await pubToPrivCall.simulate({
      from: s.user,
      fee: { estimateGas: true },
    });
    const { estimatedGas: privToPubGas } = await privToPubCall.simulate({
      from: s.user,
      fee: { estimateGas: true },
    });

    if (!pubToPrivGas || !privToPubGas) {
      throw new Error("Gas estimation failed for batch transfer calls");
    }

    const batchEstimatedGas = {
      gasLimits: pubToPrivGas.gasLimits.add(privToPubGas.gasLimits),
      teardownGasLimits: pubToPrivGas.teardownGasLimits.add(privToPubGas.teardownGasLimits),
    };
    const batchTransferFpc = await s.fpcClient.createPaymentMethod({
      wallet: s.wallet,
      user: s.user,
      tokenAddress: s.tokenAddress,
      estimatedGas: batchEstimatedGas,
    });
    const batchTransferFeePayment = BigInt(batchTransferFpc.quote.aa_payment_amount);

    const batchTransferCall = new BatchCall(s.wallet, [pubToPrivCall, privToPubCall]);
    await batchTransferCall.send({
      from: s.user,
      fee: batchTransferFpc.fee,
    });

    await recipientPrivBal.change(batchTransferAmount);
    await recipientPubBal.change(batchTransferAmount);
    await userPubBal.change(-batchTransferAmount);
    await userPrivBal.change(-batchTransferAmount - batchTransferFeePayment);
    await operatorPrivBal.change(batchTransferFeePayment);
  });
});
