import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  aztecAddress,
  decimalUint,
  ethAddress,
  isoTimestamp,
  nonNegativeSafeInt,
} from "./manifest-types.js";

// ── Schema ──────────────────────────────────────────────────────────

const testTokenManifestSchema = z.object({
  status: z.literal("deploy_ok"),
  generated_at: isoTimestamp,
  contracts: z.object({
    token: aztecAddress,
    faucet: aztecAddress,
    counter: aztecAddress,
    bridge: aztecAddress,
  }),
  l1_contracts: z.object({
    token_portal: ethAddress,
    erc20: ethAddress,
  }),
  faucet_config: z.object({
    drip_amount: decimalUint,
    cooldown_seconds: nonNegativeSafeInt,
    initial_supply: decimalUint,
  }),
});

// ── Derived type ────────────────────────────────────────────────────

export type TestTokenManifest = z.infer<typeof testTokenManifestSchema>;

// ── Public API ──────────────────────────────────────────────────────

export function readTestTokenManifest(filePath: string): TestTokenManifest {
  const absolute = path.resolve(filePath);
  const raw = JSON.parse(readFileSync(absolute, "utf8"));
  return testTokenManifestSchema.parse(raw);
}

export function writeTestTokenManifest(outPath: string, manifest: TestTokenManifest): void {
  const absolute = path.resolve(outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
