# fee_entrypoint Revertibility Risk

## Problem

The fix for the cross-phase private note discovery bug (see
`cold-start-private-fpc-debug-root-cause.md`) moved the fee token transfer in
`fee_entrypoint` from the setup (non-revertible) phase to the app (revertible)
phase. This introduced a griefing vector.

## Attack

The tx structure for `fee_entrypoint` is:

```
Account entrypoint (tx root)
+-- Fee payload: FPC.fee_entrypoint(...)    -- setup + app phase
+-- App payload: user's call(s)             -- app phase
```

Since the account entrypoint is the tx root (not the FPC), the user controls
the app payload. An attacker can:

1. Hold some private tokens and request a signed quote from the operator.
2. Build a tx where `fee_entrypoint` runs normally (quote verified in setup,
   token transfer in app phase) and the app payload contains a call that
   deliberately reverts in public execution.
3. The tx is mined: setup succeeds (FPC declared as fee payer), but the entire
   app phase reverts -- including the fee token transfer.
4. Result: the FPC paid FeeJuice gas but received zero fee tokens. The
   attacker's tokens are returned because the transfer was rolled back.

The attacker's cost per grief is effectively zero. They need tokens to obtain a
quote, but those tokens are never spent.

This is fundamentally different from `cold_start_entrypoint`, where the FPC is
the tx root (`assert(self.context.maybe_msg_sender().is_none())`). There, no
external app calls exist, so nothing can cause an app-phase revert that the FPC
did not author itself.

## Aztec Transaction Phases

Reference: https://docs.aztec.network/developers/docs/foundational-topics/advanced/circuits/public_execution

| Phase | Revertible? | Runs when app reverts? |
|---|---|---|
| Setup | No | N/A |
| App Logic | Yes | N/A |
| Teardown | **Yes** | **Yes** |

Key properties:

- **Setup** is non-revertible. `set_as_fee_payer()` and quote validation happen
  here and are permanent once the tx is mined.
- **App Logic** is revertible. If it fails, all app-phase side effects (including
  our fee token transfer after the fix) are rolled back.
- **Teardown** is revertible but runs independently of app logic. If the app
  phase reverts, teardown still executes. If teardown itself fails, only
  teardown's side effects are rolled back (the tx is still mined with setup
  effects).

This means teardown is **not** non-revertible -- if the teardown function itself
fails, its effects are rolled back. However, an attacker cannot cause teardown
to revert by reverting the app phase. Teardown reverts only if its own execution
fails.

## Mitigation Options

Production deadline: 8 days (2026-03-20).

| # | Approach | Delivery Risk | Security Risk | Technical Risk | Privacy Risk | Notes |
|---|---|---|---|---|---|---|
| **3** | Rate limit + accept | **None** -- already shipped | **High** -- zero-cost griefing drains FPC FeeJuice. Rate limiting slows but does not stop a determined attacker. Operator eats the loss. | **None** -- no code changes | **None** | Ship on time, eat the security risk. Add operator-side monitoring (alert on FeeJuice drain without corresponding fee token income). |
| **4** | Public fee transfer | **Low** -- straightforward, ~2-3 days impl + test | **Low** -- public state not rolled back by app-phase revert | **Low** -- well-understood pattern, standard Aztec FPC examples use public transfers | **Medium** -- fee amount and operator address visible on-chain. User's app call stays private. | Solid production answer, trades some privacy for security. |
| **2** | Teardown phase | **Medium-High** -- unknown if private execution works in teardown. If it doesn't, discovered late, scramble to pivot. Need teardown function, `teardownGasLimits` wiring, full E2E test. Tight for 8 days. | **Low** -- attacker cannot control teardown execution. Residual risk only if teardown itself fails (FPC bug or insufficient balance). | **High** -- uncharted territory for this codebase. No existing teardown usage. Private-in-teardown may not be supported. | **None** -- stays fully private | Best outcome if it works, but high chance of discovering blockers mid-sprint. |
| **1** | Revert fix + wait for PXE | **Blocked** -- reintroduces Phase 5 note discovery bug | N/A | N/A | N/A | Not an option for 8 days. |

## Recommended Path (8-day deadline)

1. **Ship option 3 now** -- current state. Correct the contract comment and docs
   to be honest about the griefing risk. Add operator-side FeeJuice drain
   monitoring.
2. **Spike option 2 immediately (days 1-2)** -- investigate whether private
   execution works in teardown on aztec 4.1.0-rc.2. If yes, implement and ship
   before deadline. If no, pivot to option 4 by day 3.
3. **Option 4 is the safety net (days 3-8)** -- if option 2 hits a wall, switch
   to public fee transfer. Deliverable in the remaining 5 days.
4. **Option 1 is not viable** for this deadline.

## Files Referenced

- `contracts/fpc/src/main.nr` -- `fee_entrypoint` (revertible transfer) and
  `cold_start_entrypoint` (tx-root pattern, not affected)
- `cold-start-private-fpc-debug-root-cause.md` -- original bug and fix
- `services/attestation/src/server.ts` -- quote rate limiting (partial mitigation)
