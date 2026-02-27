# FPC Gate Count Profiling

This directory contains profiling scripts for the BackedCreditFPC contract:

| Script | Contract | Entry point(s) |
|---|---|---|
| `run.sh` | `BackedCreditFPC` | `pay_and_mint`, `pay_with_credit` |

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

# 2. Profile BackedCreditFPC (pay_and_mint + pay_with_credit)
./profiling/run.sh

# 3. Tear down when done
./profiling/teardown.sh
```

### What each script does

| Script | When | What |
|---|---|---|
| `setup.sh` | Once | Installs `@aztec/*` npm packages (version from `.aztecrc`), starts `aztec start --local-network` in the background, waits for it to be ready |
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), deploys Token + BackedCreditFPC, profiles `pay_and_mint` and `pay_with_credit`, prints gate counts |
| `teardown.sh` | When done | Stops the network (if started by `setup.sh`), removes temp files |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://127.0.0.1:8080` | Aztec node endpoint (respected by all scripts) |
| `L1_RPC_URL` | `http://127.0.0.1:8545` | L1 (anvil) endpoint — needed for Fee Juice bridging |

## Iteration Workflow

```
setup.sh                               ← run once
  │
  ├─► edit contracts/backed_credit_fpc ─► run.sh
  ├─► edit contracts/backed_credit_fpc ─► run.sh
  │
teardown.sh                            ← run when done
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
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or re-run if the network died. |
