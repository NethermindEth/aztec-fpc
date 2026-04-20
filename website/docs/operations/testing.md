# Testing

Test suites, how to run them, and what they cover.

**Normative source:** [docs/spec/e2e-test-spec.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/e2e-test-spec.md). The negative-scenario test matrix is the source of truth for required FPC behavior.

## Test Layers

```
+-------------------------------------+
|     E2E / Integration Tests         |  Docker Compose
|     (scripts/tests/*.ts)            |
+-------------------------------------+
|     Service Unit Tests              |  Vitest
|     (services/*/test/*.test.ts)     |
+-------------------------------------+
|     SDK Unit Tests                  |  Vitest
|     (sdk/test/*.test.ts)            |
+-------------------------------------+
|     Contract Tests (Noir)           |  Aztec test harness
|     (contracts/fpc/src/test/*.nr)   |
+-------------------------------------+
```

## Running Tests

Run all tests:

```bash
bun run test
```

Run contract tests only (Noir):

```bash
bun run test:contracts
```

Run TypeScript tests only (services + SDK):

```bash
bun run test:ts
```

Run full integration suite (Docker Compose, requires all services):

```bash
bun run compose:full
```

## Contract Tests

**Location:** `contracts/fpc/src/test/`

### `fee_entrypoint.nr` (7 tests)

| Test | What It Verifies |
|------|-----------------|
| Happy path | Standard fee payment succeeds |
| Mismatched fee amount | Signature fails when amounts differ |
| Expired quote | Rejects quotes past `valid_until` |
| Overlong TTL | Rejects TTL > 3600 seconds |
| Non-root caller | Context-specific constraints |
| Wrong user binding | User A's quote fails for User B |
| Authwit freshness | Authorization witness must be valid |

### `cold_start_entrypoint.nr` (4 tests)

| Test | What It Verifies |
|------|-----------------|
| Setup phase enforcement | Only runs during tx setup |
| Root-call guard | Must be transaction root |
| Domain separation | Cold-start quote (`"FPCs"` = `0x46504373`) fails in `fee_entrypoint` (`"FPC"` = `0x465043`) |
| Standard quote rejection | Normal quote fails in `cold_start_entrypoint` |

### Test Helpers (`utils.nr`)

- `setup()`: deploy contracts, create test accounts
- `sign_quote()`: generate Schnorr-signed quotes
- `compute_quote_hash()`: reproduce quote hash computation

## Service Tests

### Attestation Service

| Area | Coverage |
|------|----------|
| Health | Liveness probe returns 200 |
| Asset discovery | `/accepted-assets` returns configured tokens |
| Quote signing | Returns valid Schnorr signature |
| Rate computation | Exchange rate math (`market_rate * (10000 + fee_bips) / 10000`) is correct |
| Admin CRUD | Asset policy create/read/update/delete via `/admin/asset-policies` |
| Auth | Admin API key validation, quote auth modes |
| Rate limiting | Request throttling when enabled |

### Top-up Service

| Area | Coverage |
|------|----------|
| Balance checking | Threshold comparison logic |
| Bridge submission | L1 transaction creation via `L1FeeJuicePortalManager` |
| State persistence | LMDB read/write for in-flight bridge state |
| Reconciliation | Startup recovery of pending bridges from LMDB |
| Auto-claim | L2 claiming after bridge confirmation |

### SDK

| Area | Coverage |
|------|----------|
| Payment method | Quote fetch + authwit construction + fee options |
| Cold start | Full flow orchestration (claim + pay in one tx) |
| Error handling | Invalid inputs, failed quotes, HTTP error propagation |

## Integration Tests

**Location:** `scripts/tests/`

Run as Docker Compose services against the full stack. All test services depend on `configure-token` completing first.

| Suite | What It Tests |
|-------|--------------|
| `services.ts` | Health endpoints, accepted assets, quote responses |
| `cold-start.ts` | Bridge from L1, cold-start claim, verify balances |
| `cold-start-validation.ts` | Edge cases: insufficient claim, expired quote, double-submit |
| `fee-entrypoint-validation.ts` | Submit tx with FPC, verify nullifier pushed + transfers completed |
| `concurrent.ts` | Multiple FPC transactions concurrently, no nullifier conflicts |
| `same-token-transfer.ts` | Pay fee in same token being transferred |
| `always-revert.ts` | App logic reverts, FPC still gets paid (setup-phase irreversibility) |

## Smoke Tests

Two smoke-test commands are available for post-deploy validation:

```bash
# Full compose smoke: deploy, start services, run test suite
bun run smoke:services:compose

# Fee-entrypoint negative-path smoke (requires pre-deployed contracts + node)
FPC_COLD_START_MANIFEST=path/to/manifest.json \
FPC_ATTESTATION_URL=http://localhost:3000 \
  bun run smoke:fee-entrypoint
```

The bun-path post-deploy smoke validates one successful FPC fee-path transaction and one L1 Fee Juice bridge/top-up cycle:

```bash
set -a; source .env; set +a
export L1_OPERATOR_PRIVATE_KEY="$L1_ADDRESS_PK"
export L1_RPC_URL=https://sepolia.infura.io/v3/<key>
bunx tsx scripts/contract/devnet-postdeploy-smoke.ts \
  --manifest ./deployments/devnet-manifest-v2.json
```

## Profiling

**Location:** `profiling/`

| Benchmark | What It Measures |
|-----------|-----------------|
| `fpc.benchmark.ts` | Gate count for `fee_entrypoint` |
| `cold-start.benchmark.ts` | Gate count for `cold_start_entrypoint` (worst case: DA 1,568, L2 711,103) |

The `noop` contract provides a baseline for measuring FPC-specific overhead. Re-run after contract changes:

```bash
./profiling/setup.sh && ./profiling/run.sh
```

## Test Infrastructure

| Tool | Role |
|------|------|
| Vitest | TypeScript test runner |
| Aztec test harness | Noir contract testing |
| Docker Compose | Integration orchestration |
| Anvil | Local L1 chain (Foundry) |
| Aztec Sandbox | Local Aztec node |
