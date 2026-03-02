# FPC's Informal PRD for Alpha

**Author:** Alejo (Ecosystem Lead)

**Last updated:** February 2026

**Status:** Looking for a builder

**Target:** Ready for Alpha Chaos Testing (March 2-6, 2026). Hard deadline: Alpha launch (March 30).

**Architecture decision lock (2026-03-02):** See [ADR-0001](../docs/adr-0001-alpha-asset-model.md). Alpha requires single-deployment multi-asset support. One deployment per asset is a temporary workaround, not Alpha-done.

---

## Why This Exists

For Alpha, users will bridge assets (USDC, ETH) into Aztec through one of the compliant portals (Human Tech or Raven House). Once on L2, they'll want to actually use those assets: send them, interact with apps, etc.

The problem: every L2 transaction requires Fee Juice to pay for gas. Fee Juice is the Aztec token, bridged from Ethereum and converted on L2. Expecting users to separately bridge Fee Juice before they can do anything is a terrible UX. Most users will land on Aztec with humanUSDC or ravenETH, not Fee Juice.

Aztec has account abstraction and flexible fee payment built into the protocol. **Fee Payment Contracts (FPCs)** are the mechanism that makes this work: they're smart contracts on Aztec that accept a user's bridged tokens (e.g. humanUSDC) and pay the Fee Juice cost on their behalf. The user pays in the token they already have, the FPC handles the conversion.

The goal is simple: users bridge their assets and start using Aztec immediately, without ever thinking about Fee Juice.

---

## How We Got Here

We explored several options before landing on this approach:

- **Azguard (wallet provider):** Can't develop an FPC and doesn't want to own one legally.
- **Human Tech (portal team):** Open to running the infrastructure but wants to be mindful of not spreading too thin.
- **So:** We need someone to build a general-purpose, easy-to-deploy FPC service that Human Tech (and others) can run.

The vision isn't just "build an FPC for Human Tech." It's to create a repository good enough that anyone in the ecosystem can spin up their own FPC. This creates a competitive market of FPC operators, which is healthy for users and for the network.

---

## What We Need Built

An open-source, configurable FPC service composed of three main components:

### 1. FPC Smart Contract ([Aztec.nr](http://Aztec.nr))

The on-chain component that accepts user tokens and pays Fee Juice on their behalf.

- Accept payments in configurable set of tokens. Each portal mints its own wrapped tokens (humanUSDC, humanETH, ravenUSDC, ravenETH, etc.), so the FPC must support multiple assets. These tokens follow the Wonderland token standard.
- Admin controls to add/remove accepted assets.
- Configurable fee/bips so the FPC operator can take a margin.
- Ability to transfer accumulated user-paid tokens to a designated address (so the operator can move them to an account that can bridge back to L1 for treasury management). This doesn't need to be automated for MVP, just possible.
- Alpha requirement clarification: "USDC + ETH variants" means one deployed contract instance must accept at least one USDC variant and one ETH variant at the same time.

### 2. Attestation / Quote Service

A centralized service that provides price quotes for the fee-paying token relative to Fee Juice.

**For MVP:** Let the FPC runner set a fixed price for each pair (ETH/Fee Juice, USDC/Fee Juice, etc.) that can be manually updated over time. This is good enough. We don't need on-chain oracles or zkTLS for Alpha.

**For the future (not in scope now):** On-chain quotes, zkTLS-based price feeds, decentralized quoting. This is the direction we want to go eventually, but we are explicitly not asking for it now. Build the architecture so it can be swapped in later, but don't build it.

The service provides quotes and attestations that the FPC smart contract can verify.

### 3. Top-up Service

A background service that keeps the FPC funded with Fee Juice.

- Monitor the FPC's Fee Juice balance on L2.
- When balance drops below a configurable threshold, automatically bridge Fee Juice from Ethereum mainnet.
- This is what keeps the FPC operational. If it runs out of Fee Juice, users can't pay fees.

---

## Open Question: Wallet Discovery

How does the wallet (via wallet-sdk) know which attestation server to ask for a price quote? This is unresolved. The FPC builder will need to coordinate with the Azguard / wallet-sdk team on a discovery mechanism. This could be as simple as a registry contract, a well-known URL convention, or something the wallet hardcodes initially.

---

## Repository Structure

Recommendation: This should be a well-organized monorepo with clear separation:

```
/contracts      - Aztec.nr FPC smart contracts
/services
  /attestation  - Quote/attestation service
  /topup        - Fee Juice balance monitor + bridge top-up
/infra          - Docker, IaC for deployment
/docs           - How to run, configure, and deploy your own FPC
```

### Quality expectations:

- Unit tests for smart contracts and services
- E2E tests covering the full flow (user pays in token → FPC pays Fee Juice → transaction goes through)
- Docker setup so anyone can run the full stack locally or deploy it
- Clear documentation: "Here's how you spin up your own FPC in 30 minutes"

---

## What "Done" Looks Like for Alpha

A working FPC that Human Tech / Raven House can run, accepting their portal tokens, with:

- FPC smart contract deployed and accepting at least USDC and ETH variants
- Single deployment supports multiple accepted assets (USDC + ETH variants) without per-asset contract redeploys
- Attestation service running with manually-set prices
- Top-up service keeping the FPC funded
- Repo documented well enough that Raven House (or anyone else) can fork it and run their own
- Tested against Testnet

That's it. No decentralized quoting, no zkTLS, no on-chain oracles. A simple, reliable, well-documented version that works.

---

## What's Explicitly Out of Scope

To be clear about what we're NOT asking for right now:

- Decentralized price feeds / zkTLS
- On-chain oracle integration
- Automated L1 withdrawal of accumulated tokens (just needs to be transferable to a bridge-capable address)
- Fancy UI (this is infrastructure, not user-facing)

All of these are interesting future directions. The architecture should not prevent them, but we're not paying for them now.

---

## Timeline

| Milestone | Target |
| --- | --- |
| Ideal: Ready for Alpha Chaos Testing | March 2-6, 2026 |
| Hard deadline: Ready for Alpha launch | March 23, 2026 |

We need this yesterday. A simple version that works is infinitely more valuable than an ambitious version that's late. If you have to cut corners, cut them on the "future" features, not on reliability or documentation.
