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
│   └── topup/                  ← L2 balance monitor + L1 bridge service (TypeScript)
└── docs/
    └── spec.md                 ← Full protocol specification
```

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- A running Aztec node (PXE at `http://localhost:8080`)
- L1 Ethereum RPC endpoint

### 1. Compile the contract

```bash
aztec compile
```

### 2. Format and run tests locally

```bash
nargo fmt
aztec test
```

### 3. Deploy the contract

```bash
# operator = your Aztec account (receives fees, signs quotes)
# accepted_asset = the token contract address this FPC accepts
aztec deploy \
  --artifact target/fpc-FPC.json \
  --args <operator_address> <accepted_asset_address>
```

Record the deployed address.

### 4. Configure and start the attestation service

```bash
cd services/attestation
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, operator_secret_key, accepted_asset_*, rates
npm install && npm run build && npm start
```

### 5. Configure and start the top-up service

```bash
cd services/topup
cp config.example.yaml config.yaml
# Edit config.yaml — set fpc_address, l1_operator_private_key, fee_juice_portal_address
npm install && npm run build && npm start
```

### 6. Verify

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
