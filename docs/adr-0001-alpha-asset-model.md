# ADR-0001: Alpha Asset Model

- Status: Accepted
- Date: 2026-03-02
- Owners: FPC maintainers
- Related issue: #132

## Context

Repository and product docs have mixed two models:

1. single multi-asset contract deployment, and
2. one FPC deployment per accepted asset.

This ambiguity causes conflicting acceptance criteria, operator guidance, and implementation planning.

## Decision

For Alpha, the product model is:

- One FPC deployment should handle multiple accepted assets.
- One CreditFPC deployment should handle multiple accepted assets.
- "USDC + ETH variants" is satisfied only when a single deployed contract instance can accept at least one USDC variant and at least one ETH variant without redeploying the contract for each asset.
- Deploying separate single-asset stacks per token is an interim workaround and does not satisfy Alpha done criteria.

## Implications

### Contract

- Add multi-asset storage/model (allowlist or equivalent) in each contract.
- Add admin controls for asset lifecycle (for example add/remove asset), with clear governance constraints.
- Keep quote binding user-specific and asset-specific (selected payment asset remains in quote preimage).

### Attestation

- One attestation instance per contract deployment must support multiple assets and asset-specific rates.
- Quote API must include the selected payment asset in request/response contract.
- Operator config must support per-asset pricing and policy.

### Top-up

- Top-up remains keyed by fee-payer contract address.
- No per-asset top-up split is required for Fee Juice, but operational sizing must account for aggregate traffic across all accepted assets.

### Wallet integration

- Wallet discovery should target one contract endpoint plus its supported asset set.
- Wallet quote flow must select an asset and request a quote for that asset.

## Consequences

- Aligns Alpha requirements with desired UX (single operator endpoint supporting common bridged assets).
- Increases implementation scope versus current single-asset-per-deployment contracts.
- Requires explicit migration path from current interim multi-instance operations to single-deployment multi-asset support.
