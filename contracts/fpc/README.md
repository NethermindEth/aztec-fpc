# FPC

`FPC` is a private fee-payment contract that charges users in a quoted token per transaction and pays Aztec fees from the contract's Fee Juice balance.

It does not maintain a user credit ledger.

## What This Contract Does

`FPC` stores only immutable config:

- `operator`
- operator Schnorr pubkey (`operator_pubkey_x`, `operator_pubkey_y`)

### `fee_entrypoint` flow

`fee_entrypoint(accepted_asset, authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)`:

1. Verifies operator quote signature over `accepted_asset`, `fj_fee_amount`, `aa_payment_amount`, and caller address.
2. Rejects replay by nullifying quote hash (duplicate nullifier insertion fails canonically).
3. Enforces quote expiry and max TTL (`<= 3600s` from anchor timestamp).
4. For fee-paying txs (any non-zero `maxFeesPerGas` lane), rejects revertible-phase execution (`fee_entrypoint must run in setup phase`).
5. Enforces `fj_fee_amount == get_max_gas_cost_no_teardown(...)` (`quoted fee amount mismatch` on mismatch).
6. Transfers exactly signed `aa_payment_amount` of `accepted_asset` from user to operator using authwit.
7. Marks contract as fee payer (`set_as_fee_payer`) and ends setup.

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

Attestation service reference: `services/attestation`

For `FPC`, attestation must be configured with:

- `fpc_address = <fpc_address>`
- `accepted_asset_address = <token_address>`
- operator key matching constructor `operator_pubkey_x/y`

Client flow:

1. Request `/quote?user=<aztec_address>&fj_amount=<expected_max_gas_cost_no_teardown>`.
2. Receive `accepted_asset`, `fj_amount`, `aa_payment_amount`, `valid_until`, `signature`.
3. Call `fee_entrypoint(accepted_asset, ...)` with those fields and transfer authwit nonce.

Important:

- `FPC` requires signed `fj_amount` to equal current `get_max_gas_cost_no_teardown(...)`.

## Wiring to Top-up Service

Top-up service reference: `services/topup`

Because `FPC` calls `set_as_fee_payer()`, it must hold Fee Juice on its own contract address.

Configure top-up with:

- `fpc_address = <fpc_address>`

Then top-up monitors and bridges Fee Juice to keep this contract funded for fee payment.

## Wiring to Token + Authwit

`accepted_asset` is provided per `fee_entrypoint(...)` call and must match the signed quote preimage.

`fee_entrypoint` requires a valid private authwit authorizing:

`Token.transfer_private_to_private(user, operator, aa_payment_amount, authwit_nonce)`

If authwit is missing, stale, or mismatched to amount/nonce, the call fails.

## Public/Private Interface

- `constructor(operator, operator_pubkey_x, operator_pubkey_y)` (`public`, initializer)
- `fee_entrypoint(accepted_asset, authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)` (`private`)

Internal helpers:

- `assert_valid_quote(...)`
- `get_max_gas_cost_no_teardown(...)`

## Test Coverage Highlights

Contract tests in `contracts/fpc/src/test` cover:

- constructor validation (zero `operator` rejected),
- happy-path transfer accounting,
- support for different `fj_fee_amount` and `aa_payment_amount` in quote payload,
- `fj_fee_amount` mismatch rejection (`quoted fee amount mismatch`),
- invalid quote signature path (for example, quote bound to another user),
- expired quote rejection,
- overlong TTL rejection (`quote ttl too large`),
- user-bound quote enforcement,
- fresh authwit requirement across repeated calls.
