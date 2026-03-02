import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import {
  computeCreditRateQuoteHash,
  computeQuoteHash,
  computeQuoteInnerHash,
  signCreditRateQuote,
  type QuoteParams,
  type QuoteSchnorrSigner,
  type CreditRateQuoteParams,
  signQuote,
} from "../src/signer.js";

const FPC = AztecAddress.fromString(
  "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
);
const ASSET = AztecAddress.fromString(
  "0x0000000000000000000000000000000000000000000000000000000000000002",
);
const USER = AztecAddress.fromString(
  "0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72",
);
const OTHER_USER = AztecAddress.fromString(
  "0x1b755492d6dd51deb08b7e51a33133186687ea13527f07921fd74640dc8dec24",
);

function makeQuoteParams(): QuoteParams {
  return {
    fpcAddress: FPC,
    acceptedAsset: ASSET,
    fjFeeAmount: 1_000_000n,
    aaPaymentAmount: 1020n,
    validUntil: 1740000300n,
    userAddress: USER,
  };
}

function makeCreditRateQuoteParams(): CreditRateQuoteParams {
  return {
    fpcAddress: FPC,
    acceptedAsset: ASSET,
    mintAmount: 1_000_000n,
    rateNum: 1020n,
    rateDen: 1000n,
    validUntil: 1740000300n,
    userAddress: USER,
  };
}

describe("signer", () => {
  it("computes quote hash with the exact preimage order", async () => {
    const params = makeQuoteParams();

    const expected = await computeInnerAuthWitHash([
      Fr.fromHexString("0x465043"), // "FPC"
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.fjFeeAmount),
      new Fr(params.aaPaymentAmount),
      new Fr(params.validUntil),
      params.userAddress.toField(),
    ]);

    const actual = await computeQuoteHash(params);
    assert.equal(actual.equals(expected), true);

    const wrongOrder = await computeInnerAuthWitHash([
      Fr.fromHexString("0x465043"),
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.aaPaymentAmount), // swapped
      new Fr(params.fjFeeAmount), // swapped
      new Fr(params.validUntil),
      params.userAddress.toField(),
    ]);
    assert.equal(actual.equals(wrongOrder), false);
  });

  it("backward-compatible alias computeQuoteInnerHash works", async () => {
    const params = makeQuoteParams();
    const a = await computeQuoteHash(params);
    const b = await computeQuoteInnerHash(params);
    assert.equal(a.equals(b), true);
  });

  it("returns signature hex from signer", async () => {
    const params = makeQuoteParams();
    const signer: QuoteSchnorrSigner = {
      signQuoteHash: async () => "0xdeadbeef",
    };

    const sig = await signQuote(signer, params);
    assert.equal(sig, "0xdeadbeef");
  });

  it("binds quote hash to user address", async () => {
    const params = makeQuoteParams();
    const otherUserParams: QuoteParams = {
      ...params,
      userAddress: OTHER_USER,
    };

    const userHash = await computeQuoteHash(params);
    const otherUserHash = await computeQuoteHash(otherUserParams);
    assert.equal(userHash.equals(otherUserHash), false);
  });
});

describe("signer credit rate quote", () => {
  it("computes credit rate quote hash with exact preimage order", async () => {
    const params = makeCreditRateQuoteParams();

    const expected = await computeInnerAuthWitHash([
      Fr.fromHexString("0x465043"),
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.mintAmount),
      new Fr(params.rateNum),
      new Fr(params.rateDen),
      new Fr(params.validUntil),
      params.userAddress.toField(),
    ]);

    const actual = await computeCreditRateQuoteHash(params);
    assert.equal(actual.equals(expected), true);

    const wrongOrder = await computeInnerAuthWitHash([
      Fr.fromHexString("0x465043"),
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.rateNum),
      new Fr(params.mintAmount),
      new Fr(params.rateDen),
      new Fr(params.validUntil),
      params.userAddress.toField(),
    ]);
    assert.equal(actual.equals(wrongOrder), false);
  });

  it("returns signature hex for credit rate quote", async () => {
    const params = makeCreditRateQuoteParams();
    const signer: QuoteSchnorrSigner = {
      signQuoteHash: async () => "0xfacefeed",
    };

    const sig = await signCreditRateQuote(signer, params);
    assert.equal(sig, "0xfacefeed");
  });
});
