import { connectAndAttachContracts } from "./internal/contracts";
import { SponsoredSdkError, SponsoredTxFailedError } from "./errors";
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
