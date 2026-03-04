import { connectAndAttachContracts } from "./internal/contracts";
import { SDK_DEFAULTS } from "./defaults";
import { SponsoredSdkError, SponsoredTxFailedError } from "./errors";
import { ensurePrivateBalance } from "./internal/balance-bootstrap";
import { createSponsoredPaymentMethod } from "./internal/fee-payment";
import { fetchAndValidateQuote } from "./internal/quote";
import type {
  CreateSponsoredCounterClientInput,
  SponsoredCounterClient,
} from "./types";
import { Gas, GasFees } from "@aztec/stdlib/gas";

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

        const gasLimits = new Gas(SDK_DEFAULTS.daGasLimit, SDK_DEFAULTS.l2GasLimit);
        const teardownGasLimits = new Gas(0, 0);
        const maxFeesPerGas = new GasFees(
          minFees.feePerDaGas,
          minFees.feePerL2Gas,
        );

        let receipt: { txHash: { toString(): string } };
        try {
          receipt = await context.counter.methods.increment(context.addresses.user).send({
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

        throw new SponsoredTxFailedError(
          "SDK scaffold only: post-state checks are not implemented yet.",
          {
            account: context.addresses.user.toString(),
            phase: "step-8-scaffold",
            txHash: receipt.txHash.toString(),
          },
        );
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
