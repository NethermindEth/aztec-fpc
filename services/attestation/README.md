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
   - `accepted_asset`
5. Starts Fastify and serves quote/ops endpoints.

At quote time (`GET /quote`), the service:

1. Authorizes request (depending on `quote_auth_mode`).
2. Applies fixed-window rate limiting.
3. Validates `user` and `fj_amount` (positive `u128`).
4. Computes final rate with margin:
   - `rate_num = market_rate_num * (10000 + fee_bips)`
   - `rate_den = market_rate_den * 10000`
5. Computes exact token payment:
   - `aa_payment_amount = ceil(fj_amount * rate_num / rate_den)`
6. Computes `valid_until` from current chain timestamp + `quote_validity_seconds`.
7. Signs the quote hash:
   - `computeInnerAuthWitHash([0x465043, fpc_address, accepted_asset, fj_amount, aa_payment_amount, valid_until, user])`
8. Returns the signed quote payload.

Notes:

- Quotes are user-specific (`user` must match `msg_sender` in contract execution).
- Replays are prevented on-chain by nullifying quote hash.
- The service name/config key uses `fpc_address`, but the target can be either `FPC` or `CreditFPC` because both verify the same quote preimage structure.

## Wiring to `/contracts/fpc`

Contract reference: `/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr`

How it connects:

1. `FPC.fee_entrypoint(authwit_nonce, fj_fee_amount, aa_payment_amount, valid_until, quote_sig)` expects the service quote fields directly.
2. `FPC.assert_valid_quote(...)` recomputes the same hash preimage and verifies Schnorr signature against the stored operator pubkey.
3. It enforces quote expiry and replay protection (`push_nullifier(quote_hash)`).
4. It enforces `fj_fee_amount == get_max_gas_cost_no_teardown(...)`.
5. It transfers exactly `aa_payment_amount` of `accepted_asset` from user to operator via authwit-backed `transfer_private_to_private`.

Implication: for `FPC`, clients should request `/quote` with `fj_amount = max_gas_cost_no_teardown` for the transaction they are building.

## Wiring to `/contracts/credit_fpc`

Contract reference: `/home/ametel/source/aztec-fpc/contracts/credit_fpc/src/main.nr`

How it connects:

1. `CreditFPC.pay_and_mint(authwit_nonce, fj_credit_amount, aa_payment_amount, valid_until, quote_sig)` consumes the same payload shape from `/quote`.
2. `CreditFPC.assert_valid_quote(...)` uses the same preimage format and signature verification logic as `FPC`.
3. It transfers exactly `aa_payment_amount` of `accepted_asset` from user to operator.
4. It mints exactly `fj_credit_amount` into the caller's private credit balance.
5. It immediately subtracts current `max_gas_cost_no_teardown` to pay this transaction from minted credit.

Important semantic difference:

- For `FPC`, `fj_amount` means quoted fee amount for this transaction.
- For `CreditFPC`, `fj_amount` is interpreted as `fj_credit_amount` (credit to mint), and should be chosen high enough to cover current setup cost and leave desired remaining credit.

## Single-Instance vs Multi-Instance Setup

Each attestation instance is bound to one contract address (`fpc_address`) and one accepted asset.

- If you only use `FPC`, point `fpc_address` to the `FPC` deployment.
- If you only use `CreditFPC`, point `fpc_address` to the `CreditFPC` deployment.
- If you need both simultaneously, run two attestation instances on different ports with different config files.

## Endpoints

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

### `GET /asset`

Returns configured accepted asset metadata.

Response:

```json
{
  "name": "humanUSDC",
  "address": "0x..."
}
```

### `GET /quote?user=<aztec_address>&fj_amount=<positive_u128_decimal>`

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
curl http://localhost:3000/health
curl http://localhost:3000/asset
curl "http://localhost:3000/quote?user=<aztec_address>&fj_amount=1000000"
```
