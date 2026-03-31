import path from "node:path";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall, type Contract } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { TxExecutionResult } from "@aztec/aztec.js/tx";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Gas } from "@aztec/stdlib/gas";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";
import { beforeAll, describe, expect, it } from "#test";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import { setup as commonSetup } from "../common/setup-helpers.ts";

type AlwaysRevertConfig = {
  nodeUrl: string;
  attestationUrl: string;
  manifestPath: string;
  testTokenManifestPath: string;
  operatorSecretKey: Fr;
  proverEnabled: boolean;
  messageTimeoutSeconds: number;
  iterations: number;
};

type SetupResult = {
  node: AztecNode;
  wallet: EmbeddedWallet;
  operator: AztecAddress;
  fpcClient: FpcClient;
  fpcAddress: AztecAddress;
  tokenAddress: AztecAddress;
  token: Contract;
  faucet: Contract;
  counter: Contract;
  sponsoredFeePayment: SponsoredFeePaymentMethod;
  user: AztecAddress;
  userData: AccountData;
  dripAmount: bigint;
};

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value.trim();
}

function getConfig(): AlwaysRevertConfig {
  return {
    nodeUrl: process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
    attestationUrl: requireEnv("FPC_ATTESTATION_URL"),
    manifestPath: requireEnv("FPC_COLD_START_MANIFEST"),
    testTokenManifestPath: requireEnv("FPC_TEST_TOKEN_MANIFEST"),
    operatorSecretKey: Fr.fromHexString(requireEnv("FPC_OPERATOR_SECRET_KEY")),
    proverEnabled:
      process.env.PXE_PROVER_ENABLED !== "0" && process.env.PXE_PROVER_ENABLED !== "false",
    messageTimeoutSeconds: readEnvPositiveInteger("FPC_SMOKE_MESSAGE_TIMEOUT_SECONDS", 120),
    iterations: readEnvPositiveInteger("FPC_SMOKE_ITERATIONS", 3),
  };
}

async function setupFromManifest(config: AlwaysRevertConfig): Promise<SetupResult> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  const { node, wallet, operator, contracts, sponsoredFpcAddress } = await commonSetup(
    {
      nodeUrl: config.nodeUrl,
      manifestPath: config.manifestPath,
      testTokenManifestPath: config.testTokenManifestPath,
      proverEnabled: config.proverEnabled,
      messageTimeoutSeconds: config.messageTimeoutSeconds,
    },
    repoRoot,
    "always-revert",
  );

  const { token, fpc, counter, faucet } = contracts;

  const fpcClient = new FpcClient({
    fpcAddress: fpc.address,
    operator,
    node,
    attestationBaseUrl: config.attestationUrl,
  });

  const sponsoredFeePayment = new SponsoredFeePaymentMethod(sponsoredFpcAddress);

  // Derive fresh user for this test run.
  const userData = await deriveAccount(Fr.random(), wallet);
  const user = userData.address;

  // Query faucet config for drip amount.
  const { result: faucetConfig } = await faucet.methods.get_config().simulate({ from: user });
  const dripAmount = BigInt(faucetConfig.drip_amount.toString());

  return {
    node,
    wallet,
    operator,
    fpcClient,
    fpcAddress: fpc.address,
    tokenAddress: token.address,
    token,
    faucet,
    counter,
    sponsoredFeePayment,
    user,
    userData,
    dripAmount,
  };
}

let config: AlwaysRevertConfig;
let ctx: SetupResult;

describe("always-revert smoke", () => {
  beforeAll(async () => {
    config = getConfig();
    ctx = await setupFromManifest(config);
  });

  it("deploys user account via SponsoredFPC", async () => {
    const deployMethod = await ctx.userData.accountManager.getDeployMethod();
    await deployMethod.send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod: ctx.sponsoredFeePayment },
      skipClassPublication: true,
    });
  });

  it("funds user via faucet drip and shield", async () => {
    const batch = new BatchCall(ctx.wallet, [
      ctx.faucet.methods.drip(ctx.user),
      ctx.token.methods.transfer_public_to_private(ctx.user, ctx.user, ctx.dripAmount, Fr.random()),
    ]);
    await batch.send({
      from: ctx.user,
      fee: { paymentMethod: ctx.sponsoredFeePayment },
    });

    const userBal = await PrivateBalanceTracker.create(
      ctx.token,
      ctx.wallet,
      ctx.userData.secret,
      "User",
    );
    await userBal.change(ctx.dripAmount);
  });

  it("collects fees when app logic reverts", async () => {
    const { iterations } = config;
    const { result: operatorStartBalanceRaw } = await ctx.token.methods
      .balance_of_private(ctx.operator)
      .simulate({ from: ctx.operator });
    const operatorStartBalance = BigInt(operatorStartBalanceRaw.toString());

    const userBal = await PrivateBalanceTracker.create(
      ctx.token,
      ctx.wallet,
      ctx.userData.secret,
      "User",
      ctx.dripAmount,
    );
    const operatorBal = await PrivateBalanceTracker.create(
      ctx.token,
      ctx.wallet,
      config.operatorSecretKey,
      "Operator",
      operatorStartBalance,
      "atLeast",
    );

    // Must match COLD_START_GAS_LIMITS in sdk/src/payment-method.ts.
    // See profiling/benchmarks/cold_start.benchmark.json for measured values.
    const gasSettings = {
      gasLimits: new Gas(5_000, 1_000_000),
      teardownGasLimits: new Gas(0, 0),
    };

    for (let i = 0; i < iterations; i += 1) {
      const fjBefore = await getFeeJuiceBalance(ctx.fpcAddress, ctx.node);

      const fpcResult = await ctx.fpcClient.createPaymentMethod({
        wallet: ctx.wallet,
        user: ctx.user,
        tokenAddress: ctx.tokenAddress,
        estimatedGas: gasSettings,
      });
      const aaPaymentAmount = BigInt(fpcResult.quote.aa_payment_amount);

      const { receipt } = await ctx.counter.methods.always_revert().send({
        from: ctx.user,
        fee: fpcResult.fee,
        wait: { dontThrowOnRevert: true },
      });

      expect(receipt.isMined()).toBe(true);
      expect(receipt.executionResult).toBe(TxExecutionResult.APP_LOGIC_REVERTED);

      const fjAfter = await getFeeJuiceBalance(ctx.fpcAddress, ctx.node);
      expect(fjAfter).toBeLessThan(fjBefore);

      await operatorBal.change(aaPaymentAmount);
      await userBal.change(-aaPaymentAmount);
    }
  });
});
