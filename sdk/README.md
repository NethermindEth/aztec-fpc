# `@aztec-fpc/sdk`

SDK helper for constructing FPC payment methods.

## API

This package currently exposes:

- `FpcClient`
- `FpcClient#createPaymentMethod(...)`
- `CreatePaymentMethodInput`
- `FpcClientConfig`
- `FpcPaymentMethodResult`
- `QuoteResponse`


## Install

`@aztec-fpc/sdk` is not published to npm yet.

Until the package is published, install it from a local checkout of this GitHub repo after building the SDK.

### Bun

```bash
git clone https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
bun install
cd sdk
bun run build

cd /path/to/your-app
bun add /absolute/path/to/aztec-fpc/sdk
```

### npm / Node.js

```bash
git clone https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
npm install
npm run build --workspace @aztec-fpc/sdk

cd /path/to/your-app
npm install /absolute/path/to/aztec-fpc/sdk
```

Direct GitHub installation of the repo root is not the same thing as installing the SDK package, because `@aztec-fpc/sdk` is a workspace package under `sdk/`, not the repository root package.

## Exports

All public SDK types are re-exported from the package entrypoint.

```ts
import {
  FpcClient,
  type CreatePaymentMethodInput,
  type FpcClientConfig,
  type FpcPaymentMethodResult,
  type QuoteResponse,
} from "@aztec-fpc/sdk";
```

## Usage

```ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { FpcClient } from "@aztec-fpc/sdk";

export async function createFeeOptions(input: {
  attestationBaseUrl: string;
  fpcAddress: string;
  operatorAddress: string;
  tokenAddress: string;
  userAddress: string;
  wallet: Wallet;
}) {
  const node = createAztecNodeClient("http://127.0.0.1:8080");

  const client = new FpcClient({
    fpcAddress: AztecAddress.fromString(input.fpcAddress),
    operator: AztecAddress.fromString(input.operatorAddress),
    node,
    attestationBaseUrl: input.attestationBaseUrl,
  });

  const simulation = await someContract.methods.someEntrypoint().simulate({
    from: AztecAddress.fromString(input.userAddress),
    fee: { estimateGas: true },
  });

  const result = await client.createPaymentMethod({
    wallet: input.wallet,
    user: AztecAddress.fromString(input.userAddress),
    tokenAddress: AztecAddress.fromString(input.tokenAddress),
    estimatedGas: simulation.estimatedGas,
  });

  return result.fee;
}
```

## What `createPaymentMethod` does

`FpcClient#createPaymentMethod(...)`:

1. Attaches the FPC and token contracts through the provided Aztec node and wallet.
2. Reads current minimum gas fees from the node and computes `fj_amount`.
3. Requests a quote from `GET {attestationBaseUrl}/quote`.
4. Builds the token transfer auth witness for the user-to-operator accepted-asset payment.
5. Builds the FPC `fee_entrypoint` call payload.
6. Returns:
   - `fee.paymentMethod`
   - `nonce`
   - raw `quote`

The returned `fee.paymentMethod` is suitable for Aztec interaction fee options and includes gas settings derived from the node response.

## Returned shape

```ts
type FpcPaymentMethodResult = {
  fee: InteractionFeeOptions;
  nonce: Fr;
  quote: QuoteResponse;
};
```

## Contract artifacts

The SDK auto-loads default artifacts for:

- `fpc-FPCMultiAsset.json`
- `token_contract-Token.json`

Artifact lookup checks:

1. packaged SDK artifact directories
2. repo `target/` locations during local development
3. `target/` under the current working directory

## Development

From `sdk/`:

```bash
bun run typecheck
bun run test
bun run build
```

Current test coverage is focused on [`test/payment-method.test.ts`](./test/payment-method.test.ts).
