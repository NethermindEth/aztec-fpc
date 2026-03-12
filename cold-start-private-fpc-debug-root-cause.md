# Cold-Start Private FPC Debug: Root Cause Analysis

## Root Cause: Cross-Phase Private Notes in `fee_entrypoint`

The Aztec PXE's note discovery mechanism fails when a single transaction
creates private notes in **both** the setup (non-revertible) phase and the
app (revertible) phase.  The `fee_entrypoint` originally performed its token
transfer in the setup phase while the user's private app call created notes
in the app phase, causing ALL private notes from the transaction to become
permanently undiscoverable.

### Why cross-phase notes break discovery

The exact PXE-internal mechanism is not fully diagnosed (it may involve note
hash ordering, nonce computation, or tag-index collisions between phases),
but the empirical evidence is conclusive:

| Scenario | Setup-phase notes? | App-phase notes? | Result |
|---|---|---|---|
| `cold_start_entrypoint` (tx root, all transfers in app) | No | Yes | **Works** |
| FPC `fee_entrypoint` + public app call | Yes | No | **Works** |
| FPC `fee_entrypoint` + counter increment | Yes | No | **Works** |
| Sponsored FPC + private transfer | No | Yes | **Works** |
| FPC `fee_entrypoint` + private transfer (old) | **Yes** | **Yes** | **Fails** |
| FPC `fee_entrypoint` + private transfer (fixed) | No | Yes | **Works** |

The failure is **not** a PXE sync timing issue -- 20 retries over 60 seconds
produced identical results, with notes never appearing.

### What was observed

After the failing tx:
- User's balance dropped to 0 (old notes nullified, no replacement notes found)
- Operator's balance stayed unchanged (fee note not found)
- Recipient's balance stayed at 0 (transfer note not found)
- FeeJuice was charged (tx was mined and accepted)

## Applied Fix

Moved the token transfer in `fee_entrypoint` to AFTER `end_setup()`, placing
it in the revertible (app) phase.  This matches the pattern already used by
`cold_start_entrypoint`.

```noir
fn fee_entrypoint(...) {
    // ... validation, quote verification ...

    // Declare fee payer and close setup BEFORE the token transfer,
    // so all private notes land in the app phase.
    self.context.set_as_fee_payer();
    if enforce_setup_phase | !self.context.in_revertible_phase() {
        self.context.end_setup();
    }

    // Now in app phase -- token transfer creates discoverable notes.
    let fpc_address = self.context.this_address();
    unsafe { set_sender_for_tags(fpc_address) };

    Token::at(accepted_asset)
        .transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)
        .call(self.context);
}
```

### Security trade-off

Making the fee transfer revertible means that if the user's app call reverts,
the entire app phase (including the fee transfer) is rolled back.  The FPC
would pay gas but not receive the fee token.  However:

- The user signed the app payload, so a deliberate revert only harms the user.
- The protocol fee mechanism still compensates the sequencer.
- `cold_start_entrypoint` already uses this same pattern (app-phase transfers).

### Earlier hypothesis: missing `set_sender_for_tags`

The initial analysis identified that `fee_entrypoint` was missing
`set_sender_for_tags(fpc_address)`.  This was a real issue and was added as
part of the fix, but it was **necessary but not sufficient**.  Adding
`set_sender_for_tags` alone (while keeping the transfer in setup) did not
resolve the note discovery failure.

## Debugging timeline

1. Added `set_sender_for_tags(fpc_address)` to `fee_entrypoint` -- notes
   still undiscoverable.
2. Added retry/polling logic (20 retries x 3s) to balance queries -- notes
   never appeared, ruling out PXE sync timing.
3. Moved fee transfer to after `end_setup()` -- **all notes discovered on
   first query**.  Test passes.

## Files Modified

- `contracts/fpc/src/main.nr` -- moved token transfer after `end_setup()`,
  added `set_sender_for_tags`
- `scripts/cold-start/test-happy-path.ts` -- removed retry/polling logic
  (no longer needed)

## Files Referenced

- `contracts/fpc/src/main.nr` -- FPC contract with both entrypoints
- `scripts/cold-start/test-happy-path.ts` -- Phase 5 test (now passing)
- `services/attestation/test/fee-entrypoint-local-smoke.ts` -- passing smoke
  (public app call, no cross-phase notes)
- `vendor/aztec-standards/src/token_contract/src/main.nr` -- token private
  transfer logic
