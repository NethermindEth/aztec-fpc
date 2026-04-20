# FPCMultiAsset

Fee payment contract. Accepts operator-signed quotes and pays transaction gas on behalf of users.

**Source:** [`contracts/fpc/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr)

---

## Design note

The contract holds no token allowlist. Multi-asset support comes from the quote preimage — `accepted_asset` is a signed parameter, so substituting a different token at call time breaks the Schnorr signature. Asset policy (rates, fees, which tokens are accepted) lives entirely in the off-chain attestation service. See [ADR-0001](../reference/asset-model-adr.md).

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
| `operator_pubkey_x` | `Field` | Schnorr public key X |
| `operator_pubkey_y` | `Field` | Schnorr public key Y |

All fields are set once at construction. Key rotation requires redeployment.

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

Writes `Config` to `PublicImmutable`. Called once at deployment.

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
| `fj_fee_amount` | `u128` | Gas cost in Fee Juice |
| `aa_payment_amount` | `u128` | Token amount the user pays |
| `valid_until` | `u64` | Quote expiry (unix seconds) |
| `quote_sig` | `[u8; 64]` | Operator Schnorr signature |

**Behavior**

1. Verifies the quote — Poseidon2 hash over 7-field preimage, Schnorr signature check, nullifier pushed, TTL ≤ 3600s.
2. Runs `set_as_fee_payer()` during the transaction setup phase.
3. Enqueues a public transfer of `aa_payment_amount` from `msg_sender` to the operator.
4. FPC pays the transaction gas in Fee Juice.

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
| `user` | `AztecAddress` | ✓ | User's L2 address |
| `accepted_asset` | `AztecAddress` | ✓ | Token contract |
| `bridge` | `AztecAddress` | ✗ | Bridge contract (not in quote preimage) |
| `claim_amount` | `u128` | ✓ | Amount bridged from L1 |
| `claim_secret` | `Field` | ✗ | Bridge claim secret |
| `claim_secret_hash` | `Field` | ✓ | Hash of claim secret |
| `message_leaf_index` | `Field` | ✗ | L1→L2 message index (not in quote preimage) |
| `fj_fee_amount` | `u128` | ✓ | Gas cost in Fee Juice |
| `aa_payment_amount` | `u128` | ✓ | Token fee amount |
| `valid_until` | `u64` | ✓ | Quote expiry |
| `quote_sig` | `[u8; 64]` | — | Operator Schnorr signature |


### Assert transaction root

`msg_sender.is_none()` — must be called as the transaction entrypoint, not from another contract.

### Assert claim covers fee

`claim_amount >= aa_payment_amount`.

### Verify quote

`assert_valid_cold_start_quote` — domain separator `0x46504373`, 9-field preimage, Schnorr signature verified, nullifier pushed.

### Declare fee payer

`set_as_fee_payer()` — FPC pays gas in Fee Juice.

### Claim from bridge

`TokenBridge.claim_private(fpc_address, claim_amount, claim_secret, message_leaf_index)` — tokens mint into the **FPC's private balance**.

### Distribute

- `claim_amount - aa_payment_amount` → user (skipped if zero)
- `aa_payment_amount` → operator

No authwit required — FPC is `msg_sender` for both transfers.


---

## Internal helpers

### `assert_valid_quote`

Verifies a standard quote. Computes the 7-field Poseidon2 hash, verifies the Schnorr signature, pushes the nullifier, checks expiry and TTL cap (≤ 3600s).

**Preimage:** `[0x465043, fpc_address, accepted_asset, fj_fee_amount, aa_payment_amount, valid_until, user_address]`

### `assert_valid_cold_start_quote`

Same as above with a 9-field preimage — adds `claim_amount` and `claim_secret_hash`. `bridge` and `message_leaf_index` are function arguments but are **not signed**.

**Preimage:** `[0x46504373, fpc_address, accepted_asset, fj_fee_amount, aa_payment_amount, valid_until, user_address, claim_amount, claim_secret_hash]`

### `get_max_gas_cost`

Returns the maximum possible transaction fee using protocol gas parameters. Used internally to size Fee Juice payments.

---

## Tests

### `fee_entrypoint.nr` — 7 tests

| Test | What it checks |
|------|----------------|
| `fee_entrypoint_happy_path_transfers_expected_charge` | Correct charge deducted, gas paid |
| `fee_entrypoint_rejects_mismatched_fj_fee_amount` | Tampered amount breaks signature |
| `fee_entrypoint_rejects_expired_quote` | `valid_until` in the past rejected |
| `fee_entrypoint_rejects_overlong_quote_ttl` | TTL > 3600s rejected |
| `constructor_rejects_zero_operator` | Zero operator address rejected at construction |
| `fee_entrypoint_rejects_quote_bound_to_another_user` | Quote for user A unusable by user B |
| `fee_entrypoint_requires_fresh_transfer_authwit_each_call` | Authwit cannot be reused |

### `cold_start_entrypoint.nr` — 4 tests

| Test | What it checks |
|------|----------------|
| `cold_start_happy_path` | Tokens distributed correctly, gas paid |
| `cold_start_rejects_non_root_caller` | Reverts if not transaction root |
| `cold_start_quote_rejected_by_fee_entrypoint` | Domain separation prevents cross-use |
| `regular_quote_rejected_by_cold_start_entrypoint` | Standard quote invalid in cold-start |
