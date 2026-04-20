---
title: E2E Test Matrix
description: Required negative-scenario test suite for FPC, covering replay, expiry, TTL cap, sender-binding, setup-phase enforcement, and insufficient Fee Juice.
---

# E2E Test Matrix

**Normative source:** [docs/spec/e2e-test-spec.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/e2e-test-spec.md)

These are the negative scenarios an FPC implementation must enforce. Happy-path coverage is provided by [`scripts/tests/same-token-transfer.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/same-token-transfer.ts).

## Required Negative Scenarios

All scenarios target `fee_entrypoint`. Scenarios 1 through 5 run against a pre-deployed FPC from a deployment manifest, already funded by the running top-up service. Scenario 6 deploys an isolated FPC with a controlled Fee Juice budget.

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | **Quote replay** | Reuse the same `(fj_fee_amount, aa_payment_amount, valid_until, signature)` after one successful use. Second use is rejected via nullifier conflict. |
| 2 | **Expired quote** | Submit a quote after `valid_until` has passed. Transaction is rejected. |
| 3 | **Overlong quote TTL** | Submit a quote where `valid_until - anchor_timestamp > 3600`. Transaction is rejected. |
| 4 | **Quote sender binding** | Quote issued for user A is submitted by user B. Transaction is rejected because the signature binds to `msg_sender`. |
| 5 | **Direct `fee_entrypoint` outside setup** | Call `fee_entrypoint` as a root-level transaction outside the setup phase. Transaction is rejected. |
| 6 | **Insufficient Fee Juice** | Deploy an isolated FPC with a controlled Fee Juice budget (direct bridge + claim). First transaction succeeds. Second transaction is rejected for insufficient fee-payer balance. |

## Cold-Start Parallel Matrix

`scripts/tests/cold-start-validation.ts` mirrors the same matrix for `cold_start_entrypoint`, covering:

- 9-field quote preimage validation
- Bridge claim authenticity (`claim_amount` and `claim_secret_hash` bound in the signature)
- Domain separation: a regular `fee_entrypoint` quote must fail in `cold_start_entrypoint`, and vice versa

## Test Tiering

Coverage is split by concern across these scripts:

| Script | Concern |
|---|---|
| `scripts/contract/deploy-fpc-local.ts` / `deploy-fpc-local-smoke.ts` | Deployment and relay usability. Not quote security. |
| `scripts/tests/services.ts` | Deployed service HTTP endpoints: `/quote`, `/cold-start-quote`, top-up health, metrics. |
| `scripts/tests/same-token-transfer.ts` | Happy-path integration: private/public/batched fee-paid transfers against a running attestation service and top-up-funded FPC. |
| `scripts/tests/fee-entrypoint-validation.ts` | **This matrix.** Negative scenarios 1 through 6. |
| `scripts/tests/cold-start-validation.ts` | Cold-start parallel matrix and L1 bridge/claim validation. |

## Mandatory Assertions

For the test to pass, all of the following must hold:

- FPC has a positive Fee Juice balance (the top-up service funded it).
- Quote signature constraints are enforced:
  - Quote is bound to `msg_sender`.
  - Expired quotes are rejected.
  - Replayed quotes are rejected via nullifier.
  - `fee_entrypoint` TTL is capped at 3600 seconds.
- Direct `fee_entrypoint` calls outside the setup phase are rejected.
- Insufficient Fee Juice correctly rejects the second transaction when the budget allows only one.

## Non-Goals

These concerns are out of scope for this test matrix (covered elsewhere or not an Alpha concern):

- **Happy-path transactions.** Covered by `same-token-transfer.ts`. Not duplicated here.
- **Multi-cycle bridge re-funding.** Exercised by `same-token-transfer.ts` running against a continuously-funded FPC.
- **Arithmetic hardening** of internal gas-cost multiplication. This is a contract unit test concern.
- **Operator key rotation.** Not a design goal for Alpha. The key is set at construction time.
- **Quote-note reclaim / forced destination.** Out of scope until a dedicated reclaim flow exists.

## Pass / Fail

| Outcome | Definition |
|---|---|
| PASS | Manifest setup completes, FPC is funded, all negative scenario assertions pass. |
| FAIL | Manifest not found, FPC has no Fee Juice, a negative scenario unexpectedly succeeds, or a negative scenario fails with an unexpected error. |

## Environment

**Test runner:** `scripts/tests/fee-entrypoint-validation.ts`

**Required environment variables:**

| Variable | Description |
|---|---|
| `FPC_COLD_START_MANIFEST` | Deployment manifest path (required) |
| `FPC_OPERATOR_SECRET_KEY` | Operator 0x-prefixed 32-byte hex secret (required) |
| `AZTEC_NODE_URL` | Aztec node RPC (default: `http://localhost:8080`) |
| `L1_RPC_URL` | L1 Ethereum RPC (default: `http://localhost:8545`). Only needed for scenario 6. |

**Tunable knobs:**

| Variable | Default |
|---|---|
| `FPC_FULL_E2E_FEE_JUICE_TIMEOUT_MS` | 240000 |
| `FPC_FULL_E2E_FEE_JUICE_POLL_MS` | 2000 |
| `FPC_FULL_E2E_DA_GAS_LIMIT` | 200000 |
| `FPC_FULL_E2E_L2_GAS_LIMIT` | 1000000 |

## Running

```bash
# Full TS + contract tests
bun run test

# E2E negative matrix against a deployed stack
FPC_COLD_START_MANIFEST=path/to/manifest.json \
FPC_OPERATOR_SECRET_KEY=0x... \
AZTEC_NODE_URL=http://localhost:8080 \
  bunx tsx scripts/tests/fee-entrypoint-validation.ts
```
