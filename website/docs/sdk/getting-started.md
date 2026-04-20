# SDK Getting Started

**Package:** `@nethermindeth/aztec-fpc-sdk`
**Source:** [sdk/](https://github.com/NethermindEth/aztec-fpc/tree/main/sdk)

Two methods cover the full integration surface. `createPaymentMethod()` handles users who already hold L2 tokens. `executeColdStart()` handles users arriving from L1 with no Fee Juice or deployed account.

> [!NOTE]
> **SDK is not yet published to npm**
>
> Install from a local clone. See the [Installation](#installation) section below.

> [!TIP]
> **Who this is for**
>
> - **Privacy DEX or payment app** building on Aztec: sponsor your users' gas in your app's own token instead of Fee Juice.
> - **Wallet building on Aztec:** offer FPC as a fee payment option alongside the canonical Sponsored FPC.
> - **Bridge UI:** use `executeColdStart()` to take users from "just bridged from L1" to "active L2 account" in one transaction.

## Testnet Defaults

Nethermind-operated testnet URLs, addresses, and live discovery check: **[Testnet Deployment](../reference/testnet-deployment.md)**.

Compatibility: Aztec `4.2.0-aztecnr-rc.2`, Bun `1.3.11`. All `@aztec/*` peer dependencies must match the node version.

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

## Standard Flow: User Has Tokens on L2

```typescript
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

// 1. Connect to the Aztec node and create a wallet
const node = createAztecNodeClient("https://rpc.testnet.aztec-labs.com/");
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: true },
});

// 2. Create the FPC client
const fpcClient = new FpcClient({
  fpcAddress: AztecAddress.fromString(
    "0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f",
  ),
  operator: AztecAddress.fromString(
    "0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974",
  ),
  node,
  attestationBaseUrl: "https://aztec-fpc-testnet.staging-nethermind.xyz/",
});

// 3. Simulate your tx to estimate gas
const { estimatedGas } = await myContract.methods
  .myMethod(arg1, arg2)
  .simulate({ from: userAddress, fee: { estimateGas: true } });
if (!estimatedGas) {
  throw new Error("Failed to estimate gas");
}

// 4. Build the FPC payment method
const payment = await fpcClient.createPaymentMethod({
  wallet,
  user: userAddress,
  tokenAddress: AztecAddress.fromString(
    "0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb",
  ),
  estimatedGas,
});

// 5. Send the tx with FPC fee options
await myContract.methods.myMethod(arg1, arg2).send({
  from: userAddress,
  fee: payment.fee,
});
```

The SDK handles these steps internally:

1. Computes `fj_amount` from the node's current gas fees (with a `Gas(5_000, 100_000)` buffer)
2. Fetches a signed quote from `GET <ATTESTATION_URL>/quote`
3. Builds a token-transfer auth-witness (user to operator for `aa_payment_amount`)
4. Wires the `fee_entrypoint` call as a `FeePaymentMethod`

## Cold-Start Flow: User Just Bridged from L1

Use `executeColdStart` when the user has bridged tokens from L1 but has **no existing L2 balance** to pay fees.

```typescript
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

// 1. Connect to the Aztec node and create a wallet
const node = createAztecNodeClient("https://rpc.testnet.aztec-labs.com/");
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: true },
});

const fpcClient = new FpcClient({
  fpcAddress: AztecAddress.fromString(
    "0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f",
  ),
  operator: AztecAddress.fromString(
    "0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974",
  ),
  node,
  attestationBaseUrl: "https://aztec-fpc-testnet.staging-nethermind.xyz/",
});

// 2. Create an L1 client and bridge tokens from L1 to L2
const l1WalletClient = createExtendedL1Client(
  ["https://ethereum-sepolia-rpc.publicnode.com"],
  "0x<your_l1_private_key>",
  l1Chain,
);

const portalManager = new L1ToL2TokenPortalManager(
  EthAddress.fromString("0x57a426552a472e953ecc1342f25b17cc192326be"),
  EthAddress.fromString("0xf49de848d9c00c4dfb088b2e6ba2dac81e34aa5d"),
  undefined,
  l1WalletClient,
  createLogger("bridge"),
);

const bridgeClaim = await portalManager.bridgeTokensPrivate(
  userAddress,
  10_000_000_000_000_000n, // amount to bridge
  false,
);

// 3. Wait for the L1→L2 message to be available on L2
await waitForL1ToL2MessageReady(
  node,
  Fr.fromHexString(bridgeClaim.messageHash as string),
  { timeoutSeconds: 300 },
);

// 4. Execute cold-start: claim bridged tokens + pay FPC fee in one tx
const result = await fpcClient.executeColdStart({
  wallet,
  userAddress,
  tokenAddress: AztecAddress.fromString(
    "0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb",
  ),
  bridgeAddress: AztecAddress.fromString(
    "0x19b200d772d3e9068921e6f5df7530271229e958acc9efc2c637afe64db9763f",
  ),
  bridgeClaim,
});

console.log(`Tx hash: ${result.txHash}`);
console.log(`Tx fee: ${result.txFee}`);
console.log(`Token charged: ${result.aaPaymentAmount}`);
```

One transaction takes the user from "just bridged" to "has tokens and transaction history."

> [!TIP]
> **Finding `bridgeAddress`**
>
> If the operator deployed test tokens via `configure-token`, the bridge address is in `deployments/tokens/<TokenName>.json`. For production tokens, get it from the token deployment records or the operator.

## What the SDK Constructs

### `createPaymentMethod`

1. Attaches FPC + Token contract instances to the wallet via `node.getContract`
2. Reads current gas fees (`node.getCurrentMinFees`)
3. Computes `fj_amount = daGas * feePerDaGas + l2Gas * feePerL2Gas` (plus a fixed `Gas(5_000, 100_000)` buffer)
4. Sends `GET <ATTESTATION_URL>/quote?user=...&accepted_asset=...&fj_amount=...`
5. Builds authwit: `token.transfer_private_to_private(user, operator, aa_payment_amount, nonce)`
6. Wires `fee_entrypoint` call as the transaction's `FeePaymentMethod`

### `executeColdStart`

1. Fetches a cold-start quote from `/cold-start-quote` (different domain separator: `0x46504373`)
2. Builds `cold_start_entrypoint` call with `bridgeClaim` fields and quote signature
3. Uses hardcoded gas limits `Gas(5_000, 1_000_000)` because simulation is not possible before account deployment
4. Proves, sends, and waits. Retries up to 3x on `"Message not in state"` errors from PXE sync races.

## Contract Artifacts

The SDK ships its own copies of `FPCMultiAsset`, `Token`, and `TokenBridge` artifacts via `codegen/`. Building from source produces them with `aztec compile --workspace --force`.

## Next Steps

- [API Reference](../sdk/api-reference.md) for full type signatures
- [Example](https://github.com/NethermindEth/aztec-fpc/blob/main/examples/fpc-full-flow.ts) for an end-to-end runnable file
- [Testnet Deployment](../reference/testnet-deployment.md) for live addresses
