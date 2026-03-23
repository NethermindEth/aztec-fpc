# FPC Benchmarking

This directory benchmarks the FPC (Fee Payment Contract) implementation:

| Contract | Entry point(s) | Benchmark file |
|---|---|---|
| `FPC` (standard authwit-based) | `fee_entrypoint` | `benchmarks/fpc.benchmark.ts` |
| `FPC` (cold start) | `cold_start_entrypoint` | `benchmarks/cold-start.benchmark.ts` |

`run.sh` invokes `runner.mjs` which discovers all `[benchmark]` entries in
`Nargo.toml`, runs each one sequentially, and produces structured JSON reports
in `profiling/benchmarks/` plus human-readable console summaries.

## Prerequisites

- **Aztec CLI** — version from `.aztecrc` (currently `4.1.0-nightly.20260312.2`)

```bash
VERSION=$(cat .aztecrc) bash -i <(curl -sL https://install.aztec.network/$VERSION)
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
| `setup.sh` | Once | Installs `@aztec/*` npm packages + `viem` (version from `.aztecrc`), starts `aztec start --local-network` in the background, waits for it to be ready |
| `run.sh` | Every iteration | Compiles contracts (`aztec compile`), runs `runner.mjs` to deploy + profile the FPC benchmark in `Nargo.toml` (JSON + console output) |
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

`run.sh` invokes `runner.mjs`
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
| `systemInfo` | Hardware info (CPU, cores, RAM, arch) recorded by the runner |

> **Note on metrics:** Gate counts and gas are deterministic and
> hardware-independent — they are the primary metrics for comparing FPC
> implementations. Witness generation time (`witgenMs`) and proving time vary
> by CPU, RAM, and concurrency; they are included for informational purposes
> and are not used for CI regression detection.

#### Running the benchmark standalone

```bash
# From the profiling/ directory (after setup.sh):
AZTEC_NODE_URL=http://127.0.0.1:8080 L1_RPC_URL=http://127.0.0.1:8545 \
  NODE_PATH=node_modules node runner.mjs \
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

The comparison uses the vendored `comparison.cjs` module's `runComparison()`
with a 2.5% threshold — changes below this are not flagged. Gate counts and
gas are hardware-independent, so comparisons are valid across runs. Timing
metrics (witgen, proving) may vary between runs on the same hardware.

To switch to Wonderland's default runner for hardware parity, change
`runs-on: ubuntu-latest` to `runs-on: ubuntu-latest-m` in both workflows
(requires GitHub Teams/Enterprise or larger runners enabled).

---

## Cold-Start FPC (`run.sh`)

### Profiled Flow: `cold_start_entrypoint`

The cold-start flow allows a user with no deployed L2 account to claim bridged
tokens and pay the FPC fee in a single transaction. The FPC contract is the
**tx root** (`msg_sender = None`) — there is no account entrypoint.

Internal calls traced: `FPC:cold_start_entrypoint`, `TokenBridge:claim_private`,
`Token:mint_to_private`, `Token:transfer_private_to_private` ×2, plus all
kernel circuits.

### Key difference from `fee_entrypoint`

With `fee_entrypoint`, the profiler wraps a `ContractFunctionInteraction` (the
SDK's normal path through an account entrypoint). With `cold_start_entrypoint`,
this is not possible — the FPC must be the tx root so `msg_sender` is `None`.
The benchmark builds a `TxExecutionRequest` directly (inlining `DefaultEntrypoint`
logic) and calls PXE APIs (`simulateTx`, `profileTx`, `proveTx`) via a
`ColdStartAction` wrapper that duck-types the runner's profiler interface.

### Setup

The benchmark deploys a full infrastructure from scratch: L2 Token + FPC +
TokenBridge + Noop, L1 TestERC20 + TokenPortal, bridges Fee Juice to the FPC,
and bridges tokens via the L1 portal for the cold-start claim. This is all
scaffolding — none of it is measured.

The FPC is deployed with `Contract.deployWithPublicKeys(deriveKeys(Fr.ZERO).publicKeys)`
so the PXE can resolve tagging keys for the FPC address (required because
`cold_start_entrypoint` calls `set_sender_for_tags`).

### Output

The benchmark produces both a **console summary** and a **JSON report** at
`profiling/benchmarks/cold_start.benchmark.json`.

The **FPC-Only** table shows the entrypoint + sub-calls + per-call `kernel_inner`
circuits, excluding tx-level overhead (`kernel_init`, `kernel_reset`,
`kernel_tail`, `hiding_kernel`). This matches the convention used by
`fee_entrypoint` where those kernels fall outside the FPC→Noop boundary.

The **Gas** line shows actual simulated gas consumption (not the hardcoded limits).
These values inform `COLD_START_GAS_LIMITS` in `sdk/src/payment-method.ts`.

#### Console output

```
=== Cold-Start Benchmark Results: cold_start_entrypoint ===

FPC-Only Gate Counts:
Function                                           Own gates      Witgen (ms)    Subtotal
────────────────────────────────────────────────────────────────────────────────────────────────────
FPCMultiAsset:cold_start_entrypoint                22,202         30.8           22,202
TokenBridge:claim_private                          36,171         37.4           58,373
private_kernel_inner                               101,237        129.5          159,610
Token:mint_to_private                              9,909          25.8           169,519
private_kernel_inner                               101,237        133.4          270,756
Token:transfer_private_to_private                  34,237         44.3           304,993
private_kernel_inner                               101,237        127.0          406,230
Token:transfer_private_to_private                  34,237         41.9           440,467
private_kernel_inner                               101,237        132.1          541,704
────────────────────────────────────────────────────────────────────────────────────────────────────
FPC TOTAL                                          541,704        702.3

...
TX TOTAL                                           874,415

Proving time:  5,734ms (hardware-dependent, full tx)
Gas:           DA 1,568 | L2 711,103
```

---

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
| `Invalid tx: Invalid expiration timestamp` (cold_start only) | The sandbox has accumulated too many blocks. Restart with `./profiling/teardown.sh && ./profiling/setup.sh`. |
| `No public key registered for address` (cold_start only) | The FPC must be deployed with `deployWithPublicKeys(deriveKeys(Fr.ZERO).publicKeys)` so keys match the address. |
