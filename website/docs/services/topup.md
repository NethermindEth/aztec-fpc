# Top-up Service

Background daemon that monitors the FPC's Fee Juice balance on L2 and bridges more from L1 when it runs low.

**Source:** `services/topup/`

## What It Does

The FPC contract needs Fee Juice to pay gas on behalf of users. Without it, all `fee_entrypoint` calls fail. The top-up service prevents that by polling the balance and bridging automatically.

1. Periodically reads the FPC's Fee Juice balance on L2.
2. When the balance drops below `threshold`, bridges `top_up_amount` via `L1FeeJuicePortalManager.bridgeTokensPublic(...)` on L1.
3. Persists bridge state to LMDB for crash recovery.
4. Waits for L1-to-L2 message readiness, with a balance-delta fallback as the final confirmation signal.
5. Optionally auto-claims bridged tokens on L2.

---

## Operational Flow

```
┌─────────────────────────────────────────┐
│ 1. Reconcile persisted state (startup)  │
│    Check LMDB for in-flight bridges     │
├─────────────────────────────────────────┤
│ 2. Read FPC Fee Juice balance on L2     │
├─────────────────────────────────────────┤
│ 3. Balance < threshold?                 │
│    NO  → sleep, go to 2                 │
│    YES → continue                       │
├─────────────────────────────────────────┤
│ 4. Bridge top_up_amount via L1 portal   │
├─────────────────────────────────────────┤
│ 5. Persist bridge metadata to LMDB      │
├─────────────────────────────────────────┤
│ 6. Poll for confirmation               │
│    (L1→L2 message ready + balance up)   │
├─────────────────────────────────────────┤
│ 7. Auto-claim on L2 (if enabled)        │
├─────────────────────────────────────────┤
│ 8. Clear state → go to 2               │
└─────────────────────────────────────────┘
```

Only one bridge operation runs at a time. An in-flight guard prevents concurrent bridges.

---

## Bridge Mechanics

1. The service builds an L1 wallet client and uses `L1FeeJuicePortalManager.new(node, client, logger)`.
2. The manager performs Fee Juice token approval and portal deposit, returning L1-to-L2 message metadata.
3. The service waits for L1-to-L2 message readiness (`waitForL1ToL2MessageReady`) using the returned message hash.
4. The service also polls the FPC's Fee Juice balance and treats a positive balance delta as the final fallback confirmation signal.

`l1_chain_id` and Fee Juice L1 contract addresses are derived from `nodeInfo`. The service validates that the configured `l1_rpc_url` matches the node's L1 chain id at startup.

> [!NOTE]
>
> For `aztec start --local-network`, Fee Juice L1 contracts are bootstrap-provisioned by local-network. Discover them from node info; do not add a manual custom L1 Fee Juice deployment step.

---

## L1 Funding Prerequisite

The L1 operator account must hold:

- **ETH** for L1 gas on bridge transactions
- **Fee Juice token balance** (the ERC-20 that gets bridged to L2)

Fund the L1 operator account before starting the service. The repo includes a helper:

```bash
export AZTEC_NODE_URL=<AZTEC_NODE_URL>
export L1_RPC_URL=<L1_RPC_URL>
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>
bun run fund:l1:fee-juice
```

This checks the operator's L1 Fee Juice token balance and mints up to the target if below. The L1 Fee Juice token and portal addresses are auto-discovered from the connected Aztec node.

---

## Crash Recovery

The service persists bridge metadata to LMDB before polling for confirmation. This makes it resilient to process crashes.

| Scenario | Behavior |
|----------|----------|
| Crash during confirmation polling | Restart reconciles persisted state, resumes polling, clears on success |
| Crash before persist | Nothing found on restart; next balance check re-bridges |
| Bridge older than 24 hours | Evicted with `CRITICAL` log; manual recovery required |

> [!CAUTION]
>
> If you see a `CRITICAL` log about a stale bridge, manually verify the L1 transaction status. The bridge may have succeeded on L1 but the service could not confirm it on L2.

---

## Auto-Claim

After the top-up service bridges Fee Juice from L1, the tokens must be claimed on L2. Auto-claim handles this automatically.

| Setting | Description |
|---------|-------------|
| `TOPUP_AUTOCLAIM_ENABLED` | Enable auto-claim (default: `1`; set `0` to disable) |
| `TOPUP_AUTOCLAIM_SECRET_KEY` | L2 secret key for the claimer account |
| `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` | Use a sponsored FPC to pay claim tx fees |

In `development` profile, if `TOPUP_AUTOCLAIM_SECRET_KEY` is not set, the service falls back to the first test account from `@aztec/accounts/testing`. In `production`, an explicit secret key is required.

---

## Configuration

See [Configuration](../operations/configuration.md) for the full reference.

| Field | Description |
|-------|-------------|
| `fpc_address` | FPC contract on L2 |
| `aztec_node_url` | PXE/node RPC |
| `l1_rpc_url` | L1 Ethereum RPC |
| `l1_operator_private_key` | L1 wallet key (can be supplied via env, config, or secret provider) |
| `l1_operator_secret_provider` | Secret source strategy (`auto`, `env`, `config`, `kms`, `hsm`) |
| `runtime_profile` | `development`, `test`, or `production` (production rejects plaintext config secrets) |
| `threshold` | Bridge when balance below this value (in wei) |
| `top_up_amount` | Amount to bridge per event (in wei) |
| `check_interval_ms` | Polling interval in milliseconds |
| `data_dir` | LMDB directory for crash-recovery state |
| `confirmation_timeout_ms` | Max wait for L1-to-L2 settlement (default 180s) |
| `confirmation_poll_initial_ms` | Initial poll interval (default 1s) |
| `confirmation_poll_max_ms` | Max poll interval with backoff (default 15s) |
| `ops_port` | Health/readiness/metrics port (default 3001) |

Example config:

```yaml
# config.yaml
aztec_node_url: "http://localhost:8080"
l1_rpc_url: "http://localhost:8545"
fpc_address: "0x..."
threshold: "1000000000"
top_up_amount: "5000000000"
data_dir: ".topup-data"
check_interval_ms: 60000
confirmation_timeout_ms: 180000
l1_operator_secret_provider: auto
ops_port: 3001
```

---

## Ops Endpoints

Default port: `3001`

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness: returns 200 if the process is running |
| `GET /ready` | Readiness: tracks successful checks and staleness (200 = ready, 503 = not ready) |
| `GET /metrics` | Prometheus metrics |

## Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `topup_bridge_events_total` | Counter | Bridge lifecycle events (submitted, confirmed, timeout, aborted, failed) |
| `topup_balance_checks_total` | Counter | Balance checks by outcome |
| `topup_readiness_status` | Gauge | 1 = ready, 0 = not ready |
| `topup_uptime_seconds` | Gauge | Service uptime |

---

## Key Modules

| Module | Purpose |
|--------|---------|
| `checker.ts` | Periodic balance check loop |
| `bridge.ts` | L1 portal bridge submission |
| `confirm.ts` | L1-to-L2 message confirmation polling |
| `state.ts` | LMDB state management |
| `reconcile.ts` | Startup bridge reconciliation |
| `autoclaim.ts` | Automatic L2 token claiming |
| `fund-claimer-l2.ts` | Fund the autoclaim account |
| `l1.ts` | L1 chain ID validation against Aztec node |
| `monitor.ts` | Fee Juice balance reader (wraps Aztec node) |
| `config.ts` | YAML + env config loading |
| `secret-provider.ts` | L1 operator key resolution |
| `ops.ts` | Health, readiness, and metrics endpoints |

---

## Local-Network Troubleshooting

### Stale hardcoded addresses

**Symptom:** Quote or address mismatch, or top-up failures after local-network restart.

**Check:** Compare configured addresses with fresh `nodeInfo`.

**Fix:** Remove hardcoded Fee Juice addresses and regenerate runtime config from the current deploy/node output.

### L1 chain-id mismatch

**Symptom:** Top-up startup or bridge submission fails with chain mismatch errors.

**Check:** Confirm the `l1_rpc_url` chain id matches the node-reported L1 chain id.

**Fix:** Point `l1_rpc_url` to the L1 RPC associated with the active local-network instance.

### Fee Juice portal/address mismatch

**Symptom:** Bridge submission succeeds on L1 but no expected Fee Juice balance increase on L2.

**Check:** Verify Fee Juice token and portal addresses against the node-reported L1 contract addresses.

**Fix:** Use node-derived Fee Juice addresses. Avoid manual overrides for local-network.
