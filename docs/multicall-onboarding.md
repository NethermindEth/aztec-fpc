# MultiCall Onboarding: User Guide

## What you need

- **ERC20 tokens on L1** -- the specific token accepted by the FPC operator
- **An Ethereum wallet** with enough ETH for L1 gas (the deposit transaction)
- **Access to the Aztec network** via a node URL

You do **not** need an existing L2 account, Fee Juice, or any prior Aztec setup.

## How it works

### Step 1: Deposit tokens on L1

Call `TokenPortal.depositToAztecPrivate(amount, secretHash)` on Ethereum L1. This locks your ERC20 tokens in the portal contract and creates an L1-to-L2 message that the Aztec network will pick up.

You'll receive a **claim secret** and a **message leaf index** from the deposit event -- keep these safe, you'll need them in Step 3.

### Step 2: Wait for message readiness

The L1-to-L2 message needs to be included in a proven L2 block before it can be consumed. On a local network this takes seconds; on mainnet it may take a few minutes. Your wallet or SDK will poll for readiness automatically.

### Step 3: Submit the onboarding transaction

A single L2 transaction does everything atomically:

1. **Deploys your Account Contract** -- your L2 identity
2. **Claims your bridged tokens** -- the TokenBridge consumes the L1-to-L2 message and mints private token notes to your new account
3. **Pays the transaction fee** -- the FPC transfers a portion of your newly minted tokens to the operator and covers the Fee Juice cost on your behalf

No Fee Juice is required. The FPC operator provides a signed quote specifying the exchange rate, and the transaction uses the pre-deployed MultiCallEntrypoint to batch everything into one atomic operation.

## What you end up with

- A **deployed L2 Account Contract** (your Aztec wallet)
- A **private token balance** (bridged amount minus the fee payment)
- Ready to transact on Aztec immediately

## Operator prerequisites

For this flow to work, the FPC operator must have:

- Deployed the **Token** contract (with the TokenBridge set as minter)
- Deployed the **TokenBridge** contract (linked to the L1 TokenPortal)
- Deployed the **FPC** contract (topped up with Fee Juice)
- A running **attestation service** that issues signed fee quotes
