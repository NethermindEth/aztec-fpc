# Add a Supported Asset

Register a new payment token with a running attestation service so users can pay fees in it. [Source: admin routes in `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L685)

> [!NOTE]
> **Prerequisites**
>
> - Attestation service running and reachable
> - `ADMIN_API_KEY` env var set on the attestation service (admin endpoints are disabled without it)
> - Token contract deployed on Aztec L2

## Steps

### Determine the exchange rate

The attestation service prices quotes using a rational fraction: `market_rate_num / market_rate_den`. This represents the number of accepted-asset units per 1 Fee Juice. [Source: `computeFinalRate` in `config.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts#L572)

For a token pegged 1:1 with Fee Juice:

```
market_rate_num: 1
market_rate_den: 1
```

For a token where 1 Fee Juice costs 0.001 tokens (e.g., a stablecoin):

```
market_rate_num: 1
market_rate_den: 1000
```

### Decide on a fee spread

The operator's margin is expressed in basis points (`fee_bips`), added on top of the market rate.

| Bips | Percentage | Charged on 1M units of fee |
|------|-----------|---------------------------|
| 50 | 0.5% | 5,000 |
| 100 | 1% | 10,000 |
| 200 | 2% | 20,000 |
| 300 | 3% | 30,000 |

The final rate formula:

```
final_rate_num = market_rate_num * (10000 + fee_bips)
final_rate_den = market_rate_den * 10000

aa_payment_amount = ceil(fj_amount * final_rate_num / final_rate_den)
```

### Register the asset via admin API

All four fields (`name`, `market_rate_num`, `market_rate_den`, `fee_bips`) are required.

```bash
curl -X PUT https://fpc.example.com/admin/asset-policies/0xTOKEN_ADDR \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "humanUSDC",
    "market_rate_num": 1,
    "market_rate_den": 1000,
    "fee_bips": 200
  }'
```

The default admin header name is `x-admin-api-key`. Override it by setting `ADMIN_API_KEY_HEADER` on the attestation service.

### Verify it was added

```bash
curl https://fpc.example.com/accepted-assets
```

The response should include the new token.

### Register via Docker (batch mode)

For initial deployments or multi-token setup, the `configure-token` subcommand reads the `tokens` section from `fpc-config.yaml` and registers each entry with the attestation service via the admin API.

```bash
export ADMIN_API_KEY=<admin_secret>

docker run \
  -e FPC_ATTESTATION_URL=<ATTESTATION_URL> \
  -e ADMIN_API_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token
```

If any token in `fpc-config.yaml` omits an `address`, the container deploys a test token stack first (L1 ERC20 + L2 Token + Bridge + Faucet), requiring `AZTEC_NODE_URL`, `L1_RPC_URL`, `FPC_DEPLOYER_SECRET_KEY`, and `FPC_L1_DEPLOYER_KEY`. If all tokens have explicit addresses, only registration happens.

## Updating an Existing Asset

Use the same `PUT` endpoint. It performs an upsert: existing entries are overwritten with the new values.

```bash
curl -X PUT https://fpc.example.com/admin/asset-policies/0xTOKEN_ADDR \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "humanUSDC",
    "market_rate_num": 2,
    "market_rate_den": 1,
    "fee_bips": 150
  }'
```

## Removing an Asset

```bash
curl -X DELETE https://fpc.example.com/admin/asset-policies/0xTOKEN_ADDR \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

The DELETE fails if this is the last remaining asset. At least one asset must always be registered.

> [!WARNING]
>
> After removing an asset, previously-signed quotes referencing it remain valid on-chain until they expire (up to 1 hour, per the 3600-second on-chain TTL cap). The FPC contract has no mechanism to revoke issued quotes. Consumed quotes are nullified, but unexpired, unconsumed quotes can still be submitted.

## Other Admin Endpoints

[Source: `server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L685)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/asset-policies` | List all supported asset policies |
| `GET` | `/admin/operator-balances` | Show operator's private token balances |
| `POST` | `/admin/sweeps` | Sweep operator tokens to a destination |

The sweep endpoint accepts `accepted_asset` (required), `destination` (optional if `treasury_destination_address` is configured), and `amount` (optional, omit to sweep the full balance). It returns `{ acceptedAsset, destination, sweptAmount, balanceBefore, balanceAfter, txHash }`.

## Troubleshooting

<details>
<summary>Quote requests fail with "asset not supported"</summary>

- Verify the asset was registered: `GET /accepted-assets`
- Check the token address is correct
- A restart may be needed if the policy store was not flushed properly

</details>

<details>
<summary>Wrong payment amounts</summary>

- Verify rate numerator and denominator match the intended exchange rate
- The rate represents accepted-asset units per 1 Fee Juice
- `fee_bips` is added on top: `final_rate = market_rate * (10000 + fee_bips) / 10000`

</details>

<details>
<summary>Admin request returns 401 or 503</summary>

- Admin endpoints return `503 Service Unavailable` when `ADMIN_API_KEY` is not set on the attestation service
- `401 Unauthorized` means the API key value does not match what the service expects
- Verify the header name matches (`x-admin-api-key` by default, or the value of `ADMIN_API_KEY_HEADER`)

</details>
