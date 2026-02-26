# Full E2E Test Definition

## Scope
This document defines a single end-to-end test for the full system lifecycle only:
1. topup service funds FPC,
2. user executes a fee-paid transaction through `fee_entrypoint`,
3. target contract call executes,
4. topup service funds FPC again after fee spend,
5. user executes a second fee-paid target call.

No other smoke/deploy/test flows are part of this definition.

## Test Entry Point
- Command: `bun run e2e:full-lifecycle`
- Script: `scripts/services/fpc-full-lifecycle-e2e.sh`
- Runner: `scripts/services/fpc-full-lifecycle-e2e.ts`

## Required Environment
- Docker + Docker Compose
- Aztec local network endpoints:
  - L2 node: `http://127.0.0.1:8080`
  - L1 RPC: `http://127.0.0.1:8545`
- Local network started from repo compose:
  - `docker compose up -d anvil aztec-node`
- Contracts compiled (`aztec compile --workspace --force`)
- Attestation and topup services buildable/runnable from this repo

## Asset Model And Wiring
Two different assets are involved and must not be conflated:

1. `accepted_asset` (L2 token used to charge the user)
- This is a test token deployed on Aztec L2 (`token_contract-Token`).
- It is passed to FPC constructor as `accepted_asset`.
- Attestation must return this exact address in `/quote.accepted_asset`.
- No L1 token wiring is required for this asset in this E2E.

2. Fee Juice (protocol fee asset for gas payment)
- L2 Fee Juice contract address is provided by node info:
  - `protocolContractAddresses.feeJuice`
- L1 Fee Juice ERC20 + portal addresses are provided by node info:
  - `l1ContractAddresses.feeJuiceAddress`
  - `l1ContractAddresses.feeJuicePortalAddress`
- Topup bridges L1 Fee Juice to FPC L2 address using `L1FeeJuicePortalManager.bridgeTokensPublic(...)`.

Address source of truth is always `node_getNodeInfo`; nothing is hardcoded.

## Full Lifecycle Phases
1. Start or reuse local devnet via compose (`docker compose up -d anvil aztec-node`).
2. Deploy L2 accepted-asset token (`token_contract-Token`).
3. Deploy FPC with:
   - `operator = operator Aztec address`
   - `accepted_asset = deployed L2 token address`
4. Start attestation + topup with generated runtime config:
   - attestation config uses `fpc_address` + `accepted_asset_address`
   - topup config uses `fpc_address` + `l1_rpc_url`; Fee Juice L1/L2 addresses are discovered from node info
5. Wait for bridge cycle #1:
   - topup logs `Bridge submitted.`
   - relay block advancement
   - topup logs `Bridge confirmation outcome=confirmed`
   - FPC Fee Juice balance becomes positive
6. Execute user tx #1:
   - fetch quote from attestation `/quote`
   - call target contract method using FPC payment method (`fee_entrypoint`)
   - assert fee debit/credit invariants
   - assert target contract state change
7. Wait for bridge cycle #2 after fee spend:
   - second `Bridge submitted.` and `Bridge confirmation outcome=confirmed`
   - FPC Fee Juice balance increases from post-tx#1 baseline
8. Execute user tx #2 with same invariant checks.

## Mandatory Assertions
For the test to pass, all must hold:
- Attestation `/health` and `/asset` are reachable and consistent with deployed token.
- Quote payload is valid and bound to expected asset/rate window.
- Bridge confirmation succeeds for cycle #1 and cycle #2.
- Each fee-paid tx is accepted on-chain.
- For each tx:
  - `user_debited == expected_charge`
  - `operator_credited == expected_charge`
- Target contract call is actually executed for each tx (state delta asserted).

## Config Knobs
- `FPC_FULL_E2E_START_LOCAL_NETWORK` (`1|0`)
- `FPC_FULL_E2E_RESET_LOCAL_STATE` (`1|0`)
- `FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS` (default `2`)
- `FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES` (allowed `1` or `2`, default `2`)
- `FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS`
- `FPC_FULL_E2E_TOPUP_WEI`, `FPC_FULL_E2E_THRESHOLD_WEI`

## Pass/Fail Definition
- PASS: all lifecycle phases complete and all mandatory assertions pass.
- FAIL: any missing bridge confirmation, fee invariant mismatch, missing target-call state change, or rejected transaction.
