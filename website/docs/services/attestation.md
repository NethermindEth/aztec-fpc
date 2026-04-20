# Attestation Service

The off-chain REST API that signs fee quotes for users. Run by the FPC operator.

**Source:** `services/attestation/`

## What It Does

The attestation service is the operator's quote engine.

1. Receives quote requests from wallets and dApps.
2. Looks up the requested token's pricing policy.
3. Computes the payment amount using the configured exchange rate and operator margin.
4. Signs the quote with the operator's Schnorr key.
5. Returns the signed quote for on-chain verification by `FPCMultiAsset`.

---

## HTTP Endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/fpc.json` | Wallet discovery metadata |
| `GET` | `/health` | Liveness probe (`{ "status": "ok" }`) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/accepted-assets` | Supported tokens with pricing |
| `GET` | `/quote` | Request a signed fee quote |
| `GET` | `/cold-start-quote` | Request a signed cold-start quote |

### Admin

Admin endpoints are disabled by default. Enable them by setting the `ADMIN_API_KEY` environment variable. All admin requests require the `x-admin-api-key` header with constant-time comparison.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/asset-policies` | List all pricing policies |
| `PUT` | `/admin/asset-policies/:addr` | Create or update an asset policy |
| `DELETE` | `/admin/asset-policies/:addr` | Remove an asset policy (fails if it is the last one) |
| `GET` | `/admin/operator-balances` | Operator's private token balances |
| `POST` | `/admin/sweeps` | Sweep operator tokens to a destination |

---

## `GET /quote`

```
GET /quote?user=<address>&accepted_asset=<address>&fj_amount=<positive_u128_decimal>
```

Returns a user-specific signed quote. The `user` address is bound into the quote signature, so only that user can submit it on-chain.

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `user` | `string` | User's Aztec address |
| `accepted_asset` | `string` | Token address to pay with |
| `fj_amount` | `string` | Fee Juice amount as a positive u128 decimal |

### Processing

1. **Validate inputs.** Parse and validate user address, asset address, and Fee Juice amount.
2. **Check asset support.** Look up the asset in the LMDB policy store. Reject with `400 BAD_REQUEST` if unsupported.
3. **Compute payment amount.** Apply the exchange rate formula (see [Pricing Formula](#pricing-formula) below).
4. **Set expiry.** `valid_until = now + quote_validity_seconds` (default: 300s).
5. **Sign.** Compute Poseidon2 hash over the 7-field quote preimage using `computeInnerAuthWitHash` from `@aztec/stdlib/auth-witness`. Sign the 32-byte hash with the operator Schnorr key.
6. **Return.**

### Response

```json
{
    "accepted_asset": "0x...",
    "fj_amount": "1000000",
    "aa_payment_amount": "1010000",
    "valid_until": "1700000300",
    "signature": "0xabcd...1234"
}
```

All numeric fields are returned as strings to preserve u128 precision across JSON. The signature is 64 raw Schnorr bytes, hex-encoded and `0x`-prefixed.

### Error responses

Deterministic `400 BAD_REQUEST` for: missing or invalid `user`, missing or invalid `accepted_asset`, unsupported `accepted_asset`, missing or invalid `fj_amount`, and computed overflow for `aa_payment_amount`.

---

## `GET /cold-start-quote`

Extends `/quote` with two bridge-binding query parameters for users who have no existing L2 balance.

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `user` | `string` | User's Aztec address |
| `accepted_asset` | `string` | Token address |
| `fj_amount` | `string` | Fee Juice amount (u128) |
| `claim_amount` | `string` | Amount being claimed from the L1-to-L2 bridge (u128) |
| `claim_secret_hash` | `string` | Claim secret hash (0x-prefixed hex) |

### Validation

The service validates `claim_amount >= aa_payment_amount` before signing. If the bridged amount is less than the computed fee, the request is rejected.

### Response

```json
{
    "accepted_asset": "0x...",
    "fj_amount": "1000000",
    "aa_payment_amount": "1010000",
    "valid_until": "1700000300",
    "claim_amount": "5000000000",
    "claim_secret_hash": "0xabc123...",
    "signature": "0x..."
}
```

The cold-start quote uses domain separator `0x46504373` ("FPCs") instead of `0x465043` ("FPC"). This prevents cross-entrypoint replay: a cold-start quote cannot be used with `fee_entrypoint`, and vice versa. The hash preimage includes all regular quote fields plus `claim_amount` and `claim_secret_hash`.

---

## `PUT /admin/asset-policies/:assetAddress`

Adds or updates a pricing policy for a supported asset.

```json
{
    "name": "humanUSDC",
    "market_rate_num": 1,
    "market_rate_den": 1000,
    "fee_bips": 200
}
```

All fields (`name`, `market_rate_num`, `market_rate_den`, `fee_bips`) are required.

## `POST /admin/sweeps`

Sweeps operator tokens to a destination address.

```json
{
    "accepted_asset": "<TOKEN_ADDRESS>",
    "destination": "<DESTINATION_ADDRESS>",
    "amount": "5000000"
}
```

- `destination` is optional if `treasury_destination_address` is configured.
- `amount` is optional. Omit to sweep the full operator balance.
- Returns `{ acceptedAsset, destination, sweptAmount, balanceBefore, balanceAfter, txHash }`.

---

## Pricing Formula

The operator sets baseline rate values in the attestation config:

- `market_rate_num / market_rate_den`: base exchange rate (accepted-asset units per 1 Fee Juice)
- `fee_bips`: operator margin in basis points (e.g., 200 = 2%)

For multi-asset deployments, each entry in `supported_assets` may override these values with asset-specific `market_rate_num`, `market_rate_den`, and `fee_bips`.

The service computes the final rate:

```
final_rate_num = market_rate_num * (10000 + fee_bips)
final_rate_den = market_rate_den * 10000

aa_payment_amount = ceil(fj_amount * final_rate_num / final_rate_den)
```

Example: if `market_rate_num=1`, `market_rate_den=1000`, `fee_bips=200` (2%), then 1 Fee Juice = 0.00102 accepted-asset units.

For `FPC.fee_entrypoint`, the `fj_amount` must match `max_gas_cost_no_teardown` for the transaction gas settings.

---

## Wallet Discovery

The `/.well-known/fpc.json` endpoint enables automatic wallet integration. Full normative spec at [`wallet-discovery-spec.md`](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/wallet-discovery-spec.md).

```json
{
    "discovery_version": "1.0",
    "attestation_api_version": "1.0",
    "network_id": "aztec-testnet",
    "fpc_address": "0x...",
    "contract_variant": "fpc-v1",
    "quote_base_url": "https://fpc.example.com",
    "endpoints": {
        "discovery": "/.well-known/fpc.json",
        "health": "/health",
        "accepted_assets": "/accepted-assets",
        "quote": "/quote",
        "cold_start_quote": "/cold-start-quote"
    },
    "supported_assets": [
        { "address": "0x...", "name": "humanUSDC" }
    ]
}
```

Wallet lookup key is the tuple `(network_id, asset_address, fpc_address)`. `network_id` is a string (e.g., `"aztec-testnet"`), not a number. Use HTTPS for `quote_base_url` in production; HTTP is acceptable for local development.

> [!WARNING]
>
> If the attestation service sits behind a reverse proxy, set `quote_base_url` explicitly so that `/.well-known/fpc.json` returns the correct public URL. Without this, the discovery response derives its base URL from request headers, which may not reflect the external hostname.

---

## `GET /accepted-assets`

Returns the list of supported tokens.

```json
[
    { "name": "humanUSDC", "address": "0x..." },
    { "name": "ravenETH", "address": "0x..." }
]
```

---

## Authentication

### Quote endpoint

Configurable via `quote_auth_mode`:

| Mode | Description |
|------|-------------|
| `disabled` | No authentication. Development default. Rejected when `runtime_profile` is `production`. |
| `api_key` | Require API key in header (default header: `x-api-key`) |
| `trusted_header` | Trust a reverse-proxy-set header (name and expected value configured separately) |
| `api_key_or_trusted_header` | Accept either an API key or a trusted header |
| `api_key_and_trusted_header` | Require both an API key and a trusted header (headers must differ) |

### Admin endpoints

- `ADMIN_API_KEY` environment variable checked against the `x-admin-api-key` header.
- Uses constant-time comparison to prevent timing attacks.

### Rate limiting

Optional fixed-window rate limiting on the quote endpoint. Configurable window duration and max requests per window.

---

## Startup Sequence

1. Load and validate configuration from YAML + environment variables.
2. Resolve operator secret key via the configured secret provider.
3. Connect to the Aztec node (PXE).
4. Validate the FPC contract on-chain, confirming the operator pubkey matches.
5. Initialize the LMDB asset policy store.
6. Register configured assets.
7. Start the Fastify HTTP server.

---

## Key Modules

| Module | Purpose |
|--------|---------|
| `server.ts` | Fastify HTTP server, routes, quote orchestration |
| `config.ts` | YAML + env config loading and validation |
| `signer.ts` | Schnorr signing over Poseidon2 hash |
| `asset-policy-store.ts` | LMDB-backed asset pricing persistence |
| `operator-treasury.ts` | Private balance tracking and sweeps |
| `secret-provider.ts` | Multi-mode key resolution (env, config, KMS, HSM) |
| `request-schemas.ts` | Input validation schemas |
| `metrics.ts` | Prometheus instrumentation |

---

## Configuration

See [Configuration](../operations/configuration.md) for the full reference.

Key settings:

```yaml
# config.yaml
runtime_profile: production
network_id: "aztec-testnet"            # string, not number (default "aztec-alpha-local")
fpc_address: "0x..."
contract_variant: "fpc-v1"
aztec_node_url: "https://..."
operator_secret_provider: kms          # env | config | kms | hsm | auto
operator_secret_ref: "secret-manager://prod/operator"
quote_validity_seconds: 300
quote_auth_mode: api_key               # disabled (dev only) | api_key | trusted_header | ...
port: 3000

supported_assets:
  - address: "0x..."
    name: "humanUSDC"
    market_rate_num: 1
    market_rate_den: 1000
    fee_bips: 200
```

> [!TIP]
>
> In production, use `runtime_profile: production`. This rejects plaintext secrets in config files and requires `quote_auth_mode` to be something other than `disabled`.
