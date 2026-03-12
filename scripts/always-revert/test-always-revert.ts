/**
 * Always-revert test: faucet drip -> shield -> always_revert via FPC fee_entrypoint.
 *
 * Exercises the FPC fee payment mechanism when app logic reverts:
 * 1. Deploy user account via SponsoredFPC
 * 2. Faucet drip + shield tokens (batched in one tx via SponsoredFPC)
 * 3. Loop N iterations of always_revert() calls via FPC, asserting:
 *    - The tx is mined (included in a block) despite app logic reverting
 *    - The FPC's FeeJuice balance decreases (fee was paid)
 *    - The operator's token balance increases (AA payment collected)
 *    - The user's token balance decreases (AA payment deducted)
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall, type Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { TxExecutionResult } from "@aztec/aztec.js/tx";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

const LOG_PREFIX = "[always-revert]";

// ---------------------------------------------------------------------------
// Local helper: fetch quote from attestation server
// ---------------------------------------------------------------------------

type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

async function fetchQuote(
  attestationUrl: string,
  user: AztecAddress,
  acceptedAsset: AztecAddress,
  fjAmount: bigint,
): Promise<QuoteResponse> {
  const quoteUrl = new URL(attestationUrl);
  const normalizedPath = quoteUrl.pathname.replace(/\/+$/u, "");
  quoteUrl.pathname = normalizedPath.endsWith("/quote")
    ? normalizedPath
    : `${normalizedPath}/quote`;
  quoteUrl.searchParams.set("user", user.toString());
  quoteUrl.searchParams.set("accepted_asset", acceptedAsset.toString());
  quoteUrl.searchParams.set("fj_amount", fjAmount.toString());

  const response = await fetch(quoteUrl.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Quote request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as QuoteResponse;
}

function decodeSignatureHex(signatureHex: string): number[] {
  const normalized = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  return Array.from(Buffer.from(normalized, "hex"));
}

// ---------------------------------------------------------------------------
// Local helper: build FPC fee_entrypoint payment method + authwit
// ---------------------------------------------------------------------------

async function buildFpcPaymentMethod(opts: {
  attestationUrl: string;
  wallet: EmbeddedWallet;
  user: AztecAddress;
  operator: AztecAddress;
  fpc: Contract;
  fpcAddress: AztecAddress;
  token: Contract;
  tokenAddress: AztecAddress;
  fjFeeAmount: bigint;
  feePerDaGas: bigint;
  feePerL2Gas: bigint;
  daGasLimit: number;
  l2GasLimit: number;
}) {
  // 1. Fetch quote from attestation server
  const quote = await fetchQuote(
    opts.attestationUrl,
    opts.user,
    opts.tokenAddress,
    opts.fjFeeAmount,
  );
  const aaPaymentAmount = BigInt(quote.aa_payment_amount);
  const validUntil = BigInt(quote.valid_until);
  const signatureBytes = decodeSignatureHex(quote.signature);

  // 2. Build transfer authwit: token.transfer_private_to_private(user, operator, aaPaymentAmount, nonce)
  const nonce = Fr.random();

  const transferCall = await opts.token.methods
    .transfer_private_to_private(opts.user, opts.operator, aaPaymentAmount, nonce)
    .getFunctionCall();

  // 3. Create authwit for FPC to call the transfer on user's behalf
  const transferAuthwit: AuthWitness = await opts.wallet.createAuthWit(opts.user, {
    caller: opts.fpcAddress,
    call: transferCall,
  });

  // 4. Build fee_entrypoint call
  const feeEntrypointCall = await opts.fpc.methods
    .fee_entrypoint(
      opts.tokenAddress,
      nonce,
      opts.fjFeeAmount,
      aaPaymentAmount,
      validUntil,
      signatureBytes,
    )
    .getFunctionCall();

  // 5. Build payment method and gas settings
  const paymentMethod = {
    getAsset: async () => ProtocolContractAddress.FeeJuice,
    getExecutionPayload: async () =>
      new ExecutionPayload([feeEntrypointCall], [transferAuthwit], [], [], opts.fpcAddress),
    getFeePayer: async () => opts.fpcAddress,
    getGasSettings: () => undefined,
  };

  const gasSettings = {
    gasLimits: new Gas(opts.daGasLimit, opts.l2GasLimit),
    teardownGasLimits: new Gas(0, 0),
    maxFeesPerGas: new GasFees(opts.feePerDaGas, opts.feePerL2Gas),
  };

  return { paymentMethod, gasSettings, aaPaymentAmount };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testAlwaysRevert(ctx: TestContext): Promise<void> {
  const {
    args,
    node,
    operator,
    attestationUrl,
    fpc,
    token,
    faucet,
    counter,
    fpcAddress,
    tokenAddress,
    sponsoredFeePayment,
    feePerDaGas,
    feePerL2Gas,
    fjFeeAmount,
  } = ctx;

  const { iterations } = args;

  // 0. Create a fresh user for this test
  const userData: AccountData = await deriveAccount(Fr.random(), ctx.wallet);
  const user = userData.address;
  pinoLogger.info(`${LOG_PREFIX} user=${user.toString()}`);

  // Query faucet config to get drip amount
  const faucetConfig = await faucet.methods.get_config().simulate({ from: user });
  const dripAmount = BigInt(faucetConfig.drip_amount.toString());
  pinoLogger.info(`${LOG_PREFIX} faucet drip_amount=${dripAmount}`);

  // =========================================================================
  // Phase 1: Deploy user account via SponsoredFPC
  // =========================================================================

  const deployMethod = await userData.accountManager.getDeployMethod();
  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: {
      paymentMethod: sponsoredFeePayment,
    },
    skipClassPublication: true,
  });

  pinoLogger.info(`${LOG_PREFIX} PASS: user account deployed via SponsoredFPC`);

  // =========================================================================
  // Phase 2: Faucet drip + shield tokens (batched in one tx via SponsoredFPC)
  // =========================================================================

  const shieldAmount = dripAmount;
  pinoLogger.info(`${LOG_PREFIX} batching faucet drip + shield (${shieldAmount} tokens)`);

  const batch = new BatchCall(ctx.wallet, [
    faucet.methods.drip(user),
    token.methods.transfer_public_to_private(user, user, shieldAmount, Fr.random()),
  ]);
  await batch.send({
    from: user,
    fee: {
      paymentMethod: sponsoredFeePayment,
    },
  });

  // Initialize balance trackers
  const operatorStartBalance = BigInt(
    (await token.methods.balance_of_private(operator).simulate({ from: operator })).toString(),
  );

  // Assert: drip landed in public, then shield moved it all to private
  const userBal = new PrivateBalanceTracker(token, user, "User", 0n);
  await userBal.change(shieldAmount);

  pinoLogger.info(`${LOG_PREFIX} PASS: faucet drip + shield succeeded`);

  // =========================================================================
  // Phase 3: always_revert iterations via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info(`${LOG_PREFIX} starting ${iterations} always_revert iteration(s)`);

  const operatorBal = new PrivateBalanceTracker(
    token,
    operator,
    "Operator",
    operatorStartBalance,
    "atLeast",
  );

  const fpcPaymentOpts = {
    attestationUrl,
    wallet: ctx.wallet,
    user,
    operator,
    fpc,
    fpcAddress,
    token,
    tokenAddress,
    fjFeeAmount,
    feePerDaGas,
    feePerL2Gas,
    daGasLimit: args.daGasLimit,
    l2GasLimit: args.l2GasLimit,
  };

  const fjStart = await getFeeJuiceBalance(fpcAddress, node);
  pinoLogger.info(`${LOG_PREFIX} FPC FeeJuice balance before iterations=${fjStart}`);

  for (let i = 0; i < iterations; i += 1) {
    pinoLogger.info(`${LOG_PREFIX} iteration ${i + 1}/${iterations}`);

    // Record FPC FeeJuice balance before this iteration
    const fjBefore = await getFeeJuiceBalance(fpcAddress, node);

    // Build FPC payment
    const { aaPaymentAmount, ...fee } = await buildFpcPaymentMethod(fpcPaymentOpts);

    // Send always_revert with dontThrowOnRevert so we get the receipt back
    const receipt = await counter.methods.always_revert().send({
      from: user,
      fee,
      wait: { dontThrowOnRevert: true },
    });

    // Assert: tx was mined (included in a block)
    if (!receipt.isMined()) {
      throw new Error(`Iteration ${i + 1}: tx was not mined (status=${receipt.status})`);
    }
    pinoLogger.info(`${LOG_PREFIX} iteration ${i + 1}: tx mined (status=${receipt.status})`);

    // Assert: app logic reverted
    if (receipt.executionResult !== TxExecutionResult.APP_LOGIC_REVERTED) {
      throw new Error(
        `Iteration ${i + 1}: expected APP_LOGIC_REVERTED, got ${receipt.executionResult}`,
      );
    }
    pinoLogger.info(`${LOG_PREFIX} iteration ${i + 1}: executionResult=${receipt.executionResult}`);

    // Assert: FPC FeeJuice decreased (fee was paid from FPC's FeeJuice)
    const fjAfter = await getFeeJuiceBalance(fpcAddress, node);
    if (fjAfter >= fjBefore) {
      throw new Error(
        `Iteration ${i + 1}: FPC FeeJuice did not decrease (before=${fjBefore} after=${fjAfter})`,
      );
    }
    pinoLogger.info(
      `${LOG_PREFIX} iteration ${i + 1}: FPC FeeJuice ${fjBefore} -> ${fjAfter} (delta=${fjBefore - fjAfter})`,
    );

    // Assert: operator token balance increased by aaPaymentAmount
    await operatorBal.change(aaPaymentAmount);

    // Assert: user token balance decreased by aaPaymentAmount
    await userBal.change(-aaPaymentAmount);

    pinoLogger.info(`${LOG_PREFIX} PASS: iteration ${i + 1}/${iterations}`);
  }

  // Final summary
  const fjEnd = await getFeeJuiceBalance(fpcAddress, node);
  pinoLogger.info(
    `${LOG_PREFIX} all ${iterations} iteration(s) complete. FPC FeeJuice: ${fjStart} -> ${fjEnd} (total delta=${fjStart - fjEnd})`,
  );
}
