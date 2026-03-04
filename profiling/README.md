# FPC Benchmarking

This directory benchmarks the FPC (Fee Payment Contract) implementation via
[aztec-benchmark](https://github.com/defi-wonderland/aztec-benchmark):

| Contract | Entry point(s) | Benchmark file |
|---|---|---|
| `FPC` (standard authwit-based) | `fee_entrypoint` | `benchmarks/fpc.benchmark.ts` |

`run.sh` invokes `aztec-benchmark` which discovers all `[benchmark]` entries in
`Nargo.toml`, runs each one sequentially, and produces structured JSON reports
in `profiling/benchmarks/` plus human-readable console summaries.

## Prerequisites

- **Aztec CLI (profiling pin)** — `4.0.0-devnet.2-patch.1`

```bash
VERSION=4.0.0-devnet.2-patch.1 bash -i <(curl -sL https://install.aztec.network/4.0.0-devnet.2-patch.1)
```

- **Node.js >=20** (usually bundled with the Aztec toolchain)
- **Foundry** (`anvil`) — needed by `aztec start --local-network` for the L1 node

## Quick Start

```bash
# 1. One-time setup: install SDK packages + start local network
./profiling/setup.sh

# 2. Benchmark FPC
./profiling/run.sh

# 3. Tear down when done
./profiling/teardown.sh
```

### What each script does

| Script | When | What |
|---|---|---|
| `setup.sh` | Once | Installs `@aztec/*` npm packages + `aztec-benchmark` + `viem` (version from `.aztecrc`), starts `aztec start --local-network` in the background, waits for it to be ready |
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), runs `aztec-benchmark` to deploy + profile the FPC benchmark in `Nargo.toml` (JSON + console output) |
| `teardown.sh` | When done | Stops the network (if started by `setup.sh`), removes temp files |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AZTEC_NODE_URL` | `http://127.0.0.1:8080` | Aztec node endpoint (respected by all scripts) |
| `L1_RPC_URL` | `http://127.0.0.1:8545` | L1 (anvil) endpoint — needed for Fee Juice bridging in the benchmark |

## Iteration Workflow

```
setup.sh                          ← run once
  │
  ├─► edit contracts/fpc          ─► run.sh
  │
teardown.sh                       ← run when done
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

`run.sh` invokes [aztec-benchmark](https://github.com/defi-wonderland/aztec-benchmark)
which deploys Token + FPC + Noop, bridges Fee Juice from L1, and profiles a
minimal Noop app transaction with the FPC as fee payment. The Noop boundary
lets the teardown step extract FPC-specific gate counts (from
`FPC:fee_entrypoint` up to `Noop:noop`).

The benchmark produces both a **console summary** and a **JSON report** at
`profiling/benchmarks/fpc.benchmark.json`. The benchmark file lives at
`profiling/benchmarks/fpc.benchmark.ts` and is referenced from the root
`Nargo.toml` under `[benchmark]`.

#### Console output

```
=== FPC Benchmark Results: fee_entrypoint ===

FPC-Only Gate Counts:
Function                                           Own gates      Witgen (ms)    Subtotal
────────────────────────────────────────────────────────────────────────────────────────────────────────
FPC:fee_entrypoint                                 18,657         45.2           18,657
private_kernel_inner                               101,237        12.3           119,894
Token:transfer_private_to_private                  34,237         28.1           154,131
private_kernel_inner                               101,237        11.8           255,368
SchnorrAccount:verify_private_authwit              14,328         9.4            269,696
private_kernel_inner                               101,237        11.5           370,933
────────────────────────────────────────────────────────────────────────────────────────────────────────
FPC TOTAL                                          370,933        118.3

Full Transaction Trace:
Function                                           Own gates      Witgen (ms)    Subtotal
────────────────────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount:entrypoint                          54,352         32.1           54,352
private_kernel_init                                46,811         8.7            101,163
...                                                ...            ...            ...
────────────────────────────────────────────────────────────────────────────────────────────────────────
TX TOTAL                                           772,327

Proving time:  10,517ms (hardware-dependent, full tx)
Gas:           DA 786,432 | L2 2,000,000
```

#### JSON report fields

| Field | Description |
|---|---|
| `summary` | Total gate counts (full trace) keyed by entry point name |
| `fpcSummary` | FPC-only gate counts keyed by entry point name |
| `results[].fullTrace` | Full per-circuit gate counts + witgen timing (all execution steps in the tx) |
| `results[].fullTrace[].witgenMs` | Witness generation time in ms for this circuit (from SDK `executionSteps[].timings.witgen`) |
| `results[].fpcGateCounts` | FPC-only per-circuit gate counts + witgen timing (`fee_entrypoint` + sub-calls) |
| `results[].fpcGateCounts[].witgenMs` | Witness generation time in ms for this FPC circuit |
| `results[].fpcTotalGateCount` | Sum of FPC-only gate counts |
| `results[].fpcTotalWitgenMs` | Sum of FPC-only witness generation times in ms |
| `results[].provingTime` | SDK proving time in ms (hardware-dependent, full tx) |
| `results[].gas` | Gas limits (DA + L2, including teardown) |
| `gasSummary` | Total gas (DA + L2) keyed by entry point name |
| `provingTimeSummary` | SDK proving time keyed by entry point name |
| `systemInfo` | Hardware info (CPU, cores, RAM, arch) recorded by aztec-benchmark |

> **Note on metrics:** Gate counts and gas are deterministic and
> hardware-independent — they are the primary metrics for comparing FPC
> implementations. Witness generation time (`witgenMs`) and proving time vary
> by CPU, RAM, and concurrency; they are included for informational purposes
> and are not used for CI regression detection.

#### Running the benchmark standalone

```bash
# From the profiling/ directory (after setup.sh):
AZTEC_NODE_URL=http://127.0.0.1:8080 L1_RPC_URL=http://127.0.0.1:8545 \
  npx aztec-benchmark \
    --config ../Nargo.toml \
    --output-dir ./benchmarks
```

#### CI integration

Two GitHub Actions workflows automate benchmarking:

| Workflow | Trigger | What it does |
|---|---|---|
| `update-baseline.yml` | Push to `main` | Runs benchmark, uploads result as baseline artifact (90-day retention) |
| `fpc-benchmark.yml` | Pull request | Runs benchmark, downloads baseline, posts gate count comparison as PR comment |

The workflows reuse the same Aztec setup pattern as the smoke tests (read
`.aztecrc`, cache toolchain, install via `aztec-up use`). The benchmark runs
on a fresh `aztec start --local-network` instance within each job.

The comparison uses `@defi-wonderland/aztec-benchmark`'s `runComparison()`
with a 2.5% threshold — changes below this are not flagged. Gate counts and
gas are hardware-independent, so comparisons are valid across runs. Timing
metrics (witgen, proving) may vary between runs on the same hardware.

To switch to Wonderland's default runner for hardware parity, change
`runs-on: ubuntu-latest` to `runs-on: ubuntu-latest-m` in both workflows
(requires GitHub Teams/Enterprise or larger runners enabled).

---

## Version Pinning

`profiling/package.json` and `profiling/setup.sh` are pinned to
`4.0.0-devnet.2-patch.1` (independent from repo `.aztecrc`) because
`@defi-wonderland/aztec-benchmark` is not yet published for patch.2.

## Gotchas

| Issue | Fix |
|---|---|
| `Artifact does not match expected class id` | Delete `profiling/node_modules/` and re-run `setup.sh`. |
| `Failed to get a note 'self.is_some()'` in `SchnorrAccount.verify_private_authwit` | The script passes `additionalScopes: [operatorAddress]` so the PXE can decrypt the operator's signing key note. |
| `Invalid tx: Existing nullifier` | A quote with the same `valid_until` was already consumed. Each invocation uses a distinct `valid_until`. |
| `Insufficient fee payer balance` | Fee Juice bridging failed. Check `fundFpcWithFeeJuice` completed and the FPC has enough Fee Juice. |
| `run.sh` says "no Aztec node" | Run `./profiling/setup.sh` first, or re-run if the network died. |
| `quote expired 'anchor_ts <= valid_until'` | `VALID_UNTIL` is derived from the L2 block timestamp. Restart the sandbox if it has been running a long time. |
| Gas limit errors | Gas limits are imported from `@aztec/constants` (`AVM_MAX_PROCESSABLE_L2_GAS`, `MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT`) to stay in sync with the installed version. |
