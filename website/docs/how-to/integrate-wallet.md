# Integrate FPC in Your Wallet

Add FPC-based fee payment to an Aztec wallet so users can pay gas in any supported token instead of native Fee Juice.

> [!NOTE]
> **Audience**
>
> Wallet engineers who already integrate Aztec.js and want to add FPC as a payment option. [Azguard Wallet](https://azguardwallet.io/) and [Obsidion Wallet](https://app.obsidion.xyz/), two live wallets on Aztec testnet, both run their own FPC stack using this pattern.

## What You'll Build

A wallet that:

1. Discovers FPC attestation metadata via `/.well-known/fpc.json`
2. Lets users select a supported payment token
3. Fetches a signed quote from the attestation service
4. Submits transactions with the FPC as fee payer

## Testnet Defaults

For the Nethermind-operated testnet (addresses, URLs, and live discovery check): **[Testnet Deployment](../reference/testnet-deployment.md)**.

## Steps

### Install the SDK

The SDK is not published to npm yet. Install from a local clone of `NethermindEth/aztec-fpc`. Once published, standard `bun add @nethermindeth/aztec-fpc-sdk` will work. See [SDK: Getting Started](../sdk.md#installation).

### Discover the FPC attestation metadata

Fetch `/.well-known/fpc.json` to discover the operator's endpoints and supported assets. Lookup is keyed by `(network_id, asset_address, fpc_address)`. Validate that all three match what the wallet expects.

```typescript
const response = await fetch(
  "https://aztec-fpc-testnet.staging-nethermind.xyz/.well-known/fpc.json"
);
const metadata = await response.json();
```

The response shape (normative, see [wallet-discovery-spec](https://github.com/NethermindEth/aztec-fpc/blob/main/docs/spec/wallet-discovery-spec.md)). The implementation is in [`services/attestation/src/server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L551):

```json
{
  "discovery_version": "1.0",
  "attestation_api_version": "1.0",
  "network_id": "aztec-testnet",
  "fpc_address": "0x1be2cae6...",
  "contract_variant": "fpc-v1",
  "quote_base_url": "https://aztec-fpc-testnet.staging-nethermind.xyz",
  "endpoints": {
    "discovery": "/.well-known/fpc.json",
    "health": "/health",
    "accepted_assets": "/accepted-assets",
    "quote": "/quote",
    "cold_start_quote": "/cold-start-quote"
  },
  "supported_assets": [
    { "address": "0x07348d12a...", "name": "humanUSDC" }
  ]
}
```

Validation rules:
- `discovery_version` and `attestation_api_version` must exactly equal `"1.0"`
- `network_id` and `fpc_address` must match the wallet's configured lookup key
- User-selected `asset_address` must appear in `supported_assets[].address`
- On any validation failure, fail closed (`DISCOVERY_NOT_FOUND`). Do not call `/quote`.

### Let users pick a payment token

Render `supported_assets` from the discovery document, or call `/accepted-assets` directly for the same data.

```typescript
const assets = await fetch(
  `${metadata.quote_base_url}${metadata.endpoints.accepted_assets}`
).then((r) => r.json());
// assets: [{ address, name }, ...]
const selectedAsset = assets[0];
```

### Create the FPC client and a payment method

[Source: `sdk/src/payment-method.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/payment-method.ts#L50)

The SDK's `FpcClient` needs four fields: `fpcAddress`, `operator`, `node`, and `attestationBaseUrl`.

```typescript
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

const fpcClient = new FpcClient({
  fpcAddress: AztecAddress.fromString(metadata.fpc_address),
  operator: AztecAddress.fromString(OPERATOR_ADDRESS),
  node,
  attestationBaseUrl: metadata.quote_base_url,
});

// 1. Simulate the tx to get gas estimates
const { estimatedGas } = await contract.methods
  .transfer(recipient, amount)
  .simulate({ from: wallet.getAddress(), fee: { estimateGas: true } });
if (!estimatedGas) throw new Error("Failed to estimate gas");

// 2. Build the fee payment method
const { fee } = await fpcClient.createPaymentMethod({
  wallet,
  user: wallet.getAddress(),
  tokenAddress: AztecAddress.fromString(selectedAsset.address),
  estimatedGas,
});
```

> [!WARNING]
> **Operator address is not in the discovery document**
>
> The FPC's operator address must be obtained separately, from the operator's documentation, their token manifest, or by reading the FPC's `config` slot on-chain. The SDK builds the token-transfer auth-witness `user -> operator` off-chain. A wrong operator address invalidates the authwit and the transaction will revert.

Under the hood, `createPaymentMethod` does the following:

1. Fetches current gas prices from the node and computes `fj_amount` (with a gas buffer)
2. Fetches a signed quote from `GET <ATTESTATION_URL>/quote`
3. Builds a token transfer auth-witness (user to operator) for the quoted `aa_payment_amount`
4. Builds the `fee_entrypoint` call payload with the quote signature
5. Returns `fee` options ready to attach to any Aztec transaction

### Submit the transaction

```typescript
const tx = await contract.methods
  .transfer(recipient, amount)
  .send({ from: wallet.getAddress(), fee });

const receipt = await tx.wait();
```

The user signs once. The fee is paid in their chosen token via the FPC.

## Handling Cold Start (User Just Bridged from L1)

For users who have bridged tokens but have no L2 balance yet, `executeColdStart` atomically claims from the bridge and pays the FPC fee in one transaction. Pass the `bridgeClaim` object from `L1ToL2TokenPortalManager.bridgeTokensPrivate` directly. Do not destructure it.

```typescript
const result = await fpcClient.executeColdStart({
  wallet,
  userAddress: wallet.getAddress(),
  tokenAddress: AztecAddress.fromString(selectedAsset.address),
  bridgeAddress: AztecAddress.fromString(BRIDGE_ADDRESS),
  bridgeClaim, // the L2AmountClaim from the portal manager
});
```

After this single transaction, the user has an L2 balance and transaction history and can use the standard flow for subsequent transactions. See [Cold-Start Flow](../how-to/cold-start-flow.md) for the full bridging and waiting sequence.

## Error Handling

The SDK propagates HTTP errors from the attestation service and on-chain reverts from Aztec.js.

> [!TIP]
> **User-facing errors**
>
> - **Asset not supported (HTTP 400)**: refresh `/accepted-assets`. The asset may have been removed, though previously-signed quotes remain valid until `valid_until`.
> - **Unauthorized (HTTP 401)**: the attestation service is in `api_key` auth mode. Ensure your wallet backend holds the key.
> - **Rate limited (HTTP 429)**: back off. Consider caching the quote for its TTL.
> - **Quote expired (on-chain revert)**: re-fetch. Quotes typically live ~5 minutes, capped at 3600 seconds on-chain.
> - **Sender-binding failure (on-chain revert)**: the quote was signed for a different user address.

```typescript
try {
  const { fee } = await fpcClient.createPaymentMethod({ /* ... */ });
  const tx = await contract.methods.someMethod(args).send({ from, fee });
  await tx.wait();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("400")) {
    // Asset unsupported or fj_amount overflow
  } else if (msg.includes("429")) {
    // Rate limited
  } else if (msg.includes("Quote") || msg.includes("sender")) {
    // On-chain quote validation failure
  }
}
```

## Known Limitations

- The token transfer executes in the setup phase before `end_setup()`. It is irrevocably committed. If the user's application logic reverts, the fee has still been paid. This is inherent to the Aztec FPC model.
- `fj_amount` must match `get_max_gas_cost` for the transaction gas settings. The SDK handles this, but if you build the payment method manually, a mismatch causes `fee_entrypoint` to revert.
- No teardown or refund phase exists. Unused Fee Juice stays in the FPC's balance.

## Next Steps

- [SDK API Reference](../sdk.md#api-reference): complete type signatures
- [Quote System](../quote-system.md): what the SDK wraps
- [Security Model](../security.md): trust assumptions users should know
