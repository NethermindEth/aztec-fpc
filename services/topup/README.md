# Top-up Service

This service keeps a fee-payer contract funded with Fee Juice on Aztec L2. It runs as a background daemon:

1. checks Fee Juice balance of the configured contract address,
2. triggers an L1 -> L2 Fee Juice bridge when balance is below threshold,
3. confirms bridge settlement,
4. exposes ops endpoints (`/health`, `/ready`, `/metrics`).

## What This Service Does

At startup, the service:

1. Loads config from `config.yaml` plus env overrides.
2. Resolves L1 operator private key (`env`, `config`, `kms`, or `hsm` mode).
3. Connects to Aztec node (`aztec_node_url`) and reads node info.
4. Validates:
   - `fpc_address` is non-zero.
   - node-provided L1 Fee Juice portal/token addresses are non-zero.
   - `l1_rpc_url` chain ID matches Aztec node `l1ChainId`.
5. Starts an ops HTTP server on `ops_port`.
6. Builds a periodic check loop (`check_interval_ms`).

On each cycle, it:

1. Reconciles any persisted in-flight bridge state from `data_dir`.
   - If reconciliation times out, it preserves state and skips submitting a new bridge in that cycle.
2. Reads current Fee Juice balance of `fpc_address`.
3. If `balance < threshold`, submits bridge of `top_up_amount`.
4. Persists bridge metadata (message hash, leaf index, claim secret hash, baseline balance).
5. Waits for confirmation using two signals:
   - L1->L2 message readiness (`waitForL1ToL2MessageReady`), and
   - observed increase in Fee Juice balance.
6. Clears persisted bridge state on confirmed settlement; retains it on timeout for retry.

## Wiring to `/contracts/fpc`

Contract reference: `contracts/fpc/src/main.nr`

How it is wired:

- `FPC.fee_entrypoint(...)` calls `self.context.set_as_fee_payer()` and pays protocol fees from the FPC contract's Fee Juice balance.
- Top-up service targets that same contract address via config key `fpc_address` and keeps its Fee Juice balance above `threshold`.
- There is no direct ABI call into `FPC`; wiring is address-level through protocol Fee Juice balance monitoring and L1 bridge deposits.

Operationally: if `fpc_address` points to the deployed `FPC`, this service funds the address used to pay fees for transactions using `fee_entrypoint`.

## Endpoints

The top-up service exposes ops endpoints only.

### `GET /health`

Liveness endpoint.

Response:

```json
{ "status": "ok" }
```

### `GET /ready`

Readiness endpoint. Returns `200` when ready and `503` when not ready.

Readiness is based on:

- shutdown state,
- whether at least one successful balance check happened,
- whether the latest balance check failed,
- whether balance checks are stale.

Response shape:

```json
{
  "ready": false,
  "status": "not_ready",
  "reasons": [
    {
      "code": "no_successful_balance_checks",
      "message": "No successful Fee Juice balance checks yet"
    }
  ],
  "checks": {
    "successful_balance_checks": 0,
    "failed_balance_checks": 0,
    "last_balance_check_ok": false,
    "last_balance_check_age_seconds": null
  }
}
```

### `GET /metrics`

Prometheus metrics endpoint.

Includes:

- `topup_bridge_events_total{event="submitted|confirmed|timeout|aborted|failed"}`
- `topup_balance_checks_total{outcome="success|error"}`
- `topup_readiness_status`
- `topup_uptime_seconds`

### Method/path behavior

- Non-`GET` methods return `405 METHOD_NOT_ALLOWED`.
- Unknown paths return `404 NOT_FOUND`.

## Runtime Configuration (Key Fields)

- `fpc_address`: contract address whose Fee Juice balance is monitored and topped up.
- `threshold`: minimum Fee Juice balance; bridge triggers below this value.
- `top_up_amount`: amount bridged per trigger.
- `data_dir`: LMDB-backed directory for persistent state. Created automatically with `0o700` permissions. Contains:
  - LMDB data files for in-flight bridge metadata (claim secret, message hash, baseline balance).
  - `.topup.lock` PID lock file (prevents concurrent instances).
- `check_interval_ms`: polling/check cadence.
- `confirmation_timeout_ms`, `confirmation_poll_initial_ms`, `confirmation_poll_max_ms`: bridge confirmation polling with exponential backoff (starts at `initial`, doubles up to `max`, total capped at `timeout`).
- `l1_operator_secret_provider` + secret fields: L1 signer key source.

Validation constraints enforced at startup:
- `confirmation_poll_initial_ms <= confirmation_poll_max_ms <= confirmation_timeout_ms`
- `top_up_amount >= threshold`

Useful env overrides:

- `FPC_RUNTIME_PROFILE` (override runtime profile: `development`, `test`, `production`)
- `AZTEC_NODE_URL`
- `L1_RPC_URL`
- `L1_OPERATOR_PRIVATE_KEY`
- `TOPUP_DATA_DIR`
- `TOPUP_OPS_PORT`
- `TOPUP_FEE_JUICE_RECIPIENT_ADDRESS` (overrides bridge target; defaults to `fpc_address`)
- `TOPUP_AUTOCLAIM_ENABLED` (`0` to disable auto-claim)
- `TOPUP_AUTOCLAIM_SECRET_KEY` (claimer account secret key)
- `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` (sponsored FPC for fee-less claims)

Claim secrets are logged automatically in `development` profile and never in `test`/`production`.

## Crash Recovery

Bridge metadata (including claim secrets) is persisted to an LMDB database in `data_dir`. If the service crashes or restarts while a bridge is in-flight:

1. On startup, the service reads any persisted bridge state from LMDB.
2. It polls for bridge confirmation (balance increase + L1→L2 message readiness).
3. On confirmation, persisted state is cleared and the service resumes normal operation.
4. On timeout, state is preserved for the next cycle's reconciliation attempt.
5. Persisted bridges older than 24 hours are evicted with a `CRITICAL` log to prevent deadlock. Funds from evicted bridges may require manual recovery.

In containerized deployments, `data_dir` should be backed by a persistent volume so state survives container restarts.

## Minimal Local Run

```bash
cd services/topup
cp config.example.yaml config.yaml
bun install
bun run build
L1_OPERATOR_PRIVATE_KEY=0x... bun run start -- --config config.yaml
```

Example checks:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/ready
curl http://localhost:3001/metrics
```
