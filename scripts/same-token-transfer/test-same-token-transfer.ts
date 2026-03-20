/**
 * Same-token-transfer test: faucet drip -> partial shield -> private transfer -> public transfer
 * -> batch cross-domain transfers.
 *
 * Exercises the full lifecycle from zero to FPC usage without any L1 bridging:
 * 1. Deploy user account via SponsoredFPC
 * 2. Faucet drip + shield half of tokens (batched in one tx via SponsoredFPC)
 * 3. Transfer tokens to a fresh recipient, fee paid by our FPC fee_entrypoint
 * 4. Transfer public tokens to recipient, fee paid by our FPC fee_entrypoint
 * 5. Batch: transfer_public_to_private + transfer_private_to_public, fee paid by our FPC fee_entrypoint
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BatchCall } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import pino from "pino";
import { PrivateBalanceTracker, PublicBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

const LOG_PREFIX = "[same-token-transfer]";

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testSameTokenTransfer(ctx: TestContext): Promise<void> {
  const { args, operator, fpcClient, tokenAddress, token, faucet, sponsoredFeePayment } = ctx;

  const { aaPaymentAmount } = args;

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
  // Phase 2: Faucet drip + shield half of tokens (batched in one tx via SponsoredFPC)
  // =========================================================================

  const shieldAmount = dripAmount / 2n;
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

  // Assert: drip landed in public, then shield moved half to private
  const userPrivBal = await PrivateBalanceTracker.create(
    token,
    ctx.wallet,
    userData.secret,
    "User",
  );
  await userPrivBal.change(shieldAmount);

  const userPubBal = new PublicBalanceTracker(token, user, "User");
  await userPubBal.change(dripAmount - shieldAmount);

  pinoLogger.info(`${LOG_PREFIX} PASS: faucet drip + shield succeeded`);

  const operatorPrivBal = await PrivateBalanceTracker.create(
    token,
    ctx.wallet,
    args.operatorSecretKey,
    "Operator",
    operatorStartBalance,
    "atLeast",
  );

  // =========================================================================
  // Phase 3: Transfer tokens to a fresh recipient via FPC fee_entrypoint
  // =========================================================================

  const recipientPrivBal = await PrivateBalanceTracker.create(
    token,
    ctx.wallet,
    Fr.random(),
    "Recipient",
  );
  const recipient = recipientPrivBal.address;
  const recipientPubBal = new PublicBalanceTracker(token, recipient, "Recipient");

  pinoLogger.info(`${LOG_PREFIX} transferring tokens to recipient via FPC`);

  const privTransferAmount = aaPaymentAmount;

  const transferCall = token.methods.transfer_private_to_private(
    user,
    recipient,
    privTransferAmount,
    Fr.random(),
  );
  const transferSim = await transferCall.simulate({
    from: user,
    fee: { estimateGas: true },
  });
  const transferFpc = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
    estimatedGas: transferSim.estimatedGas,
  });
  const transferFeePayment = BigInt(transferFpc.quote.aa_payment_amount);

  await transferCall.send({
    from: user,
    fee: transferFpc.fee,
  });

  await recipientPrivBal.change(privTransferAmount);
  await userPrivBal.change(-privTransferAmount - transferFeePayment);
  await operatorPrivBal.change(transferFeePayment);

  pinoLogger.info(`${LOG_PREFIX} PASS: token transfer via FPC succeeded`);

  // =========================================================================
  // Phase 4: Transfer public tokens to recipient via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info(`${LOG_PREFIX} transferring public tokens to recipient via FPC`);

  const pubTransferAmount = aaPaymentAmount;

  const publicTransferCall = token.methods.transfer_public_to_public(
    user,
    recipient,
    pubTransferAmount,
    Fr.random(),
  );
  const publicTransferSim = await publicTransferCall.simulate({
    from: user,
    fee: { estimateGas: true },
  });
  const publicTransferFpc = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
    estimatedGas: publicTransferSim.estimatedGas,
  });
  const publicTransferFeePayment = BigInt(publicTransferFpc.quote.aa_payment_amount);

  await publicTransferCall.send({
    from: user,
    fee: publicTransferFpc.fee,
  });

  await recipientPubBal.change(pubTransferAmount);
  await userPubBal.change(-pubTransferAmount);
  await userPrivBal.change(-publicTransferFeePayment);
  await operatorPrivBal.change(publicTransferFeePayment);

  pinoLogger.info(`${LOG_PREFIX} PASS: public-to-public transfer via FPC succeeded`);

  // =========================================================================
  // Phase 5: Batch transfer_public_to_private + transfer_private_to_public
  //          via FPC fee_entrypoint
  // =========================================================================

  const batchTransferAmount = aaPaymentAmount;

  pinoLogger.info(
    `${LOG_PREFIX} batching public_to_private + private_to_public (${batchTransferAmount} tokens each) via FPC`,
  );

  const pubToPrivCall = token.methods.transfer_public_to_private(
    user,
    recipient,
    batchTransferAmount,
    Fr.random(),
  );
  const privToPubCall = token.methods.transfer_private_to_public(
    user,
    recipient,
    batchTransferAmount,
    Fr.random(),
  );

  const { estimatedGas: pubToPrivGas } = await pubToPrivCall.simulate({
    from: user,
    fee: { estimateGas: true },
  });
  const { estimatedGas: privToPubGas } = await privToPubCall.simulate({
    from: user,
    fee: { estimateGas: true },
  });

  if (!pubToPrivGas || !privToPubGas) {
    throw new Error("Gas estimation failed for batch transfer calls");
  }

  const batchEstimatedGas = {
    gasLimits: pubToPrivGas.gasLimits.add(privToPubGas.gasLimits),
    teardownGasLimits: pubToPrivGas.teardownGasLimits.add(privToPubGas.teardownGasLimits),
  };
  const batchTransferFpc = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
    estimatedGas: batchEstimatedGas,
  });
  const batchTransferFeePayment = BigInt(batchTransferFpc.quote.aa_payment_amount);

  const batchTransferCall = new BatchCall(ctx.wallet, [pubToPrivCall, privToPubCall]);
  await batchTransferCall.send({
    from: user,
    fee: batchTransferFpc.fee,
  });

  await recipientPrivBal.change(batchTransferAmount);
  await recipientPubBal.change(batchTransferAmount);
  await userPubBal.change(-batchTransferAmount);
  await userPrivBal.change(-batchTransferAmount - batchTransferFeePayment);
  await operatorPrivBal.change(batchTransferFeePayment);

  pinoLogger.info(
    `${LOG_PREFIX} PASS: batch public_to_private + private_to_public via FPC succeeded`,
  );
}
