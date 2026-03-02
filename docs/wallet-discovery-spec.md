# Wallet Discovery Spec (Alpha)

> **Status:** Accepted for Alpha
> **Last updated:** 2026-03-02
> **Related:** #134, #135, [ADR-0001](./adr-0001-alpha-asset-model.md)

---

## 1. Scope

This document defines the minimum wallet discovery contract for attestation endpoints in Alpha.

Discovery lookup is keyed by:
- `network_id`
- `asset_address`
- `fpc_address`

The output must include:
- quote base URL
- endpoint paths
- schema/API versions

---

## 2. Lookup Key (Required Inputs)

Wallets resolve attestation metadata using this exact tuple:

```
(network_id, asset_address, fpc_address)
```

Normalization rules:
- `network_id`: exact string match (case-sensitive)
- `asset_address`: lowercase `0x`-prefixed Aztec address string
- `fpc_address`: lowercase `0x`-prefixed Aztec address string

If any key is missing, discovery must fail (no partial lookups).

---

## 3. Discovery Document

Each candidate attestation host must expose:

```
GET /.well-known/fpc.json
```

Required JSON fields:

| Field | Type | Rule |
|---|---|---|
| `discovery_version` | string | Discovery schema version. Alpha fixed value: `"1.0"` |
| `attestation_api_version` | string | Attestation API contract version. Alpha fixed value: `"1.0"` |
| `network_id` | string | Must exactly match lookup key `network_id` |
| `fpc_address` | string | Must exactly match lookup key `fpc_address` |
| `contract_variant` | string | Contract flavor identifier (for example `fpc-v1`, `credit-fpc-v1`) |
| `quote_base_url` | string | Absolute base URL for quote API (HTTPS required outside localhost/dev) |
| `endpoints` | object | Required relative paths: `discovery`, `health`, `asset`, `quote` |
| `supported_assets` | array | Non-empty array of `{ address, name }`; each `address` lowercase `0x` form |

---

## 4. Resolution Order and Fallback

Given `(network_id, asset_address, fpc_address)`, wallet resolution is:

1. Build ordered candidate `quote_base_url` list:
   - exact override entry for `(network_id, asset_address, fpc_address)` (wallet/dapp config)
   - exact wallet-registry entries for `(network_id, fpc_address)`
   - network defaults for `(network_id, asset_address)` marked `is_default=true`
2. For each candidate, fetch `/.well-known/fpc.json` and validate:
   - required fields exist and parse
   - `discovery_version == "1.0"`
   - `attestation_api_version == "1.0"`
   - `network_id` and `fpc_address` exactly match lookup input
   - `asset_address` exists in `supported_assets[].address`
3. First valid document wins.
4. Fallback behavior:
   - On timeout, transport error, non-2xx, or validation failure: continue to next candidate.
   - If all candidates fail: fail closed (`DISCOVERY_NOT_FOUND`) and do not call `/quote`.

No silent fallback to a record with different `network_id`, `asset_address`, or `fpc_address` is allowed.

---

## 5. Example Payload

Concrete `GET /.well-known/fpc.json` response:

```json
{
  "discovery_version": "1.0",
  "attestation_api_version": "1.0",
  "network_id": "aztec-alpha-sepolia",
  "fpc_address": "0x2f4d245729f8d1bc8d6abfe11c7f5e6d3c19bb2aa07c7e33afec11b1047d90a1",
  "contract_variant": "fpc-v1",
  "quote_base_url": "https://attestation.alpha.operator.example",
  "endpoints": {
    "discovery": "/.well-known/fpc.json",
    "health": "/health",
    "asset": "/asset",
    "quote": "/quote"
  },
  "supported_assets": [
    {
      "address": "0x0b74e8fbde6ca5d3830d60fbe9e347ccf0367f77d7e5b5f30b5e2c7d0c2e1aa0",
      "name": "humanUSDC"
    },
    {
      "address": "0x1a3ce5ef7f822f6a4395ec4e4cf8f79c8fa7cc50c4d7f9d1246d17fcb21d44b9",
      "name": "ravenETH"
    }
  ]
}
```

Single-asset interim deployments are represented with `supported_assets` length `1`.
