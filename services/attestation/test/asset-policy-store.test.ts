import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "#test";
import { LmdbAssetPolicyStore } from "../src/asset-policy-store.js";
import type { Config } from "../src/config.js";

function makeConfig(statePath: string): Config {
  return {
    runtime_profile: "development",
    network_id: "aztec-alpha-local",
    fpc_address: "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac",
    contract_variant: "fpc-v1",
    quote_base_url: undefined,
    aztec_node_url: "http://localhost:8080",
    quote_validity_seconds: 300,
    port: 3000,
    supported_assets: [
      {
        address: "0x0000000000000000000000000000000000000000000000000000000000000002",
        name: "humanUSDC",
        market_rate_num: 1,
        market_rate_den: 1000,
        fee_bips: 200,
      },
    ],
    quote_format: "amount_quote",
    operator_secret_provider: "auto",
    operator_address: undefined,
    operator_account_salt: undefined,
    operator_secret_key: "0x0000000000000000000000000000000000000000000000000000000000000001",
    operator_secret_key_source: "config",
    operator_secret_key_provider: "auto",
    operator_secret_key_dual_source: false,
    admin_auth: {
      enabled: true,
      apiKey: "admin-secret",
      apiKeyHeader: "x-admin-api-key",
    },
    asset_policy_state_path: statePath,
    treasury_destination_address: undefined,
    quote_auth: {
      mode: "disabled",
      apiKey: undefined,
      apiKeyHeader: "x-api-key",
      trustedHeaderName: undefined,
      trustedHeaderValue: undefined,
    },
    quote_rate_limit: {
      enabled: true,
      maxRequests: 60,
      windowSeconds: 60,
      maxTrackedKeys: 10000,
    },
    pxe_data_directory: undefined,
  };
}

describe("asset policy store", () => {
  it("looks up a single asset by address", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "asset-policy-store-test-"));
    const dbPath = path.join(dir, "assets-db");

    try {
      const config = makeConfig(dbPath);
      const store = new LmdbAssetPolicyStore(config);

      const seededAddress = "0x0000000000000000000000000000000000000000000000000000000000000002";
      assert.equal(store.get(seededAddress)?.name, "humanUSDC");
      assert.equal(
        store.get("0x0000000000000000000000000000000000000000000000000000000000000099"),
        undefined,
      );

      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists admin-managed supported asset state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "asset-policy-store-test-"));
    const dbPath = path.join(dir, "assets-db");

    try {
      const config = makeConfig(dbPath);
      const store = new LmdbAssetPolicyStore(config);
      await store.upsert({
        address: "0x0000000000000000000000000000000000000000000000000000000000000003",
        name: "ravenETH",
        market_rate_num: 3,
        market_rate_den: 1000,
        fee_bips: 50,
      });
      await store.close();

      const reloaded = new LmdbAssetPolicyStore(config);
      assert.equal(reloaded.getAll().length, 2);
      assert.ok(reloaded.getAll().some((a) => a.name === "ravenETH"));
      await reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
