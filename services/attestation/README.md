# Attestation Service

This service is the quote signer for fee payment flows. It exposes HTTP endpoints that return short-lived, user-bound Schnorr signatures over quoted amounts. Those signatures are consumed by on-chain contracts to authorize exact private token charges.

## What This Service Does

At startup, the service:

1. Loads config from `config.yaml` plus env overrides.
2. Resolves operator secret key (`env`, `config`, `kms`, or `hsm` mode).
3. Derives the operator signing public key.
4. Verifies on-chain constructor immutables for the configured contract address:
   - `operator`
   - `operator_pubkey_x`
   - `operator_pubkey_y`
5. Starts Fastify and serves quote/ops endpoints.

At quote time (`GET /quote`), the service:

1. Authorizes request (depending on `quote_auth_mode`).
2. Applies fixed-window rate limiting.
3. Validates `user`, `accepted_asset`, and `fj_amount` (positive `u128`).
4. Ensures `accepted_asset` is listed in configured `supported_assets`.
5. Resolves per-asset pricing policy for the selected asset.
6. Computes final rate with margin:
   - `rate_num = market_rate_num * (10000 + fee_bips)`
   - `rate_den = market_rate_den * 10000`
7. Computes exact token payment:
   - `aa_payment_amount = ceil(fj_amount * rate_num / rate_den)`
8. Computes `valid_until` from current chain timestamp + `quote_validity_seconds`.
9. Signs the quote hash:
   - `computeInnerAuthWitHash([0x465043, fpc_address, accepted_asset, fj_amount, aa_payment_amount, valid_until, user])`
10. Returns the signed quote payload.

Notes:

- Quotes are user-specific (`user` must match `msg_sender` in contract execution).
- Replays are prevented on-chain by nullifying quote hash.
- The service name/config key uses `fpc_address`, targeting the `FPC` contract which verifies the quote preimage structure.

## Wiring to `/contracts/fpc`

Contract reference: `contracts/fpc/src/main.nr`

How it connects:

1. `FPC.fee_entrypoint(accepted_asset, authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)` expects the service quote fields directly.
2. `FPC.assert_valid_quote(...)` recomputes the same hash preimage and verifies Schnorr signature against the stored operator pubkey.
3. It enforces quote expiry and replay protection (`push_nullifier(quote_hash)`).
4. It enforces `fj_fee_amount == get_max_gas_cost_no_teardown(...)`.
5. It transfers exactly `aa_payment_amount` of `accepted_asset` from user to operator via authwit-backed `transfer_private_to_private`.

Implication: for `FPC`, clients should request `/quote` with `fj_amount = max_gas_cost_no_teardown` for the transaction they are building.

## Single-Instance vs Multi-Instance Setup

Each attestation instance is bound to one contract address (`fpc_address`) and can support multiple assets via `supported_assets`.

- Use one instance per deployed `FPC` address.
- Configure `supported_assets` with all wallet-facing assets.
- Optional per-asset pricing overrides are read from each `supported_assets` entry (`market_rate_num`, `market_rate_den`, `fee_bips`).

## Endpoints

### `GET /.well-known/fpc.json`

Returns wallet discovery metadata for this attestation instance.
`supported_assets` is sourced from `supported_assets` config when provided; otherwise the service emits a single-item array from `accepted_asset_*`.

Response:

```json
{
  "discovery_version": "1.0",
  "attestation_api_version": "1.0",
  "network_id": "aztec-alpha-local",
  "fpc_address": "0x...",
  "contract_variant": "fpc-v1",
  "quote_base_url": "https://attestation.example",
  "endpoints": {
    "discovery": "/.well-known/fpc.json",
    "health": "/health",
    "accepted_assets": "/accepted-assets",
    "asset": "/asset",
    "quote": "/quote"
  },
  "supported_assets": [{ "address": "0x...", "name": "humanUSDC" }]
}
```

### `GET /health`

Liveness probe.

Response:

```json
{ "status": "ok" }
```

### `GET /metrics`

Prometheus metrics.

Includes:

- `attestation_quote_requests_total{outcome=...}`
- `attestation_quote_errors_total{error_type=...}`
- `attestation_quote_latency_seconds_*{outcome=...}`

### `GET /accepted-assets`

Returns the supported accepted-assets list (address + name).
This is the primary token-discovery endpoint for SDK clients.

Response:

```json
[
  { "name": "humanUSDC", "address": "0x..." },
  { "name": "ravenETH", "address": "0x..." }
]
```

### `GET /asset` (legacy compatibility)

Returns configured accepted asset metadata.

Response:

```json
{
  "name": "humanUSDC",
  "address": "0x..."
}
```

### `GET /quote?user=<aztec_address>&accepted_asset=<aztec_address>&fj_amount=<positive_u128_decimal>`

Returns a signed, user-bound quote for exact amounts.

Auth headers (optional/required depending on `quote_auth_mode`):

- API key header (default name: `x-api-key`)
- trusted upstream header (configurable name/value)

Success response:

```json
{
  "accepted_asset": "0x...",
  "fj_amount": "1000000",
  "aa_payment_amount": "1020",
  "valid_until": "1700000300",
  "signature": "0x<64-byte-schnorr-signature>"
}
```

Errors:

- `400 BAD_REQUEST`
  - missing/invalid `user`
  - missing/invalid `accepted_asset`
  - unsupported `accepted_asset`
  - missing/invalid `fj_amount`
  - computed `aa_payment_amount` not representable as `u128`
- `401 UNAUTHORIZED`
  - auth header policy not satisfied
- `429 RATE_LIMITED`
  - fixed-window limit exceeded (includes `retry-after` header)
- `500 INTERNAL_ERROR`
  - signing or internal failure

## Minimal Local Run

```bash
cd services/attestation
cp config.example.yaml config.yaml
bun install
bun run build
OPERATOR_SECRET_KEY=0x... bun run start -- --config config.yaml
```

Example checks:

```bash
curl http://localhost:3000/.well-known/fpc.json
curl http://localhost:3000/health
curl http://localhost:3000/asset
curl "http://localhost:3000/quote?user=<aztec_address>&accepted_asset=<asset_address>&fj_amount=1000000"
```
