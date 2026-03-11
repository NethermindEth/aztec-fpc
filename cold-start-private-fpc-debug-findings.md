# Cold-Start Private FPC Debug Findings

## Current State

`bun run smoke:cold-start:compose` no longer fails in compose/bootstrap/topup. The stack now gets all the way through:

- cold-start claim via [`scripts/cold-start/test-happy-path.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/test-happy-path.ts)
- user deploy via FPC
- counter increment via FPC
- sponsored private transfer

The remaining failure is only the last phase in [`scripts/cold-start/test-happy-path.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/test-happy-path.ts): a private app call `token.transfer_private_to_private(user, recipient, ...)` sent with FPC fee payment.

## What Was Verified

Earlier issues are fixed:

- `bootstrap-topup-autoclaim` launcher wiring in [`docker-compose.yaml`](/home/ametel/source/aztec-fpc/docker-compose.yaml)
- `topup` publication check path in [`services/topup/src/autoclaim.ts`](/home/ametel/source/aztec-fpc/services/topup/src/autoclaim.ts)
- DA gas limit too high for local-network in [`scripts/cold-start/cli.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/cli.ts)
- wrapped numeric return handling in [`scripts/cold-start/test-happy-path.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/test-happy-path.ts)

The previous default `claimAmount=10000000000000` was too low for the full happy path once current FPC quote sizes are applied, so the default was raised to `20000000000000` in:

- [`scripts/cold-start/cli.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/cli.ts)
- [`scripts/cold-start/cold-start-smoke.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/cold-start-smoke.ts)

That fixed the underfunding failure. After that, the final private phase still fails, but now with enough funds and after settlement.

## Most Important Finding

The last private FPC-paid transfer settles and burns FeeJuice, but the private token post-state is wrong.

From the last verified run:

- `final private transfer tx_fee_juice=7532640000000`
- `final private transfer balances user=0 operator=2275396000000 recipient=0`
- `final private transfer deltas user=17723604000000 operator=0 recipient=0`

This means:

- the tx is accepted and mined
- FeeJuice payment happens
- the sender’s private balance is fully consumed
- neither the operator fee note nor the recipient note nor the sender change note is visible afterward

So this is not a compose problem, not a topup problem, and not just low balance.

## Contracts To Debug

### 1. `contracts/fpc`

Primary suspect:

- [`contracts/fpc/src/main.nr`](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr)

Relevant entrypoint:

- [`fee_entrypoint`](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr#L79)

Reason:

- the failing shape is specifically `fee_entrypoint(...)` in setup phase plus a later private app call in the same tx
- `fee_entrypoint` performs a private token transfer to the operator, then calls `set_as_fee_payer()` and `end_setup()`

### 2. `vendor/aztec-standards/src/token_contract`

Secondary suspect:

- [`vendor/aztec-standards/src/token_contract/src/main.nr`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr)

Relevant functions:

- [`transfer_private_to_private`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L274)
- [`_subtract_balance`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L677)
- [`_validate_from_private`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L798)

Reason:

- this is where the actual private note movement occurs
- the failing tx appears to consume sender balance without surfacing any expected private outputs

### 3. `contracts/token_bridge`

Low priority:

- [`contracts/token_bridge`](/home/ametel/source/aztec-fpc/contracts/token_bridge)

Reason:

- the bridge is only involved in the initial cold-start funding path
- cold-start funding and FPC-side private redistribution already work
- the bridge is not in the final failing path

## Why `token_bridge` Is Probably Not The Problem

Cold-start distribution through FPC already proves:

- bridge claim works
- FPC can receive claimed private tokens
- FPC can privately transfer to user and operator in [`cold_start_entrypoint`](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr#L141)

So the bridge is very unlikely to be the source of the final-phase failure.

## Strongest Current Hypothesis

The strongest current hypothesis is not “private transfer is impossible”, but:

- the combination of `FPC.fee_entrypoint(...)` in setup phase plus a later private app call is breaking private note discoverability or private note output handling in that tx shape

Why this is the best hypothesis:

- cold-start private transfers from FPC work
- sponsored private transfer without FPC fee_entrypoint works
- public app call plus FPC fee_entrypoint works elsewhere in the repo
- the final tx consumes the sender’s private balance, but all expected output notes appear absent from balance queries

That pattern looks more like “new private notes are not being surfaced/discovered” than a simple arithmetic bug.

## Contract Call Paths

### FPC fee path

In [`contracts/fpc/src/main.nr`](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr#L79), `fee_entrypoint`:

1. validates quote
2. validates quoted max fee
3. calls:
   - `Token::at(accepted_asset).transfer_private_to_private(sender, config.operator, aa_payment_amount, authwit_nonce)`
4. calls:
   - `self.context.set_as_fee_payer()`
   - `self.context.end_setup()`

### Cold-start path that already works

In [`contracts/fpc/src/main.nr`](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr#L141), `cold_start_entrypoint`:

1. claims private tokens into FPC
2. privately transfers from FPC to user
3. privately transfers from FPC to operator

This proves that private token redistribution can work in this repository.

### Token private transfer path

In [`vendor/aztec-standards/src/token_contract/src/main.nr`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L274), `transfer_private_to_private`:

1. calls `_validate_from_private`
2. calls `_decrease_private_balance`
3. calls `_increase_private_balance(to, amount)`

The recursive subtraction path is in:

- [`_subtract_balance`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L677)

The auth validation path is in:

- [`_validate_from_private`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L798)

## Smoke Failure Shape

The failing final phase is here:

- [`scripts/cold-start/test-happy-path.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/test-happy-path.ts#L567)

It currently:

1. builds FPC fee payment metadata
2. sends:
   - `token.transfer_private_to_private(user, recipient, transferAmount, 0)`
   - with `fee: transferFee`
3. reads post-tx private balances for user/operator/recipient

Observed behavior:

- user private balance drops to zero
- operator private balance does not increase
- recipient private balance does not increase
- FeeJuice is charged

## Recommended Next Debug Steps

### 1. Create a minimal reproducer outside cold-start

Build a focused TS integration test or script that does only:

1. mint private tokens to user
2. build FPC payment method
3. send `token.transfer_private_to_private(user, recipient, x, nonce)` with FPC fee
4. inspect post-tx private balances and note discovery

This removes bridge/cold-start complexity from the failure.

### 2. Compare three app-call shapes with the same fee path

Run the same user/token/quote setup with only the app call changed:

- `transfer_public_to_public` with FPC fee
- `counter.increment` with FPC fee
- `transfer_private_to_private` with FPC fee

If only the third fails, that isolates the bug to “private app call after fee_entrypoint”.

### 3. Inspect note discovery, not just balances

After the failing tx, inspect decrypted/private logs or note inventory for:

- user change note
- operator fee note
- recipient note

Interpretation:

- if notes exist but balances read `0`, the bug is likely PXE discovery/tagging
- if notes do not exist at all, the bug is likely in FPC/token execution semantics

### 4. Add a dedicated integration test near fee-entrypoint coverage

Best candidate:

- [`services/attestation/test/fee-entrypoint-local-smoke.ts`](/home/ametel/source/aztec-fpc/services/attestation/test/fee-entrypoint-local-smoke.ts)

That suite already exercises the FPC fee path and is a better home for a targeted regression test than the broader cold-start smoke.

### 5. Debug `contracts/fpc` first if the minimal reproducer still fails

Focus on:

- [`fee_entrypoint`](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr#L79)
- interaction of `set_as_fee_payer()` and `end_setup()`
- whether private token transfer to operator inside setup phase needs additional handling for later private-note discovery

### 6. Debug `token_contract` second

Focus on:

- whether `transfer_private_to_private` outputs are emitted in this call context
- whether sender change note and recipient/operator notes are created but undiscoverable
- whether nested private transfer behavior differs when called once from FPC and once from the user in the same tx

### 7. Check nonce handling as a targeted hypothesis

The final app transfer currently uses `_nonce = 0` in:

- [`scripts/cold-start/test-happy-path.ts`](/home/ametel/source/aztec-fpc/scripts/cold-start/test-happy-path.ts#L599)

Even though token auth validation goes through [`_validate_from_private`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract/src/main.nr#L798), it is still worth testing whether using a fresh `Fr.random()` for the app transfer nonce changes behavior in this tx shape.

This is not the leading hypothesis, but it is cheap to test.

## Bottom Line

Debug priority should be:

1. [`contracts/fpc`](/home/ametel/source/aztec-fpc/contracts/fpc)
2. [`vendor/aztec-standards/src/token_contract`](/home/ametel/source/aztec-fpc/vendor/aztec-standards/src/token_contract)
3. [`contracts/token_bridge`](/home/ametel/source/aztec-fpc/contracts/token_bridge)

The remaining bug is a private FPC-paid transfer behavior issue, not a compose/topup/bootstrap issue.
