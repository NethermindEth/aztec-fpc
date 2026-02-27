# Operational Endpoints and Metrics

This document defines the baseline liveness/readiness probes and Prometheus-style
metrics exposed by the two services.

## Attestation Service

Base URL example: `http://127.0.0.1:3000`

### Endpoints

- `GET /health`
  - Liveness probe.
  - Returns `200` with `{ "status": "ok" }`.
- `GET /metrics`
  - Prometheus text exposition.
  - Returns `200` with `text/plain; version=0.0.4`.

### Metrics

- `attestation_quote_requests_total` (counter)
  - Description: total `/quote` requests grouped by outcome.
  - Labels:
    - `outcome`: `success | bad_request | unauthorized | rate_limited | internal_error`
- `attestation_quote_errors_total` (counter)
  - Description: total failed `/quote` requests grouped by error type.
  - Labels:
    - `error_type`: `bad_request | unauthorized | rate_limited | internal_error`
- `attestation_quote_latency_seconds` (histogram)
  - Description: `/quote` request latency grouped by outcome.
  - Labels:
    - `outcome`: `success | bad_request | unauthorized | rate_limited | internal_error`
    - `le`: Prometheus histogram bucket upper-bound label

## Top-up Service

Base URL example: `http://127.0.0.1:3001` (configurable via `ops_port` or `TOPUP_OPS_PORT`)

### Endpoints

- `GET /health`
  - Liveness probe.
  - Returns `200` with `{ "status": "ok" }`.
- `GET /ready`
  - Readiness probe.
  - Returns `200` when the service is ready; otherwise `503`.
  - Non-ready reasons include:
    - no successful balance checks yet
    - latest balance check failed
    - balance checks are stale
    - shutdown in progress
- `GET /metrics`
  - Prometheus text exposition.
  - Returns `200` with `text/plain; version=0.0.4`.

### Metrics

- `topup_bridge_events_total` (counter)
  - Description: bridge lifecycle counters.
  - Labels:
    - `event`: `submitted | confirmed | timeout | aborted | failed`
- `topup_balance_checks_total` (counter)
  - Description: Fee Juice balance read results used for readiness.
  - Labels:
    - `outcome`: `success | error`
- `topup_readiness_status` (gauge)
  - Description: readiness snapshot (`1` ready, `0` not ready).
  - Labels: none
- `topup_uptime_seconds` (gauge)
  - Description: process uptime in seconds.
  - Labels: none
