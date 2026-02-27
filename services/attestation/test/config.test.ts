import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const VALID_SECRET =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const QUOTE_API_KEY = "test-quote-api-key";

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

function withAttestationEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  withEnv(
    {
      AZTEC_NODE_URL: undefined,
      FPC_RUNTIME_PROFILE: undefined,
      OPERATOR_SECRET_PROVIDER: undefined,
      OPERATOR_SECRET_KEY: undefined,
      OPERATOR_SECRET_REF: undefined,
      QUOTE_AUTH_MODE: undefined,
      QUOTE_AUTH_API_KEY: undefined,
      QUOTE_AUTH_API_KEY_HEADER: undefined,
      QUOTE_AUTH_TRUSTED_HEADER_NAME: undefined,
      QUOTE_AUTH_TRUSTED_HEADER_VALUE: undefined,
      QUOTE_RATE_LIMIT_ENABLED: undefined,
      QUOTE_RATE_LIMIT_MAX_REQUESTS: undefined,
      QUOTE_RATE_LIMIT_WINDOW_SECONDS: undefined,
      QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS: undefined,
      ...overrides,
    },
    fn,
  );
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

    withAttestationEnv({}, () => {
      const config = loadConfig(configPath);
      assert.equal(config.runtime_profile, "development");
      assert.equal(config.operator_secret_key_source, "config");
    });

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

    withAttestationEnv({}, () => {
      assert.throws(
        () => loadConfig(configPath),
        /plaintext config secrets are not allowed/,
      );
    });

    cleanupConfig(configPath);
  });

  it("uses env secret in production profile", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "operator_secret_provider: auto",
          "quote_auth_mode: api_key",
          `quote_auth_api_key: "${QUOTE_API_KEY}"`,
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        OPERATOR_SECRET_KEY: VALID_SECRET,
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.runtime_profile, "production");
        assert.equal(config.operator_secret_key_source, "env");
        assert.equal(config.operator_secret_key, VALID_SECRET);
        assert.equal(config.quote_auth.mode, "api_key");
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

    withAttestationEnv(
      {
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
          "quote_auth_mode: api_key",
          `quote_auth_api_key: "${QUOTE_API_KEY}"`,
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        OPERATOR_SECRET_KEY: undefined,
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

    withAttestationEnv({}, () => {
      assert.throws(() => loadConfig(configPath), /valid Aztec address/);
    });

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

    withAttestationEnv({}, () => {
      assert.throws(() => loadConfig(configPath), /non-zero Aztec address/);
    });

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

    withAttestationEnv({}, () => {
      const config = loadConfig(configPath);
      assert.equal(config.operator_address, operatorAddress);
    });

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

    withAttestationEnv(
      {
        AZTEC_NODE_URL: "not-a-url",
      },
      () => {
        assert.throws(() => loadConfig(configPath), /Invalid url/);
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast in production when quote auth mode is disabled", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: production",
          "operator_secret_provider: auto",
          "quote_auth_mode: disabled",
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        OPERATOR_SECRET_KEY: VALID_SECRET,
      },
      () => {
        assert.throws(
          () => loadConfig(configPath),
          /quote_auth_mode must not be disabled/,
        );
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast when api_key auth mode is missing a key", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          "quote_auth_mode: api_key",
        ].join("\n"),
      ),
    );

    withAttestationEnv({}, () => {
      assert.throws(() => loadConfig(configPath), /Missing quote auth API key/);
    });

    cleanupConfig(configPath);
  });

  it("fails fast when trusted_header mode has incomplete header config", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          "quote_auth_mode: trusted_header",
          'quote_auth_trusted_header_name: "x-internal-attestation"',
        ].join("\n"),
      ),
    );

    withAttestationEnv({}, () => {
      assert.throws(
        () => loadConfig(configPath),
        /Missing trusted upstream auth header config/,
      );
    });

    cleanupConfig(configPath);
  });

  it("accepts api_key auth mode and normalizes the api key header name", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          "quote_auth_mode: api_key",
          `quote_auth_api_key: "${QUOTE_API_KEY}"`,
          'quote_auth_api_key_header: "X-Custom-Key"',
        ].join("\n"),
      ),
    );

    withAttestationEnv({}, () => {
      const config = loadConfig(configPath);
      assert.equal(config.quote_auth.mode, "api_key");
      assert.equal(config.quote_auth.apiKey, QUOTE_API_KEY);
      assert.equal(config.quote_auth.apiKeyHeader, "x-custom-key");
    });

    cleanupConfig(configPath);
  });

  it("fails fast when api_key_and_trusted_header reuses the same header name", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          "quote_auth_mode: api_key_and_trusted_header",
          `quote_auth_api_key: "${QUOTE_API_KEY}"`,
          'quote_auth_api_key_header: "x-shared-auth"',
          'quote_auth_trusted_header_name: "x-shared-auth"',
          'quote_auth_trusted_header_value: "allow"',
        ].join("\n"),
      ),
    );

    withAttestationEnv({}, () => {
      assert.throws(
        () => loadConfig(configPath),
        /quote_auth_api_key_header and quote_auth_trusted_header_name must differ/,
      );
    });

    cleanupConfig(configPath);
  });

  it("applies quote auth env overrides over config values", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          "quote_auth_mode: disabled",
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        QUOTE_AUTH_MODE: "api_key",
        QUOTE_AUTH_API_KEY: QUOTE_API_KEY,
        QUOTE_AUTH_API_KEY_HEADER: "X-Env-Api-Key",
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.quote_auth.mode, "api_key");
        assert.equal(config.quote_auth.apiKey, QUOTE_API_KEY);
        assert.equal(config.quote_auth.apiKeyHeader, "x-env-api-key");
      },
    );

    cleanupConfig(configPath);
  });

  it("applies default quote rate limit settings", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withAttestationEnv({}, () => {
      const config = loadConfig(configPath);
      assert.equal(config.quote_rate_limit.enabled, true);
      assert.equal(config.quote_rate_limit.maxRequests, 60);
      assert.equal(config.quote_rate_limit.windowSeconds, 60);
      assert.equal(config.quote_rate_limit.maxTrackedKeys, 10000);
    });

    cleanupConfig(configPath);
  });

  it("applies quote rate limit env overrides over config values", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
          "quote_rate_limit_enabled: true",
          "quote_rate_limit_max_requests: 20",
          "quote_rate_limit_window_seconds: 120",
          "quote_rate_limit_max_tracked_keys: 2048",
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        QUOTE_RATE_LIMIT_ENABLED: "false",
        QUOTE_RATE_LIMIT_MAX_REQUESTS: "7",
        QUOTE_RATE_LIMIT_WINDOW_SECONDS: "30",
        QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS: "256",
      },
      () => {
        const config = loadConfig(configPath);
        assert.equal(config.quote_rate_limit.enabled, false);
        assert.equal(config.quote_rate_limit.maxRequests, 7);
        assert.equal(config.quote_rate_limit.windowSeconds, 30);
        assert.equal(config.quote_rate_limit.maxTrackedKeys, 256);
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast when quote rate limit env override is invalid", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        QUOTE_RATE_LIMIT_MAX_REQUESTS: "0",
      },
      () => {
        assert.throws(
          () => loadConfig(configPath),
          /Invalid QUOTE_RATE_LIMIT_MAX_REQUESTS/,
        );
      },
    );

    cleanupConfig(configPath);
  });

  it("fails fast when quote rate limit enabled override is not a boolean", () => {
    const configPath = writeConfig(
      baseConfigYaml(
        [
          "runtime_profile: development",
          "operator_secret_provider: auto",
          `operator_secret_key: "${VALID_SECRET}"`,
        ].join("\n"),
      ),
    );

    withAttestationEnv(
      {
        QUOTE_RATE_LIMIT_ENABLED: "maybe",
      },
      () => {
        assert.throws(
          () => loadConfig(configPath),
          /Invalid QUOTE_RATE_LIMIT_ENABLED/,
        );
      },
    );

    cleanupConfig(configPath);
  });
});
