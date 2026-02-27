# FPC Gate Count Profiling

This directory contains profiling scripts for two FPC (Fee Payment Contract) implementations:

| Script | Contract | Entry point(s) |
|---|---|---|
| `run.sh` | `FPC` (standard authwit-based) | `fee_entrypoint` |
| `run_credit_fpc.sh` | `CreditFPC` (Schnorr-quoted) | `pay_and_mint`, `pay_with_credit` |

`run.sh` also runs [aztec-benchmark](https://github.com/defi-wonderland/aztec-benchmark)
which produces structured JSON reports in `profiling/benchmarks/`.

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

# 2a. Profile standard FPC (fee_entrypoint)
./profiling/run.sh

# 2b. Profile CreditFPC (pay_and_mint + pay_with_credit)
./profiling/run_credit_fpc.sh

# 3. Tear down when done
./profiling/teardown.sh
```

### What each script does

| Script | When | What |
|---|---|---|
| `setup.sh` | Once | Installs `@aztec/*` npm packages + `aztec-benchmark` + `viem` (version from `.aztecrc`), starts `aztec start --local-network` in the background, waits for it to be ready |
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), deploys Token + FPC, profiles `fee_entrypoint` (console output), then runs `aztec-benchmark` (JSON output) |
| `run_credit_fpc.sh` | Every iteration | Compiles contracts, deploys Token + CreditFPC, profiles `pay_and_mint` and `pay_with_credit`, prints gate counts for both |
| `teardown.sh` | When done | Stops the network (if started by `setup.sh`), removes temp files |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://127.0.0.1:8080` | Aztec node endpoint (respected by all scripts) |
| `L1_RPC_URL` | `http://127.0.0.1:8545` | L1 (anvil) endpoint — needed by `run.sh` (benchmark step) and `run_credit_fpc.sh` for Fee Juice bridging |

## Iteration Workflow

```
setup.sh                  ← run once
  │
  ├─► edit contracts/fpc  ─► run.sh              ← standard FPC
  ├─► edit contracts/fpc  ─► run.sh
  │
  ├─► edit contracts/credit_fpc ─► run_credit_fpc.sh   ← CreditFPC
  ├─► edit contracts/credit_fpc ─► run_credit_fpc.sh
  │
teardown.sh               ← run when done
```

---

## Standard FPC (`run.sh`)

### Profiled Flow: `fee_entrypoint`

The standard FPC uses an authwit-based flow. The operator signs a quote authwit
authorising the FPC to consume it; the user signs a transfer authwit authorising
the FPC to pull tokens from their private balance. Both authwits are produced
off-chain and supplied to `fee_entrypoint` at call time.

Internal calls traced: `FPC:fee_entrypoint`, `Token:transfer_private_to_private`,
`SchnorrAccount:verify_private_authwit`, plus all kernel circuits.

### Console Output (Step 2 — custom profiler)

```
=== Gate Count Profile ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                                    54,352       54,352
private_kernel_init                                          46,811       101,163
FPC:fee_entrypoint                                              ...          ...
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                         xxx,xxx
```

### JSON Output (Step 3 — aztec-benchmark)

`run.sh` also invokes the
[aztec-benchmark](https://github.com/defi-wonderland/aztec-benchmark) CLI,
which produces a structured JSON report at `profiling/benchmarks/fpc.benchmark.json`.
The benchmark file lives at `profiling/benchmarks/fpc.benchmark.ts` and is
referenced from the root `Nargo.toml` under `[benchmark]`.

The JSON report contains:

| Field | Description |
|---|---|
| `summary` | Total gate counts keyed by function name |
| `results` | Detailed per-circuit gate counts for each profiled function |
| `gasSummary` | Total gas (DA + L2) keyed by function name |
| `provingTimeSummary` | Proving time in ms per function |
| `systemInfo` | Hardware metadata (CPU, memory, OS) |

The benchmark deploys a fresh Token + FPC, bridges Fee Juice from L1 so the
FPC can act as a real fee payer, and profiles a dummy app transaction
(`Token.transfer_private_to_private`) with the FPC as fee payment. This means
the profile includes the full execution trace: `FPC:fee_entrypoint`, the token
transfer, authwit verification, and all kernel circuits.

#### Running the benchmark standalone

```bash
# From the profiling/ directory (after setup.sh):
AZTEC_NODE_URL=http://127.0.0.1:8080 L1_RPC_URL=http://127.0.0.1:8545 \
  npx aztec-benchmark \
    --config ../Nargo.toml \
    --output-dir ./benchmarks
```

#### Future CI integration

The aztec-benchmark library ships reusable GitHub workflows for PR comparison
and baseline management. When ready, add:

```yaml
# .github/workflows/pr-benchmark.yml
uses: defi-wonderland/aztec-benchmark/.github/workflows/pr-benchmark.yml@v0

# .github/workflows/update-baseline.yml
uses: defi-wonderland/aztec-benchmark/.github/workflows/update-baseline.yml@v0
```

---

## CreditFPC (`run_credit_fpc.sh`)

### Profiled Flows

#### Flow 1: `pay_and_mint` (top-up + fee)

The user tops up their credit balance in the CreditFPC and pays the current
transaction's fee in a single call. This involves:

1. Inline Schnorr quote verification (operator signed the exchange rate)
2. Token transfer: user private → operator private
3. Balance mint: credit added to user's balance set
4. Max gas cost deduction from the minted balance
5. FPC declares itself fee payer, ends setup

Internal calls traced: `CreditFPC:pay_and_mint`, `Token:transfer_private_to_private`,
`SchnorrAccount:verify_private_authwit`, plus all kernel circuits.

#### Flow 2: `pay_with_credit` (balance-only)

The user pays the transaction fee from an existing credit balance — no token
transfer or quote verification needed. This involves:

1. Read sender from context
2. Max gas cost deduction from existing balance
3. FPC declares itself fee payer, ends setup

Internal calls traced: `CreditFPC:pay_with_credit`, plus all kernel circuits.

The label "balance-only" indicates that this flow operates purely on a
pre-existing credit balance with no external token interaction, making it the
cheaper path for repeat transactions.

### Output

```
=== Flow 1: pay_and_mint (top-up + fee) ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                                    54,352       54,352
private_kernel_init                                          46,811       101,163
CreditFPC:pay_and_mint                                          ...          ...
private_kernel_inner                                         ...          ...
SchnorrAccount:verify_private_authwit                        ...          ...
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                         xxx,xxx

=== Flow 2: pay_with_credit (balance-only) ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                                    54,352       54,352
private_kernel_init                                          46,811       101,163
CreditFPC:pay_with_credit                                    ...          ...
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                         xxx,xxx

=== Summary ===

pay_and_mint total:      xxx,xxx gates
pay_with_credit total:   xxx,xxx gates
```

### How `profile-gates-credit-fpc.mjs` Works

`profile-gates-credit-fpc.mjs` performs the deploy + profile flow in a single Node.js
process. The execution order matters — see "Issues & Solutions" below for why.

1. Connects to the Aztec node and starts an **embedded PXE** (clean slate each
   run via `createPXE(node, config)` from `@aztec/pxe/server`)
2. Registers deterministic test accounts (user = test0, operator = test1) as
   Schnorr accounts via `AccountManager`
3. Loads raw nargo artifacts from `target/` and normalises them via
   `loadContractArtifact()` so the SDK computes correct contract class IDs
4. Deploys `Token` and `CreditFPC(operator, operatorPubKey.x, operatorPubKey.y, tokenAddress)`
5. Registers both contracts as **senders** on the PXE
   (`pxe.registerSender(fpcAddress)`) so the PXE knows to compute tags for
   notes originating from these contracts
6. **Bridges Fee Juice** from L1 (anvil) to the CreditFPC so it can pay protocol
   fees when acting as fee payer on real transactions. Uses
   `L1FeeJuicePortalManager.bridgeTokensPublic()` followed by
   `FeeJuice.claim()` with a retry loop
7. Computes the token charge from current node min fees
   (`charge = ceil(creditMintAmount × rateNum / rateDen)`, 1:1 rate, 1.5× fee
   padding)
8. Mints tokens to the user's private balance
9. Signs the quote with the operator's Schnorr key — produces a 64-byte
   signature passed as args to `pay_and_mint`. The contract verifies the
   signature inline and pushes a nullifier to prevent replay.
10. **Sends a real `pay_and_mint` transaction** to establish the user's credit
    balance on-chain (must happen before any `.profile()` calls — see
    "Tag index pollution" below)
11. Sends a **follow-up dummy transaction** to force the archiver to advance
    past the `pay_and_mint` block (see "Archiver cache lag" below)
12. Polls `balance_of().simulate()` until the PXE discovers the credit notes
13. If credit is still not visible: falls back to `CreditFPC.dev_mint` which
    delivers credit via `ONCHAIN_UNCONSTRAINED` (see "ONCHAIN_CONSTRAINED note
    discovery" below)
14. **Profiles `pay_and_mint`**: fresh quote sig + transfer authwit with a
    distinct `valid_until` to avoid nullifier collision
15. **Profiles `pay_with_credit`**: purely reads the existing credit balance
16. Prints per-function gate-count tables for both flows plus a summary

### Issues & Solutions (CreditFPC)

Three non-obvious issues were encountered when profiling with an embedded PXE
connected to the Aztec sandbox via RPC.

#### 1. Archiver `getL2Tips()` cache lag

**Problem**: After a real transaction is mined, the node's archiver updates a
**cached promise** (`l2TipsCache`) asynchronously. The PXE's block synchronizer
calls `getL2Tips()` to decide which blocks to fetch. If the cache hasn't been
refreshed yet, the PXE stalls one block behind indefinitely.

**Fix**: After `pay_and_mint`, the script sends a follow-up dummy transaction.
The follow-up's `.send()` waits for its receipt, which requires the archiver to
have processed the `pay_and_mint` block first (blocks are sequential).

#### 2. Tag index pollution from `.profile()` calls

**Problem**: The PXE's `get_next_app_tag_as_sender` oracle **persistently
advances** the sender's tag index. The `.profile()` method executes the full
contract logic, so profiling advances indices as a side effect. If profiling
runs before the real transaction, the real tx uses advanced tag indices that the
PXE's scanner can't find.

**Fix**: The real `pay_and_mint` transaction is sent **before** any `.profile()`
calls.

#### 3. Quote nullifier collisions

**Problem**: `pay_and_mint` calls `context.push_nullifier(quote_hash)` to prevent
replay. Two calls with the same `valid_until` produce the same nullifier and the
second fails with "Existing nullifier".

**Fix**: Each call uses a distinct `valid_until` value (real send, dev_mint
fallback, and profiling each use `VALID_UNTIL`, `VALID_UNTIL + 5n`, `VALID_UNTIL + 10n`).

#### 4. ONCHAIN_CONSTRAINED note discovery

**Problem**: `pay_and_mint` delivers balance notes via `MessageDelivery.ONCHAIN_CONSTRAINED`
(partial note mechanism). The embedded PXE may not reliably discover these notes.

**Fix**: The contract includes a `dev_mint(amount)` function that delivers credit
via `MessageDelivery.ONCHAIN_UNCONSTRAINED`. The script falls back to this if
`balance_of` polling returns 0 after 10 attempts.

#### 5. Fee Juice bridging

**Problem**: CreditFPC needs Fee Juice bridged from L1 to L2 to act as a fee
payer. The claim can fail transiently while the L1-to-L2 message propagates.

**Fix**: Retry loop (up to 30 attempts, 3-second delays) with dummy txs to
trigger L2 block production.

---

## Version Pinning

The `package.json` in this directory pins `@aztec/*` packages to the version in
`.aztecrc`. When `.aztecrc` changes, `setup.sh` automatically detects the
mismatch and re-installs the correct versions. Just re-run `setup.sh` after
updating `.aztecrc`.

## Gotchas

| Issue | Fix |
|---|---|
| `Artifact does not match expected class id` | Delete `profiling/node_modules/` and re-run `setup.sh`. |
| `Failed to get a note 'self.is_some()'` in `SchnorrAccount.verify_private_authwit` | The script passes `additionalScopes: [operatorAddress]` so the PXE can decrypt the operator's signing key note. |
| `Balance too low or note insufficient` in `CreditFPC.pay_with_credit` | Credit notes from `pay_and_mint` were not discovered. Check `[diag]` output lines — `getL2Tips.proposed` should match `getBlockNumber`. |
| `Invalid tx: Existing nullifier` | A quote with the same `valid_until` was already consumed. Each invocation uses a distinct `valid_until`. |
| `Insufficient fee payer balance` | Fee Juice bridging failed. Check `fundFpcWithFeeJuice` completed and the CreditFPC has enough Fee Juice. |
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or re-run if the network died. |
| `quote expired 'anchor_ts <= valid_until'` | `VALID_UNTIL` is derived from the L2 block timestamp. Restart the sandbox if it has been running a long time. |
| Gas limit errors | The script uses separate gas settings for profiling (high limits, simulation only) and real sends (lower AVM-compatible limits). |
