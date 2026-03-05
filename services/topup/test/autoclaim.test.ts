import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveAutoClaimRequirePublishedAccountFromEnv,
  resolveAutoClaimSecretKeyFromEnv,
  resolveAutoClaimSponsoredFpcFromEnv,
} from "../src/autoclaim.js";

const VALID_SECRET_A = "0x1111111111111111111111111111111111111111111111111111111111111111";
const VALID_SECRET_B = "0x2222222222222222222222222222222222222222222222222222222222222222";
const VALID_AZTEC_ADDRESS_A = "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2";
const VALID_AZTEC_ADDRESS_B = "0x2d08e8bdc343c3c91a4e238ae3623200ca8fba484f784660b35e19529862b88b";
const VALID_AZTEC_ADDRESS_C = "0x10f81873fd0989a147dfdfde5dcac8548c8c8c5be21b946132c7c5ce984bc0eb";

describe("resolveAutoClaimSecretKeyFromEnv", () => {
  it("prefers TOPUP_AUTOCLAIM_SECRET_KEY when set", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: VALID_SECRET_A,
      OPERATOR_SECRET_KEY: VALID_SECRET_B,
    });
    assert.equal(resolved, VALID_SECRET_A);
  });

  it("returns null when TOPUP_AUTOCLAIM_SECRET_KEY is unset", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      OPERATOR_SECRET_KEY: VALID_SECRET_B,
    });
    assert.equal(resolved, null);
  });

  it("returns null when TOPUP_AUTOCLAIM_SECRET_KEY is blank", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: "   ",
      OPERATOR_SECRET_KEY: VALID_SECRET_B,
    });
    assert.equal(resolved, null);
  });

  it("can opt-in to OPERATOR_SECRET_KEY fallback", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY: "1",
      OPERATOR_SECRET_KEY: VALID_SECRET_B,
    });
    assert.equal(resolved, VALID_SECRET_B);
  });

  it("returns null when both secret-key env vars are blank or unset", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: "",
      OPERATOR_SECRET_KEY: " ",
    });
    assert.equal(resolved, null);
  });

  it("throws on invalid TOPUP_AUTOCLAIM_SECRET_KEY", () => {
    assert.throws(
      () =>
        resolveAutoClaimSecretKeyFromEnv({
          TOPUP_AUTOCLAIM_SECRET_KEY: "not-a-key",
          OPERATOR_SECRET_KEY: VALID_SECRET_B,
        }),
      /Invalid auto-claim secret key/,
    );
  });
});

describe("resolveAutoClaimSponsoredFpcFromEnv", () => {
  it("prefers TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS when set", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({
      TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_A,
      FPC_DEVNET_SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_B,
      SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_C,
    });
    assert.equal(resolved?.toString(), VALID_AZTEC_ADDRESS_A);
  });

  it("falls back to FPC_DEVNET_SPONSORED_FPC_ADDRESS", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({
      FPC_DEVNET_SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_B,
      SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_C,
    });
    assert.equal(resolved?.toString(), VALID_AZTEC_ADDRESS_B);
  });

  it("falls back to SPONSORED_FPC_ADDRESS", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({
      SPONSORED_FPC_ADDRESS: VALID_AZTEC_ADDRESS_C,
    });
    assert.equal(resolved?.toString(), VALID_AZTEC_ADDRESS_C);
  });

  it("returns null when sponsored address env vars are unset/blank", () => {
    const resolved = resolveAutoClaimSponsoredFpcFromEnv({
      TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS: " ",
      FPC_DEVNET_SPONSORED_FPC_ADDRESS: "",
      SPONSORED_FPC_ADDRESS: "   ",
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

describe("resolveAutoClaimRequirePublishedAccountFromEnv", () => {
  it("defaults to true when unset", () => {
    const resolved = resolveAutoClaimRequirePublishedAccountFromEnv({});
    assert.equal(resolved, true);
  });

  it("accepts false-like values", () => {
    assert.equal(
      resolveAutoClaimRequirePublishedAccountFromEnv({
        TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT: "0",
      }),
      false,
    );
    assert.equal(
      resolveAutoClaimRequirePublishedAccountFromEnv({
        TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT: "false",
      }),
      false,
    );
  });

  it("accepts true-like values", () => {
    assert.equal(
      resolveAutoClaimRequirePublishedAccountFromEnv({
        TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT: "1",
      }),
      true,
    );
    assert.equal(
      resolveAutoClaimRequirePublishedAccountFromEnv({
        TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT: "yes",
      }),
      true,
    );
  });

  it("throws on invalid value", () => {
    assert.throws(
      () =>
        resolveAutoClaimRequirePublishedAccountFromEnv({
          TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT: "maybe",
        }),
      /Invalid TOPUP_AUTOCLAIM_REQUIRE_PUBLISHED_ACCOUNT/,
    );
  });
});
