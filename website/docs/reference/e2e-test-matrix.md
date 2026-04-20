---
title: E2E Test Matrix
description: Required negative-scenario test suite for FPC, covering replay, expiry, TTL cap, sender-binding, setup-phase enforcement, and insufficient Fee Juice.
---

# E2E Test Matrix

**Normative source:** [docs/spec/e2e-test-spec.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/e2e-test-spec.md)

These are the negative scenarios an FPC implementation must enforce. Happy-path coverage is provided by [`scripts/tests/same-token-transfer.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/same-token-transfer.ts).

## Required Negative Scenarios

All scenarios target `fee_entrypoint`. All run against a pre-deployed FPC from a deployment manifest, already funded by the running top-up service. Contract-level unit tests are in [`contracts/fpc/src/test/`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/test/).

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | **Quote replay** | Reuse the same `(fj_fee_amount, aa_payment_amount, valid_until, signature)` after one successful use. Second use is rejected via nullifier conflict. |
| 2 | **Expired quote** | Submit a quote after `valid_until` has passed. Transaction is rejected. |
| 3 | **Overlong quote TTL** | Submit a quote where `valid_until - anchor_timestamp > 3600`. Transaction is rejected. |
| 4 | **Quote sender binding** | Quote issued for user A is submitted by user B. Transaction is rejected because the signature binds to `msg_sender`. |
| 5 | **Direct `fee_entrypoint` outside setup** | Call `fee_entrypoint` as a root-level transaction outside the setup phase. Transaction is rejected. |
| 6 | **Insufficient Fee Juice** | Inflate `maxFeesPerGas` so the quoted fee exceeds the FPC's current Fee Juice balance. Transaction is rejected for insufficient fee-payer balance. |

## Asset Model and Wiring

Two assets are involved in the E2E tests. Do not conflate them.

1. **`accepted_asset` (L2 token used to charge the user)**
   - A test token deployed on Aztec L2 (`token_contract-Token`).
   - Chosen per quote (`accepted_asset`) at runtime for `fee_entrypoint`.
   - No L1 token wiring is required for this asset in the E2E.

2. **Fee Juice (protocol fee asset for gas payment)**
   - Scenarios 1-5: the FPC is pre-funded by the running top-up service.
   - Scenario 6: uses the same pre-funded FPC but inflates gas fees beyond its balance.
   - L1/L2 Fee Juice addresses are discovered from `node_getNodeInfo`.

## Full Lifecycle Phases

The test suite executes in 7 phases:

1. Read pre-deployed FPC and Token addresses from deployment manifest.
2. Connect to Aztec node, derive operator account from secret, create fresh test users.
3. Register pre-deployed contracts in local wallet.
4. Wait for FPC to have positive Fee Juice balance (funded by the top-up service).
5. Run negative scenarios 1-5 against the pre-deployed FPC.
6. For scenario 6: inflate gas fees to exceed FPC balance, run insufficient balance test.
7. Persist diagnostics and artifacts.

## Local-Network Troubleshooting

Use this runbook when local E2E fails with address or wiring symptoms.

1. **Stale hardcoded addresses.** Symptom: startup/config errors or bridge failures after node restart/redeploy. Check configured FeeJuice L1/L2 addresses against fresh `node_getNodeInfo` output. Fix: remove stale hardcoded values, regenerate deploy/config artifacts, use node-reported addresses.

2. **L1 chain-id mismatch.** Symptom: bridge submit fails with chain/network mismatch errors. Check: compare node-reported `l1ChainId` from `node_getNodeInfo` with the chain id served by `l1_rpc_url`. Fix: point to the correct L1 RPC for the active local-network instance.

3. **FeeJuice portal/address mismatch.** Symptom: bridge submission fails or FeeJuice balance never increases after a bridge + claim. Check configured/derived FeeJuice token + portal addresses against node-reported `l1ContractAddresses`. Fix: do not override local-network FeeJuice addresses manually. Use node-derived values.

## Cold-Start Parallel Matrix

`scripts/tests/cold-start-validation.ts` mirrors the same matrix for `cold_start_entrypoint`, covering:

- 9-field quote preimage validation
- Bridge claim authenticity (`claim_amount` and `claim_secret_hash` bound in the signature)
- Domain separation: a regular `fee_entrypoint` quote must fail in `cold_start_entrypoint`, and vice versa

## Test Tiering

Coverage is split by concern across these scripts:

| Script | Concern |
|---|---|
| [`scripts/contract/deploy-fpc-local-mode.sh`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/contract/deploy-fpc-local-mode.sh) / [`deploy-smoke-local.sh`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/contract/deploy-smoke-local.sh) | Deployment and relay usability. Not quote security. |
| [`scripts/tests/services.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/services.ts) | Deployed service HTTP endpoints: `/quote`, `/cold-start-quote`, top-up health, metrics. |
| [`scripts/tests/same-token-transfer.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/same-token-transfer.ts) | Happy-path integration: private/public/batched fee-paid transfers against a running attestation service and top-up-funded FPC. |
| [`scripts/tests/fee-entrypoint-validation.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/fee-entrypoint-validation.ts) | **This matrix.** Negative scenarios 1 through 6. |
| [`scripts/tests/cold-start-validation.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/cold-start-validation.ts) | Cold-start parallel matrix and L1 bridge/claim validation. |

## Mandatory Assertions

For the test to pass, all of the following must hold:

- FPC has a positive Fee Juice balance (the top-up service funded it).
- Quote signature constraints are enforced:
  - Quote is bound to `msg_sender`.
  - Expired quotes are rejected.
  - Replayed quotes are rejected via nullifier.
  - `fee_entrypoint` TTL is capped at 3600 seconds.
- Direct `fee_entrypoint` calls outside the setup phase are rejected.
- Insufficient Fee Juice correctly rejects a transaction when inflated gas fees exceed the FPC's balance.

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
| `FPC_TEST_TOKEN_MANIFEST` | Token deployment manifest path (required) |
| `FPC_OPERATOR_SECRET_KEY` | Operator 0x-prefixed 32-byte hex secret (required) |
| `AZTEC_NODE_URL` | Aztec node RPC (default: `http://localhost:8080`) |
| `L1_RPC_URL` | L1 Ethereum RPC (default: `http://localhost:8545`). Not currently used by this test suite but may be required by shared setup helpers. |

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
