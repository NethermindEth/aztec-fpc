import { SponsoredTxFailedError } from "./errors";
import type {
  CreateSponsoredCounterClientInput,
  SponsoredCounterClient,
} from "./types";

export async function createSponsoredCounterClient(
  input: CreateSponsoredCounterClientInput,
): Promise<SponsoredCounterClient> {
  void input;

  return {
    async increment() {
      throw new SponsoredTxFailedError(
        "SDK scaffold only: increment() is not implemented yet.",
        {
          phase: "step-1-scaffold",
        },
      );
    },
  };
}
