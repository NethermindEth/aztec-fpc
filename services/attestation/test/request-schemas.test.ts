import { describe, expect, it } from "#test";
import {
  AdminAssetAddressSchema,
  AdminAssetPolicyBodySchema,
  AdminSweepRequestBodySchema,
  ColdStartQuoteRequestQuerySchema,
  QuoteRequestQuerySchema,
} from "../src/request-schemas.js";

const VALID_ADDRESS = "0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000000";
const VALID_FR = "0x0896d0dbea3a3e52aff21c683f7053b1372bb4994d2f98a5616aba4fe82599ce";

describe("QuoteRequestQuerySchema", () => {
  it("parses valid input", () => {
    const result = QuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fj_amount).toBe(1000000n);
    }
  });

  it("rejects missing user", () => {
    const result = QuoteRequestQuerySchema.safeParse({
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing required query param: user");
    }
  });

  it("rejects zero user address", () => {
    const result = QuoteRequestQuerySchema.safeParse({
      user: ZERO_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid user address");
    }
  });

  it("rejects invalid fj_amount", () => {
    const result = QuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "not_a_number",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing or invalid query param: fj_amount");
    }
  });

  it("rejects zero fj_amount", () => {
    const result = QuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "0",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing or invalid query param: fj_amount");
    }
  });

  it("rejects fj_amount exceeding u128", () => {
    const u128Max = (1n << 128n) - 1n;
    const result = QuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: (u128Max + 1n).toString(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing or invalid query param: fj_amount");
    }
  });
});

describe("ColdStartQuoteRequestQuerySchema", () => {
  it("parses valid input", () => {
    const result = ColdStartQuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
      claim_amount: "500000",
      claim_secret_hash: VALID_FR,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claim_amount).toBe(500000n);
    }
  });

  it("rejects missing claim_amount", () => {
    const result = ColdStartQuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
      claim_secret_hash: VALID_FR,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing or invalid query param: claim_amount");
    }
  });

  it("rejects missing claim_secret_hash", () => {
    const result = ColdStartQuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
      claim_amount: "500000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Missing required query param: claim_secret_hash",
      );
    }
  });

  it("rejects invalid claim_secret_hash", () => {
    const result = ColdStartQuoteRequestQuerySchema.safeParse({
      user: VALID_ADDRESS,
      accepted_asset: VALID_ADDRESS,
      fj_amount: "1000000",
      claim_amount: "500000",
      claim_secret_hash: "not_a_hex_field",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Invalid claim_secret_hash: not a valid field element",
      );
    }
  });
});

describe("AdminAssetPolicyBodySchema", () => {
  it("parses valid input", () => {
    const result = AdminAssetPolicyBodySchema.safeParse({
      name: "TestToken",
      market_rate_num: 1,
      market_rate_den: 1000,
      fee_bips: 25,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = AdminAssetPolicyBodySchema.safeParse({
      market_rate_num: 1,
      market_rate_den: 1000,
      fee_bips: 25,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing required field: name");
    }
  });

  it("rejects non-positive market_rate_num", () => {
    const result = AdminAssetPolicyBodySchema.safeParse({
      name: "TestToken",
      market_rate_num: 0,
      market_rate_den: 1000,
      fee_bips: 25,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("market_rate_num must be a positive integer");
    }
  });

  it("rejects fee_bips above 10000", () => {
    const result = AdminAssetPolicyBodySchema.safeParse({
      name: "TestToken",
      market_rate_num: 1,
      market_rate_den: 1000,
      fee_bips: 10001,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "fee_bips must be an integer in range [0, 10000]",
      );
    }
  });

  it("accepts fee_bips of 0", () => {
    const result = AdminAssetPolicyBodySchema.safeParse({
      name: "TestToken",
      market_rate_num: 1,
      market_rate_den: 1000,
      fee_bips: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe("AdminSweepRequestBodySchema", () => {
  it("parses valid input with amount", () => {
    const result = AdminSweepRequestBodySchema.safeParse({
      accepted_asset: VALID_ADDRESS,
      destination: VALID_ADDRESS,
      amount: "100",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(100n);
    }
  });

  it("parses valid input without amount", () => {
    const result = AdminSweepRequestBodySchema.safeParse({
      accepted_asset: VALID_ADDRESS,
      destination: VALID_ADDRESS,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBeUndefined();
    }
  });

  it("rejects missing accepted_asset", () => {
    const result = AdminSweepRequestBodySchema.safeParse({
      destination: VALID_ADDRESS,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing required field: accepted_asset");
    }
  });

  it("rejects invalid amount", () => {
    const result = AdminSweepRequestBodySchema.safeParse({
      accepted_asset: VALID_ADDRESS,
      amount: "abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing or invalid field: amount");
    }
  });
});

describe("AdminAssetAddressSchema", () => {
  it("parses valid address", () => {
    const result = AdminAssetAddressSchema.safeParse(VALID_ADDRESS);
    expect(result.success).toBe(true);
  });

  it("rejects missing address", () => {
    const result = AdminAssetAddressSchema.safeParse(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Missing asset address");
    }
  });

  it("rejects zero address", () => {
    const result = AdminAssetAddressSchema.safeParse(ZERO_ADDRESS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid asset address");
    }
  });
});
