import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const AZTEC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

const PositiveBigIntString = z
  .string()
  .regex(UINT_DECIMAL_PATTERN, "must be an unsigned integer string")
  .refine((value) => BigInt(value) > 0n, "must be greater than zero");

const ConfigSchema = z
  .object({
    fpc_address: z
      .string()
      .regex(
        AZTEC_ADDRESS_PATTERN,
        "must be a 32-byte 0x-prefixed hex address",
      ),
    aztec_node_url: z.string().url(),
    /** Optional override for the L2 FeeJuice protocol contract address. */
    fee_juice_address: z
      .string()
      .regex(AZTEC_ADDRESS_PATTERN, "must be a 32-byte 0x-prefixed hex address")
      .optional(),
    l1_chain_id: z.number().int().positive(),
    l1_rpc_url: z.string().url(),
    fee_juice_portal_address: z
      .string()
      .regex(ETH_ADDRESS_PATTERN, "must be a 20-byte 0x-prefixed hex address"),
    /** TODO: replace with KMS/HSM lookup in production. */
    l1_operator_private_key: z
      .string()
      .regex(
        PRIVATE_KEY_PATTERN,
        "must be a 32-byte 0x-prefixed hex private key",
      ),
    /** Bridge when FPC balance drops below this (bigint string, wei units). */
    threshold: PositiveBigIntString,
    /** Amount to bridge per top-up (bigint string, wei units). */
    top_up_amount: PositiveBigIntString,
    check_interval_ms: z.number().int().positive().default(60_000),
    confirmation_timeout_ms: z.number().int().positive().default(180_000),
    confirmation_poll_initial_ms: z.number().int().positive().default(1_000),
    confirmation_poll_max_ms: z.number().int().positive().default(15_000),
  })
  .superRefine((config, ctx) => {
    if (config.confirmation_poll_initial_ms > config.confirmation_poll_max_ms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "confirmation_poll_initial_ms must be less than or equal to confirmation_poll_max_ms",
        path: ["confirmation_poll_initial_ms"],
      });
    }

    if (config.confirmation_poll_max_ms > config.confirmation_timeout_ms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "confirmation_poll_max_ms must be less than or equal to confirmation_timeout_ms",
        path: ["confirmation_poll_max_ms"],
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  return ConfigSchema.parse(parsed);
}
