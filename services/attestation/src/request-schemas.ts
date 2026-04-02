import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { z } from "zod";

const U128_MAX = (1n << 128n) - 1n;

/** Validates an optional string as a non-zero Aztec address, transforming to AztecAddress. */
export function nonZeroAztecAddressField(missingMessage: string, invalidMessage: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: missingMessage });
        return z.NEVER;
      }
      let parsed: AztecAddress;
      try {
        parsed = AztecAddress.fromString(trimmed);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
        return z.NEVER;
      }
      if (parsed.isZero()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalidMessage });
        return z.NEVER;
      }
      return parsed;
    });
}

/** Validates an optional string as a positive decimal integer within u128 range, transforming to bigint. */
export function positiveU128DecimalField(errorMessage: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim();
      if (!trimmed || !/^[0-9]+$/.test(trimmed) || trimmed.length > 39) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage });
        return z.NEVER;
      }
      const parsed = BigInt(trimmed);
      if (parsed <= 0n || parsed > U128_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage });
        return z.NEVER;
      }
      return parsed;
    });
}

/** Like positiveU128DecimalField but allows undefined (returns undefined for missing values). */
function optionalPositiveU128DecimalField(errorMessage: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      if (!trimmed || !/^[0-9]+$/.test(trimmed) || trimmed.length > 39) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage });
        return z.NEVER;
      }
      const parsed = BigInt(trimmed);
      if (parsed <= 0n || parsed > U128_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage });
        return z.NEVER;
      }
      return parsed;
    });
}

function requiredHexField(label: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing required query param: ${label}`,
        });
        return z.NEVER;
      }
      try {
        return Fr.fromHexString(trimmed);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid ${label}: not a valid field element`,
        });
        return z.NEVER;
      }
    });
}

const positiveIntegerField = (errorMessage: string) =>
  z
    .number({ required_error: errorMessage, invalid_type_error: errorMessage })
    .int(errorMessage)
    .positive(errorMessage);

export const QuoteRequestQuerySchema = z.object({
  user: nonZeroAztecAddressField("Missing required query param: user", "Invalid user address"),
  accepted_asset: nonZeroAztecAddressField(
    "Missing required query param: accepted_asset",
    "Invalid accepted_asset address",
  ),
  fj_amount: positiveU128DecimalField("Missing or invalid query param: fj_amount"),
});

export const ColdStartQuoteRequestQuerySchema = QuoteRequestQuerySchema.extend({
  claim_amount: positiveU128DecimalField("Missing or invalid query param: claim_amount"),
  claim_secret_hash: requiredHexField("claim_secret_hash"),
});

export const AdminAssetPolicyBodySchema = z.object({
  name: z
    .string({
      required_error: "Missing required field: name",
      invalid_type_error: "Missing required field: name",
    })
    .trim()
    .min(1, "Missing required field: name"),
  market_rate_num: positiveIntegerField("market_rate_num must be a positive integer"),
  market_rate_den: positiveIntegerField("market_rate_den must be a positive integer"),
  fee_bips: z
    .number({
      required_error: "fee_bips must be an integer in range [0, 10000]",
      invalid_type_error: "fee_bips must be an integer in range [0, 10000]",
    })
    .int("fee_bips must be an integer in range [0, 10000]")
    .min(0, "fee_bips must be an integer in range [0, 10000]")
    .max(10000, "fee_bips must be an integer in range [0, 10000]"),
});

export const AdminSweepRequestBodySchema = z.object({
  accepted_asset: z
    .string({
      required_error: "Missing required field: accepted_asset",
      invalid_type_error: "Missing required field: accepted_asset",
    })
    .trim()
    .min(1, "Missing required field: accepted_asset"),
  destination: z.string().trim().optional(),
  amount: optionalPositiveU128DecimalField("Missing or invalid field: amount"),
});

export const AdminAssetAddressSchema = nonZeroAztecAddressField(
  "Missing asset address",
  "Invalid asset address",
);
