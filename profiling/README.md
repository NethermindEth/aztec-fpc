# FPC Gate Count Profiling

This directory contains profiling scripts for the FPC (Fee Payment Contract):

| Script | Contract | Entry point(s) |
|---|---|---|
| `run.sh` | `FPC` (standard authwit-based) | `fee_entrypoint` |

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

# 2. Profile standard FPC (fee_entrypoint)
./profiling/run.sh

# 3. Tear down when done
./profiling/teardown.sh
```

### What each script does

| Script | When | What |
|---|---|---|
| `setup.sh` | Once | Installs `@aztec/*` npm packages (version from `.aztecrc`), starts `aztec start --local-network` in the background, waits for it to be ready |
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), deploys Token + FPC, profiles `fee_entrypoint`, prints gate counts |
| `teardown.sh` | When done | Stops the network (if started by `setup.sh`), removes temp files |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://127.0.0.1:8080` | Aztec node endpoint (respected by all scripts) |
| `L1_RPC_URL` | `http://127.0.0.1:8545` | L1 (anvil) endpoint |

## Iteration Workflow

```
setup.sh                  ← run once
  │
  ├─► edit contracts/fpc  ─► run.sh
  ├─► edit contracts/fpc  ─► run.sh
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

### Output

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
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or re-run if the network died. |
| `quote expired 'anchor_ts <= valid_until'` | `VALID_UNTIL` is derived from the L2 block timestamp. Restart the sandbox if it has been running a long time. |
| Gas limit errors | The script uses separate gas settings for profiling (high limits, simulation only) and real sends (lower AVM-compatible limits). |
