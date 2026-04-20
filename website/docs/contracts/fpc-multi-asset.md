# FPCMultiAsset

Fee payment contract. Accepts operator-signed quotes and pays transaction gas on behalf of users.

**Source:** [`contracts/fpc/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr)

---

## Design

The contract holds no on-chain token allowlist. Multi-asset support comes from quote binding: `accepted_asset` is included in the signed quote preimage, so substituting a different token at call time invalidates the Schnorr signature. Asset policy (rates, fees, which tokens are accepted) lives entirely in the off-chain attestation service. See [ADR-0001](../reference/asset-model-adr.md).

---

## Storage

```noir
struct Storage {
    config: PublicImmutable<Config>,
}
```

| Field | Type | Description |
|-------|------|-------------|
| `operator` | `AztecAddress` | Receives token payments |
| `operator_pubkey_x` | `Field` | Schnorr public key X coordinate |
| `operator_pubkey_y` | `Field` | Schnorr public key Y coordinate |

All fields are packed into a single `PublicImmutable<Config>` slot and set once at construction. There is no mutable admin state after deployment. Key rotation requires redeployment.

---

## `constructor`

```noir
#[public]
#[initializer]
fn constructor(
    operator: AztecAddress,
    operator_pubkey_x: Field,
    operator_pubkey_y: Field,
)
```

Writes `Config` to `PublicImmutable`. Called once at deployment. Rejects a zero `operator` address.

---

## `fee_entrypoint`

Standard fee payment for users with an existing L2 token balance.

```noir
#[external("private")]
#[allow_phase_change]
fn fee_entrypoint(
    accepted_asset: AztecAddress,
    authwit_nonce: Field,
    fj_fee_amount: u128,
    aa_payment_amount: u128,
    valid_until: u64,
    quote_sig: [u8; 64],
)
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `accepted_asset` | `AztecAddress` | Token contract the user pays in |
| `authwit_nonce` | `Field` | Nonce for the token transfer authorization witness |
| `fj_fee_amount` | `u128` | Gas cost in Fee Juice (must equal `max_gas_cost_no_teardown` for the transaction gas settings) |
| `aa_payment_amount` | `u128` | Token amount the user pays |
| `valid_until` | `u64` | Quote expiry (unix seconds) |
| `quote_sig` | `[u8; 64]` | Operator Schnorr signature over the quote preimage |

**Execution steps**

1. Reads packed `config` from storage (`operator`, signing pubkey).
2. Computes the quote hash and verifies the Schnorr signature. Binds `user_address = msg_sender`, so a quote signed for one user cannot be used by another.
3. Pushes a nullifier derived from the quote hash. Duplicate quotes fail via nullifier conflict.
4. Asserts `anchor_block_timestamp <= valid_until`.
5. Asserts `(valid_until - anchor_block_timestamp) <= 3600` seconds.
6. Asserts `fj_fee_amount == get_max_gas_cost_no_teardown(...)`.
7. Calls `Token::at(accepted_asset).transfer_private_to_private(sender, operator, aa_payment_amount, nonce)`.
8. Asserts setup-phase execution (`!in_revertible_phase`), then calls `set_as_fee_payer()` + `end_setup()`.

The token transfer executes in the setup phase, before `end_setup()`. It is irrevocably committed. If the user's app logic subsequently reverts, the fee has still been paid. This is unavoidable in the Aztec FPC model.

No teardown is scheduled. No tokens accumulate in this contract's balance. All fee payments arrive directly in the operator's private balance.

The caller must provide a valid authwit for the token transfer before submitting.

---

## `cold_start_entrypoint`

For users who have bridged tokens from L1 but have no L2 balance. Combines bridge claim and fee payment into a single transaction.

```noir
#[external("private")]
#[allow_phase_change]
fn cold_start_entrypoint(
    user: AztecAddress,
    accepted_asset: AztecAddress,
    bridge: AztecAddress,
    claim_amount: u128,
    claim_secret: Field,
    claim_secret_hash: Field,
    message_leaf_index: Field,
    fj_fee_amount: u128,
    aa_payment_amount: u128,
    valid_until: u64,
    quote_sig: [u8; 64],
)
```

**Parameters**

| Name | Type | Signed | Description |
|------|------|--------|-------------|
| `user` | `AztecAddress` | Yes | User's L2 address |
| `accepted_asset` | `AztecAddress` | Yes | Token contract |
| `bridge` | `AztecAddress` | No | Bridge contract (not in quote preimage) |
| `claim_amount` | `u128` | Yes | Amount bridged from L1 |
| `claim_secret` | `Field` | No | Bridge claim secret |
| `claim_secret_hash` | `Field` | Yes | Hash of claim secret |
| `message_leaf_index` | `Field` | No | L1-to-L2 message index (not in quote preimage) |
| `fj_fee_amount` | `u128` | Yes | Gas cost in Fee Juice |
| `aa_payment_amount` | `u128` | Yes | Token fee amount |
| `valid_until` | `u64` | Yes | Quote expiry |
| `quote_sig` | `[u8; 64]` | n/a | Operator Schnorr signature |

**Execution steps**

### Assert transaction root

`msg_sender.is_none()`. Must be called as the transaction entrypoint, not from another contract.

### Assert claim covers fee

`claim_amount >= aa_payment_amount`.

### Verify quote

`assert_valid_cold_start_quote` verifies a 9-field Poseidon2 preimage with domain separator `0x46504373`. Schnorr signature verified, nullifier pushed.

### Declare fee payer

`set_as_fee_payer()`. The FPC pays gas in Fee Juice.

### Claim from bridge

`TokenBridge.claim_private(fpc_address, claim_amount, claim_secret, message_leaf_index)`. Tokens mint into the FPC's private balance, not the user's. This is deliberate: the user's account may not be deployed on L2 yet.

### Distribute

- `claim_amount - aa_payment_amount` goes to the user (skipped if zero).
- `aa_payment_amount` goes to the operator.

No authwit required for either transfer because the FPC is `msg_sender` for both.

---

## Internal helpers

### `assert_valid_quote`

Verifies a standard quote. Computes a 7-field Poseidon2 hash, verifies the Schnorr signature against the stored operator pubkey, pushes a nullifier, checks expiry and TTL cap (max 3600 seconds).

**Preimage:**

```
poseidon2([
    0x465043,          // domain separator ("FPC")
    fpc_address,
    accepted_asset,
    fj_fee_amount,
    aa_payment_amount,
    valid_until,
    user_address       // always msg_sender, never zero
])
```

### `assert_valid_cold_start_quote`

Same as above with a 9-field preimage. Adds `claim_amount` and `claim_secret_hash`. Uses domain separator `0x46504373` ("FPCs") to prevent cross-entrypoint replay. `bridge` and `message_leaf_index` are function arguments but are not signed.

**Preimage:**

```
poseidon2([
    0x46504373,        // domain separator ("FPCs")
    fpc_address,
    accepted_asset,
    fj_fee_amount,
    aa_payment_amount,
    valid_until,
    user_address,
    claim_amount,
    claim_secret_hash
])
```

### `get_max_gas_cost`

Returns the maximum possible transaction fee using protocol gas parameters. Used internally to validate `fj_fee_amount` against the transaction's gas settings.

---

## Function Reference

| Function | Aztec context | Callable by |
|----------|---------------|-------------|
| `constructor(operator, operator_pubkey_x, operator_pubkey_y)` | public | anyone (one-time initializer) |
| `fee_entrypoint(accepted_asset, authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)` | private | any user (quote binds to caller) |
| `cold_start_entrypoint(user, accepted_asset, bridge, claim_amount, claim_secret, claim_secret_hash, message_leaf_index, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)` | private | transaction root only |

> [!NOTE]
>
> There are no admin functions. The contract has no mutable state after construction.

---

## Tests

### `fee_entrypoint.nr` (7 tests)

| Test | What it checks |
|------|----------------|
| `fee_entrypoint_happy_path_transfers_expected_charge` | Correct charge deducted, gas paid |
| `fee_entrypoint_rejects_mismatched_fj_fee_amount` | Tampered amount breaks signature |
| `fee_entrypoint_rejects_expired_quote` | `valid_until` in the past rejected |
| `fee_entrypoint_rejects_overlong_quote_ttl` | TTL > 3600s rejected |
| `constructor_rejects_zero_operator` | Zero operator address rejected at construction |
| `fee_entrypoint_rejects_quote_bound_to_another_user` | Quote for user A unusable by user B |
| `fee_entrypoint_requires_fresh_transfer_authwit_each_call` | Authwit cannot be reused |

### `cold_start_entrypoint.nr` (4 tests)

| Test | What it checks |
|------|----------------|
| `cold_start_happy_path` | Tokens distributed correctly, gas paid |
| `cold_start_rejects_non_root_caller` | Reverts if not transaction root |
| `cold_start_quote_rejected_by_fee_entrypoint` | Domain separation prevents cross-use |
| `regular_quote_rejected_by_cold_start_entrypoint` | Standard quote invalid in cold-start |
