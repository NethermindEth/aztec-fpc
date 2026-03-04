import { AztecAddress } from "@aztec/aztec.js/addresses";
import { ProtocolContractAddress } from "@aztec/aztec.js/protocol";
import { describe, expect, it, vi } from "vitest";

import { SponsoredTxFailedError } from "../src/errors";
import { createSponsoredPaymentMethod } from "../src/internal/fee-payment";

const USER = AztecAddress.fromString(
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd",
);
const TOKEN = AztecAddress.fromString(
  "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8",
);
const OPERATOR = AztecAddress.fromString(
  "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8",
);
const FPC = AztecAddress.fromString(
  "0x24a735808258519dc1637f1833202ea2dc7c829a0a82c73f61bbd195fce4105b",
);

describe("payment", () => {
  it("builds payment method with fee payer and execution payload", async () => {
    const wallet = {
      createAuthWit: vi.fn(async () => ({ witness: "ok" })),
    };
    const token = {
      methods: {
        transfer_private_to_private: () => ({
          getFunctionCall: async () => ({ fn: "transfer" }),
        }),
      },
    };
    const fpc = {
      address: FPC,
      methods: {
        fee_entrypoint: () => ({
          getFunctionCall: async () => ({ fn: "fee_entrypoint" }),
        }),
      },
    };

    const out = await createSponsoredPaymentMethod({
      aaPaymentAmount: 7n,
      fpc,
      fjAmount: 11n,
      operatorAddress: OPERATOR,
      quoteSignatureBytes: [1, 2, 3],
      quoteValidUntil: 99n,
      token,
      tokenAddress: TOKEN,
      user: USER,
      wallet: wallet as never,
    });

    expect(await out.paymentMethod.getAsset()).toBe(ProtocolContractAddress.FeeJuice);
    expect(await out.paymentMethod.getFeePayer()).toBe(FPC);
    expect(out.paymentMethod.getGasSettings()).toBeUndefined();
    expect(wallet.createAuthWit).toHaveBeenCalledTimes(1);
  });

  it("wraps construction failures", async () => {
    await expect(
      createSponsoredPaymentMethod({
        aaPaymentAmount: 7n,
        fpc: {
          address: FPC,
          methods: {
            fee_entrypoint: () => ({
              getFunctionCall: async () => ({ fn: "fee_entrypoint" }),
            }),
          },
        },
        fjAmount: 11n,
        operatorAddress: OPERATOR,
        quoteSignatureBytes: [1, 2, 3],
        quoteValidUntil: 99n,
        token: {
          methods: {
            transfer_private_to_private: () => ({
              getFunctionCall: async () => {
                throw new Error("boom");
              },
            }),
          },
        },
        tokenAddress: TOKEN,
        user: USER,
        wallet: { createAuthWit: vi.fn() } as never,
      }),
    ).rejects.toBeInstanceOf(SponsoredTxFailedError);
  });
});
