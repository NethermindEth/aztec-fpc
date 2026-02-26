# FPC — Fee Payment Contract

A minimal operator-run Fee Payment Contract (FPC) for Aztec L2. Users pay transaction fees in a single fixed token (e.g. humanUSDC) instead of the native Fee Juice, via a fully private transfer to the operator.

Full protocol specification: [docs/spec.md](docs/spec.md)

---

## Repository Layout

```text
aztec-fpc/
├── contracts/
│   └── fpc/
│       ├── Nargo.toml          ← Noir package (git-pinned Aztec deps)
│       └── src/
│           ├── main.nr         ← FPC contract
│           ├── fee_math.nr     ← Fee math helpers
│           └── test/           ← Contract integration/unit tests
├── services/
│   ├── attestation/            ← Quote-signing REST service (TypeScript)
│   │   └── test/               ← Contract + service smoke harnesses
│   └── topup/                  ← L2 balance monitor + L1 bridge service (TypeScript)
├── scripts/
│   ├── contract/               ← Contract-focused smoke script
│   └── services/               ← Service-integrated smoke script
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

Compile the full workspace so both artifacts exist:
- `target/fpc-FPC.json`
- `target/token_contract-Token.json`

```bash
aztec compile --workspace --force
```

### 4. Format and run tests locally

```bash
nargo fmt
aztec test --package fpc
```

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
- `spec-services-smoke.yml`: service-integrated local-network smoke against `docs/spec.md` flow (`/quote`, topup bridge decision, `fee_entrypoint` payment)

### 5. Run local-devnet contract smoke test (end-to-end)

This runs a full payment flow outside TXE tests:

1. compile artifacts,
2. deploy `Token` + `FPC`,
3. mint user private balance,
4. execute `fee_entrypoint` with quote + transfer authwits,
5. assert operator private balance increased by the expected charge.

```bash
aztec start --local-network
```

Default local-network endpoints:
- Aztec node / PXE RPC: `http://localhost:8080`
- Anvil L1 RPC (spawned by `aztec start --local-network`): `http://127.0.0.1:8545`

```bash
bash scripts/contract/fee-entrypoint-devnet-smoke.sh
```

Smoke implementation file:
`services/attestation/test/fee-entrypoint-devnet-smoke.ts`

Optional overrides:

- `AZTEC_NODE_URL` (default `http://localhost:8080`)
- `FPC_SMOKE_L1_RPC_URL` (default `http://127.0.0.1:8545`)
- `FPC_SMOKE_NODE_TIMEOUT_MS` (default `30000`)
- `FPC_SMOKE_RATE_NUM`, `FPC_SMOKE_RATE_DEN` (defaults: `0` / `1` for deterministic smoke)
- `FPC_SMOKE_DA_GAS_LIMIT`, `FPC_SMOKE_L2_GAS_LIMIT`
- `FPC_SMOKE_FEE_PER_DA_GAS`, `FPC_SMOKE_FEE_PER_L2_GAS` (default: current node min fees)
- `FPC_SMOKE_FEE_JUICE_TOPUP_WEI` (default: conservative auto-top-up from configured gas settings)
- `FPC_SMOKE_RELAY_ADVANCE_BLOCKS` (default: `2`; sends this many mock L2 txs after L1 bridge submit to unblock local relay)
- `FPC_SMOKE_QUOTE_TTL_SECONDS`
- `FPC_SMOKE_RESET_LOCAL_STATE` (default `1`; set `0` to reuse existing `wallet_data_*`/`pxe_data_*`)

### 6. Run local-devnet services smoke test (attestation + topup + fee_entrypoint)

This script implements Step 8 from the services plan:

1. builds both services,
2. deploys `Token` + `FPC`,
3. starts attestation and topup with generated test configs,
4. requests `/quote?user=<address>`,
5. submits a transaction using `AuthWitness.fromString(quote.authwit)`,
6. confirms topup balance-read/bridge behavior and transaction acceptance.

```bash
bun run smoke:services
# or:
bash scripts/services/fpc-services-smoke.sh
```

Useful overrides:

- `FPC_SERVICES_SMOKE_START_LOCAL_NETWORK` (default `1`; auto-starts `aztec start --local-network` if 8080/8545 are unavailable)
- `FPC_SERVICES_SMOKE_RESET_LOCAL_STATE` (default `1` only when script starts local network, otherwise `0`)
- `FPC_SERVICES_SMOKE_L1_PRIVATE_KEY` (default local anvil key)
- `FPC_SERVICES_SMOKE_TOPUP_WEI`, `FPC_SERVICES_SMOKE_THRESHOLD_WEI`
- `FPC_SERVICES_SMOKE_ATTESTATION_PORT` (default `3300`)
- `FPC_SERVICES_SMOKE_RELAY_ADVANCE_BLOCKS` (default: `2`; sends mock L2 txs after bridge submit so local relay can finalize)

### 7. Deploy the contract (recommended)

Use the local deploy wrapper:

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

### 8. Run local deploy smoke (deploy + relay-aware first use)

This smoke flow:
1. runs `deploy:fpc:local`,
2. bridges Fee Juice from L1 to the deployed FPC,
3. advances mock L2 blocks (default: 2) so relay-dependent claim is consumable,
4. confirms Fee Juice balance lands on the deployed FPC.

```bash
bun run smoke:deploy:fpc:local
```

Useful overrides:

- `FPC_DEPLOY_SMOKE_START_LOCAL_NETWORK` (default `1`)
- `FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE` (default: `1` only when smoke starts local-network, otherwise `0`)
- `FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT` (default temp path under `/tmp`)
- `FPC_DEPLOY_SMOKE_RELAY_ADVANCE_BLOCKS` (default `2`, must be `>=2`)
- `FPC_DEPLOY_SMOKE_TOPUP_WEI` (default `1000000`)

### 9. Deploy the contract manually (alternative)

```bash
# operator = your Aztec account (receives fees, signs quotes)
# accepted_asset = the token contract address this FPC accepts
aztec deploy \
  --artifact target/fpc-FPC.json \
  --args <operator_address> <accepted_asset_address>
```

Record the deployed address.

### 10. Configure and start the attestation service

```bash
cd services/attestation
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, accepted_asset_*, rates
# Provide operator key via OPERATOR_SECRET_KEY (preferred) or config.operator_secret_key
bun install && bun run build && bun run start
```

### 11. Configure and start the top-up service

```bash
cd services/topup
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, aztec_node_url, l1_rpc_url
# l1_chain_id and fee juice L1 addresses are auto-discovered from nodeInfo
# Bridge confirmation uses L1->L2 message readiness plus Fee Juice balance-delta fallback
# Provide L1 key via L1_OPERATOR_PRIVATE_KEY (preferred) or config.l1_operator_private_key
bun install && bun run build && bun run start
```

### 12. Docker builds

Build both service images:

```bash
bun run docker:build
```

Or build individually:

```bash
bun run docker:build:attestation
bun run docker:build:topup
```

Images are tagged as `nethermind/aztec-fpc-{attestation,topup}:latest` by default. Override via environment variables:

```bash
TAG=v1.0.0 bun run docker:build
```

### 13. Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/asset
curl "http://localhost:3000/quote?user=<your_aztec_address>"
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

## Payment Flow

One entry-point, fully private:

| Entry-point | Source | Destination | Quote |
|---|---|---|---|
| `fee_entrypoint` | User private balance | Operator private balance | User-specific |

```
User private balance →[transfer_in_private]→ Operator private balance
```

- Charge = `ceil(max_gas_cost_no_teardown × rate_num / rate_den)`
- No teardown. No refund. No public balance accumulation.
- Quote binds to `msg_sender` — cannot be replayed by another user.

See [docs/spec.md](docs/spec.md) for detailed flow description, security considerations, and integration examples.

---

## Security Notes

- **Operator key**: single key — receives all revenue and signs all quotes. Use a hardware wallet or KMS in production. Compromise requires redeployment (no on-chain rotation).
- **L1 operator key**: used only by the top-up service. Keep minimal ETH balance.
- All private keys in config files are for development only. **Use a KMS or HSM in production** — comments in the code mark every location where this substitution is needed.
