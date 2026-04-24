# Integrate FPC in Your Wallet

Add FPC-based fee payment to an Aztec wallet so users can pay fees in any supported token instead of native Fee Juice.

> [!NOTE]
> **Audience**
>
> Wallet engineers who already integrate Aztec.js and want to add FPC as a payment option.

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

The response shape (see [Wallet Discovery spec](../reference/wallet-discovery.md)). The implementation is in [`services/attestation/src/server.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/services/attestation/src/server.ts#L551):

```json
{
  "discovery_version": "1.0",
  "attestation_api_version": "1.0",
  "network_id": "aztec-testnet",
  "fpc_address": "<FPC_ADDRESS>",
  "contract_variant": "fpc-v1",
  "quote_base_url": "https://<ATTESTATION_HOST>",
  "endpoints": {
    "discovery": "/.well-known/fpc.json",
    "health": "/health",
    "accepted_assets": "/accepted-assets",
    "quote": "/quote",
    "cold_start_quote": "/cold-start-quote"
  },
  "supported_assets": [
    { "address": "<TOKEN_ADDRESS>", "name": "humanUSDC" }
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

The SDK propagates errors from the attestation service (HTTP), Aztec.js (simulation/revert), and network layers. See [SDK: Error Handling](../sdk.md#error-handling) for the full error taxonomy.

Key errors to surface in your wallet UI:

- **HTTP 400** (asset not supported): refresh `/accepted-assets`. The asset may have been removed.
- **HTTP 401** (unauthorized): the attestation service requires an API key. Ensure your wallet backend holds it.
- **HTTP 429** (rate limited): back off. Consider caching the quote for its TTL.
- **On-chain revert** (quote expired): re-fetch. Quotes typically live ~5 minutes, capped at 3600 seconds.
- **On-chain revert** (sender-binding failure): the quote was signed for a different user address.

## Known Limitations

- The fee is paid in the setup phase and is irrevocable, even if the user's app logic reverts. See [Security Model: setup-phase irreversibility](../security.md#trust-assumptions).
- `fj_amount` must match `get_max_gas_cost` for the transaction gas settings. The SDK handles this, but if you build the payment method manually, a mismatch causes `fee_entrypoint` to revert.
- `aztec-fpc` does not use the optional teardown phase, so there is no refund. Unused Fee Juice stays in the FPC's balance.

## Next Steps

- [SDK API Reference](../sdk.md#api-reference): complete type signatures
- [Quote System](../quote-system.md): what the SDK wraps
- [Security Model](../security.md): trust assumptions users should know
