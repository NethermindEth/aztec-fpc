---
title: Cold-Start Flow (Bridge Builder Guide)
description: How bridge UIs and cross-chain onboarding teams can deliver one-transaction L1 → first-tx-on-L2 experiences using FPC's cold-start entrypoint.
---

# Cold-Start Flow [From L1 bridge to first L2 tx in one shot]

> [!NOTE]
> **Audience**
>
> Bridge builders (Substance Labs / Train / Wormhole-style) and cross-chain wallet teams. The cold-start flow is **the UX problem you were solving anyway** — this page shows how FPC solves it in one transaction.


## The UX problem

Before cold-start, bridging a user from L1 to Aztec L2 looked like this:

```
User bridges USDC from L1
  ↓
Tokens appear on L2 (private, claimable)
  ↓
User can't do anything yet — needs Fee Juice to pay gas
  ↓
User must acquire Fee Juice somehow (second bridge? faucet? DEX?)
  ↓
User claims bridged USDC
  ↓
User does their first L2 action
```

Four steps, three of them UX cliffs. For a bridge UI this is **the** onboarding problem — and it's why most cross-chain flows abandon users between "funds arrived" and "first transaction."

## What cold-start gives you

```
User bridges USDC from L1
  ↓
Bridge UI calls executeColdStart()
  ↓
One L2 transaction:
  - Claims bridged USDC from the bridge
  - Pays FPC operator in USDC for gas (operator covers the Fee Juice)
  - Leaves the remainder in the user's private balance
  ↓
User has tokens AND a transaction history, ready for subsequent actions
```

One step. No intermediate "get Fee Juice somehow" cliff.

## How it differs from the standard fee flow

| | Standard `fee_entrypoint` | `cold_start_entrypoint` |
|---|---|---|
| Prerequisite | User has an existing L2 token balance + a deployed account | Neither — tokens are still on the L1→L2 bridge; account may not exist on L2 yet |
| Payment source | Private note the user already holds | The claim itself — bridged amount is split between fee + user |
| Quote endpoint | `GET /quote` | `GET /cold-start-quote` (different domain separator `"FPCs"` = `0x46504373`) |
| Quote preimage | 7 fields | 9 fields (adds `claim_amount` + `claim_secret_hash`) |
| Gas simulation | Yes (`simulate({fee:{estimateGas:true}})`) | **No** — hardcoded `Gas(5_000, 1_000_000)` (the user's account may not exist yet, so the PXE can't simulate) |

Attestation validates `claim_amount >= aa_payment_amount` before signing — a cold-start quote whose claim is too small to cover its own fee gets rejected by the service, not on-chain.

## Integration — step-by-step

### Prerequisites

You need to know the operator's FPC deployment details — FPC address, attestation URL, accepted token, operator address.

- Integrating against the Nethermind-operated testnet? → **[Testnet Deployment](../reference/testnet-deployment.md)**
- Integrating against a custom operator? → Resolve via [`.well-known/fpc.json`](../services/attestation.md#wallet-discovery) using the key `(network_id, asset_address, fpc_address)`.

### 1. Bridge the tokens from L1

Use the standard L1→L2 portal manager. The `bridgeClaim` object you get back carries everything the cold-start quote needs.

```typescript
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";

const l1Client = createExtendedL1Client(
  ["https://ethereum-sepolia-rpc.publicnode.com"],
  "0x<user_l1_private_key>",
  l1Chain,
);

const portalManager = new L1ToL2TokenPortalManager(
  EthAddress.fromString(L1_TOKEN_ADDRESS),
  EthAddress.fromString(L1_PORTAL_ADDRESS),
  undefined,
  l1Client,
  createLogger("bridge"),
);

const bridgeClaim = await portalManager.bridgeTokensPrivate(
  userAddress,         // destination on L2
  10_000_000_000_000_000n,
  false,               // mint = false (existing token)
);
```

### 2. Wait for the L1→L2 message to land

L2 can't see the bridged tokens until the L1→L2 message is included. For Aztec sandbox this is seconds; for testnet, expect up to a few minutes.

```typescript
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { Fr } from "@aztec/aztec.js/fields";

await waitForL1ToL2MessageReady(
  node,
  Fr.fromHexString(bridgeClaim.messageHash as string),
  { timeoutSeconds: 300 },
);
```

### 3. Execute cold-start

Pass the `bridgeClaim` as-is — do **not** destructure it. The SDK reads `claimAmount`, `claimSecret`, `claimSecretHash`, and `messageLeafIndex` off the object.

```typescript
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

const fpcClient = new FpcClient({
  fpcAddress: AztecAddress.fromString(FPC_ADDRESS),
  operator: AztecAddress.fromString(OPERATOR_ADDRESS),
  node,
  attestationBaseUrl: ATTESTATION_URL,
});

const result = await fpcClient.executeColdStart({
  wallet,
  userAddress,
  tokenAddress: AztecAddress.fromString(TOKEN_ADDRESS),
  bridgeAddress: AztecAddress.fromString(BRIDGE_ADDRESS),
  bridgeClaim,
});

console.log(`Tx: ${result.txHash}`);
// claimAmount is NOT on the result — read it from bridgeClaim (still in scope from step 1)
console.log(`User received: ${bridgeClaim.claimAmount - result.aaPaymentAmount}`);
console.log(`Operator received (fee): ${result.aaPaymentAmount}`);
```

## What the single tx actually does

```
cold_start_entrypoint(
  user, token, bridge,
  claim_amount, claim_secret, claim_secret_hash, message_leaf_index,
  fj_amount, aa_payment_amount, valid_until, quote_sig,
):
  1. Verify the cold-start quote (Schnorr, domain sep "FPCs", bound to msg_sender)
  2. Push quote nullifier (replay protection)
  3. Call bridge.claim_private(message_leaf_index, claim_amount, claim_secret)
     → mints claim_amount of the token to the contract
  4. Transfer aa_payment_amount (token) → operator (private)
  5. Transfer (claim_amount - aa_payment_amount) → user (private)
  6. set_as_fee_payer() + end_setup()
  7. Protocol deducts fj_amount Fee Juice from FPC's balance to pay gas
```

One proof, one tx, three private transfers (claim + user split + operator split), fees paid from the claim itself. The user never needs prior L2 state.

## Gas limits: why they're hardcoded

`executeColdStart` does **not** simulate — it uses `Gas(5_000, 1_000_000)` as a fixed upper bound. Two reasons the SDK can't simulate:

1. The user's **account may not exist on L2 yet**, so the PXE cannot simulate through a normal account entrypoint.
2. The **quote signature is a function argument**, but we need the quote to simulate — chicken-and-egg.

The hardcoded limits are the cold-start benchmark's worst case (measured DA 1,568 / L2 711,103) with safety margin. Unused Fee Juice stays in the FPC's balance — no teardown/refund phase. Re-measure after contract changes:

```bash
./profiling/setup.sh && ./profiling/run.sh
```

## Edge cases to handle in your UI

| Scenario | What happens | UI should |
|---|---|---|
| Claim amount too small to cover fee | Attestation returns HTTP 400 before signing | Tell user "bridge more" or add subsidy |
| L1→L2 message not yet ready when user clicks "continue" | SDK throws `"Message not in state"`, retries 3x internally | Show "waiting for L1 confirmation" spinner; SDK handles retry |
| Quote expired between fetch and submit | On-chain revert | Re-fetch + retry (quotes typically valid ~5 min, capped at 1 hour) |
| User already has an L2 account | Still works — cold-start is usable by any user, not just new accounts | Prefer `createPaymentMethod` if the user already has an L2 balance (cheaper, supports teardown refund) |
| Same `bridgeClaim` submitted twice | Second tx reverts (nullifier conflict) | Track submission state in your UI |

## Picking between cold-start and standard flows

Use **cold-start** when:
- The user is transacting for the first time on L2
- Tokens are arriving from an L1 bridge in this same user session
- You don't have a reliable way to know if the user already has L2 balance

Use **standard `fee_entrypoint`** (via `createPaymentMethod`) when:
- The user already has tokens on L2
- The user already has a deployed account
- You want accurate gas estimation (cold-start uses fixed limits, which will almost always overpay)

Most bridge UIs need **both**: cold-start for the first session, standard flow for returning users.

## Next steps

- [SDK — Getting Started](../sdk/getting-started.md) — full SDK context including the standard flow
- [SDK — API Reference](../sdk/api-reference.md#executecoldstart) — complete type signatures
- [Quote System](../overview/quote-system.md#cold-start) — the domain separator, 9-field preimage, and replay protection
- [Architecture](../overview/architecture.md#cold-start) — data-flow diagram across L1, attestation, and FPC
- [`examples/fpc-full-flow.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/examples/fpc-full-flow.ts) — end-to-end runnable bridge → cold-start → standard
