# Docker Deployment Guide

Deploy the FPC contract and generate service configs using the `nethermind/aztec-fpc-contract-deployment` Docker image. The image ships with pre-compiled contract artifacts and all required tooling — no local Aztec CLI, Bun, or Noir installation needed.

## Prerequisites

- Docker
- An Aztec node to deploy against (local sandbox or remote devnet)
- A deployer private key (L2) and operator secret key

## Quick start

```bash
# 1. Prepare the service master config
mkdir -p deployments
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
# Edit deployments/fpc-config.yaml — set exchange rates, thresholds, ports, etc.

# 2. Export secrets (keep values out of docker commands)
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_hex32>
export FPC_OPERATOR_SECRET_KEY=0x<operator_hex32>

# 3. Deploy contracts and generate service configs
docker run -v ./deployments:/app/deployments \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  nethermind/aztec-fpc-contract-deployment:local
```

The container:

1. Deploys `FPCMultiAsset` to the target Aztec node.
2. Writes a deployment manifest to `deployments/manifest.json`.
3. Auto-generates service configs from the manifest + `deployments/fpc-config.yaml`.

## Output

After the run completes, your local `./deployments/` directory will contain:

```text
deployments/
├── manifest.json                ← deployment manifest (treat as secret material)
├── fpc-config.yaml              ← master config (your copy)
├── attestation/
│   └── config.yaml              ← generated attestation service config
└── topup/
    └── config.yaml              ← generated topup service config
```

The generated `attestation/config.yaml` and `topup/config.yaml` have the deployed contract addresses (`fpc_address`) injected and are ready to mount into the service containers.

## Master config

The master config (`fpc-config.yaml`) controls operator-tunable settings that get split into per-service configs during generation. Copy the example and edit it **before** the first deploy:

```bash
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
```

Key fields:

| Section | Field | Description |
|---------|-------|-------------|
| `attestation` | `quote_validity_seconds` | Quote TTL (default 300) |
| `attestation` | `quote_auth_mode` | Auth mode: `disabled`, `api_key`, `trusted_header`, etc. |
| `topup` | `threshold` | Bridge when FPC balance drops below this (wei) |
| `topup` | `top_up_amount` | Amount to bridge each time (wei) |
| `topup` | `check_interval_ms` | Balance poll interval (default 60000) |

See [`deployments/fpc-config.example.yaml`](../deployments/fpc-config.example.yaml) for the full reference with comments.

If the master config is not present at deploy time, deployment still succeeds but config generation is skipped.

## CLI arguments

All arguments are optional. CLI args take precedence over environment variables.

### Credentials

**Always pass secrets via `-e` env vars** — CLI arguments are visible in `ps`, `docker inspect`, and shell history.

| Env var | Description |
|---------|-------------|
| `FPC_DEPLOYER_SECRET_KEY` | Deployer L2 secret key |
| `FPC_DEPLOYER_SECRET_KEY_REF` | Deployer key reference (KMS/secret manager) |
| `FPC_OPERATOR_SECRET_KEY` | Operator secret key (defaults to deployer key) |
| `FPC_OPERATOR_SECRET_KEY_REF` | Operator key reference |

CLI equivalents (`--deployer-secret-key`, `--operator-secret-key`, etc.) exist but are **not recommended** for the same reason.

### Network

| Argument | Description | Env var |
|----------|-------------|---------|
| `--node-url <url>` | Aztec node URL (default: `https://v4-devnet-2.aztec-labs.com/`) | `AZTEC_NODE_URL` |

### Options

| Argument | Description | Env var |
|----------|-------------|---------|
| `--sponsored-fpc-address <addr>` | Use sponsored FPC payment mode for deployment | `FPC_SPONSORED_FPC_ADDRESS` |
| `--operator <addr>` | Explicit operator address (default: derived from secret key) | `FPC_OPERATOR` |
| `--preflight-only` | Run checks only, do not deploy | `FPC_PREFLIGHT_ONLY=1` |

### Output

| Argument | Description | Env var |
|----------|-------------|---------|
| `--data-dir <dir>` | Data directory (default: `./deployments`) | `FPC_DATA_DIR` |
| `--out <path>` | Manifest output path (default: `$FPC_DATA_DIR/manifest.json`) | `FPC_OUT` |

### Config generation

| Env var | Description |
|---------|-------------|
| `FPC_SKIP_CONFIG_GEN=1` | Skip automatic config generation after deploy |
| `FPC_MASTER_CONFIG` | Override master config path (default: `$FPC_DATA_DIR/fpc-config.yaml`) |
| `FPC_ATTESTATION_CONFIG` | Override attestation config output path |
| `FPC_TOPUP_CONFIG` | Override topup config output path |

Run `--help` for the built-in usage text.

## Examples

All examples below assume secrets are exported beforehand:

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<your_key>
export FPC_OPERATOR_SECRET_KEY=0x<your_key>
```

### Deploy FPC

```bash
docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local
```

### Reuse a token with sponsored FPC payment

```bash
docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  --sponsored-fpc-address 0x<fpc_address>
```

### Preflight check (no deployment)

Validates node connectivity, chain compatibility, and deployer state without submitting any transactions:

```bash
docker run -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  --node-url https://v4-devnet-2.aztec-labs.com/ \
  --preflight-only
```

### Deploy against a local sandbox

```bash
docker run \
  -e AZTEC_NODE_URL=http://localhost:8080 \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  --network host \
  nethermind/aztec-fpc-contract-deployment:local
```

### Skip config generation

Deploy contracts but handle config generation separately:

```bash
docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -e FPC_SKIP_CONFIG_GEN=1 \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local
```

### Re-generate configs from an existing manifest

If you already have a `manifest.json` and want to regenerate service configs (e.g. after editing `fpc-config.yaml`):

```bash
docker run -v ./deployments:/app/deployments \
  --entrypoint bash \
  nethermind/aztec-fpc-contract-deployment:local \
  scripts/config/generate-service-configs.sh
```

## Docker Compose for public networks

For deploying to public networks (devnet, testnet), use `docker-compose.public.yaml`. This runs the full stack — contract deployment, post-deploy smoke, attestation service, and topup service — in one command.

```bash
DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

The compose file reads network defaults (node URL, L1 RPC) from `.env.${DEPLOYMENT}` (e.g. `.env.testnet`) and mounts `deployments/${DEPLOYMENT}/` as the data directory. After the run, all output — manifest, generated service configs — lives in `deployments/testnet/`:

```text
deployments/testnet/
├── manifest.json
├── attestation/
│   └── config.yaml
└── topup/
    └── config.yaml
```

Secrets must be exported before running:

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_key>
export FPC_OPERATOR_SECRET_KEY=0x<operator_key>
```

## Building the image

For contributors building the image locally:

```bash
# Build with default tag (:local)
docker buildx bake deploy

# Custom tag
TAG=v0.1.0 docker buildx bake deploy

# Custom registry + tag
REGISTRY=ghcr.io/ TAG=v0.1.0 docker buildx bake deploy
```

## Security notes

- **Never pass secrets as CLI arguments or inline `-e KEY=VALUE`.** Export them first (`export FPC_DEPLOYER_SECRET_KEY=...`) and pass by name (`-e FPC_DEPLOYER_SECRET_KEY`). Inline values are visible in `ps`, `docker inspect`, and shell history. Non-secret values like `AZTEC_NODE_URL` and `L1_RPC_URL` are fine to pass inline.
- The deployment manifest (`manifest.json`) may contain raw private keys. Treat it as secret material.
- Prefer `FPC_DEPLOYER_SECRET_KEY_REF` / `FPC_OPERATOR_SECRET_KEY_REF` for KMS/secret manager integration where supported.
- Do not commit manifests with plaintext keys to version control.
