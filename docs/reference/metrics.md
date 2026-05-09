---
title: Operational Metrics
description: Prometheus metrics and health probes exposed by the attestation and top-up services, with source file references for each metric.
---

# Operational Metrics

Both off-chain services expose Prometheus-style metrics and health/readiness probes.

Every metric below is annotated with the source file and line where it is defined. To re-verify, open the linked file.

## Source Files

| Service | Metrics defined in | Endpoints defined in |
|---------|-------------------|---------------------|
| Attestation | [`services/attestation/src/metrics.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/metrics.ts#L39) | [`services/attestation/src/server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L568) |
| Top-up | [`services/topup/src/ops.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/ops.ts#L42) | same file |

## Attestation Service

Default base URL: `http://127.0.0.1:3000` (source: `config.ts` → `port` default `3000`)

### Endpoints

| Method | Path | Response | Source |
|---|---|---|---|
| `GET` | `/health` | `200` with `{ "status": "ok" }`. Liveness probe. | `server.ts:568` |
| `GET` | `/metrics` | `200` with `text/plain; version=0.0.4`. Prometheus exposition format. | `server.ts:570` |

### Metrics

#### `attestation_quote_requests_total` (counter)

Total `/quote` requests grouped by outcome.

Source: `metrics.ts:80-88`

| Label | Values | Source |
|---|---|---|
| `outcome` | `success`, `bad_request`, `unauthorized`, `rate_limited`, `internal_error` | `metrics.ts:8-13` |

#### `attestation_quote_errors_total` (counter)

Failed `/quote` requests grouped by error type.

Source: `metrics.ts:90-98`

| Label | Values | Source |
|---|---|---|
| `error_type` | `bad_request`, `unauthorized`, `rate_limited`, `internal_error` | `metrics.ts:16-21` |

#### `attestation_quote_latency_seconds` (histogram)

`/quote` request latency grouped by outcome. Includes the standard Prometheus `le` bucket label.

Source: `metrics.ts:100-118`

| Label | Values | Source |
|---|---|---|
| `outcome` | `success`, `bad_request`, `unauthorized`, `rate_limited`, `internal_error` | `metrics.ts:8-13` |
| `le` | Histogram bucket upper-bound | Prometheus default |

## Top-up Service

Default base URL: `http://127.0.0.1:3001` (source: `config.ts` → `ops_port` default `3001`, overridable via `TOPUP_OPS_PORT`)

### Endpoints

| Method | Path | Response | Source |
|---|---|---|---|
| `GET` | `/health` | `200` with `{ "status": "ok" }`. Liveness probe. | `ops.ts:198-199` |
| `GET` | `/ready` | `200` when ready, `503` when not ready. | `ops.ts:203-205` |
| `GET` | `/metrics` | `200` with `text/plain; version=0.0.4`. Prometheus exposition format. | `ops.ts:209-210` |

Non-ready reasons reported by `/ready` (source: `ops.ts:89-119`):

- No successful balance checks yet
- Latest balance check failed
- Balance checks are stale
- Shutdown in progress

### Metrics

#### `topup_bridge_events_total` (counter)

Bridge lifecycle counters.

Source: `ops.ts:140-148`

| Label | Values | Source |
|---|---|---|
| `event` | `submitted`, `confirmed`, `timeout`, `aborted`, `failed` | `ops.ts:5-11` |

#### `topup_balance_checks_total` (counter)

Fee Juice balance read results. Used by the readiness probe.

Source: `ops.ts:150-154`

| Label | Values | Source |
|---|---|---|
| `outcome` | `success`, `error` | `ops.ts:150-154` |

#### `topup_readiness_status` (gauge)

Readiness snapshot: `1` = ready, `0` = not ready. No labels.

Source: `ops.ts:155-157`

#### `topup_uptime_seconds` (gauge)

Process uptime in seconds. No labels.

Source: `ops.ts:158-160`

## Recommended Alerts

> [!TIP]
> At minimum, set up the **Critical** alerts below. A silent `topup_readiness_status == 0` means the FPC will stop processing transactions once its Fee Juice runs out.

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

## Next Steps

- [Set up an operator node](../how-to/run-operator.md) and connect monitoring to these metric endpoints
- [Review the services architecture](../services.md) to understand which service emits each metric
- [Configure thresholds and alert parameters](../operations/configuration.md) for the attestation and top-up services
