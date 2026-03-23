import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { EthAddress } from "@aztec/foundation/eth-address";
import { z } from "zod";

// ── Custom Zod primitives ───────────────────────────────────────────

const aztecAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 64-hex-char Aztec address")
  .refine((v) => !/^0x0{64}$/i.test(v), "zero address not allowed")
  .transform((v) => AztecAddress.fromString(v));

const ethAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 40-hex-char EVM address")
  .refine((v) => !/^0x0{40}$/i.test(v), "zero address not allowed")
  .transform((v) => EthAddress.fromString(v));

const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 64-hex-char tx hash")
  .refine((v) => !/^0x0{64}$/i.test(v), "zero hash not allowed");

const fieldValue = z
  .string()
  .regex(
    /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/,
    "expected decimal integer or 0x-prefixed hex field value",
  )
  .transform((v) => Fr.fromHexString(v));

const httpUrl = z
  .string()
  .url()
  .refine((v) => {
    const p = new URL(v).protocol;
    return p === "http:" || p === "https:";
  }, "expected http(s) URL");

const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "expected ISO timestamp");

const positiveSafeInt = z
  .number()
  .int()
  .positive()
  .refine((v) => Number.isSafeInteger(v), "expected safe integer");

const nonNegativeSafeInt = z
  .number()
  .int()
  .nonnegative()
  .refine((v) => Number.isSafeInteger(v), "expected safe integer");

const decimalUint = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "expected non-negative decimal integer");

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
    accepted_asset: aztecAddress,
    fpc: aztecAddress,
    faucet: aztecAddress.optional(),
    counter: aztecAddress.optional(),
    bridge: aztecAddress.optional(),
  }),
  l1_contracts: z
    .object({
      token_portal: ethAddress,
      erc20: ethAddress,
    })
    .optional(),
  fpc_artifact: z
    .object({
      name: z.literal("FPCMultiAsset"),
      path: z.string().min(1),
    })
    .optional(),
  operator: z.object({
    address: aztecAddress,
    pubkey_x: fieldValue,
    pubkey_y: fieldValue,
  }),
  tx_hashes: z.object({
    accepted_asset_deploy: txHash.nullable(),
    fpc_deploy: txHash.nullable(),
    faucet_deploy: txHash.nullable().optional(),
    counter_deploy: txHash.nullable().optional(),
    bridge_deploy: txHash.nullable().optional(),
  }),
  faucet_config: z
    .object({
      drip_amount: decimalUint,
      cooldown_seconds: nonNegativeSafeInt,
      initial_supply: decimalUint,
    })
    .optional(),
  payment_mode: z.string().min(1).optional(),
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
