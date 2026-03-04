export type AttachedContracts = {
  token: unknown;
  fpc: unknown;
  faucet: unknown;
  counter: unknown;
};

export async function attachContracts(): Promise<AttachedContracts> {
  throw new Error("Not implemented: attachContracts");
}
