---
title: Security Model
description: Trust assumptions, key management, threat mitigations, and production hardening for the FPC system.
---

# Security Model

`aztec-fpc` operates under a trusted operator model. The operator signs all fee quotes, receives all token payments, funds the FPC with Fee Juice, and runs the attestation and top-up services.

## Trust assumptions

Users trust that the operator will:

1. **Honor signed quotes.** Enforced on-chain. The contract verifies the signature and settles the exact amounts.
2. **Keep the FPC funded.** Economic incentive: an unfunded FPC cannot process transactions, so the operator earns nothing.
3. **Offer fair rates.** Market competition. Users can compare rates across operators or bridge their own Fee Juice.

Users never give custody of their funds beyond the agreed transaction fee.

> [!CAUTION]
> **Setup-phase irreversibility: the fee is paid even if your app logic reverts**
>
> The user-to-operator token transfer executes in the Aztec setup phase (the non-revertible phase), before `end_setup()`. It is irrevocably committed at that point.
>
> Aztec supports an optional teardown phase that some FPC designs use to compute refunds; `aztec-fpc` deliberately does not. Any unused Fee Juice stays in the FPC's balance. This is a design choice, not a protocol limitation.
>
> Wallets must surface this as "fee charged even on app-level failure." App developers should simulate before sending. See [`scripts/tests/always-revert.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/always-revert.ts) for the test that confirms this behavior.

> [!WARNING]
> **No on-chain asset allowlist**
>
> The contract does not store accepted assets. Protection comes from the quote signature: `accepted_asset` is in the signed preimage, so swapping the asset at call time invalidates verification. The "multi-asset" property of `FPCMultiAsset` is off-chain policy plus quote binding, not an on-chain allowlist.

## Key management

| Key | Purpose | Stored in | Rotation |
|-----|---------|-----------|----------|
| L2 Schnorr keypair | Sign fee quotes | Attestation service config | **Requires contract redeployment** |
| L2 Schnorr pubkey | Verify quotes on-chain | FPC contract (`PublicImmutable<Config>`) | Cannot be changed |
| L1 private key | Bridge Fee Juice from L1 | Top-up service config | Config change + restart |
| Admin API key | Protect admin endpoints | Environment variable | Env var change + restart |

The L2 Schnorr key is the most sensitive. It signs every quote and its public key is baked into the contract at deploy time. Compromise means an attacker can sign arbitrary quotes (overcharging users or draining Fee Juice) and observe incoming private notes to the operator. Recovery requires deploying a new contract and updating every wallet integration.

### Secret provider modes

[Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/secret-provider.ts#L137)

| Mode | Description | Environment |
|------|-------------|-------------|
| `auto` | Try env then config; throws if neither set | Default |
| `env` | `OPERATOR_SECRET_KEY` / `L1_OPERATOR_PRIVATE_KEY` | Simple deployments |
| `config` | Plaintext in YAML config | **Development only** |
| `kms` | Cloud key management (AWS KMS, etc.) | Production |
| `hsm` | Hardware security module | High-security production |

Setting `runtime_profile: production` rejects plaintext config-file secrets at startup.

## On-chain protections

[Source](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr#L23)

| Protection | Mechanism |
|---|---|
| **Quote authenticity** | Schnorr signature verified against immutable on-chain pubkey. |
| **Replay** | Quote hash pushed as nullifier; duplicates fail. |
| **User binding** | User address is in the hash preimage (normal: `msg_sender`; cold-start: explicit `user` param). |
| **Freshness** | `anchor_block_timestamp <= valid_until`. |
| **TTL cap** | `(valid_until - anchor_block_timestamp) <= 3600`. Default `quote_validity_seconds` is 300. |
| **Fee Juice amount binding** | `fj_fee_amount == get_max_gas_cost(...)` for the tx's gas settings. |
| **Cold-start: tx-root only** | `context.maybe_msg_sender().is_none()`. No nested calls. |
| **Cold-start: claim covers fee** | `claim_amount >= aa_payment_amount`. |
| **Cold-start: extended preimage** | Adds `claim_amount` and `claim_secret_hash` to the signed hash. |
| **Cold-start: domain separation** | `0x46504373` distinct from `0x465043`. |

## Off-chain protections

| Protection | Mechanism |
|---|---|
| **Admin API auth** | `ADMIN_API_KEY` env var + `x-admin-api-key` header (constant-time compare). Disabled by default. |
| **Quote endpoint auth** | `quote_auth_mode`: `disabled` (dev only), `api_key`, `trusted_header`, or both/either. `disabled` is rejected when `runtime_profile: production`. |
| **Rate limiting** | Fixed-window on `/quote` (default on). Configure via `quote_rate_limit_*`. |
| **Plaintext secret rejection** | `runtime_profile: production` rejects plaintext config secrets at startup. |

## Threat matrix

| Threat | Mitigation |
|--------|-----------|
| Quote forgery | Schnorr signature + immutable on-chain pubkey |
| Quote replay | Nullifier per quote hash |
| Quote theft (user A uses user B's quote) | User address in hash preimage |
| Stale quotes | Expiry check + 1-hour on-chain TTL cap |
| Cross-entrypoint reuse | Different domain separators |
| Operator key compromise | KMS/HSM; recovery requires redeployment |
| Admin API abuse | API key + constant-time compare |
| Quote endpoint DoS | Rate limiting |
| Plaintext secrets in config | Rejected at startup with `runtime_profile: production` |
| FPC balance depletion | Top-up service auto-bridges from L1 |
| Top-up crash mid-bridge | LMDB persistence |
| Malicious asset address at call time | `accepted_asset` in quote preimage |
| App-logic revert bypassing fee | Fee paid in setup phase before app logic; not bypassable |
| Cold-start manipulation | Tx-root check + claim ≥ payment + extended preimage |

## Known limitations (Alpha)

- **No key rotation.** Operator key compromise requires contract redeployment.
- **Off-chain revenue tracking.** All payments arrive as private notes; the operator must use their PXE for accounting.
- **`fj_amount` must match tx gas settings exactly.** Wallets compute the quote against the same gas settings used at submission.
- **No oracle integration.** Rates are set manually in the asset policy store.
- **Single operator per contract.** No multi-operator or delegation model.

## Production checklist

- [ ] KMS or HSM for operator keys (`operator_secret_provider: kms` or `hsm`)
- [ ] `runtime_profile: production` on both services
- [ ] Attestation behind HTTPS with reverse proxy
- [ ] `quote_base_url` set explicitly so discovery returns the public URL
- [ ] Rate limiting enabled
- [ ] Alerts on FPC balance (`/ready` endpoint)
- [ ] Admin endpoints restricted to internal network
- [ ] Admin API key rotated periodically
- [ ] L1 operator account funded with ETH and Fee Juice ERC-20
- [ ] Monitor top-up logs for `CRITICAL` bridge failures
- [ ] No plaintext keys in committed manifests

## Next Steps

- [Run an FPC Operator](./how-to/run-operator.md) to apply these in production.
- [Quote System](./quote-system.md) for the full preimage and signature spec.
- [Contracts](./contracts.md) for the on-chain enforcement code.
- [Configuration Reference](./operations/configuration.md) for `runtime_profile` and secret modes.
