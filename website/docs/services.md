# Services

Two off-chain services support the FPC contract: the attestation service (quote signing) and the top-up service (Fee Juice bridging).

## Attestation Service

The off-chain REST API that signs fee quotes for users. Run by the FPC operator.

**Source:** [`services/attestation/`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/)

### What It Does

The attestation service is the operator's quote engine.

1. Receives quote requests from wallets and dApps.
2. Looks up the requested token's pricing policy.
3. Computes the payment amount using the configured exchange rate and operator margin.
4. Signs the quote with the operator's Schnorr key.
5. Returns the signed quote for on-chain verification by `FPCMultiAsset`.

---

### HTTP Endpoints

[Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts)

#### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/fpc.json` | Wallet discovery metadata |
| `GET` | `/health` | Liveness probe (`{ "status": "ok" }`) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/accepted-assets` | Supported tokens with pricing |
| `GET` | `/quote` | Request a signed fee quote |
| `GET` | `/cold-start-quote` | Request a signed cold-start quote |

#### Admin

Admin endpoints are disabled by default. Enable them by setting the `ADMIN_API_KEY` environment variable. All admin requests require the `x-admin-api-key` header with constant-time comparison. When disabled, admin endpoints return `503 Service Unavailable`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/asset-policies` | List all pricing policies |
| `PUT` | `/admin/asset-policies/:assetAddress` | Create or update an asset policy |
| `DELETE` | `/admin/asset-policies/:assetAddress` | Remove an asset policy (fails if it is the last one) |
| `GET` | `/admin/operator-balances` | Operator's private token balances |
| `POST` | `/admin/sweeps` | Sweep operator tokens to a destination |

---

### `GET /quote`

[Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L581) | [Signer: `signer.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/signer.ts#L88)

```
GET /quote?user=<address>&accepted_asset=<address>&fj_amount=<positive_u128_decimal>
```

Returns a user-specific signed quote. The `user` address is bound into the quote signature, so only that user can submit it on-chain.

#### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `user` | `string` | User's Aztec address |
| `accepted_asset` | `string` | Token address to pay with |
| `fj_amount` | `string` | Fee Juice amount as a positive u128 decimal |

#### Processing

1. **Validate inputs.** Parse and validate user address, asset address, and Fee Juice amount.
2. **Check asset support.** Look up the asset in the LMDB policy store. Reject with `400 BAD_REQUEST` if unsupported.
3. **Compute payment amount.** Apply the exchange rate formula (see [Pricing Formula](#pricing-formula) below).
4. **Set expiry.** `valid_until = now + quote_validity_seconds` (default: 300s, max: 3600s).
5. **Sign.** Compute Poseidon2 hash over the 7-field quote preimage using `computeInnerAuthWitHash` from `@aztec/stdlib/auth-witness`. Sign the 32-byte hash with the operator Schnorr key.
6. **Return.**

#### Response

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

#### Error responses

Deterministic `400 BAD_REQUEST` for: missing or invalid `user`, missing or invalid `accepted_asset`, unsupported `accepted_asset`, missing or invalid `fj_amount`, and computed overflow for `aa_payment_amount`.

---

### `GET /cold-start-quote`

[Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L881) | [Signer: `signer.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/signer.ts#L132)

Extends `/quote` with two bridge-binding query parameters for users who have no existing L2 balance.

#### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `user` | `string` | User's Aztec address |
| `accepted_asset` | `string` | Token address |
| `fj_amount` | `string` | Fee Juice amount (u128) |
| `claim_amount` | `string` | Amount being claimed from the L1-to-L2 bridge (u128) |
| `claim_secret_hash` | `string` | Claim secret hash (0x-prefixed hex) |

#### Validation

The service validates `claim_amount >= aa_payment_amount` before signing. If the bridged amount is less than the computed fee, the request is rejected.

#### Response

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

### `PUT /admin/asset-policies/:assetAddress`

[Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L685)

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

### `POST /admin/sweeps`

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

### Pricing Formula

[Source: `config.ts` `computeFinalRate`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts#L572)

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

For `FPC.fee_entrypoint`, the `fj_amount` must match `get_max_gas_cost` for the transaction gas settings.

---

### Wallet Discovery

[Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L551)

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

### `GET /accepted-assets`

Returns the list of supported tokens.

```json
[
    { "name": "humanUSDC", "address": "0x..." },
    { "name": "ravenETH", "address": "0x..." }
]
```

---

### Authentication

[Source: `config.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts#L385) | [Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L489)

#### Quote endpoint

Configurable via `quote_auth_mode`:

| Mode | Description |
|------|-------------|
| `disabled` | No authentication. Development default. Rejected when `runtime_profile` is `production`. |
| `api_key` | Require API key in header (default header: `x-api-key`) |
| `trusted_header` | Trust a reverse-proxy-set header (name and expected value configured separately) |
| `api_key_or_trusted_header` | Accept either an API key or a trusted header |
| `api_key_and_trusted_header` | Require both an API key and a trusted header (headers must differ) |

#### Admin endpoints

- `ADMIN_API_KEY` environment variable checked against the `x-admin-api-key` header.
- Uses constant-time comparison to prevent timing attacks.

#### Rate limiting

Optional fixed-window rate limiting on the quote endpoint. Configurable window duration and max requests per window.

---

### Startup Sequence

[Source: `index.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/index.ts#L35)

1. Load and validate configuration from YAML + environment variables.
2. Resolve operator secret key via the configured secret provider.
3. Connect to the Aztec node (PXE) and wait for readiness.
4. Validate the FPC contract on-chain, confirming the operator pubkey matches.
5. Initialize the LMDB asset policy store.
6. Register configured assets.
7. Start the Fastify HTTP server.

---

### Key Modules

| Module | Purpose | Source |
|--------|---------|--------|
| `server.ts` | Fastify HTTP server, routes, quote orchestration | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts) |
| `config.ts` | YAML + env config loading and validation | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts) |
| `signer.ts` | Schnorr signing over Poseidon2 hash | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/signer.ts) |
| `asset-policy-store.ts` | LMDB-backed asset pricing persistence | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/asset-policy-store.ts) |
| `operator-treasury.ts` | Private balance tracking and sweeps | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/operator-treasury.ts) |
| `secret-provider.ts` | Multi-mode key resolution (env, config, KMS, HSM) | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/secret-provider.ts) |
| `request-schemas.ts` | Input validation schemas | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/request-schemas.ts) |
| `metrics.ts` | Prometheus instrumentation | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/metrics.ts) |

---

### Configuration

[Source: `config.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts)

See [Configuration](./operations/configuration.md) for the full reference.

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

## Top-up Service

Background daemon that monitors the FPC's Fee Juice balance on L2 and bridges more from L1 when it runs low.

**Source:** [`services/topup/`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/)

### What It Does

The FPC contract needs Fee Juice to pay gas on behalf of users. Without it, all `fee_entrypoint` calls fail. The top-up service prevents that by polling the balance and bridging automatically.

1. Periodically reads the FPC's Fee Juice balance on L2.
2. When the balance drops below `threshold`, bridges `top_up_amount` via `L1FeeJuicePortalManager.bridgeTokensPublic(...)` on L1.
3. Persists bridge state to LMDB for crash recovery.
4. Waits for L1-to-L2 message readiness, with a balance-delta fallback as the final confirmation signal.
5. Optionally auto-claims bridged tokens on L2.

---

### Operational Flow

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

### Bridge Mechanics

1. The service builds an L1 wallet client and uses `L1FeeJuicePortalManager.new(node, client, logger)`.
2. The manager performs Fee Juice token approval and portal deposit, returning L1-to-L2 message metadata.
3. The service waits for L1-to-L2 message readiness (`waitForL1ToL2MessageReady`) using the returned message hash.
4. The service also polls the FPC's Fee Juice balance and treats a positive balance delta as the final fallback confirmation signal.

`l1_chain_id` and Fee Juice L1 contract addresses are derived from `nodeInfo`. The service validates that the configured `l1_rpc_url` matches the node's L1 chain id at startup.

> [!NOTE]
>
> For `aztec start --local-network`, Fee Juice L1 contracts are bootstrap-provisioned by local-network. Discover them from node info; do not add a manual custom L1 Fee Juice deployment step.

---

### L1 Funding Prerequisite

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

### Crash Recovery

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

### Auto-Claim

After the top-up service bridges Fee Juice from L1, the tokens must be claimed on L2. Auto-claim handles this automatically.

| Setting | Description |
|---------|-------------|
| `TOPUP_AUTOCLAIM_ENABLED` | Enable auto-claim (enabled unless set to `0`) |
| `TOPUP_AUTOCLAIM_SECRET_KEY` | L2 secret key for the claimer account |
| `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` | Use a sponsored FPC to pay claim tx fees |

In `development` profile, if `TOPUP_AUTOCLAIM_SECRET_KEY` is not set, the service falls back to the first test account from `@aztec/accounts/testing`. In `production`, an explicit secret key is required.

---

### Configuration

[Source: `config.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/config.ts#L136)

See [Configuration](./operations/configuration.md) for the full reference.

| Field | Description |
|-------|-------------|
| `fpc_address` | FPC contract on L2 |
| `aztec_node_url` | PXE/node RPC |
| `l1_rpc_url` | L1 Ethereum RPC |
| `l1_operator_private_key` | L1 wallet key (can be supplied via env, config, or secret provider) |
| `l1_operator_secret_provider` | Secret source strategy (`auto`, `env`, `config`, `kms`, `hsm`) |
| `runtime_profile` | `development`, `test`, or `production` (production rejects plaintext config secrets) |
| `threshold` | Bridge when balance below this value (bigint string, wei units) |
| `top_up_amount` | Amount to bridge per event (bigint string, wei units); must be >= threshold |
| `check_interval_ms` | Polling interval in milliseconds (default 60000) |
| `data_dir` | LMDB directory for crash-recovery state (default `.topup-data`) |
| `confirmation_timeout_ms` | Max wait for L1-to-L2 settlement (default 180000ms) |
| `confirmation_poll_initial_ms` | Initial poll interval (default 1000ms) |
| `confirmation_poll_max_ms` | Max poll interval with backoff (default 15000ms) |
| `ops_port` | Health/readiness/metrics port (default 3001, env: `TOPUP_OPS_PORT`) |

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

### Ops Endpoints

[Source: `ops.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/ops.ts#L228)

Default port: `3001` (overridable via `TOPUP_OPS_PORT` env var)

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness: returns 200 if the process is running |
| `GET /ready` | Readiness: tracks successful checks and staleness (200 = ready, 503 = not ready) |
| `GET /metrics` | Prometheus metrics |

### Prometheus Metrics

[Source: `ops.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/ops.ts#L42)

| Metric | Type | Description |
|--------|------|-------------|
| `topup_bridge_events_total` | Counter | Bridge lifecycle events (submitted, confirmed, timeout, aborted, failed) |
| `topup_balance_checks_total` | Counter | Balance checks by outcome (success, error) |
| `topup_readiness_status` | Gauge | 1 = ready, 0 = not ready |
| `topup_uptime_seconds` | Gauge | Service uptime in seconds |

---

### Key Modules

| Module | Purpose | Source |
|--------|---------|--------|
| `checker.ts` | Periodic balance check loop | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/checker.ts) |
| `bridge.ts` | L1 portal bridge submission | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/bridge.ts) |
| `confirm.ts` | L1-to-L2 message confirmation polling | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/confirm.ts) |
| `state.ts` | LMDB state management | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/state.ts) |
| `reconcile.ts` | Startup bridge reconciliation | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/reconcile.ts) |
| `autoclaim.ts` | Automatic L2 token claiming | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/autoclaim.ts) |
| `fund-claimer-l2.ts` | Fund the autoclaim account | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/fund-claimer-l2.ts) |
| `l1.ts` | L1 chain ID validation against Aztec node | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/l1.ts) |
| `monitor.ts` | Fee Juice balance reader (wraps Aztec node) | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/monitor.ts) |
| `config.ts` | YAML + env config loading | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/config.ts) |
| `secret-provider.ts` | L1 operator key resolution | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/secret-provider.ts) |
| `ops.ts` | Health, readiness, and metrics endpoints | [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/ops.ts) |

---

### Local-Network Troubleshooting

#### Stale hardcoded addresses

**Symptom:** Quote or address mismatch, or top-up failures after local-network restart.

**Check:** Compare configured addresses with fresh `nodeInfo`.

**Fix:** Remove hardcoded Fee Juice addresses and regenerate runtime config from the current deploy/node output.

#### L1 chain-id mismatch

**Symptom:** Top-up startup or bridge submission fails with chain mismatch errors.

**Check:** Confirm the `l1_rpc_url` chain id matches the node-reported L1 chain id.

**Fix:** Point `l1_rpc_url` to the L1 RPC associated with the active local-network instance.

#### Fee Juice portal/address mismatch

**Symptom:** Bridge submission succeeds on L1 but no expected Fee Juice balance increase on L2.

**Check:** Verify Fee Juice token and portal addresses against the node-reported L1 contract addresses.

**Fix:** Use node-derived Fee Juice addresses. Avoid manual overrides for local-network.
