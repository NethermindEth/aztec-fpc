# Full E2E Test Definition

## Scope
This document defines a single end-to-end test for the full system lifecycle only. The run must cover both fee-payer contracts in one command:
1. FPC lifecycle:
   - topup service funds FPC,
   - user executes a fee-paid transaction through `fee_entrypoint`,
   - target contract call executes,
   - topup service funds FPC again after fee spend,
   - user executes a second fee-paid target call.
2. CreditFPC lifecycle:
   - topup service funds CreditFPC,
   - user executes a fee-paid transaction through `pay_and_mint`,
   - target contract call executes,
   - user executes a second fee-paid target call through `pay_with_credit`.

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
- Contracts compiled (`aztec compile --workspace --force`) including:
  - `target/token_contract-Token.json`
  - `target/fpc-FPC.json`
  - `target/credit_fpc-CreditFPC.json`
- Attestation and topup services buildable/runnable from this repo

## Asset Model And Wiring
Two different assets are involved and must not be conflated:

1. `accepted_asset` (L2 token used to charge the user)
- This is a test token deployed on Aztec L2 (`token_contract-Token`).
- It is passed to both FPC and CreditFPC constructors as `accepted_asset`.
- Attestation must return this exact address in `/quote.accepted_asset`.
- No L1 token wiring is required for this asset in this E2E.

2. Fee Juice (protocol fee asset for gas payment)
- L2 Fee Juice contract address is provided by node info:
  - `protocolContractAddresses.feeJuice`
- L1 Fee Juice ERC20 + portal addresses are provided by node info:
  - `l1ContractAddresses.feeJuiceAddress`
  - `l1ContractAddresses.feeJuicePortalAddress`
- Topup bridges L1 Fee Juice to the active fee-payer address (`FPC` or `CreditFPC`) using `L1FeeJuicePortalManager.bridgeTokensPublic(...)`.

Address source of truth is always `node_getNodeInfo`; nothing is hardcoded.

## Full Lifecycle Phases
1. Start or reuse local devnet via compose (`docker compose up -d anvil aztec-node`).
2. Deploy L2 accepted-asset token (`token_contract-Token`).
3. Derive operator Schnorr signing public key `(operator_pubkey_x, operator_pubkey_y)`.
4. Deploy FPC with:
   - `operator = operator Aztec address`
   - `operator_pubkey_x = operator Schnorr pubkey x`
   - `operator_pubkey_y = operator Schnorr pubkey y`
   - `accepted_asset = deployed L2 token address`
5. Deploy CreditFPC with:
   - `operator = operator Aztec address`
   - `operator_pubkey_x = operator Schnorr pubkey x`
   - `operator_pubkey_y = operator Schnorr pubkey y`
   - `accepted_asset = deployed L2 token address`
6. Run FPC scenario:
   - start attestation + topup with generated runtime config:
     - attestation config uses `fpc_address=<FPC>` + `accepted_asset_address`
     - topup config uses `fpc_address=<FPC>` + `l1_rpc_url`; Fee Juice L1/L2 addresses are discovered from node info
7. Wait for FPC bridge cycle #1:
   - topup logs `Bridge submitted.`
   - relay block advancement
   - topup logs `Bridge confirmation outcome=confirmed`
   - FPC Fee Juice balance becomes positive
8. Execute FPC user tx #1:
   - fetch quote from attestation `/quote`
   - call target contract method using FPC payment method (`fee_entrypoint`)
   - assert fee debit/credit invariants
   - assert target contract state change
9. Wait for FPC bridge cycle #2 after fee spend:
   - second `Bridge submitted.` and `Bridge confirmation outcome=confirmed`
   - FPC Fee Juice balance increases from post-tx#1 baseline
10. Execute FPC user tx #2 with same invariant checks.
11. Run CreditFPC scenario:
    - restart attestation + topup with `fpc_address=<CreditFPC>`
    - wait for CreditFPC bridge cycle #1 confirmation and positive fee-juice balance
12. Execute CreditFPC user tx #1:
    - fetch quote from attestation `/quote`
    - call target contract using `pay_and_mint`
    - assert token debit/credit and credit-mint invariants
    - assert target contract state change
13. Execute CreditFPC user tx #2:
    - call target contract using `pay_with_credit`
    - assert credit decreases and no operator token transfer occurs
    - assert target contract state change

## Mandatory Assertions
For the test to pass, all must hold:
- Attestation `/health` and `/asset` are reachable and consistent with deployed token.
- Quote payload is valid and bound to expected asset/rate window.
- Quote signature verification constraints are enforced:
  - quote is bound to `msg_sender`,
  - expired quotes are rejected for both contracts,
  - quote replay is rejected for both contracts,
  - for FPC `fee_entrypoint`, `rate_num > 0` and quote TTL is capped to 3600 seconds.
- Bridge confirmation succeeds for required FPC and CreditFPC cycles.
- Each fee-paid tx is accepted on-chain.
- FPC `fee_entrypoint` txs:
  - `user_debited == expected_charge`
  - `operator_credited == expected_charge`
- CreditFPC `pay_and_mint` tx:
  - `user_debited == expected_charge`
  - `operator_credited == expected_charge`
  - `credit_after_pay_and_mint == mint_amount - max_gas_cost_no_teardown`
  - `quote_used(...) == true` after successful call
- CreditFPC `pay_with_credit` tx:
  - `credit_after < credit_before`
  - operator accepted-asset balance remains unchanged
- Target contract call is actually executed for each fee-paid tx (state delta asserted).

## Config Knobs
- `FPC_FULL_E2E_START_LOCAL_NETWORK` (`1|0`)
- `FPC_FULL_E2E_RESET_LOCAL_STATE` (`1|0`)
- `FPC_FULL_E2E_MODE` (`fpc|credit|both`, default `both`)
- `FPC_FULL_E2E_RELAY_ADVANCE_BLOCKS` (default `2`)
- `FPC_FULL_E2E_REQUIRED_TOPUP_CYCLES` (allowed `1` or `2`, default `2`)
- `FPC_FULL_E2E_TOPUP_CHECK_INTERVAL_MS`
- `FPC_FULL_E2E_TOPUP_WEI`, `FPC_FULL_E2E_THRESHOLD_WEI`
- `FPC_FULL_E2E_CREDIT_MINT_MULTIPLIER`, `FPC_FULL_E2E_CREDIT_MINT_BUFFER`

## Pass/Fail Definition
- PASS: all lifecycle phases for the selected mode(s) complete and all mandatory assertions pass.
- FAIL: any missing bridge confirmation, quote-validation mismatch, fee/credit invariant mismatch, missing target-call state change, or rejected transaction.
