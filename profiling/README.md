# AltFPC Gate Count Profiling

Profiles the gate count of `AltFPC.pay_and_mint` and `AltFPC.pay_fee` by
deploying Token + AltFPC on a local Aztec network and running the full
execution trace for each flow.

## Prerequisites

- **Aztec CLI** — version must match `.aztecrc` (currently `4.0.0-devnet.2-patch.1`)

```bash
VERSION=$(cat .aztecrc) bash -i <(curl -sL https://install.aztec.network/$(cat .aztecrc))
```

- **Node.js >=20** (usually bundled with the Aztec toolchain)
- **Foundry** (`anvil`) — needed by `aztec start --local-network` for the L1 node

## Quick Start

```bash
# 1. One-time setup: install SDK packages + start local network
./profiling/setup.sh

# 2. Profile (re-run after every contract change)
./profiling/run.sh

# 3. Tear down when done
./profiling/teardown.sh
```

### What each script does

| Script | When | What |
|---|---|---|
| `setup.sh` | Once | Installs `@aztec/*` npm packages (version from `.aztecrc`), starts `aztec start --local-network` in the background, waits for it to be ready |
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), deploys Token + AltFPC, profiles `pay_and_mint` and `pay_fee`, prints gate counts for both |
| `teardown.sh` | When done | Stops the network (if started by `setup.sh`), removes temp files |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://127.0.0.1:8080` | Aztec node endpoint (respected by all three scripts) |
| `L1_RPC_URL` | `http://127.0.0.1:8545` | L1 (anvil) endpoint, used to bridge Fee Juice to AltFPC |

## Iteration Workflow

```
setup.sh          ← run once
  │
  ├─► edit contracts/alt_fpc
  ├─► run.sh       ← compile + deploy + profile both flows
  ├─► edit contracts/alt_fpc
  ├─► run.sh
  ├─► ...
  │
teardown.sh        ← run when done
```

## Profiled Flows

### Flow 1: `pay_and_mint` (top-up + fee)

The user tops up their credit balance in the AltFPC and pays the current
transaction's fee in a single call. This involves:

1. Inline Schnorr quote verification (operator signed the exchange rate)
2. Token transfer: user private → operator private
3. Balance mint: credit added to user's balance set
4. Max gas cost deduction from the minted balance
5. FPC declares itself fee payer, ends setup

Internal calls traced: `AltFPC:pay_and_mint`, `Token:transfer_private_to_private`,
`SchnorrAccount:verify_private_authwit`, plus all kernel circuits.

### Flow 2: `pay_fee` (balance-only)

The user pays the transaction fee from an existing credit balance — no token
transfer or quote verification needed. This involves:

1. Read sender from context
2. Max gas cost deduction from existing balance
3. FPC declares itself fee payer, ends setup

Internal calls traced: `AltFPC:pay_fee`, plus all kernel circuits.

The label "balance-only" indicates that this flow operates purely on a
pre-existing credit balance with no external token interaction, making it the
cheaper path for repeat transactions.

## Output

The profiler prints two separate gate tables — one per flow — followed by a
summary. Each table includes every execution step (app functions + kernel
circuits) with its own gate count and a running subtotal.

```
=== Flow 1: pay_and_mint (top-up + fee) ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                                    54,352       54,352
private_kernel_init                                          46,811       101,163
AltFPC:pay_and_mint                                          ...          ...
private_kernel_inner                                         ...          ...
SchnorrAccount:verify_private_authwit                        ...          ...
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                         xxx,xxx

=== Flow 2: pay_fee (balance-only) ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                                    54,352       54,352
private_kernel_init                                          46,811       101,163
AltFPC:pay_fee                                               ...          ...
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                         xxx,xxx

=== Summary ===

pay_and_mint total: xxx,xxx gates
pay_fee total:      xxx,xxx gates
```

## How It Works

`profile-gates.mjs` performs the deploy + profile flow in a single Node.js
process. The execution order matters — see "Issues & Solutions" below for why.

1. Connects to the Aztec node and starts an **embedded PXE** (clean slate each
   run via `createPXE(node, config)` from `@aztec/pxe/server`)
2. Registers deterministic test accounts (user = test0, operator = test1) as
   Schnorr accounts via `AccountManager`
3. Loads raw nargo artifacts from `target/` and normalises them via
   `loadContractArtifact()` so the SDK computes correct contract class IDs
4. Deploys `Token(user, "TestToken", "TST", 18)` and
   `AltFPC(operator, operatorPubKey.x, operatorPubKey.y, tokenAddress)`
5. Registers both contracts as **senders** on the PXE
   (`pxe.registerSender(fpcAddress)`) so the PXE knows to compute tags for
   notes originating from these contracts
6. **Bridges Fee Juice** from L1 (anvil) to the AltFPC so it can pay protocol
   fees when acting as fee payer on real transactions. Uses
   `L1FeeJuicePortalManager.bridgeTokensPublic()` followed by
   `FeeJuice.claim()` with a retry loop
7. Computes the token charge from current node min fees
   (`charge = ceil(creditMintAmount × rateNum / rateDen)`, 1:1 rate, 1.5× fee
   padding)
8. Mints tokens to the user's private balance
9. Signs the quote with the operator's Schnorr key — produces a 64-byte
   signature passed as args to `pay_and_mint`. The contract verifies the
   signature inline and pushes a nullifier to prevent replay. No cross-circuit
   authwit call is needed for the quote.
10. **Sends a real `pay_and_mint` transaction** to establish the user's credit
    balance on-chain. This must happen before any `.profile()` calls (see
    "Tag index pollution" below)
11. Sends a **follow-up dummy transaction** to force the archiver to advance
    past the `pay_and_mint` block (see "Archiver cache lag" below)
12. Polls `balance_of().simulate()` until the PXE discovers the credit notes
13. If the credit balance is not yet visible in the PXE (see "ONCHAIN_CONSTRAINED
    note discovery" below): falls back to `AltFPC.dev_mint` which creates credit
    via `ONCHAIN_UNCONSTRAINED` delivery — always discoverable by the PXE
14. **Profiles `pay_and_mint`**: creates a fresh transfer authwit and Schnorr
    quote signature (with a higher `valid_until` to produce a distinct quote
    nullifier), mints additional tokens, and profiles a dummy
    `Token.transfer_private_to_private` with the AltFPC as fee payer
15. **Profiles `pay_fee`**: builds a `PayFeePaymentMethod` and profiles another
    dummy token transfer with the AltFPC as fee payer — this time the fee
    payment only reads the user's existing credit balance
16. Prints per-function gate-count tables for both flows plus a summary

## Issues & Solutions

Three non-obvious issues were encountered when profiling with an embedded PXE
connected to the Aztec sandbox via RPC. All three are worked around in the
script.

### 1. Archiver `getL2Tips()` cache lag

**Problem**: After a real transaction is mined, the node's archiver updates a
**cached promise** (`l2TipsCache`) asynchronously inside `addProposedBlocks()`.
The PXE's block synchronizer calls `getL2Tips()` to decide which blocks to
fetch. If the cache hasn't been refreshed yet, the PXE sees stale tips and
never fetches the latest block — even though `getBlockNumber()` (which queries
the store directly) returns the correct value. This causes the PXE to stall
one block behind indefinitely.

The official Aztec bench tests (`yarn-project/end-to-end/src/bench/client_flows`)
avoid this implicitly because they always send additional transactions after
the one they need notes from, which forces the archiver to process prior blocks.

**Fix**: After the real `pay_and_mint` tx, the script sends a follow-up dummy
transaction (`mint_to_private(user, 1n)`). The follow-up's `.send()` waits for
its receipt, which requires the archiver to have processed the `pay_and_mint`
block first (blocks are sequential). After the follow-up completes,
`getL2Tips()` is up to date and the PXE can sync.

### 2. Tag index pollution from `.profile()` calls

**Problem**: The PXE's `get_next_app_tag_as_sender` oracle **persistently
advances** the sender's tag index in its `senderTaggingStore`. The `.profile()`
method executes the full contract logic (including `deliver()` calls that emit
tagged logs), so profiling advances these indices as a side effect. If profiling
runs before the real transaction, the real tx uses advanced tag indices. The
PXE's recipient-side scanner then fails to match these tags to the on-chain
logs.

**Fix**: The real `pay_and_mint` transaction is sent **before** any `.profile()`
calls. This ensures the real tx uses clean tag indices (starting from 0), which
the PXE's scanner finds at the expected positions. Profiling runs afterward and
can safely advance indices without affecting note discovery.

### 3. Quote nullifier collisions

**Problem**: The `pay_and_mint` function computes a quote hash from its
parameters (including `valid_until`) and calls `context.push_nullifier(quote_hash)`
to prevent replay. If two calls use the same `valid_until` (and same rate, user,
etc.), they produce the same quote hash and thus the same nullifier. Attempting
the second call fails with "Existing nullifier".

This affects the script because both the real `pay_and_mint` send and the
subsequent profiling call each need a valid quote signature.

**Fix**: Each call uses a distinct `valid_until` value:
- Real send: `VALID_UNTIL` (derived from L2 block timestamp + 7200)
- Profiling: `VALID_UNTIL + 10n`

Since `valid_until` is part of the quote hash preimage, different values produce
different hashes and different nullifiers. The contract checks
`anchor_ts <= valid_until`, so a slightly later timestamp still passes
validation.

### 4. ONCHAIN_CONSTRAINED note discovery

**Problem**: The `pay_and_mint` function delivers balance notes via
`MessageDelivery.ONCHAIN_CONSTRAINED` (the partial note mechanism). With this
delivery, the note is committed in the private circuit and finalized by the
public `_refund` teardown function. The embedded PXE used in profiling may not
reliably discover these notes through its standard log scanner — the completed
partial note may not surface in `balance_of` even after several blocks.

**Fix**: The contract includes a `dev_mint(amount)` function that delivers
credit via `MessageDelivery.ONCHAIN_UNCONSTRAINED` (a public log directly
readable by the PXE). The script falls back to this if the primary polling
loop finds `balance_of == 0` after 10 attempts. `dev_mint` is a test-only
helper; it does not affect the gate counts of `pay_and_mint` or `pay_fee`
since it is only called to seed the balance for `pay_fee` profiling.

### 5. Fee Juice bridging

**Problem**: The AltFPC needs Fee Juice (the protocol's native fee token) to
act as a fee payer. Fee Juice must be bridged from L1 to L2 via
`L1FeeJuicePortalManager.bridgeTokensPublic()` followed by `FeeJuice.claim()`
on L2. The claim can fail transiently while the L1-to-L2 message is being
processed.

**Fix**: The script uses a retry loop (up to 30 attempts with 3-second delays)
for the claim. Between retries it sends dummy transactions to trigger L2 block
production and mines a small number of L1 blocks to nudge the archiver.

## Version Pinning

The `package.json` in this directory pins `@aztec/*` packages to the version in
`.aztecrc`. When `.aztecrc` changes, `setup.sh` automatically detects the
mismatch and re-installs the correct versions. Just re-run `setup.sh` after
updating `.aztecrc`.

## Gotchas

| Issue | Fix |
|---|---|
| `Artifact does not match expected class id` | Both deploy and profile use the same `loadContractArtifact()` from the npm packages, so this should not happen. If it does, delete `profiling/node_modules/` and re-run `setup.sh`. |
| `Failed to get a note 'self.is_some()'` in `SchnorrAccount.verify_private_authwit` | The script passes `additionalScopes: [operatorAddress]` so the PXE can decrypt the operator's signing key note. |
| `Balance too low or note insufficient` in `AltFPC.pay_fee` | The credit notes from `pay_and_mint` were not discovered by the PXE. Check the diagnostic `[diag]` lines in the output — `getL2Tips.proposed` should match `getBlockNumber` and `PXE block` should be at or past the block containing the `pay_and_mint` tx. If not, the archiver cache lag workaround (follow-up tx) may have failed. |
| `Invalid tx: Existing nullifier` | A quote with the same `valid_until` was already consumed. Each `pay_and_mint` invocation (real send, profiling) uses a distinct `valid_until` value. |
| `Insufficient fee payer balance` | Fee Juice bridging may have failed. Check that `fundFpcWithFeeJuice` completed successfully and that the AltFPC has enough Fee Juice (the script bridges 10^21). |
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or if the network died, re-run setup. |
| `quote expired 'anchor_ts <= valid_until'` | `VALID_UNTIL` is derived from the L2 block timestamp. If the sandbox has been running a long time, restart it so the block timestamp is fresh. |
| Gas limit errors (`Gas limit is higher than the amount of gas that the AVM can process`) | The script uses separate gas settings for profiling (high limits, simulation only) and real sends (lower limits, AVM-compatible). If you change gas constants, ensure `SEND_L2_GAS` stays within the AVM's processing capacity. |
