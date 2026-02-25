import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  fpc_address: z.string(),
  aztec_node_url: z.string().url(),
  /** Optional override for the L2 FeeJuice protocol contract address. */
  fee_juice_address: z.string().optional(),
  l1_rpc_url: z.string().url(),
  /** TODO: replace with KMS/HSM lookup in production. */
  l1_operator_private_key: z.string(),
  /** Bridge when FPC balance drops below this (bigint string, wei units). */
  threshold: z.string(),
  /** Amount to bridge per top-up (bigint string, wei units). */
  top_up_amount: z.string(),
  check_interval_ms: z.number().int().positive().default(60_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  return ConfigSchema.parse(parsed);
}
