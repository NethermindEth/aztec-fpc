import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  fpc_address: z.string(),
  aztec_node_url: z.string().url(),
  quote_validity_seconds: z.number().int().positive().default(300),
  port: z.number().int().positive().default(3000),
  /** The single token contract address this FPC accepts. Must match accepted_asset in the deployed contract. */
  accepted_asset_address: z.string(),
  accepted_asset_name: z.string(),
  /** Baseline exchange rate: accepted_asset units per 1 FeeJuice. */
  market_rate_num: z.number().int().positive(),
  market_rate_den: z.number().int().positive(),
  /** Operator margin in basis points (100 = 1%). Applied on top of market rate. */
  fee_bips: z.number().int().min(0).max(10000),
  /** TODO: replace with KMS/HSM lookup in production — never store raw keys on disk. */
  operator_secret_key: z.string(),
  /** Optional directory for local PXE persistent state (LMDB).
   *  When set, the service spins up a local PXE so it can call
   *  registerSender() and discover private fee-payment notes. */
  pxe_data_directory: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  return ConfigSchema.parse(parsed);
}

/** Compute the final exchange rate incorporating the operator margin.
 *
 * final_rate = market_rate * (10000 + fee_bips) / 10000
 *
 * Kept as a fraction (num, den) to avoid floating point. The contract
 * ceiling-divides, so the operator is guaranteed to collect at least
 * fee_bips of margin.
 */
export function computeFinalRate(config: Config): {
  rate_num: bigint;
  rate_den: bigint;
} {
  const rate_num =
    BigInt(config.market_rate_num) * BigInt(10000 + config.fee_bips);
  const rate_den = BigInt(config.market_rate_den) * BigInt(10000);
  return { rate_num, rate_den };
}
