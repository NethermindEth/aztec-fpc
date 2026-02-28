# CreditFPC Full E2E Test Definition

## Scope
This document defines a single end-to-end test for the CreditFPC lifecycle only.
1. CreditFPC lifecycle:
   - topup service funds CreditFPC Fee Juice balance,
   - user executes tx #1 through `pay_and_mint`,
   - target contract call executes,
   - topup service funds CreditFPC again after fee spend,
   - user executes tx #2 through `pay_with_credit`.

No other smoke/deploy/test flows are part of this definition.

## Test Entry Point
- Command: `bun run e2e:full-lifecycle:credit:local`
- Script: `scripts/services/credit-fpc-full-lifecycle-e2e.sh`
- Runner: `scripts/services/credit-fpc-full-lifecycle-e2e.ts`

## Relationship To FPC Spec
- The FPC-only suite remains defined in `docs/e2e-test-spec.md`.
- This credit suite is separate by design and must not inherit FPC-only requirements that are not implemented in `CreditFPC`.
- Specifically, CreditFPC currently enforces quote expiry but does not enforce an upper bound on quote TTL.

## Required Environment
- Aztec CLI (`aztec`) available in `PATH`
- Aztec local network endpoints:
  - L2 node: `http://127.0.0.1:8080`
  - L1 RPC: `http://127.0.0.1:8545`
- Local network started (or reused) via:
  - `aztec start --local-network`
- Contracts compiled (`aztec compile --workspace --force`) including:
  - `target/token_contract-Token.json`
  - `target/credit_fpc-CreditFPC.json`
- Attestation and topup services buildable/runnable from this repo

## Asset Model And Wiring
Two different assets are involved and must not be conflated:

1. `accepted_asset` (L2 token used to charge tx #1 in `pay_and_mint`)
- This is a test token deployed on Aztec L2 (`token_contract-Token`).
- It is passed to CreditFPC constructor as `accepted_asset`.
- Attestation must return this exact address in `/quote.accepted_asset`.

2. Fee Juice (protocol fee asset for gas payment)
- L2 Fee Juice contract address is provided by node info:
  - `protocolContractAddresses.feeJuice`
- L1 Fee Juice ERC20 + portal addresses are provided by node info:
  - `l1ContractAddresses.feeJuiceAddress`
  - `l1ContractAddresses.feeJuicePortalAddress`
- Topup bridges L1 Fee Juice to CreditFPC using `L1FeeJuicePortalManager.bridgeTokensPublic(...)`.

Address source of truth is always `node_getNodeInfo`; nothing is hardcoded.

## Full Lifecycle Phases
1. Start or reuse local devnet via `aztec start --local-network`.
2. Deploy L2 accepted-asset token (`token_contract-Token`).
3. Derive operator Schnorr signing public key `(operator_pubkey_x, operator_pubkey_y)`.
4. Deploy CreditFPC with:
   - `operator = operator Aztec address`
   - `operator_pubkey_x = operator Schnorr pubkey x`
   - `operator_pubkey_y = operator Schnorr pubkey y`
   - `accepted_asset = deployed L2 token address`
5. Run CreditFPC scenario:
   - start attestation + topup with generated runtime config:
     - attestation config uses `fpc_address=<CreditFPC>` + `accepted_asset_address`
     - topup config uses `fpc_address=<CreditFPC>` + `l1_rpc_url`; Fee Juice L1/L2 addresses are discovered from node info
6. Wait for bridge cycle #1:
   - topup logs `Bridge submitted.`
   - relay block advancement
   - topup logs `Bridge confirmation outcome=confirmed`
   - CreditFPC Fee Juice balance becomes positive
7. Execute user tx #1:
   - fetch quote from attestation `/quote?user=...&fj_amount=...`
   - execute fee payment via `pay_and_mint(...)`
   - execute target contract call
   - assert CreditFPC tx1 invariants
8. Wait for bridge cycle #2 after fee spend (if required):
   - second `Bridge submitted.` and `Bridge confirmation outcome=confirmed`
   - CreditFPC Fee Juice balance increases from post-tx#1 baseline
9. Execute user tx #2:
   - execute fee payment via `pay_with_credit()`
   - execute target contract call
   - assert CreditFPC tx2 invariants

## Required Negative Scenarios (CreditFPC E2E)
In addition to lifecycle happy-path checks, the full CreditFPC e2e suite must include:
1. Quote replay rejection:
   - reuse the same `(fj_amount, aa_payment_amount, valid_until, signature)` after one successful use;
   - second use must be rejected due to quote replay protection.
2. Expired quote rejection:
   - submit a quote after `valid_until`;
   - tx must be rejected.
3. Quote sender-binding rejection:
   - quote issued for user A is submitted by user B;
   - tx must be rejected (`invalid quote signature` binding to `msg_sender`).
4. Minted-credit-too-low rejection:
   - execute `pay_and_mint` with quoted `fj_credit_amount` below `max_gas_cost_no_teardown`;
   - tx must be rejected (`minted credit too low for max fee`).
5. Insufficient Fee Juice on second paid tx:
   - provision Fee Juice budget for one paid tx only;
   - run tx #1 successfully;
   - tx #2 must be rejected for insufficient fee-payer balance.

## Explicit Non-Requirement
- Do not require an "overlong quote TTL rejected" negative in CreditFPC e2e unless CreditFPC contract adds a TTL upper-bound check.

## Mandatory Assertions
For the test to pass, all must hold:
- Attestation `/health` and `/asset` are reachable and consistent with deployed token.
- Quote payload is valid and bound to expected asset and user.
- Quote signature constraints are enforced:
  - quote is bound to `msg_sender`,
  - expired quotes are rejected,
  - quote replay is rejected.
- Bridge confirmation succeeds for required CreditFPC cycles.
- Each fee-paid tx is accepted on-chain.
- `pay_and_mint` tx #1 invariants:
  - `user_debited == aa_payment_amount`
  - `operator_credited == aa_payment_amount`
  - `credit_after == credit_before + fj_credit_amount - max_gas_cost_no_teardown`
  - `quote_used(...) == true`
- `pay_with_credit` tx #2 invariants:
  - user private token balance unchanged by fee payment (`user_debited == 0`)
  - operator private token balance unchanged by fee payment (`operator_credited == 0`)
  - credit balance decreases across tx #2
- Target contract call is executed for each fee-paid tx (state delta asserted).

## Config Knobs
- `FPC_CREDIT_FULL_E2E_START_LOCAL_NETWORK` (`1|0`)
- `FPC_CREDIT_FULL_E2E_RESET_LOCAL_STATE` (`1|0`)
- `FPC_CREDIT_FULL_E2E_MODE` (`credit`, default `credit`)
- `FPC_CREDIT_FULL_E2E_RELAY_ADVANCE_BLOCKS` (default `2`)
- `FPC_CREDIT_FULL_E2E_REQUIRED_TOPUP_CYCLES` (allowed `1` or `2`, default `2`)
- `FPC_CREDIT_FULL_E2E_TOPUP_CHECK_INTERVAL_MS`
- `FPC_CREDIT_FULL_E2E_TOPUP_WEI`, `FPC_CREDIT_FULL_E2E_THRESHOLD_WEI`
- `FPC_CREDIT_FULL_E2E_CREDIT_MINT_MULTIPLIER`, `FPC_CREDIT_FULL_E2E_CREDIT_MINT_BUFFER`

## Pass/Fail Definition
- PASS: all lifecycle phases complete and all mandatory assertions pass.
- FAIL: any missing bridge confirmation, quote-validation mismatch, fee invariant mismatch, missing target-call state change, or rejected transaction.
