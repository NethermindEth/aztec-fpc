---
title: Operational Metrics
description: Prometheus metrics and health probes exposed by the attestation and top-up services.
---

# Operational Metrics

Both off-chain services expose Prometheus-style metrics and health/readiness probes.

**Normative source:** [docs/ops/operational-metrics.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/ops/operational-metrics.md)

## Attestation Service

Default base URL: `http://127.0.0.1:3000`

### Endpoints

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | `200` with `{ "status": "ok" }`. Liveness probe. |
| `GET` | `/metrics` | `200` with `text/plain; version=0.0.4`. Prometheus exposition format. |

### Metrics

#### `attestation_quote_requests_total` (counter)

Total `/quote` requests grouped by outcome.

| Label | Values |
|---|---|
| `outcome` | `success`, `bad_request`, `unauthorized`, `rate_limited`, `internal_error` |

#### `attestation_quote_errors_total` (counter)

Failed `/quote` requests grouped by error type.

| Label | Values |
|---|---|
| `error_type` | `bad_request`, `unauthorized`, `rate_limited`, `internal_error` |

#### `attestation_quote_latency_seconds` (histogram)

`/quote` request latency grouped by outcome. Includes the standard Prometheus `le` bucket label.

| Label | Values |
|---|---|
| `outcome` | `success`, `bad_request`, `unauthorized`, `rate_limited`, `internal_error` |
| `le` | Histogram bucket upper-bound |

## Top-up Service

Default base URL: `http://127.0.0.1:3001` (configurable via `ops_port` or `TOPUP_OPS_PORT`).

### Endpoints

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | `200` with `{ "status": "ok" }`. Liveness probe. |
| `GET` | `/ready` | `200` when ready, `503` when not ready. |
| `GET` | `/metrics` | `200` with `text/plain; version=0.0.4`. Prometheus exposition format. |

Non-ready reasons reported by `/ready`:

- No successful balance checks yet
- Latest balance check failed
- Balance checks are stale
- Shutdown in progress

### Metrics

#### `topup_bridge_events_total` (counter)

Bridge lifecycle counters.

| Label | Values |
|---|---|
| `event` | `submitted`, `confirmed`, `timeout`, `aborted`, `failed` |

#### `topup_balance_checks_total` (counter)

Fee Juice balance read results. Used by the readiness probe.

| Label | Values |
|---|---|
| `outcome` | `success`, `error` |

#### `topup_readiness_status` (gauge)

Readiness snapshot: `1` = ready, `0` = not ready. No labels.

#### `topup_uptime_seconds` (gauge)

Process uptime in seconds. No labels.

## Recommended Alerts

| Alert | Expression | Severity |
|---|---|---|
| FPC will run out of Fee Juice | `topup_readiness_status == 0 for 5m` | Critical |
| Bridge failures | `rate(topup_bridge_events_total{event="failed"}[1h]) > 0` | High |
| Quote error rate spike | `rate(attestation_quote_errors_total[5m]) / rate(attestation_quote_requests_total[5m]) > 0.05` | Medium |
| Quote rate-limiting active | `rate(attestation_quote_errors_total{error_type="rate_limited"}[5m]) > 0` | Info (consider raising limits) |
| Service down | `up{job=~"fpc-.+"} == 0` | Critical |

## Scrape Configuration

```yaml
scrape_configs:
  - job_name: 'fpc-attestation'
    static_configs:
      - targets: ['attestation:3000']
    metrics_path: /metrics

  - job_name: 'fpc-topup'
    static_configs:
      - targets: ['topup:3001']
    metrics_path: /metrics
```
