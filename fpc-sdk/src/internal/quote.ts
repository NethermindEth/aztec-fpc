export type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

export async function fetchQuote(): Promise<QuoteResponse> {
  throw new Error("Not implemented: fetchQuote");
}
