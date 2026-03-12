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

## Mitigation Options

| # | Approach | Feasibility | Work | Production Readiness | Notes |
|---|---|---|---|---|---|
| **1** | Move transfer back to setup + wait for PXE fix | Low | Low code, unknown wait | Blocked | Reintroduces the cross-phase note discovery bug. Depends on Aztec core team timeline -- could be weeks or months. |
| **2** | Teardown phase for fee collection | Medium | Medium | Good if available | Needs investigation -- does the Aztec protocol support teardown gas limits and non-revertible teardown execution in the current version? `GasSettings` has `teardownGasLimits` (set to 0 in our code), suggesting the mechanism exists. Best long-term answer if it works. |
| **3** | Rate limiting + accept risk | High | Minimal | Acceptable for devnet/testnet, risky for mainnet | Already partially in place (attestation server rate limits). Grief cost to attacker is zero per tx, so rate limiting only slows them down. FPC operator absorbs the loss. Fine for now, not a mainnet answer. |
| **4** | Public transfer for the fee | High | Medium | Good | Fee payment goes through public state (no cross-phase note issue). The fee amount becomes publicly visible, which is a privacy regression -- observers can see what the FPC charges. But the user's app call stays private. |

## Recommended Path

1. **Option 3 now** -- current state, just correct the contract comment and docs
   to be honest about the risk.
2. **Option 2 next** -- investigate teardown phase feasibility on aztec
   4.1.0-rc.2; if it works, it is the clean solution (non-revertible fee
   collection without cross-phase notes).
3. **Option 4 as fallback** -- if teardown does not work, public fee transfer is
   the pragmatic production answer at the cost of fee amount privacy.
4. **Option 1 last resort** -- only if Aztec ships a PXE fix for cross-phase
   note discovery soon.

## Files Referenced

- `contracts/fpc/src/main.nr` -- `fee_entrypoint` (revertible transfer) and
  `cold_start_entrypoint` (tx-root pattern, not affected)
- `cold-start-private-fpc-debug-root-cause.md` -- original bug and fix
- `services/attestation/src/server.ts` -- quote rate limiting (partial mitigation)
