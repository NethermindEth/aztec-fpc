# FPC

`FPC` is a private fee-payment contract that charges users in a single accepted token per transaction and pays Aztec fees from the contract's Fee Juice balance.

Unlike `CreditFPC`, it does not maintain a user credit ledger.

## What This Contract Does

`FPC` stores only immutable config:

- `operator`
- operator Schnorr pubkey (`operator_pubkey_x`, `operator_pubkey_y`)
- `accepted_asset`

### `fee_entrypoint` flow

`fee_entrypoint(authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)`:

1. Verifies operator quote signature over exact amounts and caller address.
2. Rejects replay by nullifying quote hash.
3. Enforces quote expiry and max TTL (`<= 3600s` from anchor timestamp).
4. Enforces `fj_fee_amount == get_max_gas_cost_no_teardown(...)`.
5. Transfers exactly `aa_payment_amount` of `accepted_asset` from user to operator using authwit.
6. Marks contract as fee payer (`set_as_fee_payer`) and ends setup (outside revertible phase).

## How It Differs From `/contracts/credit_fpc`

Both contracts use operator-signed, user-bound quotes and both act as fee payer via `set_as_fee_payer()`, but they differ in fee model and state.

1. Payment mode:
- `FPC`: token charge every transaction (`fee_entrypoint`).
- `CreditFPC`: token prepay + internal credit spending (`pay_and_mint`, `pay_with_credit`).

2. State model:
- `FPC`: immutable config only.
- `CreditFPC`: immutable config + per-user private credit balance notes.

3. Entrypoints:
- `FPC`: single private fee entrypoint.
- `CreditFPC`: two private fee entrypoints plus extra utility view methods.

4. Quote amount semantics:
- `FPC`: signed `fj_fee_amount` must match current no-teardown max gas cost.
- `CreditFPC`: signed `fj_credit_amount` is desired mint amount (must be sufficient for immediate deduction).

5. Internal accounting:
- `FPC`: no credit mint/burn bookkeeping.
- `CreditFPC`: mints credit and subtracts gas-reserve amounts from credit notes.

6. Quote validity constraints:
- `FPC`: expiry + explicit TTL cap (`MAX_QUOTE_TTL_SECONDS = 3600`).
- `CreditFPC`: expiry check but no equivalent explicit TTL cap in current implementation.

## Quote Model (Amount-Based)

Quote domain separator: `0x465043`.

Quote hash preimage:

`poseidon2([DOMAIN_SEP, contract_address, accepted_asset, fj_fee_amount, aa_payment_amount, valid_until, user_address])`

Signature:

- Schnorr signature verified against immutable operator pubkey.
- Signature is over `quote_hash.to_be_bytes::<32>()`.

Replay protection:

- `quote_hash` is pushed as a nullifier.
- FPC does not expose a utility `quote_used(...)` method.

## Wiring to Attestation Service

Attestation service reference: `/home/ametel/source/aztec-fpc/services/attestation`

For `FPC`, attestation must be configured with:

- `fpc_address = <fpc_address>`
- `accepted_asset_address = <token_address>`
- operator key matching constructor `operator_pubkey_x/y`

Client flow:

1. Request `/quote?user=<aztec_address>&fj_amount=<expected_max_gas_cost_no_teardown>`.
2. Receive `fj_amount`, `aa_payment_amount`, `valid_until`, `signature`.
3. Call `fee_entrypoint(...)` with those fields and transfer authwit nonce.

Important:

- `FPC` enforces `fj_fee_amount == get_max_gas_cost_no_teardown(...)`, so quote `fj_amount` must match the gas settings of the transaction being built.

## Wiring to Top-up Service

Top-up service reference: `/home/ametel/source/aztec-fpc/services/topup`

Because `FPC` calls `set_as_fee_payer()`, it must hold Fee Juice on its own contract address.

Configure top-up with:

- `fpc_address = <fpc_address>`

Then top-up monitors and bridges Fee Juice to keep this contract funded for fee payment.

## Wiring to Token + Authwit

`accepted_asset` is immutable and part of quote preimage.

`fee_entrypoint` requires a valid private authwit authorizing:

`Token.transfer_private_to_private(user, operator, aa_payment_amount, authwit_nonce)`

If authwit is missing, stale, or mismatched to amount/nonce, the call fails.

## Public/Private Interface

- `constructor(operator, operator_pubkey_x, operator_pubkey_y, accepted_asset)` (`public`, initializer)
- `fee_entrypoint(authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)` (`private`)

Internal helpers:

- `assert_valid_quote(...)`
- `get_max_gas_cost_no_teardown(...)`

## Fee Math Helper

The crate includes `fee_math::fee_juice_to_asset(...)`:

`payment_asset_amount = ceil(fee_juice_amount * rate_num / rate_den)`

with explicit `u128` overflow checks.

## Test Coverage Highlights

Contract tests in `/home/ametel/source/aztec-fpc/contracts/fpc/src/test` cover:

- constructor validation (zero `operator` / zero `accepted_asset` rejected),
- happy-path transfer accounting,
- non-1:1 amount quote support,
- tampered quote amount rejection (`invalid quote signature`),
- strict fee-amount mismatch rejection (`quoted fee amount mismatch`),
- expired quote rejection,
- overlong TTL rejection (`quote ttl too large`),
- user-bound quote enforcement,
- fresh authwit requirement across repeated calls.
