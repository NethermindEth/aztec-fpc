# Top-up Service [Automatic L1→L2 Fee Juice bridging daemon]

Background daemon that monitors the FPC's Fee Juice balance and bridges more from L1 when it runs low.

**Source:** `services/topup/`

## Overview

The FPC contract needs Fee Juice to pay gas. The top-up service ensures it never runs out:

1. Periodically checks the FPC's Fee Juice balance on L2
2. Bridges Fee Juice from L1 when balance drops below threshold
3. Persists bridge state to LMDB for crash recovery
4. Optionally auto-claims bridged tokens on L2

## Operational Flow

```
┌─────────────────────────────────────────┐
│ 1. Reconcile persisted state (startup)  │
│    Check LMDB for in-flight bridges     │
├─────────────────────────────────────────┤
│ 2. Read FPC Fee Juice balance on L2     │
├─────────────────────────────────────────┤
│ 3. Balance < threshold?                  │
│    NO  → sleep, go to 2                 │
│    YES → continue                        │
├─────────────────────────────────────────┤
│ 4. Bridge top_up_amount via L1 portal   │
├─────────────────────────────────────────┤
│ 5. Persist bridge metadata to LMDB      │
├─────────────────────────────────────────┤
│ 6. Poll for confirmation                │
│    (L1→L2 message ready + balance up)   │
├─────────────────────────────────────────┤
│ 7. Auto-claim on L2 (if enabled)        │
├─────────────────────────────────────────┤
│ 8. Clear state → go to 2               │
└─────────────────────────────────────────┘
```

## Crash Recovery

The service is designed to survive crashes without losing bridge transactions:

| Scenario | Behavior |
|----------|----------|
| Crash during confirmation | Restart → reconcile → resume polling → clear |
| Crash before persist | Restart → nothing found → next cycle re-bridges |
| Bridge older than 24h | Evict with `CRITICAL` log → manual recovery needed |

> [!CAUTION]
>
> If you see a `CRITICAL` log about a stale bridge, manually verify the L1 transaction status. The bridge may have succeeded but the service couldn't confirm it.


## Key Modules

| Module | Purpose |
|--------|---------|
| `checker.ts` | Periodic balance check loop |
| `bridge.ts` | L1 portal bridge submission |
| `confirm.ts` | L1→L2 message confirmation polling |
| `state.ts` | LMDB state management |
| `reconcile.ts` | Startup bridge reconciliation |
| `autoclaim.ts` | Automatic L2 token claiming |
| `fund-claimer-l2.ts` | Fund the autoclaim account |
| `l1.ts` | L1 chain ID validation against Aztec node |
| `monitor.ts` | Fee Juice balance reader (wraps Aztec node) |
| `config.ts` | YAML + env config loading |
| `secret-provider.ts` | L1 operator key resolution |
| `ops.ts` | Health/readiness/metrics endpoints |

## Ops Endpoints

Default port: `3001`

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness — 200 if process running |
| `GET /ready` | Readiness — tracks successful checks and staleness |
| `GET /metrics` | Prometheus metrics |

## Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `topup_bridge_events_total` | Counter | Bridge transactions submitted |
| `topup_balance_checks_total` | Counter | Balance checks performed |
| `topup_readiness_status` | Gauge | 1 = ready, 0 = not ready |
| `topup_uptime_seconds` | Gauge | Service uptime |

## Auto-Claim

After an L1 bridge is ready, the service can automatically claim tokens on L2:

| Setting | Description |
|---------|-------------|
| `TOPUP_AUTOCLAIM_ENABLED` | Enable/disable auto-claiming |
| `TOPUP_AUTOCLAIM_SECRET_KEY` | L2 key for the claimer account |
| `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` | FPC address to sponsor claimer's gas |

## Configuration

See [Configuration](../operations/configuration.md) for the full reference.

```yaml title="config.yaml"
aztec_node_url: "http://localhost:8080"
l1_rpc_url: "http://localhost:8545"
fpc_address: "0x..."
threshold: "1000000000"
top_up_amount: "5000000000"
data_dir: ".topup-data"
check_interval_ms: 60000
confirmation_timeout_ms: 180000    # default 180s — max wait for L1→L2 message + balance settlement
l1_operator_secret_provider: auto
ops_port: 3001
```
