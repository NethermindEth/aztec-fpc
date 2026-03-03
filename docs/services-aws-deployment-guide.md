# AWS Deployment Guide for `services` (Attestation + Topup)

Date: 2026-03-04  
Repo: `<repo-root>`  
Scope: repo-specific runtime and env wiring for AWS (ECS/EKS), aligned to current `contracts/`, `services/`, and `docker-compose.yaml`.

## 1. Source of Truth: Deployment Manifest

Use `deployments/devnet-manifest-v2.json` as the source of truth for deployed addresses.

Quick check:

```bash
MANIFEST=./deployments/devnet-manifest-v2.json
jq '{
  node_url: .network.node_url,
  l1_chain_id: .network.l1_chain_id,
  fpc: .contracts.fpc,
  accepted_asset: .contracts.accepted_asset,
  faucet: .contracts.faucet,
  counter: .contracts.counter,
  operator: .operator.address,
  fpc_artifact: .fpc_artifact.name
}' "$MANIFEST"
```

Current contract state relevant to services:

- Fee contract is `FPCMultiAsset` (`contracts/fpc/src/main.nr`).
- Attestation still needs a default `accepted_asset_address` in config and can publish additional assets via `supported_assets`.
- `counter` is now deployed by the devnet deploy script, but attestation/topup do not consume it.

## 2. Docker Images

Use service images:

- `nethermind/aztec-fpc-attestation:<tag>`
- `nethermind/aztec-fpc-topup:<tag>`

If mirroring to ECR, keep repo suffixes and change only registry/tag policy.

## 3. Config Files To Mount

Mount service YAML files read-only:

- Attestation: `/app/configs/attestation/config.yaml`
- Topup: `/app/configs/topup/config.yaml`

Container args:

- Attestation: `--config /app/configs/attestation/config.yaml`
- Topup: `--config /app/configs/topup/config.yaml`

Generate these from manifest + master config:

```bash
cd <repo-root>
FPC_DEPLOY_MANIFEST=./deployments/devnet-manifest-v2.json \
FPC_MASTER_CONFIG=./fpc-config.yaml \
FPC_CONFIGS_OUT=./configs \
bash scripts/config/generate-service-configs.sh
```

For production:

- Set `runtime_profile: "production"` in both YAMLs (or set `FPC_RUNTIME_PROFILE=production`).
- Remove plaintext secrets from YAML:
  - attestation: remove `operator_secret_key`
  - topup: remove `l1_operator_private_key`

Config-only fields (no env override in current code):

- Attestation:
  - `network_id`, `fpc_address`, `contract_variant`, `quote_base_url`, `quote_validity_seconds`, `port`
  - `accepted_asset_address`, `accepted_asset_name`, `supported_assets`
  - `market_rate_num`, `market_rate_den`, `fee_bips`, `quote_format`
  - `operator_address`, `pxe_data_directory`
- Topup:
  - `fpc_address`, `threshold`, `top_up_amount`
  - `check_interval_ms`, `confirmation_timeout_ms`, `confirmation_poll_initial_ms`, `confirmation_poll_max_ms`

## 4. Env Vars (Runtime-Supported)

This section is the exact env surface consumed by `services/attestation/src` and `services/topup/src`.

Shared:

- `AZTEC_NODE_URL=<https://...>`
- `FPC_RUNTIME_PROFILE=<development|test|production>`

Secret-provider note:

- `kms`/`hsm` providers require adapter wiring in code.
- With current images, use `*_SECRET_PROVIDER=env` unless you ship a custom build with adapters.

### 4.1 Attestation

Required in production:

- `OPERATOR_SECRET_PROVIDER=env`
- `OPERATOR_SECRET_KEY=<0x...32-byte-hex>`
- `QUOTE_AUTH_MODE=<api_key|trusted_header|api_key_or_trusted_header|api_key_and_trusted_header>`

Conditional:

- API-key modes need `QUOTE_AUTH_API_KEY`.
- Optional API-key header override: `QUOTE_AUTH_API_KEY_HEADER` (default `x-api-key`).
- Trusted-header modes need:
  - `QUOTE_AUTH_TRUSTED_HEADER_NAME`
  - `QUOTE_AUTH_TRUSTED_HEADER_VALUE`

Optional:

- `OPERATOR_SECRET_REF` (used when provider is `kms`/`hsm`).
- `QUOTE_RATE_LIMIT_ENABLED`
- `QUOTE_RATE_LIMIT_MAX_REQUESTS`
- `QUOTE_RATE_LIMIT_WINDOW_SECONDS`
- `QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS`

Important:

- `QUOTE_AUTH_MODE=disabled` is rejected when runtime profile is `production`.

### 4.2 Topup

Required:

- `L1_RPC_URL=<https://...>`
- `L1_OPERATOR_SECRET_PROVIDER=env`
- `L1_OPERATOR_PRIVATE_KEY=<0x...32-byte-hex>`

Recommended:

- `TOPUP_OPS_PORT=3001`
- `TOPUP_BRIDGE_STATE_PATH=/var/lib/aztec-fpc/topup-bridge-state.json`
- `TOPUP_AUTOCLAIM_ENABLED=0`

Conditional:

- `L1_OPERATOR_SECRET_REF` (used when provider is `kms`/`hsm`).
- `TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX` only matters if auto-claim is enabled.

Debug only (do not enable in production):

- `TOPUP_LOG_CLAIM_SECRET=1`

### 4.3 One-off L1 Funding Step (Before Topup)

This repo now includes a TypeScript utility to fund L1 FeeJuice for the topup operator without bridging/claiming:

```bash
bun run fund:l1:fee-juice -- \
  --l1-rpc-url "$L1_RPC_URL" \
  --node-url "$AZTEC_NODE_URL" \
  --operator-private-key "$L1_OPERATOR_PRIVATE_KEY" \
  --target-balance-wei "1000000000000000000000"
```

Expected behavior:

- ensures the operator L1 address has at least `target-balance-wei`,
- tries `FeeJuice.mint(address,uint256)` first (local-network compatible),
- falls back to `FeeAssetHandler.mint(address)` loops when direct mint is not available (devnet/testnet style),
- does not bridge to L2 (topup service handles bridging).

Env-compatible inputs for this utility:

- `L1_RPC_URL`, `AZTEC_NODE_URL`
- `L1_OPERATOR_PRIVATE_KEY`
- optional: `L1_FEE_JUICE_FUNDER_PRIVATE_KEY`
- optional: `L1_FEE_JUICE_FUND_AMOUNT_WEI`
- optional: `L1_FEE_JUICE_TOKEN_ADDRESS`, `L1_FEE_ASSET_HANDLER_ADDRESS`
- optional: `FPC_DEPLOY_MANIFEST` (address fallback source)

## 5. Compose-Parity Service Env Blocks

`docker-compose.yaml` currently wires these service envs:

Attestation compose parity:

```yaml
environment:
  AZTEC_NODE_URL: "${AZTEC_NODE_URL:-http://aztec-node:8080}"
  OPERATOR_SECRET_KEY: "${OPERATOR_SECRET_KEY:-0x...}"
```

Topup compose parity:

```yaml
environment:
  AZTEC_NODE_URL: "${AZTEC_NODE_URL:-http://aztec-node:8080}"
  L1_RPC_URL: "${L1_RPC_URL:-http://anvil:8545}"
  L1_OPERATOR_PRIVATE_KEY: "${L1_OPERATOR_PRIVATE_KEY:-0x...}"
  TOPUP_OPS_PORT: "${TOPUP_OPS_PORT:-3001}"
  TOPUP_BRIDGE_STATE_PATH: "${TOPUP_BRIDGE_STATE_PATH:-/tmp/.topup-bridge-state.json}"
  TOPUP_AUTOCLAIM_ENABLED: "${TOPUP_AUTOCLAIM_ENABLED:-1}"
  TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX: "${TOPUP_AUTOCLAIM_TEST_ACCOUNT_INDEX:-0}"
```

AWS production delta from compose parity:

- Add `FPC_RUNTIME_PROFILE=production`.
- Add secret provider envs:
  - `OPERATOR_SECRET_PROVIDER=env`
  - `L1_OPERATOR_SECRET_PROVIDER=env`
- Set `TOPUP_AUTOCLAIM_ENABLED=0` unless you intentionally run local-network-style test accounts.
- Replace local defaults (`http://aztec-node:8080`, `http://anvil:8545`) with real endpoints.

## 6. AWS Runtime Settings

- Expose attestation on container port `3000` (`/.well-known/fpc.json`, `/health`, `/metrics`, `/quote`, `/asset`).
- Expose topup ops on `TOPUP_OPS_PORT` (default `3001`) (`/health`, `/ready`, `/metrics`).
- Mount writable storage for `TOPUP_BRIDGE_STATE_PATH`.
- Run topup as singleton (`replicas=1`) unless you add leader election/distributed locking.
- Attestation can be horizontally scaled.

## 7. Validation After Deploy

Attestation:

```bash
curl -fsS "https://<attestation-host>/health"
curl -fsS "https://<attestation-host>/asset"
curl -fsS "https://<attestation-host>/.well-known/fpc.json"
```

Topup:

```bash
curl -fsS "https://<topup-host>/health"
curl -fsS "https://<topup-host>/ready"
```

If topup readiness is failing, first check:

- `L1_RPC_URL` chain ID matches manifest `network.l1_chain_id`.
- `L1_OPERATOR_PRIVATE_KEY` is present and valid.
- topup config `fpc_address` matches deployed contract.
- `TOPUP_AUTOCLAIM_ENABLED` is not accidentally left at `1` in non-local environments.

## 8. Regenerate Service Configs After Contract Redeploy

When contracts are redeployed:

```bash
cd <repo-root>
bun run generate:configs
```

Then re-apply your secret policy (remove plaintext keys / wire env or secret refs) before rollout.
