import { AztecAddress } from "@aztec/aztec.js/addresses";
import { describe, expect, it } from "vitest";

import { QuoteValidationError } from "../src/errors";
import { buildQuoteUrl, validateQuote } from "../src/internal/quote";

const USER = AztecAddress.fromString(
  "0x226762b1e122bd46054de3fd21a19f0500ebe072aeac35fe0bb82d43b85f94fd",
);
const TOKEN = AztecAddress.fromString(
  "0x10600e2f256b6500de5a79367d70b4c7d8121c408a2127dbcba995a1abc0d6f8",
);

describe("quote url", () => {
  it("appends /quote with query params", () => {
    const url = buildQuoteUrl({
      acceptedAsset: TOKEN,
      attestationBaseUrl: "https://aztec-fpc.staging-nethermind.xyz/v2",
      fjAmount: 123n,
      user: USER,
    });
    expect(url).toContain("/v2/quote?");
    expect(url).toContain(`user=${encodeURIComponent(USER.toString())}`);
    expect(url).toContain(`accepted_asset=${encodeURIComponent(TOKEN.toString())}`);
    expect(url).toContain("fj_amount=123");
  });
});

describe("quote validation", () => {
  it("accepts a valid quote", () => {
    const out = validateQuote({
      expectedAcceptedAsset: TOKEN,
      expectedFjAmount: 100n,
      quote: {
        accepted_asset: TOKEN.toString(),
        aa_payment_amount: "77",
        fj_amount: "100",
        signature: `0x${"11".repeat(64)}`,
        valid_until: "999",
      },
    });
    expect(out.aaPaymentAmount).toBe(77n);
    expect(out.fjAmount).toBe(100n);
    expect(out.signatureBytes).toHaveLength(64);
  });

  it("rejects accepted asset mismatch", () => {
    expect(() =>
      validateQuote({
        expectedAcceptedAsset: TOKEN,
        expectedFjAmount: 100n,
        quote: {
          accepted_asset:
            "0x016fa39000902287772e653a9e6cc2026dbb0f97c08a4d1b2c51ebbad4a4b24f",
          aa_payment_amount: "77",
          fj_amount: "100",
          signature: `0x${"11".repeat(64)}`,
          valid_until: "999",
        },
      }),
    ).toThrow(QuoteValidationError);
  });

  it("rejects fj amount mismatch", () => {
    expect(() =>
      validateQuote({
        expectedAcceptedAsset: TOKEN,
        expectedFjAmount: 100n,
        quote: {
          accepted_asset: TOKEN.toString(),
          aa_payment_amount: "77",
          fj_amount: "101",
          signature: `0x${"11".repeat(64)}`,
          valid_until: "999",
        },
      }),
    ).toThrow(QuoteValidationError);
  });

  it("rejects non-64-byte signature", () => {
    expect(() =>
      validateQuote({
        expectedAcceptedAsset: TOKEN,
        expectedFjAmount: 100n,
        quote: {
          accepted_asset: TOKEN.toString(),
          aa_payment_amount: "77",
          fj_amount: "100",
          signature: `0x${"11".repeat(63)}`,
          valid_until: "999",
        },
      }),
    ).toThrow(QuoteValidationError);
  });
});
