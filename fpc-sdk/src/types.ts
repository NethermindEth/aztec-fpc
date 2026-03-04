import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";

export type CreateSponsoredCounterClientInput = {
  wallet: AccountWallet;
  account: AztecAddress | string;
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
