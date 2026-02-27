import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const VALID_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    original.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "topup-config-test-"));
  const filePath = path.join(dir, "config.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function cleanupConfig(configPath: string): void {
  rmSync(path.dirname(configPath), { recursive: true, force: true });
}

function baseConfigYaml(extra: string): string {
  return [
    'fpc_address: "0x27e0f62fe6edf34f850dd7c1cc7cd638f7ec38ed3eb5ae4bd8c0c941c78e67ac"',
    'aztec_node_url: "http://127.0.0.1:8080"',
    'l1_rpc_url: "http://127.0.0.1:8545"',
    'threshold: "1000000000000000000"',
    'top_up_amount: "10000000000000000000"',
    "check_interval_ms: 60000",
    "confirmation_timeout_ms: 180000",
    "confirmation_poll_initial_ms: 1000",
    "confirmation_poll_max_ms: 15000",
    extra,
  ].join("\n");
}

describe("topup config secret providers", () => {
  it("allows plaintext config secret in development profile", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "l1_operator_secret_provider: auto",
          `l1_operator_private_key: "${VALID_PRIVATE_KEY}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        L1_OPERATOR_PRIVATE_KEY: undefined,
        TOPUP_BRIDGE_STATE_PATH: undefined,
        TOPUP_OPS_PORT: undefined,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.runtime_profile, "development");
        assert.equal(config.l1_operator_private_key_source, "config");
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast in production profile when secret resolves from plaintext config", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "l1_operator_secret_provider: auto",
          `l1_operator_private_key: "${VALID_PRIVATE_KEY}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        L1_OPERATOR_PRIVATE_KEY: undefined,
        TOPUP_BRIDGE_STATE_PATH: undefined,
        TOPUP_OPS_PORT: undefined,
      },
      () => {
        assert.throws(
          () => loadConfig(configPath),
          /plaintext config secrets are not allowed/,
        );
      },
    );

    cleanupConfig(configPath);
  });

  it("uses env secret in production profile", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "l1_operator_secret_provider: auto",
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        L1_OPERATOR_PRIVATE_KEY: VALID_PRIVATE_KEY,
        TOPUP_BRIDGE_STATE_PATH: undefined,
        TOPUP_OPS_PORT: undefined,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.runtime_profile, "production");
        assert.equal(config.l1_operator_private_key_source, "env");
        assert.equal(config.l1_operator_private_key, VALID_PRIVATE_KEY);
      },
    );

    cleanupConfig(configPath);
  });

  it("fails in production when config secret is present even if env secret is set", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "l1_operator_secret_provider: auto",
          `l1_operator_private_key: "${VALID_PRIVATE_KEY}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        L1_OPERATOR_PRIVATE_KEY: VALID_PRIVATE_KEY,
        TOPUP_BRIDGE_STATE_PATH: undefined,
        TOPUP_OPS_PORT: undefined,
      },
      () => {
        assert.throws(
          () => loadConfig(configPath),
          /plaintext config secrets are not allowed/,
        );
      },
    );

    cleanupConfig(configPath);
  });

  it("supports pluggable hsm provider via adapter hook", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "l1_operator_secret_provider: hsm",
          'l1_operator_secret_ref: "hsm://wallets/topup/l1-key"',
        ].join("\n"),
      ),
    );

    withEnv(
      {
        L1_OPERATOR_PRIVATE_KEY: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        TOPUP_BRIDGE_STATE_PATH: undefined,
        TOPUP_OPS_PORT: undefined,
      },
      () => {
        const config = loadConfig(configPath, {
          secretAdapters: {
            hsm: ({ secretRef }) => {
              assert.equal(secretRef, "hsm://wallets/topup/l1-key");
              return VALID_PRIVATE_KEY;
            },
          },
        });

        assert.equal(config.l1_operator_private_key_source, "hsm");
      },
    );

    cleanupConfig(configPath);
  });

  it("supports bridge state path override via env", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "l1_operator_secret_provider: auto",
          `l1_operator_private_key: "${VALID_PRIVATE_KEY}"`,
          'bridge_state_path: "./state-from-config.json"',
        ].join("\n"),
      ),
    );

    withEnv(
      {
        L1_OPERATOR_PRIVATE_KEY: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        TOPUP_BRIDGE_STATE_PATH: "./state-from-env.json",
        TOPUP_OPS_PORT: undefined,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.bridge_state_path, "./state-from-env.json");
      },
    );

    cleanupConfig(configPath);
  });

  it("supports ops port override via env", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "l1_operator_secret_provider: auto",
          `l1_operator_private_key: "${VALID_PRIVATE_KEY}"`,
          "ops_port: 3001",
        ].join("\n"),
      ),
    );

    withEnv(
      {
        L1_OPERATOR_PRIVATE_KEY: undefined,
        L1_OPERATOR_SECRET_PROVIDER: undefined,
        TOPUP_BRIDGE_STATE_PATH: undefined,
        TOPUP_OPS_PORT: "3100",
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.ops_port, 3100);
      },
    );

    cleanupConfig(configPath);
  });
});
