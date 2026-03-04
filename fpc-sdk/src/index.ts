export {
  BalanceBootstrapError,
  InsufficientFpcFeeJuiceError,
  PublishedAccountRequiredError,
  QuoteValidationError,
  SponsoredTxFailedError,
} from "./errors";
export { createSponsoredCounterClient } from "./client";
export type {
  CreateSponsoredCounterClientInput,
  SponsoredCounterClient,
  SponsoredIncrementResult,
} from "./types";
