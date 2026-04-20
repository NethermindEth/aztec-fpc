# Deployment

Deploy the FPC system: contracts, services, and supporting infrastructure.

[Source: deploy CLI](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/index.ts#L321) |
[Source: configure-token](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/configure-token.ts#L228) |
[Source: manifest schema](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/manifest.ts#L15)

Two deployment paths are supported:

- **Docker (recommended)**: pre-compiled artifacts, two-phase deploy, ships the full `nethermind/aztec-fpc-*` image set. Best for testnet, devnet, and production.
- **Bun scripts (non-Docker)**: `bun run deploy:fpc` wrapper. Best for local development and CI environments that already have Noir and Bun installed.

## Path A: Docker (recommended)

Deployment happens in **two phases**:

1. **FPC deploy**: deploys `FPCMultiAsset`, writes `manifest.json`, and auto-generates per-service configs
2. **Token configuration** (`configure-token` subcommand): deploys test tokens (if needed), then registers them with the running attestation service

Start the attestation and top-up services between the two phases.

### Prepare the master config

```bash
mkdir -p deployments
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
# Edit: tokens, exchange rates (market_rate_num/den, fee_bips), thresholds
```

See [Configuration](../operations/configuration.md) for the full field reference.

### Phase 1: deploy FPC and generate configs

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_hex32>
export FPC_OPERATOR_SECRET_KEY=0x<operator_hex32>

docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local
```

Output:

```text
deployments/
├── manifest.json                <- FPC deployment manifest (TREAT AS SECRET)
├── fpc-config.yaml              <- master config
├── attestation/config.yaml      <- generated, ready to mount
└── topup/config.yaml            <- generated, ready to mount
```

> [!TIP]
> **Deploy paying fees via Sponsored FPC**
>
> Add `--sponsored-fpc-address <EXISTING_FPC_ADDRESS>` to pay deployment fees through an existing sponsored FPC rather than the deployer account. Useful on testnet where the deployer may not have Fee Juice.

> [!TIP]
> **Preflight only**
>
> Add `--preflight-only` (or set `FPC_PREFLIGHT_ONLY=1`) to validate node connectivity and deployer state without submitting any transactions.

### Start the services

Attestation:

```bash
export OPERATOR_SECRET_KEY=0x<operator_hex32>
docker run -d \
  -e OPERATOR_SECRET_KEY \
  -v ./deployments/attestation/config.yaml:/app/config.yaml \
  -p 3000:3000 \
  nethermind/aztec-fpc-attestation:local
```

Top-up (the L1 operator account must hold ETH and Fee Juice tokens; run `bun run fund:l1:fee-juice` first if on devnet):

```bash
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>
docker run -d \
  -e L1_OPERATOR_PRIVATE_KEY \
  -v ./deployments/topup/config.yaml:/app/config.yaml \
  -p 3001:3001 \
  nethermind/aztec-fpc-topup:local
```

### Phase 2: configure tokens

Deploy test tokens (if their `address` is omitted in `fpc-config.yaml`) and register them with the attestation service:

```bash
export FPC_L1_DEPLOYER_KEY=0x<l1_key>
export ADMIN_API_KEY=<admin_secret>

docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e L1_RPC_URL=<L1_RPC_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_L1_DEPLOYER_KEY \
  -e FPC_ATTESTATION_URL=http://<attestation_host>:3000 \
  -e ADMIN_API_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token
```

> [!NOTE]
> If the attestation service is on `localhost`, add `--network host` so the container can reach the host network.

If all tokens in `fpc-config.yaml` have explicit `address` values, no L1/L2 deployment keys are needed. Only registration is performed:

```bash
export ADMIN_API_KEY=<admin_secret>

docker run \
  -e FPC_ATTESTATION_URL=<ATTESTATION_URL> \
  -e ADMIN_API_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token
```

Deploy test tokens only, skipping attestation registration (useful when attestation is not yet running):

```bash
docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e L1_RPC_URL=<L1_RPC_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_L1_DEPLOYER_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token --skip-registration
```

Test-token manifests land in `deployments/tokens/<TokenName>.json` and contain: L2 addresses (token, bridge, faucet, counter), L1 addresses (ERC20, portal), faucet configuration, and deployment tx hashes.

### Smoke test

```bash
bun run smoke:services:compose              # full compose smoke (all test suites)
# or
bun run smoke:deploy:fpc:devnet             # post-deploy runtime smoke
```

### Docker Compose for public networks

One command for devnet/testnet that runs deploy, attestation, topup, and configure-token in dependency order:

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<...>
export FPC_OPERATOR_SECRET_KEY=0x<...>
export FPC_L1_DEPLOYER_KEY=0x<...>
export ADMIN_API_KEY=<...>

DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

Reads `.env.${DEPLOYMENT}` for network defaults (node URL, L1 RPC) and writes outputs to `deployments/${DEPLOYMENT}/`.

The service dependency chain:

1. `deploy`: deploys the FPC contract, writes manifest and service configs
2. `attestation` + `topup`: start once deploy completes
3. `configure-token`: deploys test tokens (if needed) and registers them with the running attestation service

After the run, all output lives in `deployments/${DEPLOYMENT}/`:

```text
deployments/testnet/
├── manifest.json
├── attestation/
│   └── config.yaml
├── topup/
│   └── config.yaml
└── tokens/
    └── FpcAcceptedAsset.json
```

## Path B: Non-Docker (bun scripts)

For local development that already has Noir, Bun, and `aztec-wallet` set up.

```bash
export AZTEC_NODE_URL="https://v4-devnet-2.aztec-labs.com/"
export FPC_DEPLOYER_SECRET_KEY=0x<deployer>
# Optional: operator key defaults to deployer if omitted
export FPC_OPERATOR_SECRET_KEY=0x<operator>
# Optional: pay deployment fees via existing sponsored FPC
export FPC_SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2

bun run deploy:fpc
```

Manifest written to `deployments/manifest.json` (the default for `FPC_OUT`).

Reuse an existing token (skip test-token deploy):

```bash
export FPC_ACCEPTED_ASSET=0x<existing_token>
bun run deploy:fpc
```

Preflight only (validate connectivity + state, no transactions):

```bash
FPC_PREFLIGHT_ONLY=1 bun run deploy:fpc
```

Render service configs from the manifest:

```bash
bun run generate:configs
```

Post-deploy runtime smoke (one fee-paid tx + one L1 bridge cycle):

```bash
set -a; source .env; set +a
export L1_OPERATOR_PRIVATE_KEY="$L1_ADDRESS_PK"
export L1_RPC_URL=https://sepolia.infura.io/v3/<key>
bunx tsx scripts/contract/devnet-postdeploy-smoke.ts --manifest ./deployments/devnet-manifest-v2.json
```

### Bun path defaults

If unset, the `deploy:fpc` wrapper uses:
- `FPC_DATA_DIR=./deployments`
- `FPC_OUT=$FPC_DATA_DIR/manifest.json` (i.e., `./deployments/manifest.json`)

Required env vars (deployment fails without these):
- `AZTEC_NODE_URL`
- `FPC_DEPLOYER_SECRET_KEY` (or `FPC_DEPLOYER_SECRET_KEY_REF`)

The wrapper auto-compiles if contract artifacts are missing (`aztec compile --workspace --force`). After deployment, it auto-generates service configs unless `FPC_SKIP_CONFIG_GEN=1` is set.

### Troubleshooting

If deployment fails with wallet state errors, use a fresh temporary data directory:

```bash
export PXE_DATA_DIR="$(mktemp -d /tmp/aztec-pxe.XXXXXX)"
bun run deploy:fpc
```

## Deployment Manifest

The manifest is the canonical output of deployment. Services, smoke tests, and SDK examples read from it.

Schema (from [`contract-deployment/src/manifest.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/manifest.ts#L15), validated via `deployManifestSchema`):

```json
{
  "status": "deploy_ok",
  "generated_at": "2026-03-17T14:37:26.643Z",
  "network": {
    "node_url": "https://rpc.testnet.aztec-labs.com/",
    "node_version": "4.1.0-rc.2",
    "l1_chain_id": 11155111,
    "rollup_version": 1
  },
  "aztec_required_addresses": {
    "sponsored_fpc_address": "0x..."
  },
  "deployer_address": "0x...",
  "contracts": {
    "fpc": "0x..."
  },
  "operator": {
    "address": "0x...",
    "pubkey_x": "0x...",
    "pubkey_y": "0x..."
  },
  "tx_hashes": {
    "fpc_deploy": "0x..."
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | literal `"deploy_ok"` | Always this value on success |
| `generated_at` | ISO 8601 timestamp | When the manifest was written |
| `network.node_url` | HTTP(S) URL | The Aztec node used for deployment |
| `network.node_version` | string | Node version reported by `getNodeInfo` |
| `network.l1_chain_id` | positive integer | L1 chain ID (e.g. 11155111 for Sepolia) |
| `network.rollup_version` | positive integer | Rollup version from node |
| `aztec_required_addresses.sponsored_fpc_address` | Aztec address (optional) | Present only if `--sponsored-fpc-address` was used |
| `deployer_address` | Aztec address | The deployer's L2 address |
| `contracts.fpc` | Aztec address | Deployed FPC contract address |
| `operator.address` | Aztec address | Operator's L2 address (derived from secret key) |
| `operator.pubkey_x` | field value | Operator Schnorr public key X coordinate |
| `operator.pubkey_y` | field value | Operator Schnorr public key Y coordinate |
| `tx_hashes.fpc_deploy` | tx hash | FPC contract deployment transaction hash |

> [!WARNING]
> **L1 contract addresses are not in the manifest.** L1 addresses (Fee Juice token, portal, rollup) come from `nodeInfo` at runtime, not from the deployment manifest. The services resolve them automatically.

Manifest file locations by path:

| Path | Manifest location |
|------|-------------------|
| Docker | `deployments/manifest.json` (default `$FPC_DATA_DIR/manifest.json`) |
| Bun (`deploy:fpc`) | `deployments/manifest.json` (default `$FPC_DATA_DIR/manifest.json`) |
| Docker Compose public | `deployments/${DEPLOYMENT}/manifest.json` |

## Verify Deployment

Post-deploy verification reads on-chain state and compares against the manifest. Checks performed:

- Contract existence on node for `fpc`
- FPC immutable config matches the manifest's operator and pubkeys
- Contract instance readiness (published instance + non-zero initialization hash)
- Contract class publicly registered

Programmatic API: `verifyDeployment()` from `contract-deployment/src/verify.ts`.

Re-generate configs from an existing manifest:

```bash
docker run -v ./deployments:/app/deployments \
  --entrypoint bash \
  nethermind/aztec-fpc-contract-deployment:local \
  scripts/config/generate-service-configs.sh
```

## Security Notes

- **Never pass secrets as CLI arguments or inline `-e KEY=VALUE`.** Export them first (`export FPC_DEPLOYER_SECRET_KEY=...`), then pass by name (`-e FPC_DEPLOYER_SECRET_KEY`). Inline values are visible in `ps`, `docker inspect`, and shell history.
- `manifest.json` may contain raw private keys. Treat as secret material. Never commit.
- Prefer `_REF` variants (KMS, secret manager) over plaintext keys in production.
- Set `runtime_profile: production` in service configs to reject plaintext secrets at startup.

## Next Steps

- [Run an FPC Operator](../how-to/run-operator.md): production hardening (KMS, HTTPS, alerts)
- [Docker and CI](../operations/docker.md): image build and CI pipeline
- [Configuration](../operations/configuration.md): every service config field
