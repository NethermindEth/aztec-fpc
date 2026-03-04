export type BalanceBootstrapInput = {
  minimumPrivateAcceptedAsset: bigint;
  maxFaucetAttempts: number;
};

export async function ensurePrivateBalance(
  _input: BalanceBootstrapInput,
): Promise<void> {
  throw new Error("Not implemented: ensurePrivateBalance");
}
