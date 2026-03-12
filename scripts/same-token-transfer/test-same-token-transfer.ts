/**
 * Same-token-transfer test: faucet drip -> shield -> counter -> sponsored transfer -> FPC transfer.
 *
 * Exercises the full lifecycle from zero to FPC usage without any L1 bridging:
 * 1. Deploy user account via SponsoredFPC
 * 2. Faucet drip + shield tokens (batched in one tx via SponsoredFPC)
 * 3. Increment counter via FPC fee_entrypoint
 * 4. Transfer tokens to a fresh recipient via SponsoredFPC
 * 5. Transfer tokens to a fresh recipient, fee paid by our FPC fee_entrypoint
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import pino from "pino";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

const LOG_PREFIX = "[same-token-transfer]";

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testSameTokenTransfer(ctx: TestContext): Promise<void> {
  const { args, operator, fpcClient, tokenAddress, token, faucet, counter, sponsoredFeePayment } =
    ctx;

  const { aaPaymentAmount } = args;

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
  // Phase 3: Increment counter via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info(`${LOG_PREFIX} incrementing counter via FPC`);

  const operatorBal = new PrivateBalanceTracker(
    token,
    operator,
    "Operator",
    operatorStartBalance,
    "atLeast",
  );

  const counterBefore = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );

  const counterFpc = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
  });
  const counterFeePayment = BigInt(counterFpc.quote.aa_payment_amount);

  await counter.methods.increment(user).send({
    from: user,
    fee: counterFpc.fee,
  });

  const counterAfter = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );

  if (counterAfter !== counterBefore + 1n) {
    throw new Error(`Counter mismatch: expected=${counterBefore + 1n} got=${counterAfter}`);
  }

  await userBal.change(-counterFeePayment);
  await operatorBal.change(counterFeePayment);

  pinoLogger.info(`${LOG_PREFIX} PASS: counter increment via FPC succeeded`);

  // =========================================================================
  // Phase 4: Transfer tokens to a fresh recipient via SponsoredFPC
  // =========================================================================

  const sponsoredRecipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const sponsoredTransferAmount = aaPaymentAmount;

  pinoLogger.info(
    `${LOG_PREFIX} transferring ${sponsoredTransferAmount} tokens to sponsored recipient via SponsoredFPC`,
  );

  await token.methods
    .transfer_private_to_private(user, sponsoredRecipient, sponsoredTransferAmount, 0)
    .send({
      from: user,
      fee: {
        paymentMethod: sponsoredFeePayment,
      },
    });

  const sponsoredRecipientBal = new PrivateBalanceTracker(
    token,
    sponsoredRecipient,
    "Sponsored recipient",
    0n,
  );
  await sponsoredRecipientBal.change(sponsoredTransferAmount);
  await userBal.change(-sponsoredTransferAmount);

  pinoLogger.info(`${LOG_PREFIX} PASS: sponsored transfer succeeded`);

  // =========================================================================
  // Phase 5: Transfer tokens to a fresh recipient via FPC fee_entrypoint
  // =========================================================================

  // TODO: Uncomment these lines when phase 5 test is ready.

  // pinoLogger.info(`${LOG_PREFIX} transferring tokens to recipient via FPC`);

  // const recipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  // const transferAmount = aaPaymentAmount;

  // const transferFpc = await fpcClient.createPaymentMethod({
  //   wallet: ctx.wallet,
  //   user,
  // });
  // const transferFeePayment = BigInt(transferFpc.quote.aa_payment_amount);

  // await token.methods.transfer_private_to_private(user, recipient, transferAmount, 0).send({
  //   from: user,
  //   fee: { paymentMethod: transferFpc.paymentMethod },
  // });

  // const recipientBal = new PrivateBalanceTracker(token, recipient, "Recipient", 0n);
  // await recipientBal.change(transferAmount);
  // await userBal.change(-transferAmount - transferFeePayment);

  // await operatorBal.change(counterFeePayment + transferFeePayment);

  // pinoLogger.info(`${LOG_PREFIX} PASS: token transfer via FPC succeeded`);
}
