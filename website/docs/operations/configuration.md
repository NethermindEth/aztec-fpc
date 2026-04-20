# Configuration

Complete reference for all configuration options across FPC services.

## Configuration Hierarchy

All services follow the same precedence:

1. **YAML config file**: base configuration (path from `CONFIG_PATH` env var or `/app/config.yaml` in Docker)
2. **Environment variables**: override specific YAML values
3. **CLI arguments**: highest precedence, override at runtime

Environment variables always take precedence over YAML values. CLI arguments override both.

---

## Attestation Service

**Config file:** `services/attestation/config.example.yaml`

### Network

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `network_id` | `NETWORK_ID` | (required) | Aztec network identifier, a **string** such as `"aztec-testnet"` (not a numeric chain id) |
| `fpc_address` | `FPC_ADDRESS` | (required) | Deployed FPC contract address |
| `contract_variant` | | `"fpc-v1"` | Contract flavour identifier emitted in discovery |
| `aztec_node_url` | `AZTEC_NODE_URL` | (required) | Aztec node PXE endpoint |
| `quote_base_url` | `QUOTE_BASE_URL` | derived from request headers | Public base URL emitted in `/.well-known/fpc.json`. Set this explicitly when behind a reverse proxy. |

### Operator

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `operator_secret_provider` | `OPERATOR_SECRET_PROVIDER` | `auto` | Key source: `auto`, `env`, `config`, `kms`, `hsm` |
| `operator_address` | | | Operator L2 address (only needed when account salt is non-zero) |
| `operator_account_salt` | `OPERATOR_ACCOUNT_SALT` | | Account salt (optional) |
| `operator_secret_ref` | `OPERATOR_SECRET_REF` | | KMS or secret-manager reference for the key (preferred in production) |
| | `OPERATOR_SECRET_KEY` | | L2 operator Schnorr private key (plaintext, avoid in production) |

> [!TIP]
> **Prefer secret-ref in production**
>
> The operator secret can be resolved via `operator_secret_ref` (YAML) or `OPERATOR_SECRET_REF` (env var) through the configured secret provider (KMS/HSM). This keeps plaintext keys out of process env and shell history. Setting `runtime_profile: production` rejects plaintext secrets in config files at startup.

### Quote Settings

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `quote_validity_seconds` | `QUOTE_VALIDITY_SECONDS` | `300` | Quote lifetime in seconds. The on-chain contract caps TTL at 3600 seconds regardless of this setting. |

### Quote Format

| YAML Key | Default | Description |
|----------|---------|-------------|
| `quote_format` | `amount_quote` | Quote preimage format: `amount_quote` (signs concrete `aa_payment_amount`) or `rate_quote`. Must match the FPC contract's expected format. |

### Quote Auth (request-time auth on `/quote`)

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `quote_auth_mode` | `QUOTE_AUTH_MODE` | `disabled` | One of `disabled`, `api_key`, `trusted_header`, `api_key_or_trusted_header`, `api_key_and_trusted_header`. Rejected when `runtime_profile` is `production` if set to `disabled`. |
| `quote_auth_api_key_header` | `QUOTE_AUTH_API_KEY_HEADER` | `x-api-key` | Header name clients pass the API key in |
| | `QUOTE_AUTH_API_KEY` | | Shared secret required when mode includes `api_key` |
| `quote_auth_trusted_header_name` | `QUOTE_AUTH_TRUSTED_HEADER_NAME` | | Header name your reverse proxy sets (when mode includes `trusted_header`) |
| | `QUOTE_AUTH_TRUSTED_HEADER_VALUE` | | Value the header must equal to be accepted |

### Quote Rate Limiting

Fixed-window rate limiting on `/quote`. Defaults are defined in the attestation config schema. Env vars override.

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `quote_rate_limit_enabled` | `QUOTE_RATE_LIMIT_ENABLED` | `true` | Master toggle |
| `quote_rate_limit_max_requests` | `QUOTE_RATE_LIMIT_MAX_REQUESTS` | `60` | Max requests per window per key (capped at 1,000,000) |
| `quote_rate_limit_window_seconds` | `QUOTE_RATE_LIMIT_WINDOW_SECONDS` | `60` | Window length in seconds (capped at 3600) |
| `quote_rate_limit_max_tracked_keys` | `QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS` | `10000` | Cap on distinct keys (users/IPs) held in memory |

### Admin

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `admin_api_key_header` | | `x-admin-api-key` | Header name for admin auth |
| | `ADMIN_API_KEY` | | Admin API key value (constant-time compared). Admin endpoints are disabled unless this is set. |
| `treasury_destination_address` | | | Default destination for `POST /admin/sweeps` when the request body omits `destination` |

### Assets

Single-asset mode uses the top-level `accepted_asset_*` and `market_rate_*` fields. For multi-asset, define `supported_assets` entries. Per-asset pricing fields are optional and inherit from top-level defaults when omitted.

```yaml
# Top-level defaults (used when supported_assets entries omit pricing)
accepted_asset_name: "humanUSDC"
accepted_asset_address: "0x..."
market_rate_num: 1
market_rate_den: 1000
fee_bips: 200

# Multi-asset support (optional)
supported_assets:
  - address: "0x..."
    name: "humanUSDC"           # Human-readable name surfaced in /accepted-assets
    market_rate_num: 1          # Override: asset units per 1 FeeJuice (numerator)
    market_rate_den: 1000       # Override: denominator
    fee_bips: 200               # Override: operator margin (200 bips = 2%)
  - address: "0x..."
    name: "ravenETH"
    market_rate_num: 3
    market_rate_den: 1000
    fee_bips: 25
```

Final rate formula: `rate_num = market_rate_num * (10000 + fee_bips)`, `rate_den = market_rate_den * 10000`. The payment amount is `aa_payment_amount = ceil(fj_amount * rate_num / rate_den)`.

### State and Runtime

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `asset_policy_state_path` | | `.attestation-data` | LMDB directory for persisted asset policies |
| `runtime_profile` | `FPC_RUNTIME_PROFILE` | `development` | `development`, `test`, or `production` |
| `pxe_data_directory` | `PXE_DATA_DIRECTORY` | | PXE data dir for embedded wallet (recommended for production to persist operator notes) |
| `port` | | `3000` | HTTP listen port |

---

## Top-up Service

**Config file:** `services/topup/config.example.yaml`

### Network

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `aztec_node_url` | `AZTEC_NODE_URL` | (required) | Aztec node URL |
| `l1_rpc_url` | `L1_RPC_URL` | (required) | L1 Ethereum RPC |

The service validates that `l1_rpc_url` matches the L1 chain id reported by the Aztec node (`nodeInfo`). L1 Fee Juice contract addresses are auto-discovered from `nodeInfo`. Do not hardcode them.

### FPC and Thresholds

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `fpc_address` | `FPC_ADDRESS` | (required) | FPC contract to monitor |
| `threshold` | `TOPUP_THRESHOLD` | (required) | Bridge when FPC Fee Juice balance drops below this (wei) |
| `top_up_amount` | `TOPUP_AMOUNT` | (required) | Amount to bridge each time (wei) |

### State and Polling

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `data_dir` | `TOPUP_DATA_DIR` | `.topup-data` | LMDB directory for in-flight bridge state and crash recovery |
| `check_interval_ms` | `TOPUP_CHECK_INTERVAL_MS` | `60000` | FPC balance check interval (ms) |
| `confirmation_timeout_ms` | | `180000` | Max wait for L1-to-L2 message + balance settlement after a bridge tx. No env override; set in YAML. |
| `confirmation_poll_initial_ms` | | `1000` | Initial poll interval during confirmation |
| `confirmation_poll_max_ms` | | `15000` | Max poll interval (exponential backoff cap) |

### Operator

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `l1_operator_secret_provider` | | `auto` | L1 key source: `auto`, `env`, `config`, `kms`, `hsm` |
| `l1_operator_secret_ref` | | | KMS or secret-manager reference (preferred in production) |
| `l1_operator_private_key` | `L1_OPERATOR_PRIVATE_KEY` | | L1 operator private key (plaintext, avoid in production) |

The L1 operator account must hold ETH (for bridge gas) and Fee Juice tokens (the ERC-20 that gets bridged to L2). Fund it before starting the service. A helper script is available:

```bash
export AZTEC_NODE_URL=<AZTEC_NODE_URL>
export L1_RPC_URL=<L1_RPC_URL>
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>
bun run fund:l1:fee-juice
```

### Auto-Claim

Auto-claim completes the L2 side of the top-up bridge (claims bridged Fee Juice into the FPC's balance). Enabled by default.

| Env Var | Default | Description |
|---------|---------|-------------|
| `TOPUP_AUTOCLAIM_ENABLED` | `1` | `1` = enabled, `0` = disabled |
| `TOPUP_AUTOCLAIM_SECRET_KEY` | | L2 claimer secret key. Required when `runtime_profile=production`. In `development`, falls back to the first `@aztec/accounts/testing` account. |
| `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` | | Use a sponsored FPC to pay the claim tx's fees. Recommended to avoid needing Fee Juice on the claimer account. |

### Operations

| YAML Key | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `ops_port` | `TOPUP_OPS_PORT` | `3001` | Health, readiness, and metrics port |
| `runtime_profile` | `FPC_RUNTIME_PROFILE` | `development` | `development`, `test`, or `production` |

---

## Deployment (Contract Deployment Container)

| Env Var | Required | Description |
|---------|:--------:|-------------|
| `AZTEC_NODE_URL` | Yes | Aztec node URL |
| `FPC_DEPLOYER_SECRET_KEY` | Yes (or `_REF`) | L2 deployer account key (plaintext) |
| `FPC_DEPLOYER_SECRET_KEY_REF` | | Secret-manager reference alternative |
| `FPC_OPERATOR_SECRET_KEY` | No | L2 operator key (defaults to deployer if omitted) |
| `FPC_OPERATOR_SECRET_KEY_REF` | | Secret-manager reference alternative |
| `FPC_L1_DEPLOYER_KEY` | If deploying test tokens | L1 deployer key for ERC20 + portal deployment |
| `L1_RPC_URL` | If deploying test tokens | L1 RPC endpoint |
| `FPC_SPONSORED_FPC_ADDRESS` | No | Pay deploy fees via an existing sponsored FPC |
| `FPC_ACCEPTED_ASSET` | No | Reuse an existing token address (skips test-token deployment, bun path only) |
| `FPC_ATTESTATION_URL` | `configure-token` | Attestation service URL for token registration |
| `ADMIN_API_KEY` | `configure-token` | Attestation admin API key |
| `FPC_PREFLIGHT_ONLY` | No | `1` = validate connectivity + state, do not submit txs |
| `FPC_SKIP_CONFIG_GEN` | No | `1` = skip auto-generating per-service configs after deploy |
| `FPC_MASTER_CONFIG` | No | Override master config path (default: `$FPC_DATA_DIR/fpc-config.yaml`) |
| `FPC_DATA_DIR` | No | Data directory (default: `./deployments`) |
| `FPC_OUT` | No | Manifest output path (default: `$FPC_DATA_DIR/manifest.json`) |

---

## Runtime Profiles

| Profile | Behavior |
|---------|----------|
| `development` | Permissive. Allows plaintext secrets in config files. |
| `test` | Similar to development. |
| `production` | Strict. Rejects plaintext config secrets at startup. Requires `env`, `kms`, or `hsm` for secret providers. Requires `quote_auth_mode != disabled`. |

> [!CAUTION]
>
> Always use `runtime_profile: production` in production. It prevents accidental plaintext secret leaks and enforces auth on the quote endpoint.

## Master Config

The master config (`fpc-config.yaml`) controls operator-tunable settings that get split into per-service configs during generation. Copy the example and edit before the first deploy:

```bash
mkdir -p deployments
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
```

Key sections:

| Section | Field | Description |
|---------|-------|-------------|
| `tokens` | `name` / `symbol` | Token identity (used for test token deployment and attestation registration) |
| `tokens` | `address` | Existing token address (omit to deploy a test token) |
| `tokens` | `market_rate_num` / `market_rate_den` | Exchange rate: accepted_asset per 1 FeeJuice |
| `tokens` | `fee_bips` | Operator margin in basis points (200 = 2%) |
| `attestation` | `quote_validity_seconds` | Quote TTL (default 300) |
| `attestation` | `quote_auth_mode` | Auth mode: `disabled`, `api_key`, `trusted_header`, etc. |
| `topup` | `threshold` | Bridge when FPC balance drops below this (wei) |
| `topup` | `top_up_amount` | Amount to bridge each time (wei) |
| `topup` | `check_interval_ms` | Balance poll interval (default 60000) |

If the master config is not present at deploy time, deployment still succeeds but config generation is skipped.

Re-generate service configs from an existing manifest after editing the master config:

```bash
docker run -v ./deployments:/app/deployments \
  --entrypoint bash \
  nethermind/aztec-fpc-contract-deployment:local \
  scripts/config/generate-service-configs.sh
```

## Per-Environment Configs

```
deployments/
├── fpc-config.example.yaml    # Master template
├── local/fpc-config.yaml      # Local development
├── devnet/fpc-config.yaml     # Devnet
└── testnet/fpc-config.yaml    # Testnet
```
