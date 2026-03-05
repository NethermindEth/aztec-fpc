# `@aztec-fpc/sdk`

SDK for sponsored Aztec calls through an FPC attestation service.

## Install

```bash
bun add @aztec-fpc/sdk
```

## APIs

- Generic API: `executeSponsoredCall(...)`
- Legacy convenience API: `createSponsoredCounterClient(...).increment()`

## Generic API

```ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { NoirCompiledContract } from "@aztec/aztec.js/abi";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { executeSponsoredCall } from "@aztec-fpc/sdk";

export async function runSponsoredCall(input: {
  account: string;
  targetAddress: string;
  targetArtifact: NoirCompiledContract;
  targetMethod: string;
  targetArgs: unknown[];
  wallet: Wallet;
}) {
  const account = AztecAddress.fromString(input.account);

  const out = await executeSponsoredCall({
    wallet: input.wallet,
    account,
    sponsorship: {
      attestationBaseUrl: "https://attestation.example/v2",
      resolveFpcFromDiscovery: true,
      runtimeConfig: {
        nodeUrl: "https://your-aztec-node",
        operatorAddress:
          "0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8",
        fpc: {},
        acceptedAsset: {},
        targets: {
          target: {
            address: input.targetAddress,
            artifact: input.targetArtifact as never,
          },
        },
      },
      tokenSelection: {
        // optional:
        // explicitAcceptedAsset: "0x...",
        // selector: (assets) => assets.find((asset) => asset.name === "humanUSDC")?.address,
      },
    },
    buildCall: async (ctx) => {
      const contract = ctx.contracts.targets.target as {
        methods: {
          [name: string]: (...args: unknown[]) => {
            send: (args: unknown) => Promise<unknown>;
          };
        };
      };
      const method = contract.methods[input.targetMethod];
      if (!method) {
        throw new Error(`Unknown target method: ${input.targetMethod}`);
      }
      return method(...input.targetArgs);
    },
  });

  return out;
}
```

`executeSponsoredCall` returns:

```ts
type SponsoredExecutionResult<TReceipt> = {
  txHash: string;
  txFeeJuice: bigint;
  expectedCharge: bigint;
  userDebited: bigint;
  fjAmount: bigint;
  quoteValidUntil: bigint;
  receipt: TReceipt;
};
```

`fpc.artifact` and `acceptedAsset.artifact` are optional. When omitted, the SDK auto-loads standard artifacts (`fpc-FPCMultiAsset.json` and `token_contract-Token.json`) from `target/` when available, with bundled SDK artifact fallback.

## Token Discovery Behavior

Accepted-asset discovery fallback order is:

1. `GET /accepted-assets` (from discovery `endpoints.accepted_assets` when present)
2. `supported_assets` from `GET /.well-known/fpc.json`
3. legacy `GET /asset`

Selection options:

- explicit address: `tokenSelection.explicitAcceptedAsset`
- strategy callback: `tokenSelection.selector`
- default fallback: first supported asset

## FPC Address Resolution

`executeSponsoredCall` resolves FPC address in this order:

1. `runtimeConfig.fpc.address` when provided
2. discovery `fpc_address` when `resolveFpcFromDiscovery: true`

If both are provided and mismatched, execution fails with a typed error.

## Legacy Counter API

```ts
import { createSponsoredCounterClient } from "@aztec-fpc/sdk";

const client = await createSponsoredCounterClient({ wallet, account });
const result = await client.increment();
```

`createSponsoredCounterClient` is now a wrapper over `executeSponsoredCall`, preserving:

```ts
type SponsoredIncrementResult = {
  txHash: string;
  txFeeJuice: bigint;
  expectedCharge: bigint;
  userDebited: bigint;
  counterBefore: bigint;
  counterAfter: bigint;
  quoteValidUntil: bigint;
};
```

## Migration Example

Before:

```ts
const client = await createSponsoredCounterClient({ wallet, account });
await client.increment();
```

After:

```ts
await executeSponsoredCall({
  wallet,
  account,
  sponsorship: { attestationBaseUrl, runtimeConfig },
  buildCall: async (ctx) => {
    const target = ctx.contracts.targets.target as any;
    return target.methods.someEntrypoint(...args);
  },
});
```

## Error Codes

Errors are typed and include stable `code` and optional `details`.

- `PUBLISHED_ACCOUNT_REQUIRED`
- `INSUFFICIENT_FPC_FEE_JUICE`
- `QUOTE_VALIDATION_FAILED`
- `BALANCE_BOOTSTRAP_FAILED`
- `SPONSORED_TX_FAILED`

## Release (No Git Tags)

1. Bump only `sdk` version:

```bash
bun run release:sdk:version:patch
# or: bun run release:sdk:version:minor
# or: bun run release:sdk:version:major
```

2. Update `sdk/CHANGELOG.md` and commit.
3. Push to `main`.
4. GitHub Actions `publish-sdk.yml` publishes only when `sdk/package.json` has a version not yet on npm.
