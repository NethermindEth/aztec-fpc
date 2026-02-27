# FPC Contracts — `FPC` + `CreditFPC`

Operator-run fee payment contracts for Aztec L2:
- `FPC`: pay fees directly in one fixed token via private transfer to the operator.
- `CreditFPC`: pay once in token + mint private fee credit, then spend that credit in later transactions.

Full protocol specification: [docs/spec.md](docs/spec.md)

Operational probes and metrics: [docs/operational-metrics.md](docs/operational-metrics.md)

---

## Repository Layout

```text
aztec-fpc/
├── contracts/
│   ├── fpc/
│   │   ├── Nargo.toml          ← Noir package (git-pinned Aztec deps)
│   │   └── src/
│   │       ├── main.nr         ← FPC contract
│   │       ├── fee_math.nr     ← Fee math helpers
│   │       └── test/           ← Contract integration/unit tests
│   └── credit_fpc/
│       ├── Nargo.toml          ← Noir package (git-pinned Aztec deps)
│       └── src/
│           ├── main.nr         ← CreditFPC contract
│           ├── fee_math.nr     ← Fee math helpers
│           └── test/           ← Contract integration/unit tests
├── services/
│   ├── attestation/            ← Quote-signing REST service (TypeScript)
│   │   └── test/               ← Contract + service smoke harnesses
│   └── topup/                  ← L2 balance monitor + L1 bridge service (TypeScript)
├── scripts/
│   ├── contract/               ← Deploy + contract smoke wrappers (FPC and CreditFPC)
│   └── services/               ← Service-integrated smoke wrapper (fpc|credit|both)
├── vendor/
│   └── aztec-standards/        ← Git submodule (token contract dependency)
└── docs/
    └── spec.md                 ← Full protocol specification
```

---

## Quick Start

### Prerequisites

- Bun `1.3.9`
- Aztec CLI

```bash
VERSION=4.0.0-devnet.2-patch.1 bash -i <(curl -sL https://install.aztec.network/4.0.0-devnet.2-patch.1)
```

### 1. Clone the repository with submodules (required)

The `fpc` and `credit_fpc` tests deploy the token contract from `vendor/aztec-standards`. If submodules are not initialized, tests will fail.

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
- `target/fpc-FPC.json`
- `target/credit_fpc-CreditFPC.json`
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

If you run `aztec test --package fpc` or `aztec test --package credit_fpc` directly on a clean checkout, run
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
- `spec-fee-entrypoint-smoke.yml`: local-devnet smoke for `FPC.fee_entrypoint`
- `spec-credit-fpc-smoke.yml`: local-devnet smoke for `CreditFPC.pay_and_mint` + `pay_with_credit`
- `spec-deploy-smoke.yml`: local deploy smoke for `deploy-fpc-local` output validation
- `spec-services-smoke.yml`: service-integrated local-network smoke (`FPC_SERVICES_SMOKE_MODE=fpc|credit|both`) covering quote + topup + contract fee flow

### 5. Run local-devnet FPC fee-entrypoint smoke test

This runs a full payment flow outside TXE tests:

1. compile artifacts,
2. deploy `Token` + `FPC`,
3. mint user private balance,
4. execute `fee_entrypoint` with quote signature + token transfer authwit,
5. assert operator private balance increased by the expected charge.

```bash
aztec start --local-network
```

Default local-network endpoints:
- Aztec node / PXE RPC: `http://localhost:8080`
- Anvil L1 RPC (spawned by `aztec start --local-network`): `http://127.0.0.1:8545`

```bash
bun run smoke:fee-entrypoint:devnet
# or:
bash scripts/contract/fee-entrypoint-devnet-smoke.sh
```

Smoke implementation file:
`services/attestation/test/fee-entrypoint-devnet-smoke.ts`

Optional overrides:

- `AZTEC_NODE_URL` (default `http://localhost:8080`)
- `FPC_SMOKE_L1_RPC_URL` (default `http://127.0.0.1:8545`)
- `FPC_SMOKE_NODE_TIMEOUT_MS` (default `30000`)
- `FPC_SMOKE_RATE_NUM`, `FPC_SMOKE_RATE_DEN` (defaults: `10200` / `10000000`)
- `FPC_SMOKE_DA_GAS_LIMIT`, `FPC_SMOKE_L2_GAS_LIMIT`
- `FPC_SMOKE_FEE_PER_DA_GAS`, `FPC_SMOKE_FEE_PER_L2_GAS` (default: current node min fees)
- `FPC_SMOKE_FEE_JUICE_TOPUP_WEI` (default: conservative auto-top-up from configured gas settings)
- `FPC_SMOKE_RELAY_ADVANCE_BLOCKS` (default: `2`; sends this many mock L2 txs after L1 bridge submit to unblock local relay)
- `FPC_SMOKE_QUOTE_TTL_SECONDS`
- `FPC_SMOKE_RESET_LOCAL_STATE` (default `1`; set `0` to reuse existing `wallet_data_*`/`pxe_data_*`)

### 6. Run local-devnet CreditFPC smoke test

This runs a full CreditFPC flow outside TXE tests:

1. compile artifacts,
2. deploy `Token` + `CreditFPC`,
3. mint user private token balance,
4. execute `pay_and_mint` with a signed quote,
5. assert quote replay protection via `quote_used`,
6. execute `pay_with_credit`.

```bash
bun run smoke:credit-fpc:devnet
# or:
bash scripts/contract/credit-fpc-devnet-smoke.sh
```

Smoke implementation file:
`services/attestation/test/credit-fpc-devnet-smoke.ts`

Useful overrides:

- `AZTEC_NODE_URL` (default `http://localhost:8080`)
- `CREDIT_FPC_SMOKE_L1_RPC_URL` (default `http://localhost:8545`)
- `CREDIT_FPC_SMOKE_NODE_TIMEOUT_MS` (default `30000`)
- `CREDIT_FPC_SMOKE_RATE_NUM`, `CREDIT_FPC_SMOKE_RATE_DEN` (defaults: `1` / `1`)
- `CREDIT_FPC_SMOKE_QUOTE_TTL_SECONDS` (default `3600`)
- `CREDIT_FPC_SMOKE_RELAY_ADVANCE_BLOCKS` (default `2`, must be `>=2`)
- `CREDIT_FPC_SMOKE_MINT_MULTIPLIER` (default `5`, must be `>1`)
- `CREDIT_FPC_SMOKE_MINT_BUFFER` (default `1000000`, must be `>0`)
- `CREDIT_FPC_SMOKE_RESET_LOCAL_STATE` (default `1`; set `0` to reuse existing `wallet_data_*`/`pxe_data_*`)

### 7. Run local-devnet services smoke test (attestation + topup + contract flows)

This script implements Step 8 from the services plan:

1. builds both services,
2. deploys `Token` + `FPC` + `CreditFPC`,
3. starts attestation and topup with generated test configs,
4. requests `/quote?user=<address>`,
5. submits transactions using quote fields (`rate_num`, `rate_den`, `valid_until`, `signature`),
6. confirms topup behavior and successful fee flows.

```bash
bun run smoke:services
# or:
bash scripts/services/fpc-services-smoke.sh
```

Useful overrides:

- `FPC_SERVICES_SMOKE_START_LOCAL_NETWORK` (default `1`; auto-starts `aztec start --local-network` if 8080/8545 are unavailable)
- `FPC_SERVICES_SMOKE_RESET_LOCAL_STATE` (default `1`)
- `FPC_SERVICES_SMOKE_MODE` (default `both`; options: `fpc`, `credit`, `both`)
- `FPC_SERVICES_SMOKE_L1_PRIVATE_KEY` (default local anvil key)
- `FPC_SERVICES_SMOKE_TOPUP_WEI`, `FPC_SERVICES_SMOKE_THRESHOLD_WEI`
- `FPC_SERVICES_SMOKE_ATTESTATION_PORT` (default `3300`)
- `FPC_SERVICES_SMOKE_TOPUP_OPS_PORT` (default `3401`)
- `FPC_SERVICES_SMOKE_RELAY_ADVANCE_BLOCKS` (default: `2`; sends mock L2 txs after bridge submit so local relay can finalize)
- `FPC_SERVICES_SMOKE_CREDIT_MINT_MULTIPLIER` (default `5`)
- `FPC_SERVICES_SMOKE_CREDIT_MINT_BUFFER` (default `1000000`)

### 8. Deploy contracts (recommended)

Use the local deploy wrapper (deploys `Token`, `FPC`, and `CreditFPC`):

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
2. validates deploy output addresses for `FPC` and `CreditFPC`,
3. bridges Fee Juice from L1 to the deployed FPC,
4. runs relay-aware L1->L2 claim checks against the deployed FPC.

```bash
bun run smoke:deploy:fpc:local
```

Useful overrides:

- `FPC_DEPLOY_SMOKE_START_LOCAL_NETWORK` (default `1`)
- `FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE` (default: `1` only when smoke starts local-network, otherwise `0`)
- `FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT` (default temp path under `/tmp`)
- `FPC_DEPLOY_SMOKE_RELAY_ADVANCE_BLOCKS` (default `2`, must be `>=2`)
- `FPC_DEPLOY_SMOKE_TOPUP_WEI` (default `1000000`)

### 10. Deploy contracts manually (alternative)

```bash
# operator = your Aztec account (receives fees, signs quotes)
# operator_pubkey_x/y = Schnorr signing public key coordinates for quote signatures
# accepted_asset = token contract address accepted for payments
aztec deploy \
  --artifact target/fpc-FPC.json \
  --args <operator_address> <operator_pubkey_x> <operator_pubkey_y> <accepted_asset_address>

aztec deploy \
  --artifact target/credit_fpc-CreditFPC.json \
  --args <operator_address> <operator_pubkey_x> <operator_pubkey_y> <accepted_asset_address>
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
# In-flight bridge metadata is persisted to bridge_state_path (or TOPUP_BRIDGE_STATE_PATH)
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

Each service reads a `config.yaml` mounted into the container. By default these are `config.example.yaml`:

```
services/attestation/config.yaml -> config.example.yaml
services/topup/config.yaml       -> config.example.yaml
```

Start the stack:

```bash
docker compose up
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
| `TOPUP_BRIDGE_STATE_PATH` | topup | `.topup-bridge-state.json` |
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
curl "http://localhost:3000/quote?user=<your_aztec_address>"
# quote_auth_mode=api_key
curl -H "x-api-key: <your_api_key>" "http://localhost:3000/quote?user=<your_aztec_address>"
# quote_auth_mode=trusted_header
curl -H "x-internal-attestation: allow" "http://localhost:3000/quote?user=<your_aztec_address>"
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
aztec test --package credit_fpc
```

---

## Payment Flows

Fully private entry-points:

| Entry-point | Source | Destination | Quote |
|---|---|---|---|
| `fee_entrypoint` | User private balance | Operator private balance | User-specific |
| `pay_and_mint` | User private balance | Operator private balance + user credit note | User-specific |
| `pay_with_credit` | User credit note | Fee settlement (no token transfer) | Not required |

```
User private token balance →[transfer_private_to_private]→ Operator private token balance
User private token balance →[pay_and_mint]→ User private credit balance
User private credit balance →[pay_with_credit]→ Fee payment
```

- Token charge for signed quote flows = `ceil(base_amount × rate_num / rate_den)`.
- Quote binds to `msg_sender` and is nullified after first use.
- `FPC.fee_entrypoint` pays directly with token each transaction.
- `CreditFPC.pay_and_mint` converts token payment into private fee credit for subsequent `pay_with_credit` calls.

See [docs/spec.md](docs/spec.md) for the base quote/topup/fee design and security considerations.

---

## Security Notes

- **Operator key**: single key — receives all revenue and signs all quotes. Use a hardware wallet or KMS in production. Compromise requires redeployment (no on-chain rotation).
- **L1 operator key**: used only by the top-up service. Keep minimal ETH balance.
- Services support secret provider abstraction (env first; pluggable KMS/HSM adapters). Set `runtime_profile=production` to fail fast on plaintext config secrets.
