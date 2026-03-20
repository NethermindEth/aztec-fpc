import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveAutoClaimSecretKeyFromEnv,
  resolveAutoClaimSponsoredFpcFromEnv,
} from "../src/autoclaim.js";

const VALID_SECRET_A = "0x1111111111111111111111111111111111111111111111111111111111111111";
const VALID_AZTEC_ADDRESS_A = "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2";

describe("resolveAutoClaimSecretKeyFromEnv", () => {
  it("returns secret key when TOPUP_AUTOCLAIM_SECRET_KEY is set", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: VALID_SECRET_A,
    });
    assert.equal(resolved, VALID_SECRET_A);
  });

  it("returns null when TOPUP_AUTOCLAIM_SECRET_KEY is unset", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({});
    assert.equal(resolved, null);
  });

  it("returns null when TOPUP_AUTOCLAIM_SECRET_KEY is blank", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: "   ",
    });
    assert.equal(resolved, null);
  });

  it("returns null when TOPUP_AUTOCLAIM_SECRET_KEY is empty string", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: "",
    });
    assert.equal(resolved, null);
  });

  it("throws on invalid TOPUP_AUTOCLAIM_SECRET_KEY", () => {
    assert.throws(
      () =>
        resolveAutoClaimSecretKeyFromEnv({
          TOPUP_AUTOCLAIM_SECRET_KEY: "not-a-key",
        }),
      /Invalid auto-claim secret key/,
    );
  });
});

describe("resolveAutoClaimSponsoredFpcFromEnv", () => {
  it("returns address when TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS is set", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({
      TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_A,
    });
    assert.equal(resolved?.toString(), VALID_AZTEC_ADDRESS_A);
  });

  it("returns null when TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS is unset", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({});
    assert.equal(resolved, null);
  });

  it("returns null when TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS is blank", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({
      TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS: " ",
    });
    assert.equal(resolved, null);
  });

  it("throws on invalid sponsored address", () => {
    assert.throws(
      () =>
        resolveAutoClaimSponsoredFpcFromEnv({
          TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS: "0x1234",
        }),
      /Invalid sponsored FPC address/,
    );
  });
});
