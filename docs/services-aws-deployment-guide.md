# AWS Deployment Guide for `services` (Attestation + Topup)

Date: 2026-02-27
Repo: `/home/ametel/source/aztec-fpc`
Scope: repo-specific settings only (assumes your DevOps team already has AWS/ECS/EKS standards).

## 1. Contracts and Network This Deployment Must Target

Use `deployments/devnet-manifest-v2.json` as source of truth.

- `aztec_node_url`: `https://v4-devnet-2.aztec-labs.com/`
- `l1_chain_id`: `11155111` (Sepolia)
- `fpc_address`: `0x0041782f166133790183c9877441cd9692a987cc37f70edbcd8af0068df7d4b5`
- `credit_fpc_address`: `0x2c41d74d8b079453af4dfc865e44ccdbb68821ecf63b43aecdfde56e7f1587c3`
- `accepted_asset`: `0x105721a4fe56f8a7c20f7ce36c661ef609a8dec30a7595585dd2f2ada5fad40a`
- `operator_address`: `0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8`

## 2. Docker Images

Use the existing service images:

- `nethermind/aztec-fpc-attestation:<tag>`
- `nethermind/aztec-fpc-topup:<tag>`

(If your org mirrors images to ECR, keep the same repo suffixes and only swap registry prefix/tag policy.)

## 3. Config Files To Mount

These services require YAML config files. Keep them external and mount read-only.

- Attestation config path in container: `/app/configs/attestation/config.yaml`
- Topup config path in container: `/app/configs/topup/config.yaml`

Entrypoints expect `config.yaml` in cwd by default, so pass command args in AWS:

- Attestation args: `--config /app/configs/attestation/config.yaml`
- Topup args: `--config /app/configs/topup/config.yaml`

Start from current repo files:

- `services/attestation/config.yaml`
- `services/topup/config.yaml`

For production, update both configs:

- set `runtime_profile: "production"`
- remove plaintext key fields from files:
  - attestation: remove `operator_secret_key`
  - topup: remove `l1_operator_private_key`

Important repo detail: several fields are config-only (not env-overridable), so keep them correct in YAML.

- Attestation config-only: `fpc_address`, `accepted_asset_address`, `accepted_asset_name`, `market_rate_num`, `market_rate_den`, `fee_bips`, `operator_address`, `quote_validity_seconds`, `port`
- Topup config-only: `fpc_address`, `threshold`, `top_up_amount`, `check_interval_ms`, `confirmation_*`

## 4. Environment Variables To Set

### 4.1 Shared

- `AZTEC_NODE_URL=https://v4-devnet-2.aztec-labs.com/`
- `FPC_RUNTIME_PROFILE=production`

Provider note: `kms`/`hsm` secret providers in this repo require custom adapter wiring in code. With current images, use `*_SECRET_PROVIDER=env`.

### 4.2 Attestation (required/recommended)

Required:

- `OPERATOR_SECRET_PROVIDER=env`
- `OPERATOR_SECRET_KEY=<secret>`
- `QUOTE_AUTH_MODE=<api_key|trusted_header|api_key_or_trusted_header|api_key_and_trusted_header>`

If using API key modes:

- `QUOTE_AUTH_API_KEY=<secret>`
- Optional `QUOTE_AUTH_API_KEY_HEADER` (default `x-api-key`)

If using trusted header modes:

- `QUOTE_AUTH_TRUSTED_HEADER_NAME=<header-name>`
- `QUOTE_AUTH_TRUSTED_HEADER_VALUE=<secret-value>`

Recommended tuning:

- `QUOTE_RATE_LIMIT_ENABLED=true`
- `QUOTE_RATE_LIMIT_MAX_REQUESTS=60`
- `QUOTE_RATE_LIMIT_WINDOW_SECONDS=60`
- `QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS=10000`

### 4.3 Topup (required/recommended)

Required:

- `L1_RPC_URL=<sepolia_rpc_https_url>`
- `L1_OPERATOR_SECRET_PROVIDER=env`
- `L1_OPERATOR_PRIVATE_KEY=<secret>`

Recommended:

- `TOPUP_OPS_PORT=3001`
- `TOPUP_BRIDGE_STATE_PATH=/var/lib/aztec-fpc/topup-bridge-state.json`

Optional debug only (do not enable in prod):

- `TOPUP_LOG_CLAIM_SECRET=1`

## 5. AWS Runtime Settings (Repo-Specific)

- Expose attestation on container port `3000` (`/health`, `/metrics`, `/quote`, `/asset`).
- Expose topup ops on `TOPUP_OPS_PORT` (default `3001`) (`/health`, `/ready`, `/metrics`).
- Add writable storage for topup bridge state path (`TOPUP_BRIDGE_STATE_PATH`).
- Run topup as a singleton (`replicas=1`) unless you add external leader election.
- Attestation can be horizontally scaled.

## 6. Validation After Deploy

Attestation:

```bash
curl -fsS "https://<attestation-host>/health"
curl -fsS "https://<attestation-host>/asset"
```

Topup:

```bash
curl -fsS "https://<topup-host>/health"
curl -fsS "https://<topup-host>/ready"
```

If topup is not ready, first checks are usually:

- `L1_RPC_URL` chain mismatch (must match Aztec node `l1_chain_id=11155111`)
- missing/invalid `L1_OPERATOR_PRIVATE_KEY`
- bad `fpc_address` in mounted topup config

## 7. Fast Config Regeneration From Manifest (Optional)

If contracts are redeployed later, regenerate both service configs from the new manifest:

```bash
cd /home/ametel/source/aztec-fpc
FPC_RUNTIME_PROFILE=production \
FPC_DEVNET_L1_RPC_URL="https://<sepolia-rpc>" \
OPERATOR_SECRET_PROVIDER=env \
L1_OPERATOR_SECRET_PROVIDER=env \
bun run render:config:devnet
```

Then re-apply your secret removal/secret-ref policy in the generated YAML before rollout.
