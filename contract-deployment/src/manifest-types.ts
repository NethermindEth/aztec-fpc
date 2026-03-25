import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { EthAddress } from "@aztec/foundation/eth-address";
import { z } from "zod";

export const aztecAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 64-hex-char Aztec address")
  .refine((v) => !/^0x0{64}$/i.test(v), "zero address not allowed")
  .transform((v) => AztecAddress.fromString(v));

export const ethAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 40-hex-char EVM address")
  .refine((v) => !/^0x0{40}$/i.test(v), "zero address not allowed")
  .transform((v) => EthAddress.fromString(v));

export const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 64-hex-char tx hash")
  .refine((v) => !/^0x0{64}$/i.test(v), "zero hash not allowed");

export const fieldValue = z
  .string()
  .regex(
    /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/,
    "expected decimal integer or 0x-prefixed hex field value",
  )
  .transform((v) => Fr.fromHexString(v));

export const httpUrl = z
  .string()
  .url()
  .refine((v) => {
    const p = new URL(v).protocol;
    return p === "http:" || p === "https:";
  }, "expected http(s) URL");

export const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "expected ISO timestamp");

export const positiveSafeInt = z
  .number()
  .int()
  .positive()
  .refine((v) => Number.isSafeInteger(v), "expected safe integer");

export const nonNegativeSafeInt = z
  .number()
  .int()
  .nonnegative()
  .refine((v) => Number.isSafeInteger(v), "expected safe integer");

export const decimalUint = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "expected non-negative decimal integer");
