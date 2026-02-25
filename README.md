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
│   │   └── test/               ← Local-devnet smoke test flow
│   └── topup/                  ← L2 balance monitor + L1 bridge service (TypeScript)
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

### 1. Compile the contract

```bash
aztec compile
```

### 2. Format and run tests locally

```bash
nargo fmt
aztec test
```

### TypeScript quality checks

```bash
bun run format
bun run lint
bun run typecheck
bun run ci
```

### 3. Run local-devnet smoke test (end-to-end)

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
- `FPC_SMOKE_QUOTE_TTL_SECONDS`
- `FPC_SMOKE_RESET_LOCAL_STATE` (default `1`; set `0` to reuse existing `wallet_data_*`/`pxe_data_*`)

### 4. Deploy the contract

```bash
# operator = your Aztec account (receives fees, signs quotes)
# accepted_asset = the token contract address this FPC accepts
aztec deploy \
  --artifact target/fpc-FPC.json \
  --args <operator_address> <accepted_asset_address>
```

Record the deployed address.

### 5. Configure and start the attestation service

```bash
cd services/attestation
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, operator_secret_key, accepted_asset_*, rates
bun install && bun run build && bun run start
```

### 6. Configure and start the top-up service

```bash
cd services/topup
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, l1_operator_private_key, fee_juice_portal_address
bun install && bun run build && bun run start
```

### 7. Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/asset
curl "http://localhost:3000/quote?user=<your_aztec_address>"
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
