---
title: Glossary
description: Definitions for FPC-specific terms and the Aztec primitives FPC depends on.
---

# Glossary

Two layers of terminology appear in this documentation.

1. **FPC-specific terms** relate to concepts introduced by this project: quotes, attestation service, cold-start, `fee_bips`, and similar.
2. **Aztec primitives** are general Aztec concepts that FPC builds on: authwit, nullifier, setup phase, PXE, Fee Juice, and others.

> [!TIP]
> The Aztec Foundation maintains an [official glossary](https://docs.aztec.network/developers/docs/resources/glossary). For any term not covered here, start there.

---

## FPC-specific terms

### FPC (Fee Payment Contract)
A smart contract that pays transaction gas in [Fee Juice](#fee-juice) on behalf of a user. In return, the user pays the operator in a different token. FPC is a generic Aztec primitive. See Aztec's [Paying Fees](https://docs.aztec.network/developers/docs/aztec-js/how_to_pay_fees) documentation for the canonical definition.

### FPCMultiAsset
Nethermind's FPC implementation. A single deployed contract instance accepts multiple tokens (USDC, ETH, app tokens). Token selection is enforced through quote-binding, not an on-chain allowlist. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr#L23)

### Sponsored FPC
Aztec's canonical FPC, deployed by Aztec Labs. It pays fees unconditionally, with no charge to the user. Useful for testnet UX and app-sponsored gas.

### Attestation service
The off-chain REST API run by an FPC operator. It signs per-user [quotes](#quote) with the operator's Schnorr key, serves [wallet discovery](#wallet-discovery) metadata, and exposes admin endpoints for asset policy management. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L817). See the [API reference](../sdk.md#api-reference).

### Top-up service
A background daemon that watches the FPC contract's Fee Juice balance on L2 and bridges more from L1 when it drops below a configured threshold. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/topup/src/index.ts#L35)

### Quote
A signed message from the operator: "I will accept `aa_payment_amount` of `accepted_asset` in exchange for paying `fj_fee_amount` of Fee Juice for this user, valid until `valid_until`." Signed off-chain with Schnorr, verified on-chain.

### Quote preimage
The ordered tuple of fields hashed with Poseidon2 before signing. Two variants exist: a 7-field preimage for `fee_entrypoint` and a 9-field preimage for `cold_start_entrypoint`.

### Domain separator
A constant prepended to the hash preimage to make quotes for different entrypoints non-interchangeable. `0x465043` (`"FPC"`) for normal quotes. `0x46504373` (`"FPCs"`) for cold-start quotes. A cold-start quote fails verification in `fee_entrypoint`, and vice versa. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr#L36)

### `fee_entrypoint`
The FPC contract function for the standard fee-payment flow. The user already has L2 tokens and a deployed account. Takes a signed quote, transfers tokens from user to operator via `transfer_private_to_private`, declares the FPC as fee payer, and calls `end_setup()`. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr)

### `cold_start_entrypoint`
The FPC contract function for cold-start. The user has just bridged from L1 and has neither an L2 balance nor a deployed account. Atomically claims bridged tokens into the FPC, splits them between user and operator, and pays gas. Must be the transaction root. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr)

### Cold start
The onboarding problem: a user arrives on Aztec with bridged tokens but no Fee Juice to pay gas. The `cold_start_entrypoint` solves this in a single transaction.

### `aa_payment_amount`
The "accepted asset payment amount." How many units of the user's chosen token the FPC operator receives. Computed as `ceil(fj_fee_amount * final_rate_num / final_rate_den)`, where the final rate includes the operator's margin.

### `fj_fee_amount`
The "Fee Juice fee amount." How much Fee Juice the protocol will deduct from the FPC's balance. For `fee_entrypoint`, this must equal `get_max_gas_cost` for the transaction's gas settings. Any divergence causes the on-chain quote check to fail. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr)

### `market_rate_num` / `market_rate_den`
The operator's baseline exchange rate as a fraction: units of accepted asset per 1 Fee Juice. Configured per-asset in the attestation service.

### `fee_bips`
The operator's margin in basis points (100 = 1%, 200 = 2%). Applied on top of the market rate: `final_rate = market_rate * (10000 + fee_bips) / 10000`.

### Accepted asset
Any token the attestation service is willing to accept as payment. Managed via `PUT /admin/asset-policies/:addr`. No on-chain change required to add or remove assets.

### Wallet discovery
The `GET /.well-known/fpc.json` endpoint that lets wallets auto-configure for a given `(network_id, asset_address, fpc_address)` tuple. [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/wallet-discovery-spec.md). See the [wallet discovery specification](../reference/wallet-discovery.md).

### Auto-claim
An optional feature of the top-up service. After bridging Fee Juice from L1, it automatically submits the L2 `FeeJuice.claim()` so the FPC's balance reflects the bridged amount.

### Operator
The entity running the attestation and top-up services. Holds the Schnorr key that signs quotes and receives all token payments. Typically a wallet vendor, DeFi protocol, or infrastructure team.

### Runtime profile
A service-wide mode: `development`, `test`, or `production`. In `production`, plaintext secrets in config files are rejected, and `quote_auth_mode: disabled` is rejected.

### Secret provider
The mechanism for loading sensitive keys: `env`, `config`, `kms`, `hsm`, or `auto` (tries env then config in order). [Source](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/secret-provider.ts)

---

## Aztec primitives (used by FPC)

### Fee Juice
Aztec's native gas token. Every L2 transaction must be paid for in Fee Juice. It is non-transferable at the user level, so ordinary users rely on FPCs to pay for them. Official doc: [Fees](https://docs.aztec.network/developers/docs/foundational-topics/fees).

### PXE (Private eXecution Environment)
A component that runs locally in the user's wallet and executes private functions, then produces SNARK proofs before submitting them. Pronounced "pixie." Official doc: [PXE](https://docs.aztec.network/developers/docs/foundational-topics/pxe).

### Noir
The DSL used to write Aztec smart contracts. Rust-like syntax, compiles to SNARK circuits. Official doc: [Noir](https://docs.aztec.network/developers/noir).

### Aztec.nr
The framework built on Noir that provides Aztec-specific contract primitives (state, events, cross-chain messaging). Official doc: [Aztec.nr](https://docs.aztec.network/developers/docs/aztec-nr).

### Aztec.js
The client-side TypeScript library for interacting with Aztec (comparable to ethers.js for Ethereum). The FPC SDK wraps Aztec.js. Official doc: [Getting Started with Aztec.js](https://docs.aztec.network/developers/tutorials/codealong/js_tutorials/aztecjs-getting-started).

### Authwit (Authorization Witness)
A one-time signed authorization for a third party (like the FPC) to perform a specific action (like `transfer_private_to_private`) on behalf of the user. Consuming an authwit pushes a nullifier, preventing reuse. The FPC SDK builds this automatically when you call `createPaymentMethod`. Official doc: [Authentication Witness](https://docs.aztec.network/developers/docs/foundational-topics/advanced/authwit).

### Nullifier
A value pushed to the Aztec nullifier tree that invalidates a note (spent UTXO) or a quote (consumed). First push succeeds. Second push causes a transaction failure. FPC uses nullifiers for quote replay protection. Official doc: [Notes & Nullifiers](https://docs.aztec.network/developers/docs/concepts/storage/notes).

### Setup phase
The first phase of an Aztec transaction. Non-revertible. Execution failures here invalidate the entire transaction (it is never included in a block). FPC performs signature verification and token transfer in this phase. Official doc: [Transaction setup & teardown](https://docs.aztec.network/protocol-specs/gas-and-fees/tx-setup-and-teardown).

> [!WARNING]
> **Setup-phase irreversibility**
>
> The token transfer happens in setup. The fee is paid even if the application logic later reverts. This is inherent to the Aztec FPC model.

### App phase (execution)
The main phase of a transaction, where the user's application logic runs. Revertible: if it fails, side-effects are rolled back, but the transaction is still included in a block.

### Teardown phase
An optional final phase for refund or settlement logic. FPC does not use teardown. Quotes are priced exactly (`fj_fee_amount` == `get_max_gas_cost`), so there is no refund mechanism. Official doc: [Setup & teardown](https://docs.aztec.network/protocol-specs/gas-and-fees/tx-setup-and-teardown).

### `fee_payer`
The account or contract that pays a transaction's Fee Juice. The FPC declares itself as `fee_payer` via `set_as_fee_payer()` during setup. Official doc: [Paying Fees](https://docs.aztec.network/developers/docs/aztec-js/how_to_pay_fees).

### `msg_sender`
The caller of a function. In FPC, `fee_entrypoint` binds `msg_sender` into the quote hash, so User A's quote cannot be used by User B. `cold_start_entrypoint` requires `context.maybe_msg_sender().is_none()`, meaning the function must be the transaction root with no parent caller.

### L1-L2 message
Aztec's cross-chain communication primitive. A message posted by an L1 portal contract is later consumable on L2 (and vice versa). Cold-start depends on this: the bridge deposit becomes an L1-to-L2 message that `cold_start_entrypoint` consumes. Official doc: [L1-L2 communication](https://docs.aztec.network/developers/docs/foundational-topics/ethereum-aztec-messaging).

### Portal (L1 portal)
The Solidity contract on L1 that mirrors an L2 contract and handles L1-L2 message passing. The FPC system uses two portals: the Fee Juice portal (for top-up bridging) and the token portal (for user bridging in cold-start). Official doc: [Portals](https://docs.aztec.network/developers/docs/foundational-topics/ethereum-aztec-messaging).

### `L2AmountClaim`
The return type from `L1ToL2TokenPortalManager.bridgeTokensPrivate()`. Contains `claimAmount`, `claimSecret`, `claimSecretHash`, and `messageLeafIndex`. Pass the whole object to `executeColdStart`. Do not destructure it.

### `mint_to_private`
An Aztec Token contract pattern for minting tokens directly into a private balance. Cold-start uses this via the bridge: the FPC calls `bridge.claim_private()` to pull bridged tokens into its own private balance before redistributing. The mint amount is visible on-chain (it updates total supply), but user identities and balances remain private.

### AztecAddress
An Aztec L2 contract or account address (a `Field` element, 0x-prefixed hex). Distinct from `EthAddress` (20-byte L1 address). The SDK uses `AztecAddress.fromString()` to parse.

### Field / `Fr`
Aztec's native finite-field element type (approximately 254 bits). Used for hashes, addresses, signatures, and most on-chain data. Constructed in JS as `Fr.fromHexString(...)` or `Fr.random()`.

### `PublicImmutable<T>` / `PublicMutable<T>`
Aztec storage types. `PublicImmutable` is write-once (initialized in the constructor, never changed). The FPC uses this for its operator config. `PublicMutable` is standard mutable storage.

---

## Cryptographic primitives

### Schnorr signature
The signature scheme FPC uses for quotes. 64 bytes. Verified on-chain via `schnorr::verify_signature` against the operator's public key stored in the FPC contract's immutable config.

### Grumpkin curve
The elliptic curve Aztec uses for Schnorr signatures. Native to Aztec's proving system, unlike secp256k1 used in Ethereum.

### Poseidon2
A SNARK-friendly hash function. FPC hashes the quote preimage with Poseidon2 before signing. Much cheaper inside a circuit than SHA-256 or Keccak.

---

## Related

- [Aztec's official glossary](https://docs.aztec.network/developers/docs/resources/glossary)
- [SDK Getting Started](../sdk.md)
- [Wallet Discovery Specification](../reference/wallet-discovery.md)
