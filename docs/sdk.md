# SDK

**Package:** `@nethermindeth/aztec-fpc-sdk`
**Source:** [sdk/](https://github.com/NethermindEth/aztec-fpc/tree/main/sdk)

**On this page:**
[Installation](#installation) | [FpcWallet](#fpcwallet-required-wallet-class) | [Common Setup](#common-setup) | [Standard Flow](#standard-flow-user-has-tokens-on-l2) | [Cold-Start Flow](#cold-start-flow-user-just-bridged-from-l1) | [What the SDK Constructs](#what-the-sdk-constructs) | [API Reference](#api-reference) | [Types](#types) | [Gas Handling](#gas-handling) | [Error Handling](#error-handling)

---

The SDK exposes two methods. `createPaymentMethod()` handles users who already hold L2 tokens. `executeColdStart()` handles users arriving from L1 with no Fee Juice or deployed account.

> [!NOTE]
> **SDK is not yet published to npm**
>
> Install from a local clone. See the [Installation](#installation) section below.

## Testnet Defaults

Nethermind-operated testnet URLs, addresses, and live discovery check: **[Testnet Deployment](./reference/testnet-deployment.md)**.

Compatibility: Aztec `4.2.0-aztecnr-rc.2`, Bun `1.3.11`. All `@aztec/*` peer dependencies must match the node version. These versions are pinned in `package.json` and `docker-compose.yaml`; if they drift from what's shown here, trust the repo files.

## Installation

```bash
git clone https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
git submodule update --init --recursive
aztec compile --workspace --force
bun install && bun run build

cd /path/to/your-app
bun add /absolute/path/to/aztec-fpc/sdk
```

Once the package is published, `bun add @nethermindeth/aztec-fpc-sdk` will work.

## FpcWallet: required wallet class

[Source](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/common/fpc-wallet.ts#L37)

> [!CAUTION]
> **Do not use `EmbeddedWallet` directly for FPC flows.**
>
> Aztec 4.2.0 introduced three breaking changes in `EmbeddedWallet` that cause FPC transactions to fail at runtime. Use `FpcWallet` instead. Copy [`scripts/common/fpc-wallet.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/common/fpc-wallet.ts#L37) into your project, or import it from the cloned repo.

`FpcWallet` extends `EmbeddedWallet` and overrides four methods to fix three compatibility issues introduced in Aztec 4.2.0:

| Override | Problem in 4.2.0 | Fix |
|---|---|---|
| `sendTx()` | `EmbeddedWallet.sendTx()` runs mandatory pre-simulation with inflated gas limits. The FPC contract asserts `fj_fee_amount == max_fee`, so inflated limits break the assertion. | Delegates to `BaseWallet.prototype.sendTx`, skipping pre-simulation. |
| `scopesFrom()` | `scopesFrom(AztecAddress.ZERO)` returns `[AztecAddress.ZERO]` instead of `[]`. This triggers "Key validation request denied" during proving for undeployed accounts. | Returns `[]` when the address is `AztecAddress.ZERO`. |
| `simulateViaEntrypoint()` and `createTxExecutionRequestFromPayloadAndFee()` | Account deployment uses `from: AztecAddress.ZERO` (the account does not exist yet). In 4.2.0, these paths call `getAccountFromAddress(ZERO)` which throws. | Intercepts `AztecAddress.ZERO` and routes through `DefaultMultiCallEntrypoint`, replicating the 4.1.0 `SignerlessAccount` + multicall behavior. |

If Aztec restores zero-address handling and adds a skip-simulation option, this subclass can be removed.

## Common Setup

> [!TIP]
> **Prerequisites:** Bun `1.3.11`, Aztec CLI, compiled contract artifacts. See [Quick Start](./quick-start.md) for setup.

Both flows below need a node connection, wallet, and `FpcClient`. This block is shared:

```typescript
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";
import { FpcWallet } from "./fpc-wallet"; // copied from scripts/common/fpc-wallet.ts

// Testnet addresses -- see reference/testnet-deployment.md for current values
const AZTEC_NODE_URL = "https://rpc.testnet.aztec-labs.com/";
const ATTESTATION_URL = "https://aztec-fpc-testnet.staging-nethermind.xyz/";
const FPC_ADDRESS = "0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f";
const OPERATOR_ADDRESS = "0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974";
const TOKEN_ADDRESS = "0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb";

const node = createAztecNodeClient(AZTEC_NODE_URL);
await waitForNode(node);
const wallet = await FpcWallet.create(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: true },
});

const fpcClient = new FpcClient({
  fpcAddress: AztecAddress.fromString(FPC_ADDRESS),
  operator: AztecAddress.fromString(OPERATOR_ADDRESS),
  node,
  attestationBaseUrl: ATTESTATION_URL,
});
```

## Standard Flow: User Has Tokens on L2

Assumes [Common Setup](#common-setup) above.

```typescript
// 1. Simulate your tx to estimate gas
const { estimatedGas } = await myContract.methods
  .myMethod(arg1, arg2)
  .simulate({ from: userAddress, fee: { estimateGas: true } });
if (!estimatedGas) {
  throw new Error("Failed to estimate gas");
}

// 2. Build the FPC payment method
const payment = await fpcClient.createPaymentMethod({
  wallet,
  user: userAddress,
  tokenAddress: AztecAddress.fromString(TOKEN_ADDRESS),
  estimatedGas,
});

// 3. Send the tx with FPC fee options
await myContract.methods.myMethod(arg1, arg2).send({
  from: userAddress,
  fee: payment.fee,
});
```

The SDK handles these steps internally:

1. Computes `fj_amount` from the node's current gas fees. A fixed `Gas(5_000, 100_000)` buffer is added to `gasLimits` before the computation.
2. Fetches a signed quote from `GET <ATTESTATION_URL>/quote`
3. Builds an auth-witness authorizing the FPC contract (not the operator) to call `token.transfer_private_to_private(user, operator, aa_payment_amount, nonce)` on the user's behalf
4. Wires the `fee_entrypoint` call as the transaction's `FeePaymentMethod`

> [!WARNING]
> **`fj_fee_amount` must match the transaction's gas cost**
>
> The FPC contract asserts `fj_fee_amount == get_max_gas_cost(...)` for the transaction's actual gas settings. If the `fj_amount` in the quote does not match, the transaction reverts with "quoted fee amount mismatch". The SDK computes this correctly, but if you build fee payloads manually, the amounts must align exactly.

## Cold-Start Flow: User Just Bridged from L1

Use `executeColdStart` when the user has bridged tokens from L1 but has **no existing L2 balance** to pay fees. One transaction claims bridged tokens and pays the FPC fee atomically.

```typescript
const result = await fpcClient.executeColdStart({
  wallet,
  userAddress,
  tokenAddress: AztecAddress.fromString(TOKEN_ADDRESS),
  bridgeAddress: AztecAddress.fromString(BRIDGE_ADDRESS),
  bridgeClaim, // pass the L2AmountClaim object as-is, do not destructure
});
```

For the full bridging sequence (L1 deposit, waiting for L1-to-L2 message, executing cold-start), see **[Cold-Start Flow](./how-to/cold-start-flow.md)**.

## What the SDK Constructs

[Source](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/payment-method.ts#L50)

### `createPaymentMethod`

1. Attaches FPC + Token contract instances to the wallet via `node.getContract`
2. Reads current gas fees (`node.getCurrentMinFees`)
3. Adds a `Gas(5_000, 100_000)` buffer to `gasLimits`, then computes `fj_amount = daGas * feePerDaGas + l2Gas * feePerL2Gas`
4. Sends `GET <ATTESTATION_URL>/quote?user=...&accepted_asset=...&fj_amount=...`
5. Builds authwit authorizing the FPC contract (`fpcAddress` is the `caller`) to execute `token.transfer_private_to_private(user, operator, aa_payment_amount, nonce)`
6. Wires `fee_entrypoint` call as the transaction's `FeePaymentMethod`
7. Returns `{ fee, nonce, quote }`. The `fee` field is ready to pass to `.send()`. The `nonce` and `quote` fields are available for debugging or UI display.

### `executeColdStart`

1. Fetches a cold-start quote from `/cold-start-quote` (different domain separator: `0x46504373`)
2. Builds `cold_start_entrypoint` call with `bridgeClaim` fields and quote signature
3. Uses hardcoded gas limits `Gas(5_000, 1_000_000)` because simulation is not possible before account deployment. Uses `DefaultEntrypoint` instead of the user's account entrypoint (the account may not exist yet).
4. Proves, sends, and waits. Retries up to 3x on `"Message not in state"` errors from PXE sync races.
5. Returns `{ txHash, txFee, fjAmount, aaPaymentAmount, quoteValidUntil }`.

An optional `txWaitTimeoutMs` parameter controls how long `executeColdStart` waits for the transaction to be included in a block (default: 180,000ms).

## Contract Artifacts

The SDK ships its own copies of `FPCMultiAsset`, `Token`, and `TokenBridge` artifacts via [`codegen/`](https://github.com/NethermindEth/aztec-fpc/tree/main/codegen). Building from source produces them with `aztec compile --workspace --force`.

## Next Steps

- [API Reference](./sdk.md#api-reference) for full type signatures
- [Full example](https://github.com/NethermindEth/aztec-fpc/blob/main/examples/fpc-full-flow.ts): cold-start + FPC-paid account deployment, end-to-end
- [FpcWallet source](https://github.com/NethermindEth/aztec-fpc/blob/main/scripts/common/fpc-wallet.ts#L37): the wallet compatibility shim
- [Testnet Deployment](./reference/testnet-deployment.md) for live addresses

## API Reference

Complete type definitions and method signatures for `@nethermindeth/aztec-fpc-sdk`.

**Source:** [sdk/src/types.ts](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/types.ts#L9)

### `FpcClient`

[Source](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/payment-method.ts#L50)

The main class for interacting with FPC.

#### Constructor

```typescript
new FpcClient(config: FpcClientConfig)
```

```typescript
interface FpcClientConfig {
  /** Deployed FPC contract address */
  fpcAddress: AztecAddress;
  /** Operator's Aztec address, the fee revenue recipient */
  operator: AztecAddress;
  /** Aztec node client (used for contract reads, gas fees, tx submission) */
  node: AztecNode;
  /** Attestation service base URL, must include scheme + host, no trailing path */
  attestationBaseUrl: string;
}
```

The `operator` address is required because the SDK constructs the token-transfer auth-witness (`user -> operator`) off-chain. Passing a wrong operator makes the authwit invalid and the transaction will revert.

---

#### `createPaymentMethod`

Creates a fee payment method for users with existing L2 token balances.

```typescript
async createPaymentMethod(
  input: CreatePaymentMethodInput
): Promise<FpcPaymentMethodResult>
```

##### Input

```typescript
interface CreatePaymentMethodInput {
  /** Aztec.js wallet instance */
  wallet: AccountWallet;
  /** User's L2 address (bound into the quote signature) */
  user: AztecAddress;
  /** Token to pay fees with */
  tokenAddress: AztecAddress;
  /**
   * Gas settings from a simulated tx. Obtain via:
   *   const { estimatedGas } = await contract.methods.foo().simulate({
   *     from: user,
   *     fee: { estimateGas: true },
   *   });
   */
  estimatedGas: Pick<GasSettings, "gasLimits" | "teardownGasLimits">;
}
```

> [!NOTE]
> This method uses `user`, not `userAddress`. The `executeColdStart` method uses `userAddress`. This asymmetry matches the SDK's actual signature.

##### Output

```typescript
interface FpcPaymentMethodResult {
  /** Fee options to pass directly to .send({ fee }) */
  fee: InteractionFeeOptions;
  /** Authwit nonce for the token transfer */
  nonce: Fr;
  /** The signed quote from the attestation service */
  quote: QuoteResponse;
}
```

##### Usage

```typescript
// 1. Simulate to get gas estimate
const { estimatedGas } = await contract.methods
  .someMethod(args)
  .simulate({ from: user, fee: { estimateGas: true } });
if (!estimatedGas) throw new Error("Failed to estimate gas");

// 2. Build fee payment method
const { fee } = await fpcClient.createPaymentMethod({
  wallet,
  user,
  tokenAddress: usdcAddress,
  estimatedGas,
});

// 3. Send
const tx = await contract.methods.someMethod(args).send({ from: user, fee });
```

---

#### `executeColdStart`

Executes a cold-start transaction for users claiming bridged L1 tokens. Atomically claims tokens from the L1-to-L2 bridge and pays the FPC fee in one transaction.

```typescript
async executeColdStart(
  input: ExecuteColdStartInput
): Promise<ColdStartResult>
```

##### Input

```typescript
interface ExecuteColdStartInput {
  /** Aztec.js wallet instance */
  wallet: AccountWallet;
  /** User's L2 address */
  userAddress: AztecAddress;
  /** Token being claimed */
  tokenAddress: AztecAddress;
  /** Bridge contract address */
  bridgeAddress: AztecAddress;
  /**
   * The L1→L2 claim object returned by the portal manager's bridge call.
   * Obtain via L1ToL2TokenPortalManager.bridgeTokensPrivate(...).
   */
  bridgeClaim: L2AmountClaim;
  /** Optional timeout waiting for tx inclusion (default: 180_000ms) */
  txWaitTimeoutMs?: number;
}
```

`L2AmountClaim` is the standard Aztec.js type. The SDK reads `claimAmount`, `claimSecret`, `claimSecretHash`, and `messageLeafIndex` from it. Pass the whole object. Do not destructure.

##### Output

```typescript
interface ColdStartResult {
  /** Transaction hash (hex string) */
  txHash: string;
  /** Actual fee paid in Fee Juice */
  txFee: bigint;
  /** Fee Juice amount quoted */
  fjAmount: bigint;
  /** Token amount paid to the operator */
  aaPaymentAmount: bigint;
  /** Quote expiry timestamp (unix seconds) */
  quoteValidUntil: bigint;
}
```

> [!WARNING]
> **`claimAmount` is not on the result**
>
> To compute what the user received (`claimAmount - aaPaymentAmount`), use `bridgeClaim.claimAmount` from the `L2AmountClaim` you passed in. The SDK does not re-expose it on `ColdStartResult`.

##### Usage

```typescript
// 1. Bridge tokens from L1
const bridgeClaim = await portalManager.bridgeTokensPrivate(
  userAddress,
  10_000_000_000_000_000n,
  false,
);

// 2. Wait for L1→L2 message
await waitForL1ToL2MessageReady(
  node,
  Fr.fromHexString(bridgeClaim.messageHash as string),
  { timeoutSeconds: 300 },
);

// 3. Execute cold-start
const result = await fpcClient.executeColdStart({
  wallet,
  userAddress,
  tokenAddress: usdcAddress,
  bridgeAddress,
  bridgeClaim,
});
```

---

### Types

#### `QuoteResponse`

Returned by the attestation service's `GET /quote` endpoint.

```typescript
interface QuoteResponse {
  /** Token contract address */
  accepted_asset: string;
  /** Fee Juice amount */
  fj_amount: string;
  /** Token payment amount */
  aa_payment_amount: string;
  /** Quote expiry (Unix timestamp, string) */
  valid_until: string;
  /** Schnorr signature (64-byte hex, 0x-prefixed) */
  signature: string;
}
```

#### `ColdStartQuoteResponse`

Extends `QuoteResponse` with claim-binding fields. Signed with the cold-start domain separator (`0x46504373` = `"FPCs"`). Not interchangeable with regular quotes.

```typescript
interface ColdStartQuoteResponse extends QuoteResponse {
  /** Amount being claimed from the L1→L2 bridge */
  claim_amount: string;
  /** Claim secret hash (hex) */
  claim_secret_hash: string;
}
```

### Gas Handling

#### `createPaymentMethod`

The SDK uses `estimatedGas.gasLimits` and `teardownGasLimits` from your simulation. Internally it adds a fixed [`GAS_BUFFER` of `Gas(5_000, 100_000)`](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/payment-method.ts#L30) to `gasLimits` before computing `fj_amount` as `daGas * feePerDaGas + l2Gas * feePerL2Gas` against the node's `getCurrentMinFees()`.

#### `executeColdStart`

Uses [hardcoded gas limits](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/payment-method.ts#L46) because simulation is not possible before account deployment.

The two reasons simulation cannot work:

1. The user may not have a deployed account, so the PXE cannot simulate through a normal entrypoint.
2. The quote signature is a function argument, but we need the quote to simulate (circular dependency).

| Gas Type | Limit | Measured (benchmark) | Safety Margin |
|----------|-------|----------------------|---------------|
| DA gas | 5,000 | 1,568 | ~3.2x |
| L2 gas | 1,000,000 | 711,103 | ~1.4x |

Unused Fee Juice stays in the FPC's balance. `aztec-fpc` does not use the teardown phase, so there is no refund. Re-measure after contract changes with `./profiling/setup.sh && ./profiling/run.sh`.

### Error Handling

The SDK propagates errors from three sources:

- **Attestation service:** HTTP 400 (bad request, unsupported asset, overflow), 401 (unauthorized), 429 (rate limited), 5xx
- **Aztec.js:** Simulation failures, on-chain reverts (expired quote, sender-binding failure, insufficient Fee Juice)
- **Network:** Connection failures to the attestation service or Aztec node

All errors are thrown as standard JavaScript exceptions. Cold-start [retries up to 3 times](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/payment-method.ts#L29) on `"Message not in state"` errors (PXE sync race). All other errors propagate immediately.
