# FPC Gate Count Profiling

Profiles the gate count of `FPC.fee_entrypoint` by deploying Token + FPC on a
local Aztec network and running the full execution trace.

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
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), deploys Token + FPC, profiles `fee_entrypoint`, prints gate counts |
| `teardown.sh` | When done | Stops the network (if started by `setup.sh`), removes temp files |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://127.0.0.1:8080` | Aztec node endpoint (respected by all three scripts) |

## Iteration Workflow

```
setup.sh          ← run once
  │
  ├─► edit contracts
  ├─► run.sh       ← compile + deploy + profile
  ├─► edit contracts
  ├─► run.sh
  ├─► ...
  │
teardown.sh        ← run when done
```

## Output

```
=== Gate Count Profile ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                                    54,352       54,352
private_kernel_init                                          46,811       101,163
FPC:fee_entrypoint                                           14,498       115,661
private_kernel_inner                                         101,237      216,898
SchnorrAccount:verify_private_authwit                        14,328       231,226
private_kernel_inner                                         101,237      332,463
Token:transfer_in_private                                    150,928      483,391
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                                     1,280,851
```

## How It Works

`profile-gates.mjs` performs the deploy + profile flow in a single Node.js process:

1. Connects to the Aztec node and starts an embedded PXE (clean slate each run)
2. Registers deterministic test accounts (user = test0, operator = test1) as
   Schnorr accounts via `AccountManager`
3. Loads raw nargo artifacts from `target/` and normalises them via
   `loadContractArtifact()` so the SDK computes correct contract class IDs
4. Deploys `Token(user, "TestToken", "TST", 18)` and `FPC(operator, tokenAddress)`
5. Computes the token charge from current node min fees
   (`charge = ceil(maxGasCost × rateNum / rateDen)`, 1:1 rate, 1.5× fee padding)
6. Mints `charge + 1000` tokens to the user's private balance
7. Creates a **quote authwit** — operator signs authorisation for the FPC to
   consume a fee quote bound to the user
8. Creates a **transfer authwit** — user authorises the FPC to call
   `Token.transfer_in_private(user, operator, charge, nonce)` on their behalf
9. Builds a `CustomFPCPaymentMethod` wrapping the transfer authwit, rate params,
   and gas settings, then profiles a dummy `Token.transfer_in_private(user→user,
   1, nonce=0)` with the FPC as fee payer — this triggers the full
   `fee_entrypoint` execution path including kernel circuits
10. Prints a per-function gate-count table (app functions + kernel circuits)

## Version Pinning

The `package.json` in this directory pins `@aztec/*` packages to the version in
`.aztecrc`. When `.aztecrc` changes, `setup.sh` automatically detects the mismatch
and re-installs the correct versions. Just re-run `setup.sh` after updating `.aztecrc`.

## Gotchas

| Issue | Fix |
|---|---|
| `Artifact does not match expected class id` | Both deploy and profile use the same `loadContractArtifact()` from the npm packages, so this should not happen. If it does, delete `profiling/node_modules/` and re-run `setup.sh`. |
| `Failed to get a note 'self.is_some()'` in `SchnorrAccount.verify_private_authwit` | The script passes `additionalScopes: [operatorAddress]` so the PXE can decrypt the operator's signing key note. |
| `Invalid authwit nonce` in `Token.transfer_in_private` | When `from == msg_sender`, the token contract requires `nonce=0` (no authwit path). The profiled call uses `nonce=0`. |
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or if the network died, re-run setup. |
