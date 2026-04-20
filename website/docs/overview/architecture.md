# Architecture [How the four layers of FPC work together]

The FPC system has four layers that work together to abstract gas payments.

> [!TIP]
> **Where do you fit?**
>
> - **Wallet team** (Azguard, Obsidion-style) — you run all four layers yourself: deploy the contract, run attestation + top-up, integrate the SDK in your wallet UI.
> - **dApp or DEX** (Shieldswap, Nemi-style) — you use the SDK against an operator you trust (or run your own attestation service). You never touch the contract directly.
> - **Bridge builder** (Substance Labs, TRAIN, Wormhole-style) — you use the SDK's `executeColdStart()`. The [Cold-Start flow diagram](#cold-start) below is the one that matters to you.


## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      USER / WALLET                      │
│                                                         │
│  1. User wants to transact on Aztec L2                  │
│  2. Wallet uses SDK to fetch a fee quote                │
│  3. Transaction includes FPC as fee payer               │
└────────────────────────┬────────────────────────────────┘
                         │
           ┌─────────────┼─────────────────┐
           │             │                 │
           ▼             ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
│  Attestation │ │ FPC Contract │ │  Top-up Service      │
│  Service     │ │  (on-chain)  │ │                      │
│              │ │              │ │  Monitors FPC balance │
│  Signs fee   │ │  Verifies    │ │  Bridges Fee Juice   │
│  quotes      │ │  signatures  │ │  from L1 when low    │
│              │ │  Pays gas    │ │                      │
└──────────────┘ └──────────────┘ └──────────┬───────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │   L1 (Ethereum)  │
                                    │   Fee Juice      │
                                    │   Portal         │
                                    └──────────────────┘
```

## Component Roles

### FPC Contract (on-chain)

The core smart contract deployed on Aztec L2. Written in Noir (Aztec.nr).

**Responsibilities:**
- Holds a Fee Juice balance to pay gas on behalf of users
- Verifies Schnorr-signed fee quotes from the operator
- Transfers the user's payment token to the operator
- Declares itself as fee payer for the transaction
- Nullifies quotes to prevent replay

**Two entrypoints:**
- `fee_entrypoint` — Standard flow for existing L2 users
- `cold_start_entrypoint` — New users claiming bridged L1 tokens

### Attestation Service (off-chain)

A Fastify REST API run by the FPC operator.

**Responsibilities:**
- Accepts quote requests from users/wallets
- Computes exchange rates (token X → Fee Juice)
- Signs quotes with the operator's Schnorr private key
- Serves wallet discovery metadata at `/.well-known/fpc.json`
- Manages asset pricing via admin endpoints
- Exposes Prometheus metrics

### Top-up Service (off-chain)

A background daemon ensuring the FPC never runs dry.

**Responsibilities:**
- Periodically checks the FPC's Fee Juice balance on L2
- Bridges Fee Juice from L1 when balance drops below threshold
- Tracks in-flight bridges in LMDB for crash recovery
- Optionally auto-claims bridged tokens on L2

### SDK (client-side)

A TypeScript library wrapping the attestation API and Aztec.js.

**Responsibilities:**
- Fetches quotes from the attestation service
- Constructs `FeePaymentMethod` objects for Aztec.js
- Handles authorization witnesses (authwits) for token transfers
- Supports both standard and cold-start flows

## Data Flows

### Standard Fee Payment

```
User Wallet                 Attestation Service       Aztec L2 (FPC)
    │                              │                        │
    │  1. GET /quote               │                        │
    │─────────────────────────────►│                        │
    │                              │                        │
    │  2. Signed quote             │                        │
    │◄─────────────────────────────│                        │
    │                              │                        │
    │  3. Submit tx with FPC fee payer                      │
    │──────────────────────────────────────────────────────►│
    │                              │                        │
    │                              │  4. fee_entrypoint()   │
    │                              │  - Verify Schnorr sig  │
    │                              │  - Nullify quote       │
    │                              │  - Transfer token      │
    │                              │  - Pay gas             │
    │                              │                        │
    │  5. Tx confirmed                                      │
    │◄──────────────────────────────────────────────────────│
```

### Cold Start

```
User (from L1)              Attestation Service       Aztec L2 (FPC + Bridge)
    │                              │                        │
    │  0. Bridge tokens L1→L2     │                        │
    │                              │                        │
    │  1. GET /quote (cold-start) │                        │
    │─────────────────────────────►│                        │
    │                              │                        │
    │  2. Signed cold-start quote │                        │
    │◄─────────────────────────────│                        │
    │                              │                        │
    │  3. Submit cold_start tx                              │
    │──────────────────────────────────────────────────────►│
    │                              │                        │
    │                              │  4. cold_start_entry() │
    │                              │  - Claim from bridge   │
    │                              │  - Split: user + op    │
    │                              │  - Pay gas             │
    │                              │                        │
    │  5. User has L2 tokens                                │
    │◄──────────────────────────────────────────────────────│
```

### Top-up

```
Top-up Service              L1 (Ethereum)             Aztec L2
    │                              │                        │
    │  1. Check FPC balance                                 │
    │──────────────────────────────────────────────────────►│
    │                              │                        │
    │  2. Balance < threshold      │                        │
    │                              │                        │
    │  3. Bridge Fee Juice         │                        │
    │─────────────────────────────►│                        │
    │                              │                        │
    │  4. Persist to LMDB          │                        │
    │                              │                        │
    │  5. Poll for confirmation                             │
    │──────────────────────────────────────────────────────►│
    │                              │                        │
    │  6. Auto-claim (optional)                             │
    │──────────────────────────────────────────────────────►│
    │                              │                        │
    │  7. Clear state              │                        │
```

## Interface Map

| From | To | Interface | Protocol |
|------|----|-----------|----------|
| Wallet/SDK | Attestation | HTTP REST | `GET /quote`, `GET /cold-start-quote`, `GET /accepted-assets`, `GET /.well-known/fpc.json` |
| Wallet/SDK | FPC Contract | Aztec tx | `fee_entrypoint()`, `cold_start_entrypoint()` |
| Top-up | L1 Portal | Ethereum tx | `L1FeeJuicePortalManager.bridgeTokensPublic()` |
| Top-up | Aztec L2 | Aztec tx | `FeeJuice.claim()` (auto-claim) |
| Attestation | Aztec Node | PXE RPC | Gas estimation, operator note discovery, `node_getNodeInfo` |
| FPC Contract | Token Contract | Aztec call (private) | `transfer_private_to_private(user → operator, amount, nonce)` |

## Operator Model

A single **operator** runs both off-chain services and holds the keys:

| Key | Purpose | Rotation |
|-----|---------|----------|
| **L2 Schnorr keypair** | Signs quotes; pubkey stored immutably in FPC | Requires redeployment |
| **L1 private key** | Bridges Fee Juice from L1 | Config change + restart |
| **Admin API key** | Protects attestation admin endpoints | Env var change + restart |

The operator earns revenue from the spread between Fee Juice cost and token payment (`fee_bips`).

> [!TIP]
>
> For production deployments, use **KMS or HSM** for operator keys. See [Security Model](../overview/security.md) for details.

