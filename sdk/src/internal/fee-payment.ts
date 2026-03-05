import type { FunctionCall } from "@aztec/aztec.js/abi";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import type { Wallet as AccountWallet } from "@aztec/aztec.js/wallet";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import { ExecutionPayload } from "@aztec/stdlib/tx";

import { SponsoredTxFailedError } from "../errors";

export type SponsoredPaymentMethod = {
  getAsset: () => Promise<typeof ProtocolContractAddress.FeeJuice>;
  getExecutionPayload: () => Promise<ExecutionPayload>;
  getFeePayer: () => Promise<AztecAddress>;
  getGasSettings: () => undefined;
};

export type SponsoredPaymentBuildResult = {
  feeEntrypointCall: FunctionCall;
  nonce: Fr;
  paymentMethod: SponsoredPaymentMethod;
  transferAuthwit: AuthWitness;
};

export async function createSponsoredPaymentMethod(input: {
  aaPaymentAmount: bigint;
  fpc: {
    address: AztecAddress;
    methods: {
      fee_entrypoint: (
        token: AztecAddress,
        nonce: Fr,
        fjAmount: bigint,
        aaAmount: bigint,
        validUntil: bigint,
        sig: number[],
      ) => { getFunctionCall: () => Promise<FunctionCall> };
    };
  };
  fjAmount: bigint;
  operatorAddress: AztecAddress;
  quoteSignatureBytes: number[];
  quoteValidUntil: bigint;
  token: {
    methods: {
      transfer_private_to_private: (
        from: AztecAddress,
        to: AztecAddress,
        amount: bigint,
        nonce: Fr,
      ) => { getFunctionCall: () => Promise<FunctionCall> };
    };
  };
  tokenAddress: AztecAddress;
  user: AztecAddress;
  wallet: AccountWallet;
}): Promise<SponsoredPaymentBuildResult> {
  const nonce = Fr.random();

  try {
    const transferCall = await input.token.methods
      .transfer_private_to_private(input.user, input.operatorAddress, input.aaPaymentAmount, nonce)
      .getFunctionCall();
    const transferAuthwit = await input.wallet.createAuthWit(input.user, {
      caller: input.fpc.address,
      call: transferCall,
    });

    const feeEntrypointCall = await input.fpc.methods
      .fee_entrypoint(
        input.tokenAddress,
        nonce,
        input.fjAmount,
        input.aaPaymentAmount,
        input.quoteValidUntil,
        input.quoteSignatureBytes,
      )
      .getFunctionCall();

    const paymentMethod: SponsoredPaymentMethod = {
      getAsset: async () => ProtocolContractAddress.FeeJuice,
      getExecutionPayload: async () =>
        new ExecutionPayload(
          [feeEntrypointCall as never],
          [transferAuthwit as never],
          [],
          [],
          input.fpc.address,
        ),
      getFeePayer: async () => input.fpc.address,
      getGasSettings: () => undefined,
    };

    return {
      feeEntrypointCall,
      nonce,
      paymentMethod,
      transferAuthwit,
    };
  } catch (error) {
    throw new SponsoredTxFailedError("Failed to build sponsored payment method.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
