# FPC Contracts — `BackedCreditFPC`

Operator-run fee payment contract for Aztec L2:
- `BackedCreditFPC`: pay once in token + mint private fee credit backed by operator collateral, then spend that credit in later transactions.

Full protocol specification: [docs/spec.md](docs/spec.md)

Operational probes and metrics: [docs/operational-metrics.md](docs/operational-metrics.md)

---

## Repository Layout

```text
aztec-fpc/
├── contracts/
│   └── backed_credit_fpc/
│       ├── Nargo.toml          ← Noir package (git-pinned Aztec deps)
│       └── src/
│           ├── main.nr         ← BackedCreditFPC contract
│           ├── fee_math.nr     ← Fee math helpers
│           └── test/           ← Contract integration/unit tests
├── services/
│   ├── attestation/            ← Quote-signing REST service (TypeScript)
│   │   └── test/               ← Contract + service smoke harnesses
│   └── topup/                  ← L2 balance monitor + L1 bridge service (TypeScript)
├── scripts/
│   └── contract/               ← Contract smoke wrappers
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

The `backed_credit_fpc` tests deploy the token contract from `vendor/aztec-standards`. If submodules are not initialized, tests will fail.

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
- `target/backed_credit_fpc-BackedCreditFPC.json`
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

If you run `aztec test --package backed_credit_fpc` directly on a clean checkout, run
`aztec compile --workspace --force` first so external resolver artifacts are present.

### TypeScript quality checks

```bash
bun run format
bun run lint
bun run typecheck
bun run ci
```

### CI workflow coverage

- `build-contract.yml`: noir format + compile + `aztec test --package backed_credit_fpc`
- `ts-packages.yml`: biome + typecheck + TS build/tests

### 5. Deploy contracts manually

```bash
# operator = your Aztec account (receives fees, signs quotes)
# operator_pubkey_x/y = Schnorr signing public key coordinates for quote signatures
# accepted_asset = token contract address accepted for payments
aztec deploy \
  --artifact target/backed_credit_fpc-BackedCreditFPC.json \
  --args <operator_address> <operator_pubkey_x> <operator_pubkey_y> <accepted_asset_address>
```

Record the deployed address.

### 6. Configure and start the attestation service

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

### 7. Configure and start the top-up service

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

### 8. Docker

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

### 9. Verify

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
aztec test --package backed_credit_fpc
```

---

## Payment Flows

Fully private entry-points:

| Entry-point | Source | Destination | Quote |
|---|---|---|---|
| `pay_and_mint` | User private balance | Operator private balance + user credit note | User-specific |
| `pay_with_credit` | User credit note | Fee settlement (no token transfer) | Not required |

```
User private token balance →[pay_and_mint]→ User private credit balance
User private credit balance →[pay_with_credit]→ Fee payment
```

- Token charge for signed quote flows = `ceil(base_amount × rate_num / rate_den)`.
- Quote binds to `msg_sender` and is nullified after first use.
- `BackedCreditFPC.pay_and_mint` converts token payment into private fee credit for subsequent `pay_with_credit` calls.

See [docs/spec.md](docs/spec.md) for the base quote/topup/fee design and security considerations.

---

## Security Notes

- **Operator key**: single key — receives all revenue and signs all quotes. Use a hardware wallet or KMS in production. Compromise requires redeployment (no on-chain rotation).
- **L1 operator key**: used only by the top-up service. Keep minimal ETH balance.
- Services support secret provider abstraction (env first; pluggable KMS/HSM adapters). Set `runtime_profile=production` to fail fast on plaintext config secrets.
