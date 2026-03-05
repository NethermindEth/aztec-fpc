import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { Gas, GasFees } from "@aztec/stdlib/gas";
import { SDK_DEFAULTS } from "./defaults";
import {
  InsufficientFpcFeeJuiceError,
  SponsoredSdkError,
  SponsoredTxFailedError,
} from "./errors";
import { ensurePrivateBalance } from "./internal/balance-bootstrap";
import { connectAndAttachContracts } from "./internal/contracts";
import { createSponsoredPaymentMethod } from "./internal/fee-payment";
import { fetchAndValidateQuote } from "./internal/quote";
import type {
  CreateSponsoredCounterClientInput,
  SponsoredCounterClient,
} from "./types";

function toBigInt(value: { toString(): string } | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

function sameAddress(
  a: { toString(): string },
  b: { toString(): string },
): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

export async function createSponsoredCounterClient(
  input: CreateSponsoredCounterClientInput,
): Promise<SponsoredCounterClient> {
  const context = await connectAndAttachContracts({
    account: input.account,
    wallet: input.wallet,
  });

  return {
    async increment() {
      try {
        const minFees = await context.node.getCurrentMinFees();
        const fjAmount =
          BigInt(SDK_DEFAULTS.daGasLimit) * minFees.feePerDaGas +
          BigInt(SDK_DEFAULTS.l2GasLimit) * minFees.feePerL2Gas;
        const fpcFeeJuiceBalance = await getFeeJuiceBalance(
          context.addresses.fpc,
          context.node,
        );
        if (fpcFeeJuiceBalance < fjAmount) {
          throw new InsufficientFpcFeeJuiceError(
            "FPC FeeJuice balance is below required amount.",
            {
              current: fpcFeeJuiceBalance.toString(),
              required: fjAmount.toString(),
            },
          );
        }

        const quote = await fetchAndValidateQuote({
          acceptedAsset: context.addresses.token,
          attestationBaseUrl: SDK_DEFAULTS.attestationBaseUrl,
          fjAmount,
          user: context.addresses.user,
        });
        await ensurePrivateBalance({
          faucet: context.faucet as never,
          from: context.addresses.user,
          maxFaucetAttempts: SDK_DEFAULTS.maxFaucetAttempts,
          minimumPrivateAcceptedAsset:
            quote.aaPaymentAmount + SDK_DEFAULTS.minimumPrivateBalanceBuffer,
          token: context.token as never,
          txWaitTimeoutSeconds: SDK_DEFAULTS.txWaitTimeoutSeconds,
          user: context.addresses.user,
        });
        const counterBefore = toBigInt(
          await context.counter.methods
            .get_counter(context.addresses.user)
            .simulate({ from: context.addresses.user }),
        );
        const userPrivateBefore = toBigInt(
          await context.token.methods
            .balance_of_private(context.addresses.user)
            .simulate({ from: context.addresses.user }),
        );

        const { paymentMethod } = await createSponsoredPaymentMethod({
          aaPaymentAmount: quote.aaPaymentAmount,
          fpc: context.fpc as never,
          fjAmount,
          operatorAddress: context.addresses.operator,
          quoteSignatureBytes: quote.signatureBytes,
          quoteValidUntil: quote.validUntil,
          token: context.token as never,
          tokenAddress: context.addresses.token,
          user: context.addresses.user,
          wallet: input.wallet,
        });

        const gasLimits = new Gas(
          SDK_DEFAULTS.daGasLimit,
          SDK_DEFAULTS.l2GasLimit,
        );
        const teardownGasLimits = new Gas(0, 0);
        const maxFeesPerGas = new GasFees(
          minFees.feePerDaGas,
          minFees.feePerL2Gas,
        );

        let receipt: {
          transactionFee: { toString(): string } | bigint;
          txHash: { toString(): string };
        };
        try {
          receipt = await context.counter.methods
            .increment(context.addresses.user)
            .send({
              fee: {
                gasSettings: { gasLimits, maxFeesPerGas, teardownGasLimits },
                paymentMethod,
              },
              from: context.addresses.user,
              wait: { timeout: SDK_DEFAULTS.txWaitTimeoutSeconds },
            });
        } catch (error) {
          throw new SponsoredTxFailedError(
            "Sponsored transaction submission failed.",
            {
              cause: error instanceof Error ? error.message : String(error),
            },
          );
        }
        const counterAfter = toBigInt(
          await context.counter.methods
            .get_counter(context.addresses.user)
            .simulate({ from: context.addresses.user }),
        );
        const userPrivateAfter = toBigInt(
          await context.token.methods
            .balance_of_private(context.addresses.user)
            .simulate({ from: context.addresses.user }),
        );
        const userDebited = userPrivateBefore - userPrivateAfter;

        if (counterAfter !== counterBefore + 1n) {
          throw new SponsoredTxFailedError(
            "Counter increment invariant failed.",
            {
              counterAfter: counterAfter.toString(),
              counterBefore: counterBefore.toString(),
            },
          );
        }
        if (
          !sameAddress(context.addresses.user, context.addresses.operator) &&
          userDebited !== quote.aaPaymentAmount
        ) {
          throw new SponsoredTxFailedError("Accounting invariant failed.", {
            expectedCharge: quote.aaPaymentAmount.toString(),
            userDebited: userDebited.toString(),
          });
        }

        return {
          counterAfter,
          counterBefore,
          expectedCharge: quote.aaPaymentAmount,
          quoteValidUntil: quote.validUntil,
          txFeeJuice: toBigInt(receipt.transactionFee),
          txHash: receipt.txHash.toString(),
          userDebited,
        };
      } catch (error) {
        if (error instanceof SponsoredSdkError) {
          throw error;
        }
        throw new SponsoredTxFailedError(
          "Failed to execute sponsored increment.",
          {
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
    },
  };
}
