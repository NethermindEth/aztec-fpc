# Aztec FPC

Nethermind's multi-asset Fee Payment Contract for Aztec. Users pay transaction fees in USDC, ETH, or any operator-configured token. The FPC contract pays Fee Juice to the protocol. The operator earns the spread.

| | |
|---|---|
| **Tokens accepted** | Any token the operator configures |
| **Cold-start** | 1 tx from L1 bridge to active L2 account |
| **On-chain allowlist** | None required (quote-binding enforces asset selection) |
| **SDK surface** | 2 methods |

[GitHub](https://github.com/NethermindEth/aztec-fpc) | [SDK Getting Started](./sdk/getting-started.md) | [Testnet Deployment](./reference/testnet-deployment.md)

---

## Components

| Component | Role |
|-----------|------|
| **FPC Contract** (`FPCMultiAsset`) | On-chain fee payer. Verifies operator-signed quotes, transfers tokens from user to operator, pays Fee Juice to the protocol. |
| **Attestation Service** | REST API that signs per-user fee quotes with the operator's Schnorr key. Serves wallet discovery metadata. |
| **Top-up Service** | Monitors the FPC's Fee Juice balance on L2 and bridges more from L1 when it drops below a threshold. |
| **SDK** (`@nethermindeth/aztec-fpc-sdk`) | TypeScript client that handles quote fetching, auth-witness construction, and transaction submission. |

---

## Start Here

| You are... | Goal | Start here |
|---|---|---|
| **dApp developer** | Use an existing FPC operator or run your own | [SDK Getting Started](./sdk/getting-started.md) |
| **Wallet team / operator** | Deploy the contract, configure attestation, surface FPC in your wallet | [Testnet Deployment](./reference/testnet-deployment.md) |
| **Bridge / onboarding UX** | Claim bridged tokens, pay gas, deliver the remainder in one atomic tx | [SDK Getting Started](./sdk/getting-started.md#cold-start-flow-user-just-bridged-from-l1) |
| **Auditor** | Quote binding, setup-phase irreversibility, replay protection, operator key custody | [Glossary](./reference/glossary.md) |

---

## Documentation

| Section | Contents |
|---|---|
| [SDK](./sdk/getting-started.md) | Getting started, API reference |
| [Reference](./reference/glossary.md) | Glossary, metrics, E2E test matrix, testnet deployment, wallet discovery, asset model ADR |

---

## Quick Example

```typescript
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

// Standard flow: user already has L2 tokens
const { fee } = await fpcClient.createPaymentMethod({
  wallet,
  user: userAddress,
  tokenAddress,
  estimatedGas,
});
await contract.methods.transfer(recipient, amount).send({ fee });

// Cold-start: user just bridged from L1
const result = await fpcClient.executeColdStart({
  wallet,
  userAddress,
  tokenAddress,
  bridgeAddress,
  bridgeClaim,
});
```

---

*Aztec FPC, Nethermind, MIT License*
