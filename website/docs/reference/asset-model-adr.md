---
title: ADR-0001, Alpha Asset Model
description: Decision record establishing that a single FPC deployment must support multiple accepted assets for Alpha.
---

# ADR-0001: Alpha Asset Model

> **Status:** Accepted, 2026-03-02, Owners: FPC maintainers
> **Normative source:** [docs/spec/adr-0001-alpha-asset-model.md](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/adr-0001-alpha-asset-model.md)

## Context

Repository and product docs had mixed two incompatible models:

1. **Single multi-asset contract deployment.** One FPC, many tokens via an on-contract allowlist.
2. **One FPC deployment per accepted asset.** A separate stack per token.

This ambiguity produced conflicting acceptance criteria, operator guidance, and implementation plans.

## Decision

For Alpha, the product model is single-deployment multi-asset.

- One FPC deployment handles multiple accepted assets.
- "USDC + ETH variants" is satisfied only when a single deployed contract instance can accept at least one USDC variant and at least one ETH variant **without redeploying** the contract for each asset.
- Deploying separate single-asset stacks per token is an interim workaround and does **not** satisfy Alpha done-criteria.

## What this changes

### Contract (on-chain)

- Multi-asset storage or model (allowlist or equivalent) in each contract.
- Admin controls for asset lifecycle (add/remove), with clear governance constraints.
- Quote binding remains user-specific **and** asset-specific. The selected payment asset is part of the quote preimage.

### Attestation service

- One attestation instance per contract deployment supports multiple assets with asset-specific rates.
- The quote API includes the selected payment asset in both the request and the response.
- Operator config supports per-asset pricing and policy via the `supported_assets` configuration.

### Top-up service

- Top-up remains keyed by fee-payer contract address, not per-asset.
- No per-asset top-up split for Fee Juice. Operational sizing must account for aggregate traffic across all accepted assets.

### Wallet integration

- Wallet discovery targets one contract endpoint plus its supported asset set. See [Wallet Discovery](../reference/wallet-discovery.md).
- The wallet quote flow selects an asset and requests a quote for that asset.

## Consequences

| Consequence | Implication |
|---|---|
| Aligns Alpha requirements with desired UX | One operator endpoint supporting common bridged assets |
| Increases implementation scope | Multi-asset support requires more work than per-deployment single-asset |
| Requires migration path | Operators running interim multi-instance setups need to consolidate to the single-deployment model |
