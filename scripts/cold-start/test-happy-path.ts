/**
 * Positive test: cold-start -> account deploy -> counter increment -> sponsored
 * transfer -> FPC transfer, all via FPC.
 *
 * Bridges tokens L1->L2 for the user, builds and proves the cold-start tx,
 * then deploys the user's account contract, increments a counter, transfers
 * tokens via sponsored FPC, and finally transfers tokens via our FPC
 * fee_entrypoint.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { FpcClient } from "@aztec-fpc/sdk";
import pino from "pino";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testHappyPath(ctx: TestContext): Promise<void> {
  const {
    args,
    node,
    operator,
    token,
    counter,
    fpcAddress,
    tokenAddress,
    bridgeAddress,
    sponsoredFpcAddress,
    l1WalletClient,
    l1Erc20,
    portalManager,
  } = ctx;

  const { claimAmount } = args;

  // 0. Create a fresh user for this test
  const userData: AccountData = await deriveAccount(Fr.random(), ctx.wallet);
  const user = userData.address;

  // Balance trackers — accumulate expected private balances across phases
  const userBalance = new PrivateBalanceTracker(token, user, "User", 0n);
  const operatorBalance = new PrivateBalanceTracker(token, operator, "Operator", 0n, "atLeast");

  // Shared FpcClient for all FPC-sponsored phases
  const fpcClient = new FpcClient({
    fpcAddress,
    operator,
    node,
    attestationBaseUrl: args.attestationUrl,
  });

  // =========================================================================
  // Phase 1: Cold-start — claim bridged tokens + pay FPC fee in one tx
  // =========================================================================

  // 1. Bridge tokens L1->L2 for the user (private)
  pinoLogger.info("[cold-start-smoke] bridging tokens L1->L2 for user");

  const l1Account = l1WalletClient.account;
  const mintHash = await l1Erc20.write.mint([l1Account.address, claimAmount]);
  await l1WalletClient.waitForTransactionReceipt({ hash: mintHash });

  const bridgeClaim = await portalManager.bridgeTokensPrivate(user, claimAmount, false);
  const bridgeMsgHash = Fr.fromHexString(bridgeClaim.messageHash as string);
  await waitForL1ToL2MessageReady(node, bridgeMsgHash, {
    timeoutSeconds: args.messageTimeoutSeconds,
  });

  pinoLogger.info(
    `[cold-start-smoke] tokens bridged. claim_amount=${claimAmount} message_hash=${bridgeClaim.messageHash}`,
  );

  // 2. Execute cold-start via SDK
  pinoLogger.info("[cold-start-smoke] executing cold-start via FpcClient");

  const coldStartResult = await fpcClient.executeColdStart({
    wallet: ctx.wallet,
    userAddress: user,
    tokenAddress,
    bridgeAddress,
    bridgeClaim,
  });

  pinoLogger.info(
    `[cold-start-smoke] cold-start tx confirmed tx_hash=${coldStartResult.txHash} fee=${coldStartResult.txFee} aa_payment=${coldStartResult.aaPaymentAmount}`,
  );

  // 3. Verify balances after cold-start
  await userBalance.change(claimAmount - coldStartResult.aaPaymentAmount);
  await operatorBalance.change(coldStartResult.aaPaymentAmount);
  pinoLogger.info("[cold-start-smoke] PASS: cold-start balance verification succeeded");

  // =========================================================================
  // Phase 2: Deploy user account contract via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] deploying user account via FPC");

  const deployMethod = await userData.accountManager.getDeployMethod();
  const { estimatedGas: deployEstimatedGas } = await deployMethod.simulate({
    from: AztecAddress.ZERO,
    fee: { estimateGas: true },
    skipClassPublication: true,
  });

  const deployPaymentMethod = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
    estimatedGas: deployEstimatedGas,
  });

  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: deployPaymentMethod.fee,
    skipClassPublication: true,
  });

  // Verify balances after deploy
  const deployPayment = BigInt(deployPaymentMethod.quote.aa_payment_amount);
  await userBalance.change(-deployPayment);
  await operatorBalance.change(deployPayment);

  pinoLogger.info("[cold-start-smoke] PASS: user account deployed via FPC");

  // =========================================================================
  // Phase 3: Increment counter via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] incrementing counter via FPC");

  const counterBefore = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).result.toString(),
  );

  const incrementMethod = counter.methods.increment(user);
  const { estimatedGas: incrementEstimatedGas } = await incrementMethod.simulate({
    from: user,
    fee: { estimateGas: true },
  });

  const incrementPaymentMethod = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
    estimatedGas: incrementEstimatedGas,
  });

  await incrementMethod.send({
    from: user,
    fee: incrementPaymentMethod.fee,
  });

  // Verify counter incremented
  const counterAfter = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).result.toString(),
  );
  if (counterAfter !== counterBefore + 1n) {
    throw new Error(`Counter mismatch: expected=${counterBefore + 1n} got=${counterAfter}`);
  }

  // Verify balances after increment
  const incrementPayment = BigInt(incrementPaymentMethod.quote.aa_payment_amount);
  await operatorBalance.change(incrementPayment);
  await userBalance.change(-incrementPayment);

  pinoLogger.info("[cold-start-smoke] PASS: counter increment via FPC succeeded");

  // =========================================================================
  // Phase 4: Transfer tokens to a fresh recipient via sponsored FPC
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] transferring tokens to recipient via sponsored FPC");

  const sponsoredRecipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const sponsoredTransferAmount = args.aaPaymentAmount;
  const sponsoredRecipientBalance = new PrivateBalanceTracker(
    token,
    sponsoredRecipient,
    "Sponsored recipient",
    0n,
  );

  await token.methods
    .transfer_private_to_private(user, sponsoredRecipient, sponsoredTransferAmount, 0)
    .send({
      from: user,
      fee: {
        paymentMethod: new SponsoredFeePaymentMethod(sponsoredFpcAddress),
      },
    });

  // Verify balances after sponsored transfer
  // Sponsored FPC pays gas — user only debited the transfer amount itself
  await operatorBalance.change(0n);
  await userBalance.change(-sponsoredTransferAmount);
  await sponsoredRecipientBalance.change(sponsoredTransferAmount);

  pinoLogger.info("[cold-start-smoke] PASS: sponsored FPC transfer succeeded");

  // =========================================================================
  // Phase 5: Transfer tokens to a fresh recipient via FPC fee_entrypoint
  // =========================================================================

  pinoLogger.info("[cold-start-smoke] transferring tokens to recipient via FPC");

  const recipient = (await deriveAccount(Fr.random(), ctx.wallet)).address;
  const transferAmount = args.aaPaymentAmount;
  const recipientBalance = new PrivateBalanceTracker(token, recipient, "Recipient", 0n);

  const transferMethod = token.methods.transfer_private_to_private(
    user,
    recipient,
    transferAmount,
    0,
  );
  const { estimatedGas: transferEstimatedGas } = await transferMethod.simulate({
    from: user,
    fee: { estimateGas: true },
  });

  const transferPaymentMethod = await fpcClient.createPaymentMethod({
    wallet: ctx.wallet,
    user,
    tokenAddress,
    estimatedGas: transferEstimatedGas,
  });
  const transferFeePayment = BigInt(transferPaymentMethod.quote.aa_payment_amount);

  await transferMethod.send({
    from: user,
    fee: transferPaymentMethod.fee,
  });

  // Verify final balances
  await operatorBalance.change(transferFeePayment);
  await userBalance.change(-(transferFeePayment + transferAmount));
  await recipientBalance.change(transferAmount);

  pinoLogger.info("[cold-start-smoke] PASS: token transfer via FPC succeeded");
}
