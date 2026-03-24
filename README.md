# FPC Contracts

Operator-run fee payment contracts for Aztec L2. Pay transaction fees in any supported token via private transfer to the operator.

Current contract surface: `FPCMultiAsset`.

---

## Deploy FPC

Deploy the FPC contract and run the full operator stack with a single Docker Compose command. No local toolchain required — the images ship with pre-compiled contract artifacts.

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_key>
export FPC_OPERATOR_SECRET_KEY=0x<operator_key>
export FPC_L1_DEPLOYER_KEY=0x<l1_deployer_key>

DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

This deploys contracts, generates service configs, and starts the attestation and topup services. Output goes to `deployments/testnet/`.

To deploy FPC against an existing token (skip test token deployment):

```bash
export FPC_ACCEPTED_ASSET=0x<token_address>
DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

**[Full deployment & integration guide](docs/aztec-deployer-user-guide.md)** — deployer setup, service configuration, SDK integration, API reference, and troubleshooting.

---

## Integrate with the SDK

Use [`@aztec-fpc/sdk`](sdk/) to construct FPC payment methods and execute cold-start flows from your application.

```ts
import { FpcClient } from "@aztec-fpc/sdk";

const client = new FpcClient({
  fpcAddress,
  operator,
  node,
  attestationBaseUrl: "https://your-attestation-service.example.com",
});

// Create a payment method for an existing transaction
const result = await client.createPaymentMethod({
  wallet,
  user,
  tokenAddress,
  estimatedGas: simulation.estimatedGas,
});

// Or cold-start: claim bridged tokens and pay fees in one tx
const coldStart = await client.executeColdStart({
  wallet,
  userAddress,
  tokenAddress,
  bridgeAddress,
  bridgeClaim,
});
```

**[Full SDK documentation](sdk/README.md)** — installation, API reference, `createPaymentMethod` and `executeColdStart` usage, artifact loading, and returned types.

---

## Documentation

| Document | Description |
|----------|-------------|
| **[docs/aztec-deployer-user-guide.md](docs/aztec-deployer-user-guide.md)** | **Main guide** — deployment, services, SDK integration, API reference |
| [sdk/README.md](sdk/README.md) | SDK integration guide |
| [docs/ops/docker-deployment-guide.md](docs/ops/docker-deployment-guide.md) | Docker image CLI arguments, config generation, Compose examples |
| [docs/ops/devnet-deployment-how-to.md](docs/ops/devnet-deployment-how-to.md) | Non-Docker devnet deployment via `bun run deploy:fpc` |
| [docs/ops/operator-runbook.md](docs/ops/operator-runbook.md) | 30-minute local operator quick-start |
| [docs/ops/operational-metrics.md](docs/ops/operational-metrics.md) | Prometheus metrics and health probes reference |
| [docs/spec/protocol-spec.md](docs/spec/protocol-spec.md) | Full protocol specification |
| [docs/spec/wallet-discovery-spec.md](docs/spec/wallet-discovery-spec.md) | Wallet discovery (`GET /.well-known/fpc.json`) |
| [docs/spec/e2e-test-spec.md](docs/spec/e2e-test-spec.md) | E2E test definition and runbook |
| [docs/spec/adr-0001-alpha-asset-model.md](docs/spec/adr-0001-alpha-asset-model.md) | Alpha asset model decision record |

---

## Repository Layout

```text
aztec-fpc/
├── contracts/
│   ├── fpc/
│   │   ├── Nargo.toml          ← Noir package (git-pinned Aztec deps)
│   │   └── src/
│   │       ├── main.nr         ← FPC contract
│   │       └── test/           ← Contract integration/unit tests
├── services/
│   ├── attestation/            ← Quote-signing REST service (TypeScript)
│   │   └── test/               ← Contract + service smoke harnesses
│   └── topup/                  ← L2 balance monitor + L1 bridge service (TypeScript)
├── sdk/                        ← TypeScript SDK for constructing FPC payment methods
│   ├── src/                    ← Public client, exported types, and artifact loading
│   └── test/                   ← SDK unit tests
├── scripts/
│   ├── contract/               ← Deploy + contract smoke wrappers
│   ├── services/               ← Service bootstrap and operational scripts
│   └── tests/                  ← Integration and E2E test suites
├── vendor/
│   └── aztec-standards/        ← Git submodule (token contract dependency)
└── docs/
    ├── aztec-deployer-user-guide.md  ← Main deployment & integration guide
    ├── spec/                         ← Protocol & design specs
    └── ops/                          ← Operator runbooks & deployment guides
```

---

## Quick Start

### Prerequisites

- Bun `1.3.9`
- Aztec CLI

```bash
VERSION=4.1.0-nightly.20260312.2 bash -i <(curl -sL https://install.aztec.network/4.1.0-nightly.20260312.2)
```

### 1. Clone the repository with submodules (required)

The `fpc` tests deploy the token contract from `vendor/aztec-standards`. If submodules are not initialized, tests will fail.

Fresh clone:

```bash
git clone --recurse-submodules https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
```

If you already cloned without submodules:

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

Verify submodule is present:

```bash
git submodule status --recursive
```

You should see `vendor/aztec-standards` in the output.

### 2. Install dependencies

```bash
bun install
```

### 3. Compile contracts (workspace)

Compile the full workspace so all required artifacts exist:
- `target/fpc-FPCMultiAsset.json`
- `target/generic_proxy-GenericProxy.json`
- `target/token_contract-Token.json`

```bash
aztec compile --workspace --force
```

### 4. Format and run tests locally

```bash
nargo fmt
bun run test:contracts
```

If you run `aztec test --package fpc` directly on a clean checkout, run
`aztec compile --workspace --force` first so external resolver artifacts are present.

### TypeScript quality checks

```bash
bun run format
bun run lint
bun run typecheck
bun run ci
```

### CI workflow coverage

- `build-contract.yml`: noir format + compile + `aztec test --package fpc`
- `ts-packages.yml`: biome + typecheck + TS build/tests

- `spec-deploy-smoke.yml`: local deploy smoke for `deploy-fpc-local` output validation
- `spec-full-lifecycle-compose.yml`: compose-backed full lifecycle suite for `FPC`, with uploaded diagnostics artifacts

### 5. Run fee-entrypoint negative-path smoke test

Negative-path smoke test that verifies `fee_entrypoint` cannot be called as a root-level transaction outside the setup phase. Uses pre-deployed contracts from a deployment manifest and fetches a real quote from the attestation service via the SDK. Run via docker compose (`smoke` or `full` profile) or directly:

```bash
FPC_COLD_START_MANIFEST=path/to/manifest.json \
FPC_ATTESTATION_URL=http://localhost:3000 \
  bun run smoke:fee-entrypoint
```

Required:

- `FPC_COLD_START_MANIFEST` — path to deployment manifest
- `FPC_ATTESTATION_URL` — attestation service base URL

Optional overrides:

- `AZTEC_NODE_URL` (default `http://localhost:8080`)
- `L1_RPC_URL` (default `http://127.0.0.1:8545`)

### 6. Run local-devnet services smoke test (attestation + topup + contract flows)

This script implements Step 8 from the services plan:

1. builds both services,
2. deploys `Token` + `FPC`,
3. starts attestation and topup with generated test configs,
4. requests `/quote?user=<address>&fj_amount=<u128>`,
5. submits transactions using quote fields (`fj_amount`, `aa_payment_amount`, `valid_until`, `signature`),
6. confirms topup behavior and successful fee flows.

```bash
bun run smoke:services:compose
```
- `FPC_SERVICES_SMOKE_RESET_LOCAL_STATE` (default `1`)
- `FPC_SERVICES_SMOKE_L1_PRIVATE_KEY` (default local anvil key)
- `FPC_SERVICES_SMOKE_TOPUP_WEI`, `FPC_SERVICES_SMOKE_THRESHOLD_WEI`
- `FPC_SERVICES_SMOKE_ATTESTATION_PORT` (default `3300`)
- `FPC_SERVICES_SMOKE_TOPUP_OPS_PORT` (default `3401`)

### 7. Deploy contracts (recommended)

Use the local deploy wrapper (deploys `Token` and `FPC`):

For `aztec start --local-network`, FeeJuice L1 contracts are bootstrap-provisioned and discovered from node info; local deploy scripts should only deploy L2 contracts (`Token`, `FPC`) and consume node-reported L1 addresses.

```bash
bun run deploy:fpc:local
```

Useful overrides:

- `AZTEC_NODE_URL` (default `http://127.0.0.1:8080`)
- `L1_RPC_URL` (default `http://127.0.0.1:8545`)
- `FPC_LOCAL_OPERATOR` (default local `test0` Aztec address)
- `FPC_LOCAL_OUT` (default `./tmp/deploy-fpc-local.json`)

Pass through extra deploy args when needed (for example reuse mode):

```bash
bun run deploy:fpc:local -- --reuse
```

### 9. Run local deploy smoke (deploy output + relay claim validation)

This smoke flow:
1. runs `deploy:fpc:local`,
2. validates deploy output addresses for `FPC`,
3. bridges Fee Juice from L1 to the deployed FPC,
4. runs relay-aware L1->L2 claim checks against the deployed FPC.

```bash
bun run smoke:deploy:fpc:local
```

Useful overrides:

- `FPC_DEPLOY_SMOKE_START_LOCAL_NETWORK` (default `1`)
- `FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE` (default: `1` only when smoke starts local-network, otherwise `0`)
- `FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT` (default temp path under `/tmp`)
- `FPC_DEPLOY_SMOKE_TOPUP_WEI` (default `1000000`)

### Devnet deployment and validation (live network)

For the current devnet deployment flow, see [devnet-deployment-how-to.md](docs/ops/devnet-deployment-how-to.md).

Canonical command sequence:

```bash
cd <repo-root>

# Load your local env file if used by your setup
set -a; source .env; set +a

# 1) Deploy Token/FPC and write canonical manifest
bun run deploy:fpc:devnet

# 2) Verify deployed contracts and FPC immutables from manifest
bun run verify:deploy:fpc:devnet

# 3) Generate attestation/topup configs from manifest + master config
bun run generate:configs

# 4) Execute post-deploy runtime smoke
bun run smoke:deploy:fpc:devnet
```

Manifest secret-handling warning:

- `deployments/devnet-manifest-v2.json` can contain raw private keys if you use `FPC_DEVNET_DEPLOYER_SECRET_KEY` or `L1_OPERATOR_PRIVATE_KEY`.
- Treat the manifest as secret material and do not commit it to public repos.
- Prefer key reference inputs (`*_SECRET_KEY_REF`, `*_SECRET_REF`) where supported.

### 10. Deploy contracts manually (alternative)

```bash
# operator = your Aztec account (receives fees, signs quotes)
# operator_pubkey_x/y = Schnorr signing public key coordinates for quote signatures
# accepted_asset is selected per quote/request (not constructor-bound)
aztec deploy \
  --artifact target/fpc-FPCMultiAsset.json \
  --args <operator_address> <operator_pubkey_x> <operator_pubkey_y>
```

Record the deployed address.

### 11. Configure and start the attestation service

```bash
cd services/attestation
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, accepted_asset_*, rates
# Default runtime_profile is development (config secrets allowed).
# In production, set runtime_profile=production and provide OPERATOR_SECRET_KEY
# and remove config.operator_secret_key from config.yaml
# (any plaintext config secret material is rejected at startup).
# /quote auth:
# - development/test: quote_auth_mode can stay "disabled"
# - production: quote_auth_mode must be one of
#   api_key, trusted_header, api_key_or_trusted_header, api_key_and_trusted_header
#   and required auth fields must be configured.
# /quote rate limiting:
# - fixed-window throttling is enabled by default
# - identity is valid API key (when api-key auth mode is active), otherwise remote IP
# - behind reverse proxies, ensure the service sees real client IPs if using IP-based limits
# - tune with quote_rate_limit_* config keys or QUOTE_RATE_LIMIT_* env overrides
bun install && bun run build && bun run start
```

### 12. Configure and start the top-up service

```bash
cd services/topup
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, aztec_node_url, l1_rpc_url
# l1_chain_id and fee juice L1 addresses are auto-discovered from nodeInfo
# Bridge confirmation uses L1->L2 message readiness plus Fee Juice balance-delta fallback
# In-flight bridge metadata is persisted to data_dir (or TOPUP_DATA_DIR)
# so restarts reconcile pending bridges before submitting new ones.
# If reconciliation times out, the state is retained and bridge submissions are deferred
# until a later reconciliation attempt succeeds.
# Top-up exposes ops endpoints on ops_port (default 3001):
# - /health (liveness)
# - /ready (readiness)
# - /metrics (Prometheus format)
# Default runtime_profile is development (config secrets allowed).
# In production, set runtime_profile=production and provide L1_OPERATOR_PRIVATE_KEY
# and remove config.l1_operator_private_key from config.yaml
# (any plaintext config secret material is rejected at startup).
bun install && bun run build && bun run start
```

### 13. Docker

#### Building images

Both service images are built with [Docker Buildx Bake](https://docs.docker.com/build/bake/) via `docker-bake.hcl`. The bake file uses a two-stage build: `Dockerfile.common` produces a shared runtime base, then each service's Dockerfile adds its entrypoint and healthcheck.

```bash
# Build both images (attestation + topup)
docker buildx bake

# Build a single target
docker buildx bake attestation
docker buildx bake topup

# Custom tag / registry
TAG=v0.1.0 docker buildx bake
REGISTRY=ghcr.io/ TAG=v0.1.0 docker buildx bake

# Tag with current git SHA
GIT_SHA=$(git rev-parse HEAD) docker buildx bake
```

Or via the workspace scripts:

```bash
bun run docker:build
bun run docker:build:attestation
bun run docker:build:topup
```

#### Running with Docker Compose

The compose stack (`docker-compose.yaml`) includes:

| Service | Description | Port |
|---------|-------------|------|
| `anvil` | Local L1 chain (Foundry) | 8545 |
| `aztec-node` | Aztec sandbox node | 8080 |
| `attestation` | FPC attestation service | 3000 |
| `topup` | FPC Fee Juice top-up daemon + ops probe server | 3001 |
| `tests-fee-entrypoint-validation` (profile `full`) | Fee entrypoint validation test runner | — |

Each service reads a `config.yaml` mounted into the container. By default these are `config.example.yaml`:

```
services/attestation/config.yaml -> config.example.yaml
services/topup/config.yaml       -> config.example.yaml
```

Run compose in mode-based flows:

```bash
# Infra only (no tests)
bun run compose:infra

# Full mode (deployment + smoke tests, exits with smoke status)
bun run compose:full

# Or directly with docker compose for infra-only
docker compose up
```

Run compose-backed full lifecycle suite:

```bash
bun run e2e:full-lifecycle:fpc:compose
```

Compose full-lifecycle artifacts are persisted under:

```text
artifacts/compose-e2e/fpc
```

#### Environment variable overrides

Environment variables take precedence over values in the config file:

| Variable | Used by | Compose default |
|----------|---------|-----------------|
| `AZTEC_NODE_URL` | attestation, topup | `http://aztec-node:8080` |
| `L1_RPC_URL` | topup | `http://anvil:8545` |
| `OPERATOR_SECRET_KEY` | attestation | — |
| `QUOTE_AUTH_MODE` | attestation | `disabled` |
| `QUOTE_AUTH_API_KEY` | attestation | — |
| `QUOTE_AUTH_API_KEY_HEADER` | attestation | `x-api-key` |
| `QUOTE_AUTH_TRUSTED_HEADER_NAME` | attestation | — |
| `QUOTE_AUTH_TRUSTED_HEADER_VALUE` | attestation | — |
| `QUOTE_RATE_LIMIT_ENABLED` | attestation | `true` |
| `QUOTE_RATE_LIMIT_MAX_REQUESTS` | attestation | `60` |
| `QUOTE_RATE_LIMIT_WINDOW_SECONDS` | attestation | `60` |
| `QUOTE_RATE_LIMIT_MAX_TRACKED_KEYS` | attestation | `10000` |
| `L1_OPERATOR_PRIVATE_KEY` | topup | — |
| `TOPUP_DATA_DIR` | topup | `.topup-data` |
| `TOPUP_OPS_PORT` | topup | `3001` |

Pass them via a `.env` file or inline:

```bash
OPERATOR_SECRET_KEY=0x... \
QUOTE_AUTH_MODE=api_key \
QUOTE_AUTH_API_KEY=replace-with-random-secret \
L1_OPERATOR_PRIVATE_KEY=0x... \
docker compose up
```

### 14. Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics
curl http://localhost:3000/asset
# quote_auth_mode=disabled
curl "http://localhost:3000/quote?user=<your_aztec_address>&fj_amount=1000000"
# quote_auth_mode=api_key
curl -H "x-api-key: <your_api_key>" "http://localhost:3000/quote?user=<your_aztec_address>&fj_amount=1000000"
# quote_auth_mode=trusted_header
curl -H "x-internal-attestation: allow" "http://localhost:3000/quote?user=<your_aztec_address>&fj_amount=1000000"
curl http://localhost:3001/health
curl http://localhost:3001/ready
curl http://localhost:3001/metrics
```

### Troubleshooting

If you see errors like:
- `ENOENT: ... target/token_contract-Token.json`
- `No constructor found with name constructor_with_minter`

run:

```bash
git submodule sync --recursive
git submodule update --init --recursive
aztec compile --workspace --force
aztec test --package fpc
```

---

## Payment Flows

Fully private entry-points:

| Entry-point | Source | Destination | Quote |
|---|---|---|---|
| `fee_entrypoint` | User private balance | Operator private balance | User-specific |

```
User private token balance →[transfer_private_to_private]→ Operator private token balance
```

- Signed quote flows return exact amounts: `fj_amount` and `aa_payment_amount`.
- Quote binds to `msg_sender` and is nullified after first use.
- `FPC.fee_entrypoint` pays directly with token each transaction.

See [docs/spec/protocol-spec.md](docs/spec/protocol-spec.md) for the base quote/topup/fee design and security considerations.

---

## Security Notes

- **Operator key**: single key — receives all revenue and signs all quotes. Use a hardware wallet or KMS in production. Compromise requires redeployment (no on-chain rotation).
- **L1 operator key**: used only by the top-up service. Keep minimal ETH balance.
- Services support secret provider abstraction (env first; pluggable KMS/HSM adapters). Set `runtime_profile=production` to fail fast on plaintext config secrets.
