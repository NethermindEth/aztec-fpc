export type SponsoredSdkErrorDetails = Record<string, unknown>;

class SponsoredSdkError extends Error {
  public readonly code: string;
  public readonly details?: SponsoredSdkErrorDetails;

  public constructor(
    code: string,
    message: string,
    details?: SponsoredSdkErrorDetails,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class PublishedAccountRequiredError extends SponsoredSdkError {
  public constructor(message: string, details?: SponsoredSdkErrorDetails) {
    super("PUBLISHED_ACCOUNT_REQUIRED", message, details);
  }
}

export class InsufficientFpcFeeJuiceError extends SponsoredSdkError {
  public constructor(message: string, details?: SponsoredSdkErrorDetails) {
    super("INSUFFICIENT_FPC_FEE_JUICE", message, details);
  }
}

export class QuoteValidationError extends SponsoredSdkError {
  public constructor(message: string, details?: SponsoredSdkErrorDetails) {
    super("QUOTE_VALIDATION_FAILED", message, details);
  }
}

export class BalanceBootstrapError extends SponsoredSdkError {
  public constructor(message: string, details?: SponsoredSdkErrorDetails) {
    super("BALANCE_BOOTSTRAP_FAILED", message, details);
  }
}

export class SponsoredTxFailedError extends SponsoredSdkError {
  public constructor(message: string, details?: SponsoredSdkErrorDetails) {
    super("SPONSORED_TX_FAILED", message, details);
  }
}
