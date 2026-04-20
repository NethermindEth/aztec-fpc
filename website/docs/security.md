---
title: Security Model
description: Trust assumptions, key management, threat mitigations, and production hardening for the FPC system.
---

# Security Model

FPC operates under a trusted operator model. The operator signs all fee quotes, receives all token payments, funds the FPC with Fee Juice, and runs the attestation and top-up services. This page covers what users trust, how that trust is enforced, and where the model has hard edges.

## Trust assumptions

Users trust that the operator will:

1. **Honor signed quotes.** Enforced on-chain. The FPC contract verifies the signature and settles the exact amounts. The operator cannot alter terms after signing.
2. **Keep the FPC funded with Fee Juice.** Economic incentive. An unfunded FPC cannot process transactions, so the operator earns nothing.
3. **Offer fair exchange rates.** Market competition. Users can compare rates across operators or bridge their own Fee Juice.

> [!NOTE]
> Users never give custody of their funds beyond the agreed transaction fee. The FPC contract enforces exact amounts on-chain.

> [!CAUTION]
> **Setup-phase irreversibility: the fee is paid even if your app logic reverts**
>
> The user-to-operator token transfer executes directly inside the Aztec setup phase, before `end_setup()`. It is irrevocably committed at that point.
>
> If the user's subsequent app logic reverts, the fee has still been paid. There is no teardown phase and no refund. This is inherent to the Aztec FPC model, not a Nethermind design choice.
>
> Implications for integrators:
> - **Wallets** must surface this clearly. "Fee charged even on app-level failure" is a truthful description.
> - **App developers** should simulate transactions before sending. A failing transaction still costs fees.
> - **Always-revert testing** (see [`scripts/tests/always-revert.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/tests/always-revert.ts)) confirms the FPC is still paid when downstream logic reverts.

> [!WARNING]
> **No on-chain asset allowlist**
>
> The FPC contract does not store a list of accepted assets. Nothing on-chain rejects an arbitrary token address passed to `fee_entrypoint`. Protection comes from the quote signature: `accepted_asset` is in the signed `compute_inner_authwit_hash` preimage, so swapping the asset at call time invalidates signature verification. The "multi-asset" property of `FPCMultiAsset` is an off-chain policy (attestation service) plus quote binding, not an on-chain allowlist.

## Key management

### Operator keys

| Key | Purpose | Stored in | Rotation |
|-----|---------|-----------|----------|
| L2 Schnorr keypair | Sign fee quotes | Attestation service config | **Requires contract redeployment** |
| L2 Schnorr pubkey | Verify quotes on-chain | FPC contract (`PublicImmutable<Config>`) | Cannot be changed |
| L1 private key | Bridge Fee Juice from L1 | Top-up service config | Config change + restart |
| Admin API key | Protect admin endpoints | Environment variable | Env var change + restart |

The L2 Schnorr key is the most sensitive. It signs every quote and its public key is baked into the contract at deploy time. Compromise means an attacker can sign arbitrary quotes (overcharging users or draining the operator's Fee Juice) and, because the operator address also receives all payments, the attacker can observe incoming private notes. There is no on-chain key rotation. Recovery requires deploying a new contract and updating every wallet integration.

> [!CAUTION]
> The L2 Schnorr key cannot be rotated. The public key is stored as `PublicImmutable` in the FPC contract. Compromise requires redeploying the contract and updating all downstream integrations.

### Secret provider modes

[Source: `services/attestation/src/secret-provider.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/secret-provider.ts#L137)

Both the attestation and top-up services support multiple key storage backends:

| Mode | Description | Environment |
|------|-------------|-------------|
| `auto` | Try env then config in order; throws if neither is set | Default |
| `env` | `OPERATOR_SECRET_KEY` / `L1_OPERATOR_PRIVATE_KEY` environment variable | Simple deployments |
| `config` | Plaintext in YAML config file | **Development only** |
| `kms` | Cloud key management (AWS KMS, etc.) | Production |
| `hsm` | Hardware security module | High-security production |

Setting `runtime_profile: production` rejects plaintext config-file secrets. This is enforced at startup. [Source: `services/attestation/src/secret-provider.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/secret-provider.ts#L61)

## On-chain protections

[Source: `contracts/fpc/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr#L23)

### Quote authenticity

Every quote is verified via Schnorr signature against the operator public key stored immutably in the contract's config. No one else can produce valid signatures.

### Replay protection

Each quote hash is pushed as a nullifier to the Aztec state tree:

```
First use  → nullifier doesn't exist → succeeds → nullifier stored
Second use → nullifier already exists → transaction fails (nullifier conflict)
```

### User binding

Quotes include the user's address in the `compute_inner_authwit_hash` hash preimage:

- **Normal quotes:** bound to `msg_sender`
- **Cold-start quotes:** bound to the explicit `user` parameter

Signature verification fails if a different user attempts to submit the quote.

### Freshness and TTL

| Check | Rule | Purpose |
|-------|------|---------|
| Expiry | `anchor_block_timestamp <= valid_until` | Reject expired quotes |
| TTL cap | `(valid_until - anchor_block_timestamp) <= 3600` | Prevent indefinitely valid quotes (max 1 hour) |

The default `quote_validity_seconds` in the attestation service is 300 seconds (5 minutes). Practical deployments should keep this short. The 3600-second cap is a hard limit enforced on-chain.

### Fee Juice amount binding

The contract asserts `fj_fee_amount == get_max_gas_cost(...)` for the transaction's gas settings. If the wallet requests a quote with an `fj_amount` that does not match the gas settings used at submission, `fee_entrypoint` rejects with a quoted-fee mismatch.

### Cold-start guards

[Source: `cold_start_entrypoint` in `contracts/fpc/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr#L141)

| Guard | What it prevents |
|-------|-----------------|
| `context.maybe_msg_sender().is_none()` | Must be transaction root, no nested calls |
| `claim_amount >= aa_payment_amount` | User cannot be charged more than they are claiming |
| Extended hash preimage | Quote is bound to specific claim details (`claim_amount`, `claim_secret_hash`) |
| Different domain separator (`0x46504373`) | Normal quotes cannot be used for cold-start, and vice versa |

## Off-chain protections

### Admin API authentication

[Source: `services/attestation/src/server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L489)

Admin endpoints are disabled by default. Enable them by setting the `ADMIN_API_KEY` env var. All admin requests require the `x-admin-api-key` header.

- Constant-time comparison prevents timing attacks
- Serve over HTTPS in production
- Restrict admin endpoints to internal networks

### Rate limiting

[Source: `services/attestation/src/config.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/config.ts#L405)

Fixed-window rate limiting on the quote endpoint prevents abuse. Enabled by default. Configure via `quote_rate_limit_enabled`, `quote_rate_limit_max_requests`, and `quote_rate_limit_window_seconds` in the attestation service config.

### Authentication modes

| Mode | Use case |
|------|----------|
| `disabled` | Development only |
| `api_key` | Simple production deployments |
| `trusted_header` | Behind a reverse proxy that injects identity headers |
| `api_key_or_trusted_header` | Either mechanism satisfies auth |
| `api_key_and_trusted_header` | Both mechanisms required simultaneously |

Setting `runtime_profile: production` requires `quote_auth_mode != disabled`.

## Threat mitigation matrix

| Threat | Mitigation |
|--------|-----------|
| Quote forgery | Schnorr signature + immutable on-chain pubkey |
| Quote replay | Nullifier per quote hash |
| Quote theft (User A uses User B's quote) | User address in hash preimage |
| Stale quotes | Expiry check + 1-hour on-chain TTL cap |
| Cross-entrypoint reuse | Different domain separators (`0x465043` vs `0x46504373`) |
| Operator key compromise | Use KMS/HSM; compromise requires redeployment |
| Admin API abuse | API key with constant-time comparison |
| Quote endpoint DoS | Rate limiting |
| Plaintext secrets in config | Rejected when `runtime_profile: production` |
| FPC balance depletion | Top-up service auto-bridges from L1 |
| Top-up service crash mid-bridge | LMDB persistence; L1 tx still completes and L2 receives funds |
| Malicious asset address at call time | `accepted_asset` in quote preimage; tampering invalidates the signature |
| App-logic revert bypassing fee | Fee is paid in setup phase before app logic runs; not bypassable |
| Cold-start manipulation | Transaction-root check + `claim_amount >= aa_payment_amount` + extended preimage binding |

## Known limitations (Alpha)

These are constraints of the current design, not planned features:

- **No key rotation.** The packed config is `PublicImmutable`. Operator key compromise requires contract redeployment.
- **Operator tracks revenue off-chain.** All payments arrive as private notes in the operator's balance. The operator must use their PXE to discover incoming notes and maintain off-chain accounting.
- **`fj_amount` must match tx gas settings.** Wallets must request a quote where `fj_amount` equals `get_max_gas_cost` for the exact gas settings used at submission. If they diverge, `fee_entrypoint` rejects.
- **No oracle integration.** Exchange rates are set manually in the attestation service config. A service restart reloads from `config.yaml`.
- **Single operator per contract.** There is no multi-operator or delegation model.

## Production checklist

> [!TIP]
> **Before going to production**
>
> - [ ] Use KMS or HSM for operator keys (`operator_secret_provider: kms` or `hsm`)
> - [ ] Set `runtime_profile: production` (rejects plaintext secrets, requires auth mode)
> - [ ] Serve attestation behind HTTPS with a reverse proxy
> - [ ] Set `quote_base_url` in attestation config so `/.well-known/fpc.json` returns the correct public URL
> - [ ] Enable rate limiting on the quote endpoint
> - [ ] Set alerts on FPC balance (top-up readiness endpoint at `GET /ready`)
> - [ ] Monitor Prometheus metrics for anomalies
> - [ ] Restrict admin endpoints to internal network
> - [ ] Rotate admin API key periodically
> - [ ] Keep operator L1 account funded with ETH and Fee Juice tokens for bridge transactions
> - [ ] Review top-up logs for `CRITICAL` bridge failures
> - [ ] Never commit manifests or config files containing plaintext keys to version control
