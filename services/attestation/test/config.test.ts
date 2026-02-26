import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const VALID_SECRET =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

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
  const dir = mkdtempSync(path.join(tmpdir(), "attestation-config-test-"));
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
    "quote_validity_seconds: 300",
    "port: 3000",
    'accepted_asset_address: "0x0000000000000000000000000000000000000000000000000000000000000002"',
    'accepted_asset_name: "humanUSDC"',
    "market_rate_num: 1",
    "market_rate_den: 1000",
    "fee_bips: 200",
    extra,
  ].join("\n");
}

describe("attestation config secret providers", () => {
  it("allows plaintext config secret in development profile", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: undefined,
        OPERATOR_SECRET_REF: undefined,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.runtime_profile, "development");
        assert.equal(config.operator_secret_key_source, "config");
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast in production profile when secret resolves from plaintext config", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: undefined,
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
        ["runtime_profile: production", "operator_secret_provider: auto"].join(
          "\n",
        ),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: VALID_SECRET,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.runtime_profile, "production");
        assert.equal(config.operator_secret_key_source, "env");
        assert.equal(config.operator_secret_key, VALID_SECRET);
      },
    );

    cleanupConfig(configPath);
  });

  it("fails in production when config secret is present even if env secret is set", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: VALID_SECRET,
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

  it("supports pluggable kms provider via adapter hook", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "operator_secret_provider: kms",
          'operator_secret_ref: "kms://operator/secret-key"',
        ].join("\n"),
      ),
    );

    withEnv(
      {
        OPERATOR_SECRET_KEY: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
      },
      () => {
        const config = loadConfig(configPath, {
          secretAdapters: {
            kms: ({ secretRef }) => {
              assert.equal(secretRef, "kms://operator/secret-key");
              return VALID_SECRET;
            },
          },
        });

        assert.equal(config.operator_secret_key_source, "kms");
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast when fpc or accepted asset address is invalid", () => {
    const configPath = writeConfig(
      [
        "runtime_profile: development",
        'fpc_address: "not_an_aztec_address"',
        'aztec_node_url: "http://127.0.0.1:8080"',
        "quote_validity_seconds: 300",
        "port: 3000",
        'accepted_asset_address: "still_not_an_aztec_address"',
        'accepted_asset_name: "humanUSDC"',
        "market_rate_num: 1",
        "market_rate_den: 1000",
        "fee_bips: 200",
        "operator_secret_provider: auto",
        `operator_secret_key: "${VALID_SECRET}"`,
      ].join("\n"),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: undefined,
      },
      () => {
        assert.throws(() => loadConfig(configPath), /valid Aztec address/);
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast when fpc or accepted asset address is zero", () => {
    const configPath = writeConfig(
      [
        "runtime_profile: development",
        'fpc_address: "0x0000000000000000000000000000000000000000000000000000000000000000"',
        'aztec_node_url: "http://127.0.0.1:8080"',
        "quote_validity_seconds: 300",
        "port: 3000",
        'accepted_asset_address: "0x0000000000000000000000000000000000000000000000000000000000000000"',
        'accepted_asset_name: "humanUSDC"',
        "market_rate_num: 1",
        "market_rate_den: 1000",
        "fee_bips: 200",
        "operator_secret_provider: auto",
        `operator_secret_key: "${VALID_SECRET}"`,
      ].join("\n"),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: undefined,
      },
      () => {
        assert.throws(() => loadConfig(configPath), /non-zero Aztec address/);
      },
    );

    cleanupConfig(configPath);
  });

  it("accepts explicit operator_address in config", () => {
    const operatorAddress =
      "0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72";
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          `operator_address: "${operatorAddress}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: undefined,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.operator_address, operatorAddress);
      },
    );

    cleanupConfig(configPath);
  });

  it("validates AZTEC_NODE_URL env override as URL", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withEnv(
      {
        AZTEC_NODE_URL: "not-a-url",
        FPC_RUNTIME_PROFILE: undefined,
        OPERATOR_SECRET_PROVIDER: undefined,
        OPERATOR_SECRET_KEY: undefined,
      },
      () => {
        assert.throws(() => loadConfig(configPath), /Invalid url/);
      },
    );

    cleanupConfig(configPath);
  });
});
