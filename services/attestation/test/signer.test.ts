import assert from "node:assert/strict";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { describe, it } from "#test";
import {
  type ColdStartQuoteParams,
  computeColdStartQuoteHash,
  computeQuoteHash,
  type QuoteParams,
  type QuoteSchnorrSigner,
  signColdStartQuote,
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

const CLAIM_SECRET_HASH = Fr.fromHexString(
  "0x00000000000000000000000000000000000000000000000000000000cafebabe",
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

function makeColdStartQuoteParams(): ColdStartQuoteParams {
  return {
    fpcAddress: FPC,
    acceptedAsset: ASSET,
    fjFeeAmount: 1_000_000n,
    aaPaymentAmount: 1020n,
    validUntil: 1740000300n,
    userAddress: USER,
    claimAmount: 5000n,
    claimSecretHash: CLAIM_SECRET_HASH,
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

describe("cold-start signer", () => {
  it("computes cold-start quote hash with extended preimage", async () => {
    const params = makeColdStartQuoteParams();

    const expected = await computeInnerAuthWitHash([
      Fr.fromHexString("0x46504373"), // "FPCs"
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.fjFeeAmount),
      new Fr(params.aaPaymentAmount),
      new Fr(params.validUntil),
      params.userAddress.toField(),
      new Fr(params.claimAmount),
      params.claimSecretHash,
    ]);

    const actual = await computeColdStartQuoteHash(params);
    assert.equal(actual.equals(expected), true);
  });

  it("cold-start hash differs from regular quote hash", async () => {
    const quoteParams = makeQuoteParams();
    const coldStartParams = makeColdStartQuoteParams();

    const regularHash = await computeQuoteHash(quoteParams);
    const coldStartHash = await computeColdStartQuoteHash(coldStartParams);
    assert.equal(regularHash.equals(coldStartHash), false);
  });

  it("binds cold-start hash to claim_amount", async () => {
    const params = makeColdStartQuoteParams();
    const differentClaimParams: ColdStartQuoteParams = {
      ...params,
      claimAmount: params.claimAmount + 1n,
    };

    const hash1 = await computeColdStartQuoteHash(params);
    const hash2 = await computeColdStartQuoteHash(differentClaimParams);
    assert.equal(hash1.equals(hash2), false);
  });

  it("binds cold-start hash to claim_secret_hash", async () => {
    const params = makeColdStartQuoteParams();
    const differentSecretParams: ColdStartQuoteParams = {
      ...params,
      claimSecretHash: Fr.fromHexString("0xdeadbeef"),
    };

    const hash1 = await computeColdStartQuoteHash(params);
    const hash2 = await computeColdStartQuoteHash(differentSecretParams);
    assert.equal(hash1.equals(hash2), false);
  });

  it("binds cold-start hash to user address", async () => {
    const params = makeColdStartQuoteParams();
    const otherUserParams: ColdStartQuoteParams = {
      ...params,
      userAddress: OTHER_USER,
    };

    const userHash = await computeColdStartQuoteHash(params);
    const otherUserHash = await computeColdStartQuoteHash(otherUserParams);
    assert.equal(userHash.equals(otherUserHash), false);
  });

  it("returns signature hex from signer for cold-start quote", async () => {
    const params = makeColdStartQuoteParams();
    const signer: QuoteSchnorrSigner = {
      signQuoteHash: async () => "0xcoldstart",
    };

    const sig = await signColdStartQuote(signer, params);
    assert.equal(sig, "0xcoldstart");
  });
});
