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
import { BatchCall } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { TxExecutionResult } from "@aztec/aztec.js/tx";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import pino from "pino";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

const LOG_PREFIX = "[always-revert]";

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testAlwaysRevert(ctx: TestContext): Promise<void> {
  const {
    args,
    node,
    operator,
    fpcClient,
    fpcAddress,
    tokenAddress,
    token,
    faucet,
    counter,
    sponsoredFeePayment,
  } = ctx;

  const { iterations } = args;

  // 0. Create a fresh user for this test
  const userData: AccountData = await deriveAccount(Fr.random(), ctx.wallet);
  const user = userData.address;
  pinoLogger.info(`${LOG_PREFIX} user=${user.toString()}`);

  // Query faucet config to get drip amount
  const { result: faucetConfig } = await faucet.methods.get_config().simulate({ from: user });
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
  const { result: operatorStartBalanceRaw } = await token.methods
    .balance_of_private(operator)
    .simulate({ from: operator });
  const operatorStartBalance = BigInt(operatorStartBalanceRaw.toString());

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

  const fjStart = await getFeeJuiceBalance(fpcAddress, node);
  pinoLogger.info(`${LOG_PREFIX} FPC FeeJuice balance before iterations=${fjStart}`);

  // Simulate increment as a gas proxy (always_revert would revert during simulation)
  const gasProxySim = await counter.methods.increment(user).simulate({
    from: user,
    fee: { estimateGas: true },
  });

  for (let i = 0; i < iterations; i += 1) {
    pinoLogger.info(`${LOG_PREFIX} iteration ${i + 1}/${iterations}`);

    // Record FPC FeeJuice balance before this iteration
    const fjBefore = await getFeeJuiceBalance(fpcAddress, node);

    // Build FPC payment
    const fpcResult = await fpcClient.createPaymentMethod({
      wallet: ctx.wallet,
      user,
      tokenAddress,
      estimatedGas: gasProxySim.estimatedGas,
    });
    const aaPaymentAmount = BigInt(fpcResult.quote.aa_payment_amount);

    // Send always_revert with dontThrowOnRevert so we get the receipt back
    const { receipt } = await counter.methods.always_revert().send({
      from: user,
      fee: fpcResult.fee,
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
