# Testing

Test suites, how to run them, and what they cover.

[Source: contract tests](https://github.com/NethermindEth/aztec-fpc/tree/main/contracts/fpc/src/test) |
[Source: integration tests](https://github.com/NethermindEth/aztec-fpc/tree/main/scripts/tests) |
[Source: vitest config](https://github.com/NethermindEth/aztec-fpc/blob/main/vitest.config.ts)

**Normative source:** [docs/spec/e2e-test-spec.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/specs/spec/e2e-test-spec.md). The negative-scenario test matrix is the source of truth for required FPC behavior.

> [!NOTE]
> Contract tests require compiled artifacts. Run `aztec compile --workspace --force` before `bun run test:contracts` on a fresh checkout. The integration tests (Docker Compose) handle this automatically.

## Test Layers

```
+-------------------------------------+
|     E2E / Integration Tests         |  Docker Compose (profile: full)
|     (scripts/tests/*.ts)            |
+-------------------------------------+
|     Service Unit Tests              |  Vitest
|     (services/*/test/**/*.ts)       |
+-------------------------------------+
|     SDK Unit Tests                  |  Vitest
|     (sdk/test/*.test.ts)            |
+-------------------------------------+
|     Contract Tests (Noir)           |  Aztec test harness (aztec test)
|     (contracts/fpc/src/test/*.nr)   |
+-------------------------------------+
```

## Running Tests

Run all tests (contracts + TypeScript):

```bash
bun run test
```

Run contract tests only (Noir, compiles workspace first):

```bash
bun run test:contracts
```

Run TypeScript tests only (attestation + topup + SDK via Vitest):

```bash
bun run test:ts
```

Run full integration suite (Docker Compose with all services and test containers):

```bash
bun run smoke:services:compose
```

## Contract Tests

**Location:** `contracts/fpc/src/test/`

### `fee_entrypoint.nr` (7 tests)

| Test | What It Verifies |
|------|-----------------|
| `constructor_rejects_zero_operator` | Constructor rejects zero-address operator |
| `fee_entrypoint_happy_path_transfers_expected_charge` | Standard fee payment transfers correct amount from user to operator |
| `fee_entrypoint_rejects_mismatched_fj_fee_amount` | Rejects quote when fee amount differs from actual gas cost |
| `fee_entrypoint_requires_fresh_transfer_authwit_each_call` | Requires a fresh transfer authorization witness per call (replay protection) |
| `fee_entrypoint_rejects_expired_quote` | Rejects quotes past `valid_until` timestamp |
| `fee_entrypoint_rejects_overlong_quote_ttl` | Rejects TTL > 3600 seconds from anchor timestamp |
| `fee_entrypoint_rejects_quote_bound_to_another_user` | User A's quote signature fails verification when User B calls |

### `cold_start_entrypoint.nr` (4 tests)

| Test | What It Verifies |
|------|-----------------|
| `cold_start_happy_path` | Full cold-start flow reaches bridge claim (fails at L1-to-L2 message lookup in TXE, validating everything prior) |
| `cold_start_rejects_non_root_caller` | Must be called as tx entrypoint (msg_sender = None) |
| `cold_start_quote_rejected_by_fee_entrypoint` | Cold-start domain separator (`0x46504373`) fails in `fee_entrypoint` (domain `0x465043`) |
| `regular_quote_rejected_by_cold_start_entrypoint` | Standard domain separator fails in `cold_start_entrypoint` |

### Test Helpers ([`utils.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/test/utils.nr))

- `setup()`: deploy Token, TokenBridge, and FPCMultiAsset contracts; create operator and user accounts
- `sign_quote()`: compute quote hash with `QUOTE_DOMAIN_SEPARATOR` and return a valid test Schnorr signature
- `sign_cold_start_quote()`: compute quote hash with `COLD_START_QUOTE_DOMAIN_SEPARATOR` and return a valid test Schnorr signature
- `test_schnorr_sign()`: low-level Schnorr signing using modular arithmetic over Grumpkin group order
- `private_balance()`: utility to query private token balance

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

Post-deploy validation commands:

```bash
# Full compose smoke: deploy, start services, run all test suites
bun run smoke:services:compose

# Local deploy + smoke (infrastructure only)
bun run smoke:deploy:fpc:local
```

The bun-path post-deploy smoke validates one successful FPC fee-path transaction and one L1 Fee Juice bridge/top-up cycle:

```bash
set -a; source .env; set +a
export L1_OPERATOR_PRIVATE_KEY="$L1_ADDRESS_PK"
export L1_RPC_URL=https://sepolia.infura.io/v3/<key>
bun run smoke:deploy:fpc:devnet
```

## Profiling

**Location:** `profiling/benchmarks/`

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

## Next Steps

- [Review the E2E test matrix](../reference/e2e-test-matrix.md) for the full list of required negative scenarios
- [Set up Docker Compose](./docker.md) to run integration tests against the full stack
- [Understand the contract internals](../contracts.md) that the contract-level tests exercise
- [Check the security model](../security.md) to see which threat scenarios the tests enforce
