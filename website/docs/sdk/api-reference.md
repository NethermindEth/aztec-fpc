# SDK API Reference

Complete type definitions and method signatures for `@nethermindeth/aztec-fpc-sdk`.

**Source:** [sdk/src/types.ts](https://github.com/NethermindEth/aztec-fpc/blob/main/sdk/src/types.ts)

## `FpcClient`

The main class for interacting with FPC.

### Constructor

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

### `createPaymentMethod`

Creates a fee payment method for users with existing L2 token balances.

```typescript
async createPaymentMethod(
  input: CreatePaymentMethodInput
): Promise<FpcPaymentMethodResult>
```

#### Input

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

#### Output

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

#### Usage

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

### `executeColdStart`

Executes a cold-start transaction for users claiming bridged L1 tokens. Atomically claims tokens from the L1-to-L2 bridge and pays the FPC fee in one transaction.

```typescript
async executeColdStart(
  input: ExecuteColdStartInput
): Promise<ColdStartResult>
```

#### Input

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

#### Output

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

#### Usage

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

## Types

### `QuoteResponse`

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

### `ColdStartQuoteResponse`

Extends `QuoteResponse` with claim-binding fields. Signed with the cold-start domain separator (`0x46504373` = `"FPCs"`). Not interchangeable with regular quotes.

```typescript
interface ColdStartQuoteResponse extends QuoteResponse {
  /** Amount being claimed from the L1→L2 bridge */
  claim_amount: string;
  /** Claim secret hash (hex) */
  claim_secret_hash: string;
}
```

## Gas Handling

### `createPaymentMethod`

The SDK uses `estimatedGas.gasLimits` and `teardownGasLimits` from your simulation. Internally it adds a fixed `GAS_BUFFER` of `Gas(5_000, 100_000)` to `gasLimits` before computing `fj_amount` as `daGas * feePerDaGas + l2Gas * feePerL2Gas` against the node's `getCurrentMinFees()`.

### `executeColdStart`

Uses hardcoded gas limits because simulation is not possible before account deployment.

The two reasons simulation cannot work:

1. The user may not have a deployed account, so the PXE cannot simulate through a normal entrypoint.
2. The quote signature is a function argument, but we need the quote to simulate (circular dependency).

| Gas Type | Limit | Measured (benchmark) | Safety Margin |
|----------|-------|----------------------|---------------|
| DA gas | 5,000 | 1,568 | ~3.2x |
| L2 gas | 1,000,000 | 711,103 | ~1.4x |

Unused Fee Juice stays in the FPC's balance. There is no teardown/refund phase. Re-measure after contract changes with `./profiling/setup.sh && ./profiling/run.sh`.

## Error Handling

The SDK propagates errors from three sources:

- **Attestation service:** HTTP 400 (bad request, unsupported asset, overflow), 401 (unauthorized), 429 (rate limited), 5xx
- **Aztec.js:** Simulation failures, on-chain reverts (expired quote, sender-binding failure, insufficient Fee Juice)
- **Network:** Connection failures to the attestation service or Aztec node

All errors are thrown as standard JavaScript exceptions. Cold-start retries up to 3 times on `"Message not in state"` errors (PXE sync race). All other errors propagate immediately.
