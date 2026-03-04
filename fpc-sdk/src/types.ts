export type CreateSponsoredCounterClientInput = {
  wallet: unknown;
  account: string;
};

export type SponsoredIncrementResult = {
  txHash: string;
  txFeeJuice: bigint;
  expectedCharge: bigint;
  userDebited: bigint;
  counterBefore: bigint;
  counterAfter: bigint;
  quoteValidUntil: bigint;
};

export type SponsoredCounterClient = {
  increment(): Promise<SponsoredIncrementResult>;
};
