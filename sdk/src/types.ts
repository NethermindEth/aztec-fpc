import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { InteractionFeeOptions } from "@aztec/aztec.js/contracts";
import type { L2AmountClaim } from "@aztec/aztec.js/ethereum";
import type { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";
import type { GasSettings } from "@aztec/stdlib/gas";

export type FpcClientConfig = {
  fpcAddress: AztecAddress;
  operator: AztecAddress;
  node: AztecNode;
  attestationBaseUrl: string;
};

export type CreatePaymentMethodInput = {
  wallet: AccountWallet;
  user: AztecAddress;
  tokenAddress: AztecAddress;
  estimatedGas: Pick<GasSettings, "gasLimits" | "teardownGasLimits">;
};

export type QuoteResponse = {
  accepted_asset: string;
  fj_amount: string;
  aa_payment_amount: string;
  valid_until: string;
  signature: string;
};

export type FpcPaymentMethodResult = {
  fee: InteractionFeeOptions;
  nonce: Fr;
  quote: QuoteResponse;
};

export type ColdStartQuoteResponse = QuoteResponse & {
  claim_amount: string;
  claim_secret_hash: string;
};

export type ExecuteColdStartInput = {
  wallet: AccountWallet;
  userAddress: AztecAddress;
  tokenAddress: AztecAddress;
  bridgeAddress: AztecAddress;
  bridgeClaim: L2AmountClaim;
  txWaitTimeoutMs?: number;
};

export type ColdStartResult = {
  txHash: string;
  txFee: bigint;
  fjAmount: bigint;
  aaPaymentAmount: bigint;
  quoteValidUntil: bigint;
};
