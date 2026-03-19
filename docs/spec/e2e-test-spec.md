# Full E2E Test Definition

## Scope
This document defines the end-to-end negative-scenario test for the FPC lifecycle.

Scenarios 1-5 run against a pre-deployed FPC from a deployment manifest,
already funded by the running topup service. No contract deployment or service
startup is performed for these scenarios.

Scenario 6 (insufficient Fee Juice) deploys its own isolated Token + FPC,
bridges Fee Juice directly via `L1FeeJuicePortalManager` + `FeeJuice.claim()`,
and then runs the two-tx insufficient balance test.

Happy-path FPC transaction coverage (fee-paid transfers, balance-delta
assertions, multi-cycle bridge re-funding) is provided by the
same-token-transfer integration test
(`scripts/same-token-transfer/test-same-token-transfer.ts`), which exercises
more transfer types (private-to-private, public-to-public, batched
cross-domain) against a running attestation service and top-up-funded FPC.

No other smoke/deploy/test flows are part of this definition.

## Test Entry Point
- Command: `bun run e2e:full-lifecycle:fpc:local`
- Script: `scripts/services/fpc-full-lifecycle-e2e.sh`
- Runner: `scripts/services/fpc-full-lifecycle-e2e.ts`

## Required Environment
- Aztec CLI (`aztec`) available in `PATH`
- Aztec local network endpoints:
  - L2 node: `http://127.0.0.1:8080`
  - L1 RPC: `http://127.0.0.1:8545`
- Pre-deployed FPC and Token contracts (via deployment manifest)
- Running topup service funding the FPC with Fee Juice
- Contracts compiled (`aztec compile --workspace --force`) including:
  - `target/token_contract-Token.json`
  - `target/fpc-FPCMultiAsset.json`

## Required Env Vars
- `FPC_COLD_START_MANIFEST` — deployment manifest path
- `FPC_OPERATOR_SECRET_KEY` — operator 0x-prefixed 32-byte hex secret
- `AZTEC_NODE_URL` (default: `http://localhost:8080`)
- `L1_RPC_URL` (default: `http://localhost:8545`) — only needed for scenario 6

## Asset Model And Wiring
Two different assets are involved and must not be conflated:

1. `accepted_asset` (L2 token used to charge the user)
- This is a test token deployed on Aztec L2 (`token_contract-Token`).
- It is chosen per quote (`accepted_asset`) at runtime for `fee_entrypoint`.
- No L1 token wiring is required for this asset in this E2E.

2. Fee Juice (protocol fee asset for gas payment)
- For scenarios 1-5: the FPC is pre-funded by the running topup service.
- For scenario 6: Fee Juice is bridged directly via `L1FeeJuicePortalManager.bridgeTokensPublic()`
  and claimed on L2 via `FeeJuice.claim()`.
- L1/L2 Fee Juice addresses are discovered from `node_getNodeInfo`.

## Local-Network Troubleshooting
Use this runbook when local E2E fails with address or wiring symptoms.

1. Stale hardcoded addresses
- Symptom: startup/config errors or bridge failures after node restart/redeploy.
- Check: verify any configured FeeJuice L1/L2 addresses against fresh `node_getNodeInfo` output.
- Fix: remove stale hardcoded values; regenerate deploy/config artifacts and use node-reported addresses.

2. L1 chain-id mismatch (`l1_rpc_url` vs node-reported chain)
- Symptom: bridge submit fails with chain/network mismatch errors.
- Check: compare node-reported `l1ChainId` from `node_getNodeInfo` with the chain id served by `l1_rpc_url`.
- Fix: point to the correct L1 RPC for the active local-network instance.

3. FeeJuice portal/address mismatch
- Symptom: bridge submission fails or FeeJuice balance never increases after a bridge + claim.
- Check: compare configured/derived FeeJuice token + portal addresses with node-reported `l1ContractAddresses`.
- Fix: do not override local-network FeeJuice addresses manually; use node-derived values.

## Full Lifecycle Phases
1. Read pre-deployed FPC and Token addresses from deployment manifest.
2. Connect to Aztec node, derive operator account from secret, create fresh test users.
3. Register pre-deployed contracts in local wallet.
4. Wait for FPC to have positive Fee Juice balance (funded by topup service).
5. Run negative scenarios 1-5 against pre-deployed FPC.
6. For scenario 6: deploy isolated Token + FPC, bridge + claim Fee Juice directly, run insufficient balance test.
7. Persist diagnostics and artifacts.

## Required Negative Scenarios (FPC E2E)
1. Quote replay rejection:
   - reuse the same `(rate_num, rate_den, valid_until, signature)` after one successful use;
   - second use must be rejected due to quote replay protection.
2. Expired quote rejection:
   - submit a quote after `valid_until`;
   - tx must be rejected.
3. Overlong quote TTL rejection:
   - submit a quote whose `valid_until - anchor_timestamp > 3600`;
   - tx must be rejected.
4. Quote sender-binding rejection:
   - quote issued for user A is submitted by user B;
   - tx must be rejected (invalid signature binding to `msg_sender`).
5. Direct fee_entrypoint call rejection:
   - call `fee_entrypoint` as a root-level transaction outside the setup phase;
   - tx must be rejected.
6. Insufficient Fee Juice under concurrent quote issuance:
   - deploy an isolated FPC with a controlled Fee Juice budget (via direct bridge + claim);
   - first tx succeeds, second tx is rejected for insufficient fee-payer balance.

## Coverage Findings And Test Tiering
Current script coverage in this repository is intentionally split:
- `scripts/contract/deploy-fpc-local.ts` and `scripts/contract/deploy-fpc-local-smoke.ts` are deployment/relay usability checks, not quote-security or negative-behavior tests.
- `scripts/services/fee-entrypoint-smoke.ts` is a negative-path smoke check verifying that `fee_entrypoint` cannot be called as a root-level transaction outside the setup phase (against pre-deployed services).
- `scripts/services/fpc-services-smoke.ts` tests deployed service HTTP endpoints (attestation quotes, topup health, metrics).
- `scripts/same-token-transfer/test-same-token-transfer.ts` is the happy-path integration test covering FPC-paid transactions across multiple transfer types.

This document is the source of truth for full FPC e2e negative-scenario requirements. Happy-path coverage is defined by the same-token-transfer test.

## Non-Goals For This E2E
- Happy-path FPC transaction assertions are covered by the same-token-transfer integration test and are not duplicated here.
- Multi-cycle bridge re-funding is covered by the same-token-transfer test (which runs against a continuously-funded FPC) and is not required in this E2E.
- Arithmetic hardening for internal gas-cost multiplication (`max_fees_per_gas * gas_limits`) is a contract-level concern and must be validated in contract tests; it is not a required assertion in this e2e flow.
- Operator key rotation is currently a design non-goal (constructor-time key configuration only) and is not part of this e2e.
- Quote-note reclaim/forced-destination scenarios are out of scope for this e2e until a dedicated reclaim API/flow exists in the FPC contract.

## Mandatory Assertions
For the test to pass, all must hold:
- FPC has positive Fee Juice balance (topup service funded it).
- Quote signature verification constraints are enforced:
  - quote is bound to `msg_sender`,
  - expired quotes are rejected,
  - quote replay is rejected,
  - for FPC `fee_entrypoint`, quote TTL is capped to 3600 seconds.
- Direct `fee_entrypoint` calls outside setup phase are rejected.
- Insufficient Fee Juice correctly rejects a second transaction when budget allows only one.

## Config Knobs
- `FPC_COLD_START_MANIFEST` — deployment manifest path (required)
- `FPC_OPERATOR_SECRET_KEY` — operator secret key (required)
- `FPC_FULL_E2E_MODE` (`fpc`, default `fpc`)
- `FPC_FULL_E2E_FEE_JUICE_TIMEOUT_MS` (default: 240000)
- `FPC_FULL_E2E_FEE_JUICE_POLL_MS` (default: 2000)
- `FPC_FULL_E2E_DA_GAS_LIMIT` (default: 200000)
- `FPC_FULL_E2E_L2_GAS_LIMIT` (default: 1000000)

## Pass/Fail Definition
- PASS: setup from manifest completes, FPC is funded, and all negative scenario assertions pass.
- FAIL: manifest not found, FPC has no Fee Juice, negative scenario unexpectedly succeeds, or negative scenario fails with an unexpected error.
