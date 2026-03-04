export type SponsoredPaymentMethod = {
  getAsset: () => Promise<unknown>;
  getExecutionPayload: () => Promise<unknown>;
  getFeePayer: () => Promise<unknown>;
  getGasSettings: () => unknown;
};

export async function createSponsoredPaymentMethod(): Promise<SponsoredPaymentMethod> {
  throw new Error("Not implemented: createSponsoredPaymentMethod");
}
