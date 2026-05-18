# Configuration

Reference for all configuration options across FPC services.

[Source: attestation config](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts) | [Source: topup config](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/config.ts)

## Hierarchy

1. YAML config file (`--config` CLI flag, or `/app/config.yaml` in Docker)
2. Environment variables override YAML
3. CLI arguments override both

## Runtime profiles

| Profile | Behavior |
|---------|----------|
| `development` | Permissive. Allows plaintext config secrets. |
| `test` | Same as development. |
| `production` | Rejects plaintext config secrets at startup. Requires `env`, `kms`, or `hsm` for secret providers. Requires `quote_auth_mode != disabled`. |

> [!CAUTION]
> Always use `runtime_profile: production` in production.

---

## Attestation Service

**Config file:** `services/attestation/config.example.yaml`

| YAML Key | Env Var | Default | Description |
|---|---|---|---|
| `network_id` | | `aztec-alpha-local` | Network identifier (string, e.g. `aztec-testnet`). YAML only. |
| `fpc_address` | | (required) | Deployed FPC contract address. YAML only. |
| `contract_variant` | | `fpc-v1` | Contract flavour identifier emitted in discovery. |
| `aztec_node_url` | `AZTEC_NODE_URL` | (required) | Aztec node PXE endpoint. |
| `quote_base_url` | | | External base URL for discovery clients. YAML only. |
| `port` | | `3000` | HTTP listen port. YAML only. |
| `runtime_profile` | `FPC_RUNTIME_PROFILE` | `development` | `development`, `test`, or `production`. |
| `pxe_data_directory` | | | PXE data dir (recommended in production for note persistence). YAML only. |

### Operator key

| YAML Key | Env Var | Default | Description |
|---|---|---|---|
| `operator_secret_provider` | `OPERATOR_SECRET_PROVIDER` | `auto` | `auto`, `env`, `config`, `kms`, `hsm`. |
| `operator_secret_ref` | `OPERATOR_SECRET_REF` | | KMS or secret-manager reference (preferred in production). |
| | `OPERATOR_SECRET_KEY` | | Plaintext key (avoid in production). |
| `operator_address` | | | Operator L2 address (only when account salt is non-zero). |
| `operator_account_salt` | `OPERATOR_ACCOUNT_SALT` | | Account salt (32-byte hex). |

### Quotes

| YAML Key | Env Var | Default | Description |
|---|---|---|---|
| `quote_validity_seconds` | | `300` | Quote lifetime. On-chain caps TTL at 3600. |
| `quote_format` | | `amount_quote` | `amount_quote` or `rate_quote`. Must match the contract. |
| `quote_auth_mode` | `QUOTE_AUTH_MODE` | `disabled` | `disabled` (dev only), `api_key`, `trusted_header`, `api_key_or_trusted_header`, `api_key_and_trusted_header`. |
| `quote_auth_api_key_header` | `QUOTE_AUTH_API_KEY_HEADER` | `x-api-key` | Header name for API key. |
| | `QUOTE_AUTH_API_KEY` | | Shared secret. |
| `quote_auth_trusted_header_name` | `QUOTE_AUTH_TRUSTED_HEADER_NAME` | | Reverse-proxy-set header name. |
| | `QUOTE_AUTH_TRUSTED_HEADER_VALUE` | | Required value of the trusted header. |

### Rate limiting

Fixed-window limiting on `/quote`.

| YAML Key | Env Var | Default | Description |
|---|---|---|---|
| `quote_rate_limit_enabled` | `QUOTE_RATE_LIMIT_ENABLED` | `true` | Master toggle. |
| `quote_rate_limit_max_requests` | `QUOTE_RATE_LIMIT_MAX_REQUESTS` | `60` | Per-key cap (max 1,000,000). |
| `quote_rate_limit_window_seconds` | `QUOTE_RATE_LIMIT_WINDOW_SECONDS` | `60` | Window length (max 3600). |
| `quote_rate_limit_max_tracked_keys` | `QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS` | `10000` | Distinct keys held in memory. |

### Admin

| YAML Key | Env Var | Default | Description |
|---|---|---|---|
| `admin_api_key_header` | `ADMIN_API_KEY_HEADER` | `x-admin-api-key` | Header name for admin auth. |
| | `ADMIN_API_KEY` | | Admin key. Admin endpoints disabled unless set. |
| `treasury_destination_address` | `TREASURY_DESTINATION_ADDRESS` | | Default destination for `POST /admin/sweeps`. |
| `asset_policy_state_path` | `ATTESTATION_ASSET_POLICY_STATE_PATH` | `.attestation-asset-policies` | LMDB directory. |

### Assets

`supported_assets` array. Each entry seeds the asset policy store on first boot. Subsequent admin API mutations persist to LMDB and become authoritative.

```yaml
supported_assets:
  - address: "0x..."
    name: "humanUSDC"           # Human-readable name surfaced in /accepted-assets
    market_rate_num: 1          # Asset units per 1 Fee Juice (numerator)
    market_rate_den: 1000       # Denominator
    fee_bips: 200               # Operator margin (200 bips = 2%)
```

Required per entry: non-zero `address`, non-empty `name`, positive `market_rate_num`, positive `market_rate_den`, `fee_bips` 0-10000. Payment math: see [exchange rate](../quote-system.md#exchange-rate).

> [!TIP]
> Prefer `operator_secret_ref` (KMS) over `OPERATOR_SECRET_KEY`. Setting `runtime_profile: production` enforces this at startup.

---

## Top-up Service

**Config file:** `services/topup/config.example.yaml`

| YAML Key | Env Var | Default | Description |
|---|---|---|---|
| `aztec_node_url` | `AZTEC_NODE_URL` | (required) | Aztec node URL. |
| `l1_rpc_url` | `L1_RPC_URL` | (required) | L1 Ethereum RPC. Validated against the node-reported L1 chain ID at startup. |
| `fpc_address` | | (required) | FPC contract to monitor. |
| `threshold` | | (required) | Bridge when balance drops below this (Fee Juice base units, 18 decimals, decimal string). |
| `top_up_amount` | | (required) | Amount per bridge (Fee Juice base units, 18 decimals). Must be ≥ `threshold`. |
| `data_dir` | `TOPUP_DATA_DIR` | `.topup-data` | LMDB for in-flight bridge state. |
| `check_interval_ms` | | `60000` | Balance check cadence. |
| `confirmation_timeout_ms` | | `180000` | Max wait for L2 settlement. |
| `confirmation_poll_initial_ms` | | `1000` | Initial poll interval. |
| `confirmation_poll_max_ms` | | `15000` | Max poll interval (exponential backoff). |
| `ops_port` | `TOPUP_OPS_PORT` | `3001` | Health/readiness/metrics port. |
| `runtime_profile` | `FPC_RUNTIME_PROFILE` | `development` | `development`, `test`, or `production`. |

### L1 operator key

| YAML Key | Env Var | Description |
|---|---|---|
| `l1_operator_secret_provider` | | `auto`, `env`, `config`, `kms`, `hsm`. |
| `l1_operator_secret_ref` | | KMS or secret-manager reference. |
| `l1_operator_private_key` | `L1_OPERATOR_PRIVATE_KEY` | Plaintext (avoid in production). |

The L1 operator must hold ETH (for L1 transaction fees) and the Fee Juice ERC-20. Helper: `bun run fund:l1:fee-juice`.

### Auto-claim (env vars only)

| Env Var | Default | Description |
|---|---|---|
| `TOPUP_AUTOCLAIM_ENABLED` | enabled (unset) | Set to `0` to disable. |
| `TOPUP_AUTOCLAIM_SECRET_KEY` | | L2 claimer secret. Required in `production`. Falls back to a test account in `development`. |
| `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` | | Sponsored FPC for fee-less claims. |

---

## Contract Deployment Container

| Env Var | Required | Description |
|---|:---:|---|
| `AZTEC_NODE_URL` | Yes | Aztec node URL. |
| `FPC_DEPLOYER_SECRET_KEY` (or `_REF`) | Yes | L2 deployer key. |
| `FPC_OPERATOR_SECRET_KEY` (or `_REF`) | | Defaults to deployer if omitted. |
| `FPC_L1_DEPLOYER_KEY` | Test tokens | L1 deployer key. |
| `L1_RPC_URL` | Test tokens | L1 RPC. |
| `FPC_SPONSORED_FPC_ADDRESS` | | Pay deploy fees via existing sponsored FPC. |
| `FPC_ACCEPTED_ASSET` | | Reuse existing token (skips deploy). |
| `FPC_ATTESTATION_URL` | `configure-token` | Attestation URL for registration. |
| `ADMIN_API_KEY` | `configure-token` | Attestation admin key. |
| `FPC_PREFLIGHT_ONLY` | | `1` = validate only, no transactions. |
| `FPC_DATA_DIR` | | Data directory (default `./deployments`). |
| `FPC_OUT` | | Manifest path (default `$FPC_DATA_DIR/manifest.json`). |

---

## Master Config

`fpc-config.yaml` controls operator-tunable settings split into per-service configs at deploy.

```bash
mkdir -p deployments
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
```

| Section | Field | Description |
|---|---|---|
| `tokens` | `name`, `symbol`, `address?` | Identity. Omit `address` to deploy a test token. |
| `tokens` | `market_rate_num`, `market_rate_den`, `fee_bips` | Pricing per token. |
| `attestation` | `quote_validity_seconds`, `quote_auth_mode` | Quote settings. |
| `topup` | `threshold`, `top_up_amount`, `check_interval_ms` | Bridge thresholds and cadence. |

Re-generate per-service configs from a manifest:

```bash
docker run -v ./deployments:/app/deployments \
  --entrypoint bash \
  nethermind/aztec-fpc-contract-deployment:local \
  scripts/config/generate-service-configs.sh
```

## Per-environment layout

```
deployments/
├── fpc-config.example.yaml    # Master template
├── local/fpc-config.yaml
├── devnet/fpc-config.yaml
└── testnet/fpc-config.yaml
```

## Next Steps

- [Deploy services](./deployment.md)
- [Run an FPC operator](../how-to/run-operator.md)
- [Set up monitoring](../reference/metrics.md)
