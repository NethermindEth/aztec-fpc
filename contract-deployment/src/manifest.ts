import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  aztecAddress,
  ethAddress,
  fieldValue,
  httpUrl,
  isoTimestamp,
  positiveSafeInt,
  txHash,
} from "./manifest-types.js";

// ── Schema ──────────────────────────────────────────────────────────

const deployManifestSchema = z.object({
  status: z.literal("deploy_ok"),
  generated_at: isoTimestamp,
  network: z.object({
    node_url: httpUrl,
    node_version: z.string().min(1),
    l1_chain_id: positiveSafeInt,
    rollup_version: positiveSafeInt,
  }),
  aztec_required_addresses: z.object({
    l1_contract_addresses: z.object({
      registryAddress: ethAddress,
      rollupAddress: ethAddress,
      inboxAddress: ethAddress,
      outboxAddress: ethAddress,
      feeJuiceAddress: ethAddress,
      feeJuicePortalAddress: ethAddress,
      feeAssetHandlerAddress: ethAddress.optional(),
    }),
    protocol_contract_addresses: z.object({
      instanceRegistry: aztecAddress,
      classRegistry: aztecAddress,
      multiCallEntrypoint: aztecAddress,
      feeJuice: aztecAddress,
    }),
    sponsored_fpc_address: aztecAddress.optional(),
  }),
  deployer_address: aztecAddress,
  contracts: z.object({
    fpc: aztecAddress,
  }),
  operator: z.object({
    address: aztecAddress,
    pubkey_x: fieldValue,
    pubkey_y: fieldValue,
  }),
  tx_hashes: z.object({
    fpc_deploy: txHash,
  }),
});

// ── Derived type ────────────────────────────────────────────────────

export type DeployManifest = z.infer<typeof deployManifestSchema>;

// ── Public API ──────────────────────────────────────────────────────

export function validateDeployManifest(input: unknown): DeployManifest {
  return deployManifestSchema.parse(input);
}

export function readDeployManifest(filePath: string): DeployManifest {
  const absolute = path.resolve(filePath);
  const raw = JSON.parse(readFileSync(absolute, "utf8"));
  return deployManifestSchema.parse(raw);
}

export function writeDeployManifest(outPath: string, manifest: DeployManifest): void {
  const absolute = path.resolve(outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
