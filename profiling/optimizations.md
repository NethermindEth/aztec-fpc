# FPC Gate Count Optimizations

## Current Baseline

Total to user's app start: **~583k gates**

```
Step                                    Own gates   kernel_inner   Notes
──────────────────────────────────────────────────────────────────────────
Base (entrypoint + kernel_init)         101,163     —              Unavoidable
A. FPC:fee_entrypoint                    14,498     101,237        Storage reads, charge math
B. verify_private_authwit (quote)        14,328     101,237        Operator's account contract
C. Token:transfer_private_to_private     34,237     101,237        Note nullify + create (inlined)
D. verify_private_authwit (transfer)     14,328     101,237        User's account contract
```

84% of FPC overhead is `private_kernel_inner` (~101k per nested call).
Each nested private call costs ~115k (function + kernel). Reducing call
count is the only lever that moves the needle significantly.

| Nested calls from FPC | Estimated total |
|------------------------|-----------------|
| 4 (current)            | ~583k           |
| 3                      | ~468k           |
| 2                      | ~365k           |

---

## Optimization 1 — Inline Schnorr Verification

**Eliminates call B. Saves ~101k. No token contract changes.**

Replace `assert_inner_hash_valid_authwit` (which static-calls the
operator's account contract for Schnorr verification) with a direct
`schnorr::verify_signature` inside `fee_entrypoint`.

- Store operator signing public key `(x, y)` in `PublicImmutable` storage
  (instead of just the address).
- Verify the quote signature inline (~14k gates).
- Push a nullifier to prevent replay.

Adds ~14k to `fee_entrypoint`, removes 14k + 101k (call B + its kernel).

**New total: ~482k (3 calls)**

---

## Optimization 2 — Eliminate Transfer Authwit

**Eliminates call D. Saves another ~101k. Requires one of the options below.**

When the FPC calls `Token.transfer_private_to_private(from=user, ...)`,
the token sees `from != msg_sender` and triggers a `verify_private_authwit`
call on the user's account contract — adding 14k + 101k gates.

### Option 2A — Custom token function ("trusted caller")

Add a `transfer_from_approved` function to the token that skips authwit
when `msg_sender` is a pre-approved FPC address. Requires extending the
Wonderland standard token contract.

### Option 2B — Restructure tx flow (user calls transfer directly)

User's account entrypoint dispatches two setup-phase calls:

1. `Token.transfer_private_to_private(from=self, to=operator, charge)` —
   `from == msg_sender`, no authwit needed.
2. `FPC.fee_entrypoint_lite(...)` — only verifies quote + sets fee payer.

Weaker atomicity: the FPC cannot verify the transfer happened in private.
Operator relies on note monitoring and can gatekeep via attestation service.

**Optimization 1 + either 2A or 2B → ~365k (2 calls)**

---

## Why ~365k Is Likely the Floor

Any transfer from a user's private balance requires two things that each
need their own circuit:

1. **Calling the token contract** to nullify notes — the FPC cannot
   manipulate another contract's notes (note hashes are siloed by
   contract address).
2. **Authwit verification** when a third party (the FPC) initiates the
   transfer — `from != msg_sender` triggers a call to the user's account
   contract.

Eliminating #1 is impossible with standard tokens. Eliminating #2 is
what Optimization 2 targets. With both Opt 1 and Opt 2 applied, two
nested calls remain (the FPC entrypoint + the token transfer), giving
~365k.

---

## Compatibility with Wonderland Standard Token

Options 1 and 2B work with the unmodified Wonderland `token_contract`.
Option 2A requires adding a function to the token (or a thin wrapper).

---

## Recommended Path

| Phase | What | Gate target | Token changes |
|-------|------|-------------|---------------|
| **Now** | Optimization 1 (inline Schnorr) | ~482k | None |
| **Next** | + Option 2A or 2B | ~365k | 2A: extend token / 2B: none |
