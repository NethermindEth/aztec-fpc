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

1. Quote authwit verification (operator signed the exchange rate)
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

`profile-gates.mjs` performs the deploy + profile flow in a single Node.js process:

1. Connects to the Aztec node and starts an embedded PXE (clean slate each run)
2. Registers deterministic test accounts (user = test0, operator = test1) as
   Schnorr accounts via `AccountManager`
3. Loads raw nargo artifacts from `target/` and normalises them via
   `loadContractArtifact()` so the SDK computes correct contract class IDs
4. Deploys `Token(user, "TestToken", "TST", 18)` and `AltFPC(operator, tokenAddress)`
5. Bridges Fee Juice from L1 (anvil) to the AltFPC so it can pay protocol fees
   when acting as fee payer on real transactions (uses anvil default account 0)
6. Computes the token charge from current node min fees
   (`charge = ceil(creditMintAmount × rateNum / rateDen)`, 1:1 rate, 1.5× fee padding)
7. Mints tokens to the user's private balance
8. Creates a **quote authwit** — operator signs authorisation for the AltFPC to
   consume a fee quote bound to the user
9. **Profiles `pay_and_mint`**: creates a transfer authwit, builds a
   `PayAndMintPaymentMethod`, and profiles a dummy `Token.transfer_private_to_private
   (user→user, 1, nonce=0)` with the AltFPC as fee payer
10. **Establishes balance**: sends a real `pay_and_mint` transaction (with a
    separate transfer authwit nonce) so the user has a credit balance on-chain
11. **Profiles `pay_fee`**: builds a `PayFeePaymentMethod` and profiles another
    dummy token transfer with the AltFPC as fee payer — this time the fee payment
    only reads the user's existing credit balance
12. Prints per-function gate-count tables for both flows plus a summary

## Version Pinning

The `package.json` in this directory pins `@aztec/*` packages to the version in
`.aztecrc`. When `.aztecrc` changes, `setup.sh` automatically detects the mismatch
and re-installs the correct versions. Just re-run `setup.sh` after updating `.aztecrc`.

## Gotchas

| Issue | Fix |
|---|---|
| `Artifact does not match expected class id` | Both deploy and profile use the same `loadContractArtifact()` from the npm packages, so this should not happen. If it does, delete `profiling/node_modules/` and re-run `setup.sh`. |
| `Failed to get a note 'self.is_some()'` in `SchnorrAccount.verify_private_authwit` | The script passes `additionalScopes: [operatorAddress]` so the PXE can decrypt the operator's signing key note. |
| `Balance too low or note insufficient` in `AltFPC.pay_fee` | The intermediate `pay_and_mint` send step may have failed. Check that the credit mint amount is large enough to cover both flows (default: 3× max gas cost). |
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or if the network died, re-run setup. |
