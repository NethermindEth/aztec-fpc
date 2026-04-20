# FPC: Fee Payment Contracts for Aztec

> **Using an AI assistant?** Paste this into your agent to give it full project context:
> ```
> Read this project context before answering: curl -sL https://raw.githubusercontent.com/NethermindEth/aztec-fpc/main/website/public/llms.txt
> ```
> For the full docs (~5k lines): replace `llms.txt` with `llms-full.txt`. See [`AGENT_PROMPT.md`](website/public/AGENT_PROMPT.md) for a ready-to-paste prompt.

## Why FPC Exists

Every transaction on Aztec L2 costs gas, paid in the native **Fee Juice** token (more in the [docs](https://docs.aztec.network/developers/docs/foundational-topics/fees)). Fee Juice creates two problems for users:

1. **Cold start**: Users arrive on Aztec by bridging assets like USDC or ETH from Ethereum — they have no Fee Juice and may not even have a deployed account contract. You need Fee Juice to do anything, but getting Fee Juice *is* doing something.
2. **Ongoing UX friction**: Even after onboarding, users don't want to keep buying and bridging small amounts of Fee Juice just to run transactions. They already hold tokens — they should be able to pay with those.

**This FPC implementation solves both.** Users pay fees in whatever token the operator accepts (e.g., USDC/ETH/...); the FPC pays the actual gas in Fee Juice on their behalf.

## How It Works

The FPC system has following components:

| Component | Role |
|---|---|
| **FPC contract** (`FPCMultiAsset`) | Smart contract on Aztec L2 that sits between the user and the protocol — it accepts the user's token payment, pays the gas on their behalf, and delivers the remaining tokens to the user |
| **Attestation service** | Pricing API the wallet calls before each transaction — returns a signed price quote telling the user exactly how much token they'll pay for a given amount of gas |
| **Top-up service** | Background daemon that watches the FPC's gas balance and automatically tops it up by bridging Fee Juice from Ethereum L1, so the FPC always has gas to cover user transactions |

## Token Flow

There are two transaction paths. Both are fully private*.


### Cold Start (`cold_start_entrypoint`)

For users who just bridged tokens from L1 — no L2 balance, no deployed account:

```
┌──────────────┐                         ┌──────────────────┐
│ Ethereum L1  │  User deposits tokens   │   Aztec Bridge   │
│  (e.g. USDC) │ ──────────────────────► │   (L1 portal)    │
└──────────────┘                         └────────┬─────────┘
                                                  │ L1→L2 message
                                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Aztec L2 — cold_start_entrypoint (this IS the tx, no account    │
│             entrypoint needed)                                   │
│                                                                  │
│  Setup phase:                                                    │
│    Perform verifications & guards                                │
│    FPC declares itself fee_payer                                 │
│                                                                  │
│  App phase:                                                      │
│    1. Claim bridged tokens INTO FPC's private balance            │
│       (not the user's — avoids needing authwit or deployed acct) │
│    2. Transfer (claim - fee) → user's address (remainder)        │
│    3. Transfer fee → operator's address (exact token payment)    │
│                                                                  │
│  Fee deduction:                                                  │
│    Protocol deducts gas cost from FPC's Fee Juice                │
└──────────────────────────────────────────────────────────────────┘
```

The operator is reimbursed in the accepted token. The FPC itself never holds tokens — it is a pass-through. Unused Fee Juice stays in the FPC's balance.


### Normal Payment (`fee_entrypoint`)

For users who already have an L2 account and token balance:

```
┌──────────┐  1. GET /quote   ┌─────────────────┐
│  Wallet  │ ───────────────► │  Attestation Svc│
│  (SDK)   │ ◄─────────────── │  (signs quote)  │
└────┬─────┘  signed quote    └─────────────────┘
     │
     │  2. Submit tx: fee_entrypoint(quote_sig, amounts, ...)
     ▼
┌──────────────────────────────────────────────────────────┐
│  Aztec L2                                                │
│                                                          │
│  Setup phase:                                            │
│    Perform verifications & guards                        │
│    User transfers exact token payment → operator         │
│    (no refund — user calculates the precise amount       │
│     based on estimated gas and quoted rate)              │
│    FPC declares itself fee_payer                         │
│                                                          │
│  App phase:                                              │
│    User's actual transaction logic runs                  │
│                                                          │
│  Fee deduction:                                          │
│    Protocol deducts gas cost from FPC's Fee Juice        │
└──────────────────────────────────────────────────────────┘
```

### How Fee Juice Gets Into the FPC

```
┌─────────────┐  monitors FPC   ┌─────────────┐  bridges when   ┌──────────────┐
│  Top-up Svc │ ──────────────► │  FPC on L2  │  balance < thr  │ Ethereum L1  │
│             │ ◄────────────── │  (Fee Juice │ ◄────────────── │ (Fee Juice   │
│             │  balance check  │   balance)  │  L1→L2 bridge   │  ERC-20)     │
└─────────────┘                 └─────────────┘                 └──────────────┘
```

The top-up service holds an L1 wallet key with ETH + Fee Juice. It polls the FPC's L2 balance and bridges via the Fee Juice portal when it drops below a threshold.

\* The cold start path claims bridged tokens via `Token::mint_to_private`, which enqueues a public call to update the token's total supply — so the minted amount is visible on-chain. User identity and balances remain private. This is an inherent property of Aztec's `mint_to_private` design, not specific to the FPC.

See [docs/spec/protocol-spec.md](docs/spec/protocol-spec.md) for the full protocol specification, quote format, and security model.

---

## Deploy FPC (Testnet)

Deploy the FPC contract and run the full operator stack with Docker Compose. No local toolchain required — the images ship with pre-compiled contract artifacts.

#### 1. Build images

```bash
docker buildx bake
```

#### 2. Review the master config

The repo ships `deployments/testnet/fpc-config.yaml` with sensible defaults — no changes needed for a standard testnet deployment. See the [full guide](docs/aztec-deployer-user-guide.md#master-config) for customization options.

#### 3. Required keys

| Env var | Layer | Used for |
|---------|-------|----------|
| `FPC_DEPLOYER_SECRET_KEY` | L2 | Deploys the FPC contract and test tokens |
| `FPC_OPERATOR_SECRET_KEY` | L2 | Signs fee quotes, receives token payments |
| `FPC_L1_DEPLOYER_KEY` | L1 | Bridges Fee Juice (topup) and deploys test token L1 contracts |
| `ADMIN_API_KEY` | — | Authenticates admin requests to the attestation service |

> For a minimal setup, you can use the same L2 key for both deployer and operator, and a single L1 key.

#### 4. Fund accounts

| Account | What's needed | How to get it |
|---------|---------------|---------------|
| L1 (`FPC_L1_DEPLOYER_KEY`) | Sepolia ETH | Sepolia faucet |
| L1 (`FPC_L1_DEPLOYER_KEY`) | Fee Juice ERC-20 token | `bun run fund:l1:fee-juice` (mints it) |
| L2 (`FPC_DEPLOYER_SECRET_KEY`) | Fee Juice | Aztec faucet or `aztec bridge-erc20` — needed to pay for the FPC deployment tx |

**Fund L1 Fee Juice:**

```bash
export AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com
export L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>  # same key as FPC_L1_DEPLOYER_KEY
bun run fund:l1:fee-juice
```

> The L1 Fee Juice is used by the topup service to bridge into the FPC's L2 balance. The L2 Fee Juice is needed only once — to pay gas for the initial FPC contract deployment.

#### 5. Deploy and start

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_key>
export FPC_OPERATOR_SECRET_KEY=0x<operator_key>
export FPC_L1_DEPLOYER_KEY=0x<l1_key>
export ADMIN_API_KEY=<admin_secret>

DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

This deploys the FPC contract, generates service configs, starts attestation + topup, and deploys/registers tokens via `configure-token`. Output goes to `deployments/testnet/`.

#### 6. Verify

```bash
curl http://localhost:3000/health          # attestation
curl http://localhost:3001/ready           # topup
curl http://localhost:3000/accepted-assets # registered tokens
```

For manual step-by-step deployment, custom configuration, SDK integration, and API reference, see the **[Full Deployer & User Guide](docs/aztec-deployer-user-guide.md)**.

---

## Integrate with the SDK

Use [`@nethermindeth/aztec-fpc-sdk`](sdk/) to construct FPC payment methods and execute cold-start flows from your application.

```ts
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

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
| **[docs/aztec-deployer-user-guide.md](docs/aztec-deployer-user-guide.md)** | **Full guide** — manual deployment, custom config, SDK integration, API reference |
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

- Bun `1.3.11`
- Aztec CLI

```bash
VERSION=4.2.0-aztecnr-rc.2 bash -i <(curl -sL https://install.aztec.network/$VERSION)
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
- `docker-build-ci.yml`: builds all Docker images, deploys locally via compose, runs the full integration test suite

### 5. Run integration tests (Docker Compose)

The full integration test suite runs via Docker Compose. This is the same flow CI uses:

```bash
# Build all images
docker buildx bake

# Run deploy + services + all tests
docker compose --profile full up wait --wait
```

This starts the full stack (anvil, aztec-node, deploy, configure-token, attestation, topup) and runs all test services under the `full` profile:

| Test service | Description |
|-------------|-------------|
| `tests-services` | Service health, API, and quote flow validation |
| `tests-cold-start` | Cold-start flow (L1 bridge + claim + FPC payment) |
| `tests-cold-start-validation` | Cold-start negative scenarios (replay, expiry, sender binding) |
| `tests-fee-entrypoint-validation` | fee_entrypoint negative scenarios (replay, expiry, TTL, phase enforcement) |
| `tests-concurrent` | Concurrent transaction stress test |
| `tests-same-token-transfer` | Same-token transfer flow |
| `tests-always-revert` | Revert behavior validation |

The `wait` service gates on all tests completing successfully.

To tear down after running:

```bash
docker compose --profile full down -v --remove-orphans
```

### 6. Docker

#### Building images

All images are built with [Docker Buildx Bake](https://docs.docker.com/build/bake/) via `docker-bake.hcl`:

```bash
# Build all images
docker buildx bake

# Build a single target
docker buildx bake attestation
docker buildx bake topup
docker buildx bake deploy

# Custom tag / registry
TAG=v0.1.0 docker buildx bake
REGISTRY=ghcr.io/ TAG=v0.1.0 docker buildx bake

# Tag with current git SHA
GIT_SHA=$(git rev-parse HEAD) docker buildx bake
```

#### Running with Docker Compose

The compose stack (`docker-compose.yaml`) runs the full local environment:

| Service | Description | Port |
|---------|-------------|------|
| `anvil` | Local L1 chain (Foundry) | 8545 |
| `aztec-node` | Aztec sandbox node | 8080 |
| `deploy` | FPC contract deployment | — |
| `configure-token` | Test token deployment + attestation registration | — |
| `attestation` | FPC attestation service | 3000 |
| `topup` | FPC Fee Juice top-up daemon | 3001 |
| `block-producer` | Local block producer | — |

Service dependency chain: `anvil` + `aztec-node` → `deploy` → `attestation` + `topup` → `configure-token` → tests.

```bash
# Infra only (no tests)
docker compose up

# Full suite (deploy + services + all tests)
docker compose --profile full up wait --wait

# Tear down
docker compose --profile full down -v --remove-orphans
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

### Troubleshooting

If you see errors like:
- `ENOENT: ... target/token_contract-Token.json`
- `No constructor found with name constructor_with_minter`

run:

```bash
git submodule sync --recursive
git submodule update --init --recursive
aztec compile --workspace --force
```

---

## Security Notes

- **Operator key**: single key — receives all revenue and signs all quotes. Use a hardware wallet or KMS in production. Compromise requires redeployment (no on-chain rotation).
- **L1 operator key**: used only by the top-up service. Keep minimal ETH balance.
- Services support secret provider abstraction (env first; pluggable KMS/HSM adapters). Set `runtime_profile=production` to fail fast on plaintext config secrets.
