# Optimization 2: Pack Immutable Config Into a Single PublicImmutable Slot

## Problem

`pay_and_mint` previously read four separate `PublicImmutable` storage fields:

```noir
let operator          = self.storage.operator.read();
let operator_pubkey_x = self.storage.operator_pubkey_x.read();
let operator_pubkey_y = self.storage.operator_pubkey_y.read();
let accepted_asset    = self.storage.accepted_asset.read();
```

Each `PublicImmutable::read()` call in a private function generates a **separate Merkle membership proof** against the public data tree (one sibling path per slot). With four fields that is four independent proofs — four sets of sibling-path constraints.

## Solution

Define a single packed struct and store all four fields under one storage slot:

```noir
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Config {
    operator: AztecAddress,
    operator_pubkey_x: Field,
    operator_pubkey_y: Field,
    accepted_asset: AztecAddress,
}

#[storage]
struct Storage<Context> {
    config: PublicImmutable<Config, Context>,
    balances: Owned<BalanceSet<Context>, Context>,
}
```

`pay_and_mint` now does a single read:

```noir
let config = self.storage.config.read();
```

The constructor signature is **unchanged** — it still accepts the four values as individual parameters and packs them on initialization:

```noir
self.storage.config.initialize(Config { operator, operator_pubkey_x, operator_pubkey_y, accepted_asset });
```

## Expected Gate Reduction

| Site | Before | After |
|------|--------|-------|
| Public data tree membership proofs | 4 | 1 |
| Storage slots touched in `pay_and_mint` private circuit | 4 | 1 |

Replacing 3 Merkle proofs with 1 reduces the gate count in the `pay_and_mint` private circuit by roughly **3 × (tree depth × ~6 gates/level)**. For a tree of depth 40 this is on the order of ~720 gates saved, though the exact number depends on the Aztec kernel version and tree depth in use.

## Trade-offs

- **No functional change**: constructor ABI, `pay_and_mint` behaviour, and test suite are all identical.
- **Slightly larger single slot**: `Config` serialises to 4 field elements; the slot stores 4 consecutive leaf entries. Reading one slot still fetches all 4 values at the cost of a single sibling path.
- **Negligible overhead**: packing/unpacking is pure witness assignment with no extra constraints relative to reading individual fields.
