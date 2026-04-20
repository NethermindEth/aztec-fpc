# Add a Supported Asset [Register a new token with the attestation service]

This guide shows how to add a new payment token to a running attestation service so users can pay fees in it.

> [!NOTE]
> **Prerequisites**
>
> - Attestation service running and reachable
> - `ADMIN_API_KEY` configured
> - Token contract deployed on Aztec L2


## Steps


### Determine the exchange rate

The attestation service prices quotes using a fraction:

```
market_rate_num / market_rate_den
```

For a token pegged 1:1 with Fee Juice:

```
market_rate_num: 1
market_rate_den: 1
```

For a token where 1 Fee Juice costs 10 tokens:

```
market_rate_num: 10
market_rate_den: 1
```

### Decide on a fee spread

The operator's fee is expressed in basis points (`fee_bips`):

| Bips | Percentage | Example on 1M units |
|------|-----------|--------------------|
| 50 | 0.5% | 5,000 |
| 100 | 1% | 10,000 |
| 300 | 3% | 30,000 |

### Register the asset via admin API

```bash
curl -X PUT https://fpc.example.com/admin/asset-policies/0xTOKEN_ADDR \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "humanUSDC",
    "market_rate_num": 1,
    "market_rate_den": 1,
    "fee_bips": 100
  }'
```

### Verify it was added

```bash
curl https://fpc.example.com/accepted-assets
```

The response should include the new token.


## Updating an Existing Asset

Use the same `PUT` endpoint — it performs upsert semantics.

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

> [!WARNING]
>
> After removing an asset, previously-signed quotes referencing it will still be valid on-chain until they expire (up to 1 hour). The FPC contract has no way to revoke issued quotes.


## Troubleshooting

<details>
<summary>Quote requests fail with "asset not supported"</summary>

- Verify the asset was registered: `GET /accepted-assets`
- Check the address is correct (checksum-sensitive)
- Restart may be needed if the policy store wasn't flushed properly

</details>

<details>
<summary>Wrong payment amounts</summary>

- Verify rate numerator and denominator are correct
- Remember rate is `fj / aa` — how much Fee Juice per unit of token
- `fee_bips` is added on top: final rate is `market × (10000 + fee_bips) / 10000`

</details>
