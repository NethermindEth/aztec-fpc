# CreditFPC

`CreditFPC` is a private fee-payment contract that converts a quoted token payment into private fee credit, then spends that credit to pay Aztec transaction fees.

It supports two private flows:

1. `pay_and_mint`: pay token now, mint fee credit, and use part of it immediately for the current transaction.
2. `pay_with_credit`: spend existing fee credit without any token transfer.

## What This Contract Does

`CreditFPC` stores:

- immutable config (`operator`, operator Schnorr pubkey, `accepted_asset`), and
- per-user private credit balance notes (`balances`).

### `pay_and_mint` flow

`pay_and_mint(authwit_nonce, fj_credit_amount, aa_payment_amount, valid_until, quote_sig)`:

1. Verifies operator quote signature over exact amounts and caller address.
2. Rejects replay by nullifying quote hash.
3. Checks quote expiry against anchor timestamp.
4. Transfers exactly `aa_payment_amount` of `accepted_asset` from user to operator using authwit.
5. Mints exactly `fj_credit_amount` private credit for the caller.
6. Deducts `get_max_gas_cost_no_teardown(...)` from the minted credit for the current tx setup gas.
7. Marks contract as fee payer (`set_as_fee_payer`) and ends setup phase.

### `pay_with_credit` flow

`pay_with_credit()`:

1. Computes `get_max_gas_cost(...)` including teardown gas limits.
2. Deducts that amount from caller credit balance.
3. Marks contract as fee payer and ends setup.

No quote and no token transfer are used in this path.

## How It Differs From `/contracts/fpc`

Both contracts verify user-bound, operator-signed amount quotes and both call `set_as_fee_payer()`, but their payment models are different.

1. Payment mode:
- `FPC`: pay token every transaction via `fee_entrypoint(...)`.
- `CreditFPC`: prepay token via `pay_and_mint(...)`, then reuse credit via `pay_with_credit()`.

2. State model:
- `FPC`: only immutable config; no per-user credit state.
- `CreditFPC`: immutable config + private per-user `balances` note set.

3. Entrypoints:
- `FPC`: one private fee entrypoint (`fee_entrypoint`).
- `CreditFPC`: two private fee entrypoints (`pay_and_mint`, `pay_with_credit`), plus utility `balance_of` and `quote_used`.

4. Amount semantics in quote:
- `FPC`: signed `fj_fee_amount` must equal `get_max_gas_cost_no_teardown(...)` in-contract (`quoted fee amount mismatch` on mismatch).
- `CreditFPC`: signed `fj_credit_amount` is caller-chosen mint amount (must still be large enough for immediate setup deduction).

5. Gas deduction behavior:
- `FPC`: token transfer covers payment; no internal credit ledger.
- `CreditFPC`: `pay_and_mint` mints credit then immediately subtracts current `get_max_gas_cost_no_teardown(...)`; `pay_with_credit` subtracts `get_max_gas_cost(...)` (includes teardown).

6. Quote validity constraints:
- `FPC`: enforces expiry and a hard max TTL (`MAX_QUOTE_TTL_SECONDS = 3600`).
- `CreditFPC`: enforces expiry (`anchor_ts <= valid_until`) but does not enforce the same max-TTL cap in current implementation.

## Quote Model (Amount-Based)

Quote domain separator: `0x465043`.

Quote hash preimage:

`poseidon2([DOMAIN_SEP, contract_address, accepted_asset, fj_credit_amount, aa_payment_amount, valid_until, user_address])`

Signature:

- Schnorr signature verified against immutable operator pubkey.
- Signature is over `quote_hash.to_be_bytes::<32>()`.

Replay protection:

- `quote_hash` is pushed as a nullifier.
- `quote_used(...)` utility exposes nullifier presence for a given quote tuple.

## Wiring to Attestation Service

Attestation service reference: `/home/ametel/source/aztec-fpc/services/attestation`

For `CreditFPC`, the attestation service must be configured with:

- `fpc_address = <credit_fpc_address>`
- `accepted_asset_address = <token_address>`
- operator key matching constructor `operator_pubkey_x/y`

The service signs the exact preimage this contract verifies. Client usage is:

1. Request `/quote?user=<aztec_address>&fj_amount=<desired_credit_mint>`.
2. Receive `fj_amount`, `aa_payment_amount`, `valid_until`, `signature`.
3. Call `pay_and_mint(...)` with those fields plus transfer authwit nonce.

Important semantics:

- In this contract, attestation `fj_amount` is interpreted as `fj_credit_amount` (credit to mint), not necessarily current max tx gas.

## Wiring to Top-up Service

Top-up service reference: `/home/ametel/source/aztec-fpc/services/topup`

Because `CreditFPC` calls `set_as_fee_payer()`, it must hold Fee Juice balance on its own contract address.

Configure top-up with:

- `fpc_address = <credit_fpc_address>`

Then top-up monitors and bridges Fee Juice to keep this contract funded as a fee payer.

## Wiring to Token + Authwit

`accepted_asset` is immutable and enforced in quote hash preimage.

`pay_and_mint` requires a valid private authwit authorizing this contract to execute:

`Token.transfer_private_to_private(user, operator, aa_payment_amount, authwit_nonce)`

If authwit is missing or mismatched, the call fails.

## Public/Private/Utility Interface

- `constructor(operator, operator_pubkey_x, operator_pubkey_y, accepted_asset)` (`public`, initializer)
- `pay_and_mint(authwit_nonce, fj_credit_amount, aa_payment_amount, valid_until, quote_sig)` (`private`)
- `pay_with_credit()` (`private`)
- `_refund(max_gas_cost, partial_note)` (`public`, `only_self`)
- `balance_of(account)` (`utility`, unconstrained)
- `quote_used(fj_credit_amount, aa_payment_amount, valid_until, user_address)` (`utility`, unconstrained)
- `dev_mint(amount)` (`private`, test-only helper)

## Gas-Cost Helpers

- `get_max_gas_cost_no_teardown(...)`: used by `pay_and_mint` immediate deduction.
- `get_max_gas_cost(...)`: used by `pay_with_credit`, includes teardown gas limits.

## Test Coverage Highlights

Contract tests in `/home/ametel/source/aztec-fpc/contracts/credit_fpc/src/test` cover:

- happy path token charge + credit mint,
- non-1:1 quoted amount support,
- expired quote rejection,
- user-bound signature enforcement,
- tampered amount rejection (`invalid quote signature`),
- authwit freshness/missing authwit failure,
- quote replay tracking via `quote_used`.
