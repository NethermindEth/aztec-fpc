# `@aztec-fpc/sdk`

SDK helper for constructing FPC payment methods.

## API

This package currently exposes:

- `FpcClient`
- `FpcClient#createPaymentMethod(...)`
- `FpcClient#executeColdStart(...)`
- `CreatePaymentMethodInput`
- `ExecuteColdStartInput`
- `FpcClientConfig`
- `FpcPaymentMethodResult`
- `ColdStartResult`
- `ColdStartQuoteResponse`
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
  type ColdStartQuoteResponse,
  type ColdStartResult,
  type CreatePaymentMethodInput,
  type ExecuteColdStartInput,
  type FpcClientConfig,
  type FpcPaymentMethodResult,
  type QuoteResponse,
} from "@aztec-fpc/sdk";
```

## Payment method

Use `createPaymentMethod` when the user already has an L2 token balance and needs fee options for an existing transaction.

### Usage

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

### What `createPaymentMethod` does

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

### Returned shape

```ts
type FpcPaymentMethodResult = {
  fee: InteractionFeeOptions;
  nonce: Fr;
  quote: QuoteResponse;
};
```

## Cold start

Use `executeColdStart` when a user has bridged tokens from L1 but has no existing L2 balance to pay fees. It claims the bridged tokens and pays for the transaction in a single step.

### Usage

```ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { L2AmountClaim } from "@aztec/aztec.js/ethereum";
import { FpcClient } from "@aztec-fpc/sdk";

export async function coldStart(input: {
  attestationBaseUrl: string;
  fpcAddress: string;
  operatorAddress: string;
  tokenAddress: string;
  bridgeAddress: string;
  userAddress: string;
  bridgeClaim: L2AmountClaim;
  wallet: Wallet;
}) {
  const node = createAztecNodeClient("http://127.0.0.1:8080");

  const client = new FpcClient({
    fpcAddress: AztecAddress.fromString(input.fpcAddress),
    operator: AztecAddress.fromString(input.operatorAddress),
    node,
    attestationBaseUrl: input.attestationBaseUrl,
  });

  const result = await client.executeColdStart({
    wallet: input.wallet,
    userAddress: AztecAddress.fromString(input.userAddress),
    tokenAddress: AztecAddress.fromString(input.tokenAddress),
    bridgeAddress: AztecAddress.fromString(input.bridgeAddress),
    bridgeClaim: input.bridgeClaim,
  });

  return result;
}
```

### What `executeColdStart` does

`FpcClient#executeColdStart(...)`:

1. Attaches the FPC contract through the provided Aztec node and wallet.
2. Reads current minimum gas fees from the node and computes `fj_amount` using predefined cold-start gas limits (see [Why gas limits are hardcoded](#why-cold-start-gas-limits-are-hardcoded)).
3. Requests a cold-start quote from `GET {attestationBaseUrl}/cold-start-quote`, providing the user's claim details.
4. Builds the FPC `cold_start_entrypoint` call payload, which claims the bridged tokens and pays the fee in one transaction.
5. Proves and sends the transaction, then waits for confirmation.
6. Returns:
   - `txHash`
   - `txFee`
   - `fjAmount`
   - `aaPaymentAmount`
   - `quoteValidUntil`

The default transaction wait timeout is 180 seconds. Override it with `txWaitTimeoutMs`.

### Returned shape

```ts
type ColdStartResult = {
  txHash: string;
  txFee: bigint;
  fjAmount: bigint;
  aaPaymentAmount: bigint;
  quoteValidUntil: bigint;
};
```

### Why cold-start gas limits are hardcoded

Unlike `createPaymentMethod` — which derives gas limits from a prior simulation of the user's app call — `executeColdStart` uses fixed gas limits (`5,000 DA / 1,000,000 L2`). Simulation is not possible for two reasons:

1. **No deployed account.** The PXE simulates transactions through the user's account entrypoint. Cold-start users may not have a deployed account on L2 yet.
2. **Chicken-and-egg with the quote.** The operator's quote signature is a required argument to `cold_start_entrypoint`. To simulate, you'd need the signature; to get the signature, you'd need the gas limits that simulation would produce.

With `fee_entrypoint`, neither problem applies: the user's account is deployed, and the app call (e.g., a token swap) is separate from the fee call — so the app can be simulated independently, and gas limits from that simulation are used to fetch the quote afterward.

The cold-start gas limits are upper bounds informed by the `cold_start` benchmark (`profiling/benchmarks/cold_start.benchmark.json`). The benchmark measures actual gas consumption of the full `cold_start_entrypoint` tx (bridge claim + two private token transfers):

| | DA gas | L2 gas |
|---|---|---|
| **Measured** | 1,568 | 711,103 |
| **Hardcoded limit** | 5,000 | 1,000,000 |
| **Safety margin** | ~3.2× | ~1.4× |

To re-measure after contract changes: `./profiling/setup.sh && ./profiling/run.sh` (runs both `fpc` and `cold_start` benchmarks).

The user pays based on worst-case gas, not actual consumption. Since there is no teardown/refund phase, unused Fee Juice remains in the FPC's balance — reducing future topup frequency for the operator.

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
