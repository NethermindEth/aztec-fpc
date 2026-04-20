# Aztec FPC

**Nethermind's production multi-asset Fee Payment Contract for Aztec.**

Users pay in USDC, ETH, or your app's token. The contract pays Fee Juice. You earn the spread.

| | |
|---|---|
| **Tokens accepted** | Any token the operator configures |
| **Cold-start** | 1 TX from L1 |
| **On-chain allowlist** | None required |
| **SDK surface** | 2 methods |

[What is FPC?](./overview/what-is-fpc.md) | [GitHub](https://github.com/NethermindEth/aztec-fpc) | [Quick Start](./overview/quick-start.md)

---

## What's in the box

### Multi-Asset, Not Single-Token

Accept USDC, ETH, wstETH, or your app's native token. Token policy is off-chain and operator-controlled. Adding a new asset is a single API call, no contract upgrade required. [See the contract](./contracts/fpc-multi-asset.md)

### Cold Start: L1 to Aztec in One Transaction

User bridges tokens from L1 with no Fee Juice and no deployed account. `cold_start_entrypoint` atomically claims the bridge, splits tokens, pays gas, and delivers the remainder. This is why bridge and onboarding teams integrate FPC. [Cold-start guide](./how-to/cold-start-flow.md)

### Schnorr-Signed Quotes

Domain-separated, replay-protected quotes signed off-chain with the operator's Schnorr key, verified on-chain via Poseidon2. No front-running, no replay attacks. [Quote system](./overview/quote-system.md)

### Configurable Operator Spread

Set `fee_bips` per asset. Every quote includes your margin on top of the market rate. Earn revenue on every sponsored transaction. [Configure](./operations/configuration.md)

### Two SDK Methods, Full Coverage

`createPaymentMethod()` for users already on Aztec. `executeColdStart()` for first-tx users arriving from L1. That's the entire integration surface. [SDK docs](./sdk/getting-started.md)

```typescript
// existing user
const payment = await fpc.createPaymentMethod(
  { wallet, tokenAddress }
);
await contract.method().send({ fee: payment.fee });

// cold-start from L1
const result = await fpc.executeColdStart(
  { wallet, bridgeClaim }
);
```

---

## Start here

| You are... | Goal | Start here |
|---|---|---|
| **Wallet team / operator** | Deploy the contract, configure the attestation service, surface it in your wallet | [Integrate in a wallet](./how-to/integrate-wallet.md) |
| **dApp / DEX builder** | Use an existing FPC operator or run your own. SDK-first, two methods, done | [SDK getting started](./sdk/getting-started.md) |
| **Bridge / onboarding UX** | Claim bridged tokens, pay gas, and deliver the remainder in one atomic transaction | [Cold-start flow](./how-to/cold-start-flow.md) |
| **Auditor / security reviewer** | Quote binding, setup-phase irreversibility, replay protection, operator key custody | [Security model](./overview/security.md) |

---

## Documentation

| Section | What's covered |
|---|---|
| [Overview](./overview/what-is-fpc.md) | What FPC is, architecture, quote system, security model |
| [How-To Guides](./how-to/run-operator.md) | Run an operator, integrate a wallet, add assets, cold-start flow |
| [Contracts](./contracts/overview.md) | FPCMultiAsset, TokenBridge, Faucet contract reference |
| [Operations](./operations/configuration.md) | Configuration, deployment, Docker, testing |
| [SDK](./sdk/getting-started.md) | Getting started, API reference |
| [Services](./services/attestation.md) | Attestation service, top-up daemon |
| [Reference](./reference/glossary.md) | Glossary, metrics, test matrix, testnet deployment, wallet discovery |

---

*Aztec FPC - Nethermind - v3.0.0 - MIT License*
