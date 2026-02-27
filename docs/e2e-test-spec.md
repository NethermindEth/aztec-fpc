# Full E2E Test Definition

## Scope
This document defines a single end-to-end test for the FPC lifecycle only.
1. FPC lifecycle:
   - topup service funds FPC,
   - user executes a fee-paid transaction through `fee_entrypoint`,
   - target contract call executes,
   - topup service funds FPC again after fee spend,
   - user executes a second fee-paid target call.

No other smoke/deploy/test flows are part of this definition.

## Test Entry Point
- Command: `bun run e2e:full-lifecycle`
- Script: `scripts/services/fpc-full-lifecycle-e2e.sh`
- Runner: `scripts/services/fpc-full-lifecycle-e2e.ts`

## Required Environment
- Aztec CLI (`aztec`) available in `PATH`
- Aztec local network endpoints:
  - L2 node: `http://127.0.0.1:8080`
  - L1 RPC: `http://127.0.0.1:8545`
- Local network started (or reused) via:
  - `aztec start --local-network`
- Contracts compiled (`aztec compile --workspace --force`) including:
  - `target/token_contract-Token.json`
  - `target/fpc-FPC.json`
- Attestation and topup services buildable/runnable from this repo

## Asset Model And Wiring
Two different assets are involved and must not be conflated:

1. `accepted_asset` (L2 token used to charge the user)
- This is a test token deployed on Aztec L2 (`token_contract-Token`).
- It is passed to the FPC constructor as `accepted_asset`.
- Attestation must return this exact address in `/quote.accepted_asset`.
- No L1 token wiring is required for this asset in this E2E.

2. Fee Juice (protocol fee asset for gas payment)
- L2 Fee Juice contract address is provided by node info:
  - `protocolContractAddresses.feeJuice`
- L1 Fee Juice ERC20 + portal addresses are provided by node info:
  - `l1ContractAddresses.feeJuiceAddress`
  - `l1ContractAddresses.feeJuicePortalAddress`
- Topup bridges L1 Fee Juice to FPC using `L1FeeJuicePortalManager.bridgeTokensPublic(...)`.

Address source of truth is always `node_getNodeInfo`; nothing is hardcoded.

## Full Lifecycle Phases
1. Start or reuse local devnet via `aztec start --local-network`.
2. Deploy L2 accepted-asset token (`token_contract-Token`).
3. Derive operator Schnorr signing public key `(operator_pubkey_x, operator_pubkey_y)`.
4. Deploy FPC with:
   - `operator = operator Aztec address`
   - `operator_pubkey_x = operator Schnorr pubkey x`
   - `operator_pubkey_y = operator Schnorr pubkey y`
   - `accepted_asset = deployed L2 token address`
5. Run FPC scenario:
   - start attestation + topup with generated runtime config:
     - attestation config uses `fpc_address=<FPC>` + `accepted_asset_address`
     - topup config uses `fpc_address=<FPC>` + `l1_rpc_url`; Fee Juice L1/L2 addresses are discovered from node info
6. Wait for FPC bridge cycle #1:
   - topup logs `Bridge submitted.`
   - relay block advancement
   - topup logs `Bridge confirmation outcome=confirmed`
   - FPC Fee Juice balance becomes positive
7. Execute FPC user tx #1:
   - fetch quote from attestation `/quote`
   - call target contract method using FPC payment method (`fee_entrypoint`)
   - assert fee debit/credit invariants
   - assert target contract state change
8. Wait for FPC bridge cycle #2 after fee spend:
   - second `Bridge submitted.` and `Bridge confirmation outcome=confirmed`
   - FPC Fee Juice balance increases from post-tx#1 baseline
9. Execute FPC user tx #2 with same invariant checks.

## Coverage Findings And Test Tiering
Current script coverage in this repository is intentionally split:
- `scripts/contract/deploy-fpc-local.ts` and `scripts/contract/deploy-fpc-local-smoke.ts` are deployment/relay usability checks, not quote-security or negative-behavior tests.
- `services/attestation/test/fee-entrypoint-devnet-smoke.ts` and `scripts/services/fpc-services-smoke.ts` are primarily happy-path smoke checks, plus basic malformed-request validation.

This document is the source of truth for full FPC e2e behavior requirements, including negative scenarios that are not required in lightweight smoke scripts.

## Required Negative Scenarios (FPC E2E)
In addition to lifecycle happy-path checks, the full FPC e2e suite must include:
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
5. Insufficient Fee Juice under concurrent quote issuance:
   - issue two valid quotes while FPC has Fee Juice budget for only one transaction;
   - first tx succeeds, second tx is rejected for insufficient fee-payer balance.

## Non-Goals For This E2E
- Arithmetic hardening for internal gas-cost multiplication (`max_fees_per_gas * gas_limits`) is a contract-level concern and must be validated in contract tests; it is not a required assertion in this e2e flow.
- Operator key rotation is currently a design non-goal (constructor-time key configuration only) and is not part of this e2e.
- Quote-note reclaim/forced-destination scenarios are out of scope for this e2e until a dedicated reclaim API/flow exists in the FPC contract.

## Mandatory Assertions
For the test to pass, all must hold:
- Attestation `/health` and `/asset` are reachable and consistent with deployed token.
- Quote payload is valid and bound to expected asset/rate window.
- Quote signature verification constraints are enforced:
  - quote is bound to `msg_sender`,
  - expired quotes are rejected,
  - quote replay is rejected,
  - for FPC `fee_entrypoint`, `rate_num > 0` and quote TTL is capped to 3600 seconds.
- Bridge confirmation succeeds for required FPC cycles.
- Each fee-paid tx is accepted on-chain.
- FPC `fee_entrypoint` txs:
  - `user_debited == expected_charge`
  - `operator_credited == expected_charge`
- Target contract call is actually executed for each fee-paid tx (state delta asserted).

## Config Knobs
- `FPC_FULL_E2E_START_LOCAL_NETWORK` (`1|0`)
- `FPC_FULL_E2E_RESET_LOCAL_STATE` (`1|0`)
- `FPC_FULL_E2E_MODE` (`fpc`, default `fpc`)
- `FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS` (default `2`)
- `FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES` (allowed `1` or `2`, default `2`)
- `FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS`
- `FPC_FULL_E2E_TOPUP_WEI`, `FPC_FULL_E2E_THRESHOLD_WEI`

## Pass/Fail Definition
- PASS: all lifecycle phases complete and all mandatory assertions pass.
- FAIL: any missing bridge confirmation, quote-validation mismatch, fee invariant mismatch, missing target-call state change, or rejected transaction.
