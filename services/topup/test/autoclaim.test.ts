import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAutoClaimSecretKeyFromEnv } from "../src/autoclaim.js";

const VALID_SECRET_A =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const VALID_SECRET_B =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

describe("resolveAutoClaimSecretKeyFromEnv", () => {
  it("prefers TOPUP_AUTOCLAIM_SECRET_KEY when set", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: VALID_SECRET_A,
      OPERATOR_SECRET_KEY: VALID_SECRET_B,
    });
    assert.equal(resolved, VALID_SECRET_A);
  });

  it("falls back to OPERATOR_SECRET_KEY when TOPUP_AUTOCLAIM_SECRET_KEY is unset", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      OPERATOR_SECRET_KEY: VALID_SECRET_B,
    });
    assert.equal(resolved, VALID_SECRET_B);
  });

  it("falls back to OPERATOR_SECRET_KEY when TOPUP_AUTOCLAIM_SECRET_KEY is blank", () => {
    const resolved = resolveAutoClaimSecretKeyFromEnv({
      TOPUP_AUTOCLAIM_SECRET_KEY: "   ",
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
