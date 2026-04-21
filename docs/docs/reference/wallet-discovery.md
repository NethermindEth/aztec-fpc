---
title: Wallet Discovery Specification
description: Normative spec for .well-known/fpc.json resolution, covering lookup key, required fields, resolution order, and fallback behavior.
---

# Wallet Discovery Specification (Alpha)

> **Status:** Accepted for Alpha
> **Normative source:** [docs/spec/wallet-discovery-spec.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/docs-legacy/spec/wallet-discovery-spec.md)

This is the minimum wallet-discovery contract for resolving attestation endpoints. It is normative for Alpha. Wallets and SDKs must implement it exactly.

## Lookup Key

Discovery is keyed by this exact tuple. If any field is missing, discovery must fail. No partial lookups are allowed.

```
(network_id, asset_address, fpc_address)
```

Normalization rules:

| Field | Rule |
|---|---|
| `network_id` | Exact string match, case-sensitive (e.g. `"aztec-testnet"`, not a numeric chain id) |
| `asset_address` | Lowercase, `0x`-prefixed Aztec address string |
| `fpc_address` | Lowercase, `0x`-prefixed Aztec address string |

## Discovery Document

[Source: `services/attestation/src/server.ts` (lines 551-566)](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L551)

Each candidate attestation host must expose:

```
GET /.well-known/fpc.json
```

### Required fields

| Field | Type | Rule |
|---|---|---|
| `discovery_version` | string | Alpha fixed value: `"1.0"` |
| `attestation_api_version` | string | Alpha fixed value: `"1.0"` |
| `network_id` | string | Must exactly match the lookup key |
| `fpc_address` | string | Must exactly match the lookup key |
| `contract_variant` | string | Contract flavor identifier (e.g. `"fpc-v1"`) |
| `quote_base_url` | string | Absolute base URL for the quote API. HTTPS required outside localhost/dev. |
| `endpoints` | object | Required relative paths: `discovery`, `health`, `accepted_assets`, `quote`, `cold_start_quote` |
| `supported_assets` | array | Non-empty. Each entry is `{ address, name }` with `address` in lowercase `0x` form. |

## Resolution Order

Given `(network_id, asset_address, fpc_address)`:

### 1. Build an ordered candidate `quote_base_url` list

In priority order:

1. Exact override entry for `(network_id, asset_address, fpc_address)` from wallet/dapp config
2. Exact wallet-registry entries for `(network_id, fpc_address)`
3. Network defaults for `(network_id, asset_address)` marked `is_default=true`

### 2. Validate each candidate

For each `quote_base_url`, fetch `/.well-known/fpc.json` and check all of:

- Required fields exist and parse correctly
- `discovery_version == "1.0"`
- `attestation_api_version == "1.0"`
- `network_id` and `fpc_address` exactly match the lookup input
- `asset_address` exists in `supported_assets[].address`

### 3. First valid document wins

Stop and use it.

### 4. Fallback behavior

On any of:
- Timeout
- Transport error
- Non-2xx HTTP status
- Validation failure

Continue to the next candidate.

**If all candidates fail:** fail closed (`DISCOVERY_NOT_FOUND`) and do **not** call `/quote`.

> [!CAUTION]
> **No silent fallback**
>
> A wallet must never fall back to a record with a different `network_id`, `asset_address`, or `fpc_address`. The user selected the operator and asset explicitly. Swapping silently is a security risk because a different operator could be malicious or offline.

## Example Payload

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
    "accepted_assets": "/accepted-assets",
    "quote": "/quote",
    "cold_start_quote": "/cold-start-quote"
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

Single-asset deployments still use `supported_assets` as an array of length 1.

## What is NOT in the discovery document

The operator's Aztec address is **not** in `.well-known/fpc.json`. Wallets need it separately because the SDK builds the token-transfer authwit `user -> operator` off-chain. Passing a wrong operator makes the authwit invalid.

Sources for the operator address:

- The operator's documentation or integration guide
- Token manifest (if tokens were deployed via `configure-token`)
- Reading the FPC contract's `config` storage slot on-chain
