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
import { BatchCall, type Contract } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import pino from "pino";
import { PrivateBalanceTracker } from "../common/balance-tracker.ts";
import { type AccountData, deriveAccount } from "../common/script-credentials.ts";
import type { TestContext } from "./setup.ts";

const pinoLogger = pino();

const LOG_PREFIX = "[same-token-transfer]";

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

export async function testSameTokenTransfer(ctx: TestContext): Promise<void> {
  const {
    args,
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

  // pinoLogger.info(`${LOG_PREFIX} deploying user account via SponsoredFPC`);

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

  const counterBefore = BigInt(
    (await counter.methods.get_counter(user).simulate({ from: user })).toString(),
  );

  const { aaPaymentAmount: counterFeePayment, ...counterFee } =
    await buildFpcPaymentMethod(fpcPaymentOpts);

  await counter.methods.increment(user).send({
    from: user,
    fee: counterFee,
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

  // const { aaPaymentAmount: transferFeePayment, ...transferFee } =
  //   await buildFpcPaymentMethod(fpcPaymentOpts);

  // await token.methods.transfer_private_to_private(user, recipient, transferAmount, 0).send({
  //   from: user,
  //   fee: transferFee,
  // });

  // const recipientBal = new PrivateBalanceTracker(token, recipient, "Recipient", 0n);
  // await recipientBal.change(transferAmount);
  // await userBal.change(-transferAmount - transferFeePayment);

  // await operatorBal.change(counterFeePayment + transferFeePayment);

  // pinoLogger.info(`${LOG_PREFIX} PASS: token transfer via FPC succeeded`);
}
