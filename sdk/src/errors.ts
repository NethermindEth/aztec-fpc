export type SponsoredSdkErrorDetails = Record<string, unknown>;

export abstract class SponsoredSdkError extends Error {
  public readonly code: string;
  public readonly details?: SponsoredSdkErrorDetails;

  protected constructor(code: string, message: string, details?: SponsoredSdkErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  public toJSON(): {
    code: string;
    details?: SponsoredSdkErrorDetails;
    message: string;
    name: string;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class PublishedAccountRequiredError extends SponsoredSdkError {
  public constructor(
    message = "Account is not published on node.",
    details?: SponsoredSdkErrorDetails,
  ) {
    super("PUBLISHED_ACCOUNT_REQUIRED", message, details);
  }
}

export class InsufficientFpcFeeJuiceError extends SponsoredSdkError {
  public constructor(
    message = "FPC has insufficient FeeJuice for the sponsored transaction.",
    details?: SponsoredSdkErrorDetails,
  ) {
    super("INSUFFICIENT_FPC_FEE_JUICE", message, details);
  }
}

export class QuoteValidationError extends SponsoredSdkError {
  public constructor(
    message = "Attestation quote failed validation.",
    details?: SponsoredSdkErrorDetails,
  ) {
    super("QUOTE_VALIDATION_FAILED", message, details);
  }
}

export class BalanceBootstrapError extends SponsoredSdkError {
  public constructor(
    message = "Unable to bootstrap private accepted-asset balance.",
    details?: SponsoredSdkErrorDetails,
  ) {
    super("BALANCE_BOOTSTRAP_FAILED", message, details);
  }
}

export class SponsoredTxFailedError extends SponsoredSdkError {
  public constructor(
    message = "Sponsored transaction failed.",
    details?: SponsoredSdkErrorDetails,
  ) {
    super("SPONSORED_TX_FAILED", message, details);
  }
}
