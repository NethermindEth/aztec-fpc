import { connectAndAttachContracts } from "./internal/contracts";
import { SDK_DEFAULTS } from "./defaults";
import { SponsoredSdkError, SponsoredTxFailedError } from "./errors";
import { ensurePrivateBalance } from "./internal/balance-bootstrap";
import { fetchAndValidateQuote } from "./internal/quote";
import type {
  CreateSponsoredCounterClientInput,
  SponsoredCounterClient,
} from "./types";

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

        throw new SponsoredTxFailedError(
          "SDK scaffold only: increment() is not implemented yet.",
          {
            account: context.addresses.user.toString(),
            phase: "step-5-scaffold",
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
