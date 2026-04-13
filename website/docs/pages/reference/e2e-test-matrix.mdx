---
title: E2E Test Matrix
description: The required negative-scenario test suite for FPC — replay, expiry, TTL cap, sender-binding, setup-phase enforcement, insufficient Fee Juice.
---

# E2E Test Matrix

> **Normative source:** [docs/spec/e2e-test-spec.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/e2e-test-spec.md)

The end-to-end test spec is normative: these are the negative scenarios an FPC implementation **must** enforce. For happy-path coverage see [`scripts/tests/same-token-transfer.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/same-token-transfer.ts).

## Required Negative Scenarios (FPC `fee_entrypoint`)

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | **Quote replay** | Reuse `(rate_num, rate_den, valid_until, signature)` after one successful use — second use must be rejected (nullifier conflict). |
| 2 | **Expired quote** | Submit a quote after `valid_until` — rejected. |
| 3 | **Overlong quote TTL** | Submit a quote whose `valid_until − anchor_timestamp > 3600` — rejected. |
| 4 | **Quote sender binding** | Quote issued for user A submitted by user B — rejected (invalid signature binding to `msg_sender`). |
| 5 | **Direct `fee_entrypoint` outside setup** | Call `fee_entrypoint` as a root-level tx outside the setup phase — rejected. |
| 6 | **Insufficient Fee Juice under concurrent issuance** | Deploy an isolated FPC with a controlled Fee Juice budget (direct bridge + claim); first tx succeeds, second tx is rejected for insufficient fee-payer balance. |

## Cold-Start Parallel Matrix

`scripts/tests/cold-start-validation.ts` mirrors the same matrix for `cold_start_entrypoint`, exercising:

- 9-field quote preimage validation
- Bridge claim authenticity (`claim_amount`, `claim_secret_hash` bound in signature)
- Domain separation — a regular `fee_entrypoint` quote must fail in `cold_start_entrypoint`, and vice versa

## Test Tiering

Coverage is intentionally split by concern:

| Script | Concern |
|---|---|
| `scripts/contract/deploy-fpc-local.ts` / `deploy-fpc-local-smoke.ts` | Deployment/relay usability — not quote security |
| `scripts/tests/services.ts` | Deployed service HTTP endpoints: `/quote`, `/cold-start-quote`, topup health + metrics |
| `scripts/tests/same-token-transfer.ts` | Happy-path integration: private/public/batched fee-paid transfers against a running attestation + topup-funded FPC |
| `scripts/tests/fee-entrypoint-validation.ts` | **This matrix** — negative scenarios 1–5 |
| `scripts/tests/cold-start-validation.ts` | Cold-start parallel matrix + L1 bridge/claim validation |

## Mandatory Assertions

For the e2e test to pass, all must hold:

- FPC has positive Fee Juice balance (topup funded it).
- Quote signature constraints:
  - Bound to `msg_sender`
  - Expired quotes rejected
  - Replay rejected (nullifier)
  - `fee_entrypoint` TTL capped at 3600 seconds
- Direct `fee_entrypoint` calls outside setup phase are rejected.
- Insufficient Fee Juice correctly rejects the second tx when the budget allows only one.

## Non-Goals for the E2E

These are out of scope (covered elsewhere or not an Alpha concern):

- **Happy-path** FPC transactions — covered by `same-token-transfer.ts`, not duplicated
- **Multi-cycle bridge re-funding** — exercised by `same-token-transfer.ts` running against a continuously-funded FPC
- **Arithmetic hardening** of internal gas-cost multiplication — a contract-unit-test concern
- **Operator key rotation** — currently a design non-goal (constructor-time config only)
- **Quote-note reclaim / forced destination** — out of scope until a dedicated reclaim flow exists

## Pass / Fail

| Outcome | Definition |
|---|---|
| PASS | Manifest setup completes, FPC is funded, all negative scenario assertions pass. |
| FAIL | Manifest not found, FPC has no Fee Juice, a negative scenario unexpectedly succeeds, or a negative scenario fails with an unexpected error. |

## Running

```bash
# All TS + contract tests
bun run test

# E2E negative matrix against a deployed stack
FPC_COLD_START_MANIFEST=path/to/manifest.json \
FPC_OPERATOR_SECRET_KEY=0x... \
AZTEC_NODE_URL=http://localhost:8080 \
  bunx tsx scripts/tests/fee-entrypoint-validation.ts
```
