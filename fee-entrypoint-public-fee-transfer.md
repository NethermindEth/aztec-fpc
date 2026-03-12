# fee_entrypoint: Public Fee Transfer (Option 4)

## Context

`fee-entrypoint-revertibility-risk.md` documented a griefing vector: when the
FPC's `fee_entrypoint` collected fees via a private token transfer in the
revertible app phase, an attacker could craft a tx whose app payload reverts in
public execution, rolling back the fee transfer while the FPC still paid
FeeJuice gas. The attacker's tokens were never spent.

Option 4 -- "public fee transfer" -- was selected as the production fix. This
document records what was changed, why, and what trade-offs were accepted.

## Summary

All fee collection in `fee_entrypoint` now uses
`Token.transfer_public_to_public` instead of
`Token.transfer_private_to_private`. Public state changes are committed
independently of the app phase's revert status, so the FPC always receives the
fee tokens when the tx is mined.

`cold_start_entrypoint` is **not affected** -- it is the tx root
(`msg_sender = None`), so no external app calls can cause an app-phase revert.

## Trade-offs

| Property | Before (private transfer) | After (public transfer) |
|---|---|---|
| Griefing resistance | Vulnerable -- zero-cost rollback of fee transfer | Mitigated -- public state survives app-phase reverts |
| Privacy | Fee amount and parties hidden | Fee amount, user address, and operator address visible on-chain |
| User funding | User needs private token notes | User needs public token balance |
| Authwit type | Private (`AuthWitness`) | Public (`AuthRegistry.set_authorized()`) |

The privacy cost is scoped to the fee leg only. The user's app call (e.g.
private transfer, counter increment) remains fully private.

## Contract Changes

### `contracts/fpc/src/main.nr`

1. **New public function `collect_public_fee_internal`** (`#[external("public")]
   #[only_self]`) -- enqueued by `fee_entrypoint` to execute the public token
   transfer. The `#[only_self]` guard ensures only the FPC itself can call it.

2. **`fee_entrypoint`** -- removed the private
   `transfer_private_to_private` call and the `set_sender_for_tags` oracle hint.
   Now enqueues `collect_public_fee_internal` after closing the setup phase.

3. **Import `only_self` macro** for the new function.

```noir
#[external("public")]
#[only_self]
fn collect_public_fee_internal(
    accepted_asset: AztecAddress,
    from: AztecAddress,
    to: AztecAddress,
    amount: u128,
    authwit_nonce: Field,
) {
    Token::at(accepted_asset)
        .transfer_public_to_public(from, to, amount, authwit_nonce)
        .call(self.context);
}
```

`fee_entrypoint` calls it via `self.enqueue_self.collect_public_fee_internal(...)`.

Because `Token.transfer_public_to_public` is itself `#[internal("public")]`, it
does **not** create a new call frame -- it shares the calling function's context
(`msg_sender`, `selector`, `args_hash`). This means the authwit `caller` is the
FPC address, matching what `SetPublicAuthwitContractInteraction` writes.

### `contracts/fpc/src/test/fee_entrypoint.nr`

All test cases updated:

| Change | Reason |
|---|---|
| `mint_to_private` -> `mint_to_public` | User needs public balance, not private notes |
| `transfer_private_to_private` -> `transfer_public_to_public` | Matches new contract logic |
| `add_private_authwit_from_call` -> `add_public_authwit_from_call` | Public authwits go through AuthRegistry |
| `private_balance` -> `public_balance` assertions | Verify public state changes |
| `should_fail_with "Unknown auth witness..."` -> `should_fail_with "unauthorized"` | Public authwit validation returns "unauthorized" |

### `contracts/fpc/src/test/utils.nr`

Added `public_balance` helper that calls `Token.balance_of_public` via
`env.view_public()`.

## TypeScript Changes

### Authwit Pattern (all scripts)

Every script that calls `fee_entrypoint` was changed from:

```typescript
// BEFORE: private authwit (transient AuthWitness)
const transferCall = await token.methods
  .transfer_private_to_private(user, operator, amount, nonce)
  .getFunctionCall();
const authwit = await wallet.createAuthWit(user, {
  caller: fpcAddress,
  call: transferCall,
});
// ...
new ExecutionPayload([feeEntrypointCall], [authwit], [], [], fpcAddress)
```

to:

```typescript
// AFTER: public authwit (AuthRegistry.set_authorized)
const transferCall = await token.methods
  .transfer_public_to_public(user, operator, amount, nonce)
  .getFunctionCall();
const intent: CallIntent = { caller: fpcAddress, call: transferCall };
const setAuthInteraction = await SetPublicAuthwitContractInteraction.create(
  wallet, user, intent, true,
);
const setAuthPayload = await setAuthInteraction.request();
// ...
new ExecutionPayload(
  [...setAuthPayload.calls, feeEntrypointCall],
  [],    // no private authwits
  [],
  [],
  fpcAddress,
)
```

The `set_authorized` calls are prepended to the fee payload so the AuthRegistry
entry exists before `collect_public_fee_internal` attempts the transfer.

### User Funding

All minting changed from `mint_to_private` to `mint_to_public` for the fee
portion. Scripts that need both private tokens (for app calls) and public tokens
(for fee payment) now fund them separately.

### Balance Assertions

All post-tx balance checks changed from `balance_of_private` to
`balance_of_public` for the fee-related assertions. Where scripts previously
tracked a single `operatorReceived` counter, they now track
`operatorPrivateReceived` and `operatorPublicReceived` separately.

### Files Modified

| File | Summary |
|---|---|
| `scripts/manual-fpc-sponsored-user-tx.ts` | Core manual test script |
| `scripts/manual-fpc-sponsored-user-tx-devnet.ts` | Devnet variant |
| `scripts/manual-fpc-sponsored-user-tx-devnet-attestation-v2.ts` | Devnet attestation variant |
| `scripts/cold-start/test-happy-path.ts` | Compose cold-start E2E (also added Phase 2 public fee budget seeding) |
| `scripts/cold-start/setup.ts` | Updated context type (`counter` -> `bridge`) |
| `scripts/contract/devnet-postdeploy-smoke.ts` | Post-deploy smoke test |
| `scripts/services/fpc-full-lifecycle-e2e.ts` | Full lifecycle E2E |
| `scripts/services/fpc-services-smoke.ts` | Services smoke test |
| `scripts/chaos/fpc-chaos-test.ts` | Chaos/load test |
| `services/attestation/test/fee-entrypoint-local-smoke.ts` | Local attestation smoke |

### Cold-Start Test Flow Change

`test-happy-path.ts` was restructured beyond the authwit fix:

- **Removed** the counter-increment phase (Phase 3 in the old flow) -- it was
  not relevant to the fee transfer validation.
- **Added** a `transfer_private_to_public` step in Phase 2 to seed the user's
  public fee budget after account deployment.
- **Phase numbering** changed from 5 phases to 4:
  1. Cold-start (claim + private fee)
  2. Deploy account via SponsoredFPC + seed public fee budget
  3. Sponsored private transfer
  4. FPC `fee_entrypoint` transfer (now public)

## What Did Not Change

- **`cold_start_entrypoint`** -- still uses private transfers. It is the tx root
  so the griefing vector does not apply.
- **Quote signing and verification** -- the Schnorr quote mechanism is unchanged.
  The quote hash does not include transfer type information.
- **Attestation service** -- no server-side changes. Quote responses are the same
  format.
- **Gas settings and limits** -- unchanged.

## Verification

- All 11 Noir contract tests pass (`fee_entrypoint` + `cold_start_entrypoint`).
- TypeScript typecheck passes across all workspaces.
- Compose cold-start smoke test passes end-to-end with freshly rebuilt Docker
  images (no volume mount workarounds):
  - Phase 1 (cold-start): PASS
  - Phase 2 (deploy + public fee budget): PASS
  - Phase 3 (sponsored transfer): PASS
  - Phase 4 (FPC fee_entrypoint): PASS
  - Negative test (claim < fee): PASS
