---
title: Glossary
description: Definitions for FPC-specific terms plus the Aztec primitives FPC depends on. Links to the official Aztec docs for deeper reading.
---

# Glossary [FPC terms + the Aztec primitives they build on]

This glossary covers two layers of terminology:

1. **FPC-specific terms** — concepts introduced by this repo (quote, attestation service, cold-start, `fee_bips`, etc.)
2. **Aztec primitives** — general Aztec concepts FPC depends on (authwit, nullifier, setup phase, PXE, Fee Juice, etc.)

> [!TIP]
> **For broader Aztec terminology**
>
> The Aztec Foundation maintains an **[official Aztec Glossary](https://docs.aztec.network/developers/docs/resources/glossary)**. When in doubt about a non-FPC term, start there.


---

## FPC-specific terms

### FPC (Fee Payment Contract)
A smart contract that pays transaction gas in [Fee Juice](#fee-juice) on behalf of a user, in exchange for the user paying the operator in a different token. A generic Aztec primitive — see Aztec's [Paying Fees](https://docs.aztec.network/developers/docs/aztec-js/how_to_pay_fees) doc for the canonical definition.

### FPCMultiAsset
Nethermind's production FPC implementation. A single deployed contract instance can accept many tokens (USDC, ETH, app tokens…) — see [the contract page](../contracts/fpc-multi-asset.md) for how that's actually enforced (hint: quote-binding, not an on-chain allowlist).

### Sponsored FPC
Aztec's canonical FPC, deployed by Aztec Labs, that pays fees unconditionally — users don't pay anything in exchange. Useful for testnet UX and app-sponsored gas. Compare to Nethermind's FPC in [What is FPC?](../overview/what-is-fpc.md).

### Attestation service
The off-chain REST API run by an FPC operator. Signs per-user [quotes](#quote) with the operator's Schnorr key, serves [wallet discovery](#wallet-discovery) metadata, and exposes admin endpoints for asset policy management. See [Attestation Service](../services/attestation.md).

### Top-up service
A background daemon that watches the FPC contract's Fee Juice balance on L2 and bridges more from L1 when it drops below a configured threshold. See [Top-up Service](../services/topup.md).

### Quote
A signed message from the operator stating: *"I'll accept `aa_payment_amount` of `accepted_asset` in exchange for paying `fj_fee_amount` of Fee Juice for this user, valid until `valid_until`."* Signed off-chain with Schnorr, verified on-chain. See [Quote System](../overview/quote-system.md).

### Quote preimage
The exact ordered tuple of fields hashed with Poseidon2 before signing — the hash is what gets Schnorr-signed. Two variants exist: a 7-field preimage for `fee_entrypoint` and a 9-field preimage for `cold_start_entrypoint`. See [Quote System](../overview/quote-system.md#quote-types).

### Domain separator
A constant prepended to the hash preimage to make quotes for different entrypoints non-interchangeable. FPC uses `0x465043` (`"FPC"`) for normal quotes and `0x46504373` (`"FPCs"`) for cold-start quotes. A cold-start quote fails verification in `fee_entrypoint` and vice versa.

### `fee_entrypoint`
The FPC contract function that handles the standard fee-payment flow — user already has L2 tokens + a deployed account. Takes a signed quote, transfers tokens user → operator, declares the FPC as fee payer. See [FPCMultiAsset](../contracts/fpc-multi-asset.md#fee_entrypoint).

### `cold_start_entrypoint`
The FPC contract function that handles the cold-start flow — user just bridged from L1 and has neither an L2 balance nor a deployed account. Atomically claims the bridged tokens into the FPC, splits them between user and operator, and pays gas. Must be the transaction root. See [Cold-Start Flow](../how-to/cold-start-flow.md).

### Cold start
The onboarding problem: a user arrives on Aztec with bridged tokens but no Fee Juice to pay gas. The [`cold_start_entrypoint`](#cold_start_entrypoint) solves it in a single transaction.

### `aa_payment_amount`
The "accepted asset payment amount" — how many units of the user's chosen token the FPC operator receives. Computed from `fj_fee_amount × market_rate × (1 + fee_bips/10000)`.

### `fj_fee_amount`
The "Fee Juice fee amount" — how much Fee Juice will be deducted from the FPC's balance to pay protocol-level gas. For `fee_entrypoint`, must equal `max_gas_cost_no_teardown` for the transaction's gas settings exactly — any divergence fails the quote check.

### `market_rate_num` / `market_rate_den`
The operator's baseline exchange rate expressed as a fraction: units of accepted asset per 1 Fee Juice. Configured per-asset in the attestation service. See [Configuration § Assets](../operations/configuration.md#assets).

### `fee_bips`
The operator's margin in basis points (100 = 1%, 200 = 2%). Added on top of the market rate: `final_rate = market_rate × (10000 + fee_bips) / 10000`.

### Accepted asset
Any token the attestation service is willing to accept as payment. Tracked per-deployment in LMDB; adding one is a `PUT /admin/asset-policies/:addr` call — no on-chain change required.

### Wallet discovery
The `GET /.well-known/fpc.json` endpoint that lets wallets auto-configure for a given `(network_id, asset_address, fpc_address)` tuple. Normative spec at [Wallet Discovery Spec](../reference/wallet-discovery.md).

### Auto-claim
An optional feature of the top-up service: after bridging Fee Juice from L1, automatically submit the L2 `FeeJuice.claim()` so the FPC's balance actually reflects the bridged amount. See [Configuration § Auto-Claim](../operations/configuration.md#auto-claim).

### Operator
The entity running the attestation + top-up services. Holds the Schnorr key that signs quotes and receives all token payments. Typically a wallet vendor, DeFi protocol, or infrastructure team. See [Run an Operator](../how-to/run-operator.md).

### Runtime profile
A service-wide mode — `development`, `test`, or `production` — that toggles strictness. In `production`, plaintext secrets in config files are rejected; `quote_auth_mode: disabled` is rejected; etc. See [Configuration § Runtime Profiles](../operations/configuration.md#runtime-profiles).

### Secret provider
The mechanism for loading sensitive keys: `env`, `config`, `kms`, `hsm`, or `auto` (try each in order). See [Security Model § Secret Provider Modes](../overview/security.md#secret-provider-modes).

---

## Aztec primitives (used by FPC)

### Fee Juice
Aztec's native gas token. Every L2 transaction must be paid for in Fee Juice; it's non-transferable at the user level, so ordinary users rely on FPCs to pay for them. Official doc: [Fees](https://docs.aztec.network/developers/docs/foundational-topics/fees).

### PXE (Private eXecution Environment)
A component that runs **locally in the user's wallet** and executes private functions + produces SNARK proofs before submitting them. Pronounced "pixie". Official doc: [PXE](https://docs.aztec.network/developers/docs/foundational-topics/pxe).

### Noir
The DSL used to write Aztec smart contracts (Rust-like syntax, compiles to SNARK circuits). Official doc: [Noir](https://docs.aztec.network/developers/noir).

### Aztec.nr
The framework built on Noir that provides Aztec-specific contract primitives (state, events, cross-chain messaging). Official doc: [Aztec.nr](https://docs.aztec.network/developers/docs/aztec-nr).

### Aztec.js
The client-side TypeScript library for interacting with Aztec (akin to ethers.js). The FPC SDK is a wrapper around Aztec.js. Official doc: [Getting Started with Aztec.js](https://docs.aztec.network/developers/tutorials/codealong/js_tutorials/aztecjs-getting-started).

### Authwit (Authorization Witness)
A one-time signed authorization for a third party (like the FPC) to perform a specific action (like `transfer_private_to_private`) on behalf of the user. Consuming an authwit pushes a nullifier, so it can't be reused. The FPC SDK builds this automatically when you call `createPaymentMethod`. Official doc: [Authentication Witness](https://docs.aztec.network/developers/docs/foundational-topics/advanced/authwit).

### Nullifier
A value pushed to the Aztec nullifier tree that "invalidates" a note (spent UTXO) or a quote (consumed). First use: pushed; second use: transaction fails. FPC uses this for quote replay protection. Official doc: [Notes & Nullifiers](https://docs.aztec.network/developers/docs/concepts/storage/notes).

### Setup phase
The first phase of an Aztec transaction — non-revertible. Execution failures here invalidate the whole tx (not included in a block). FPC does its signature verification and token transfer here. Official doc: [Transaction setup & teardown](https://docs.aztec.network/protocol-specs/gas-and-fees/tx-setup-and-teardown).

> [!WARNING]
> **Setup-phase irreversibility**
>
> Because the token transfer happens in setup, **the fee is paid even if the app logic later reverts.** See [Security Model](../overview/security.md).


### App phase (execution)
The "main" phase of a transaction, where the user's application logic runs. Revertible — if it fails, side-effects are rolled back but the tx is still included.

### Teardown phase
An optional final phase for refund/settlement logic. **FPC does not use teardown** — quotes are priced exactly (`fj_fee_amount` == `max_gas_cost_no_teardown`), so there's no refund. Official doc: [Setup & teardown](https://docs.aztec.network/protocol-specs/gas-and-fees/tx-setup-and-teardown).

### `fee_payer`
The account or contract that pays the transaction's Fee Juice. The FPC declares itself as `fee_payer` via `set_as_fee_payer()` in setup. Official doc: [Paying Fees](https://docs.aztec.network/developers/docs/aztec-js/how_to_pay_fees).

### `msg_sender`
The caller of a function. In FPC, `fee_entrypoint` binds `msg_sender` into the quote hash — so User A's quote can't be used by User B. `cold_start_entrypoint` requires `msg_sender.is_none()` — meaning the function must be the transaction root, with no parent caller.

### L1↔L2 message
Aztec's cross-chain communication primitive. A message posted by an L1 portal contract is later consumable on L2 (and vice versa). Cold-start depends on this — the bridge deposit becomes an L1→L2 message that `cold_start_entrypoint` consumes. Official doc: [L1↔L2 communication](https://docs.aztec.network/developers/docs/foundational-topics/ethereum-aztec-messaging).

### Portal (L1 portal)
The Solidity contract on L1 that mirrors an L2 contract and handles L1↔L2 message passing. The FPC system uses two portals: the Fee Juice portal (for top-up service bridging) and the token portal (for user bridging in cold-start). Official doc: [Portals](https://docs.aztec.network/developers/docs/foundational-topics/ethereum-aztec-messaging).

### `L2AmountClaim`
The return type from `L1ToL2TokenPortalManager.bridgeTokensPrivate()`. Contains `claimAmount`, `claimSecret`, `claimSecretHash`, and `messageLeafIndex` — everything the cold-start quote and `cold_start_entrypoint` need to consume the bridge message. Pass the whole object to `executeColdStart`; don't destructure.

### `mint_to_private`
An Aztec Token contract pattern for minting tokens directly into a private balance. Cold-start uses this via the bridge — the FPC calls `bridge.claim_public()` / `mint_to_private` to pull bridged tokens into its own private balance before redistributing. Caveat: the mint amount is visible on-chain (updates total supply), though user identities and balances remain private.

### AztecAddress
An Aztec L2 contract or account address (a `Field` element, 0x-prefixed hex). Distinct from `EthAddress` (20-byte L1 address). The SDK uses `AztecAddress.fromString()` to parse.

### Field / `Fr`
Aztec's native finite-field element type (≈ 254 bits). Used for hashes, addresses, signatures, and most on-chain data. Constructed in JS as `Fr.fromHexString(...)` or `Fr.random()`.

### `PublicImmutable<T>` / `PublicMutable<T>`
Aztec storage types. `PublicImmutable` is write-once (initialized in the constructor, never changed) — the FPC uses this for its operator config. `PublicMutable` is standard mutable storage.

---

## Cryptographic primitives

### Schnorr signature
The signature scheme FPC uses for quotes. 64 bytes. Verified on-chain via `schnorr::verify_signature` against the operator's public key stored in the FPC contract's immutable config.

### Grumpkin curve
The elliptic curve Aztec uses for Schnorr signatures — native to Aztec's proving system (unlike secp256k1 used in Ethereum).

### Poseidon2
A SNARK-friendly hash function. FPC hashes the quote preimage with Poseidon2 before signing. Much cheaper in a circuit than SHA-256 or Keccak.

---

## Related

- [Aztec's official glossary](https://docs.aztec.network/developers/docs/resources/glossary) — broader Aztec terminology
- [Quote System](../overview/quote-system.md) — how the quote-specific terms above fit together
- [Architecture](../overview/architecture.md) — the full system using these terms
- [Security Model](../overview/security.md) — threat mitigations using these primitives
