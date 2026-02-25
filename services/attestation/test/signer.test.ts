import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import {
  computeQuoteInnerHash,
  createQuoteAuthwitSigner,
  type MessageHashAuthwitSigner,
  type QuoteParams,
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
    rateNum: 10200n,
    rateDen: 10000000n,
    validUntil: 1740000300n,
    userAddress: USER,
  };
}

describe("signer", () => {
  it("computes inner hash with the exact preimage order", async () => {
    const params = makeQuoteParams();

    const expected = await computeInnerAuthWitHash([
      Fr.fromHexString("0x465043"), // "FPC"
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.rateNum),
      new Fr(params.rateDen),
      new Fr(params.validUntil),
      params.userAddress.toField(),
    ]);

    const actual = await computeQuoteInnerHash(params);
    assert.equal(actual.equals(expected), true);

    const wrongOrder = await computeInnerAuthWitHash([
      Fr.fromHexString("0x465043"),
      params.fpcAddress.toField(),
      params.acceptedAsset.toField(),
      new Fr(params.rateDen), // swapped
      new Fr(params.rateNum), // swapped
      new Fr(params.validUntil),
      params.userAddress.toField(),
    ]);
    assert.equal(actual.equals(wrongOrder), false);
  });

  it("serializes authwit output to string", async () => {
    const params = makeQuoteParams();
    const messageHashSigner: MessageHashAuthwitSigner = {
      createAuthWit: async () =>
        ({
          toString: () => "0xdeadbeef",
        }) as never,
    };

    const quoteSigner = createQuoteAuthwitSigner(messageHashSigner, {
      chainId: new Fr(31337),
      version: new Fr(1),
    });

    const authwit = await signQuote(quoteSigner, params);
    assert.equal(authwit, "0xdeadbeef");
  });

  it("binds quote hash to user address", async () => {
    const params = makeQuoteParams();
    const otherUserParams: QuoteParams = {
      ...params,
      userAddress: OTHER_USER,
    };

    const userHash = await computeQuoteInnerHash(params);
    const otherUserHash = await computeQuoteInnerHash(otherUserParams);
    assert.equal(userHash.equals(otherUserHash), false);
  });
});
