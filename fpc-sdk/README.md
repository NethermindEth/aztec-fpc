# `@aztec-fpc/sponsored-counter-sdk`

Minimal SDK for FPC-sponsored `Counter.increment(user)` on Aztec devnet.

## Install

```bash
bun add @aztec-fpc/sponsored-counter-sdk
```

## Minimal Usage

```ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { createSponsoredCounterClient } from "@aztec-fpc/sponsored-counter-sdk";

export async function runSponsoredIncrement(input: {
  account: string;
  wallet: Wallet;
}) {
  const client = await createSponsoredCounterClient({
    wallet: input.wallet,
    account: AztecAddress.fromString(input.account),
  });

  return client.increment();
}
```

## Returned Result

`client.increment()` resolves to:

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

## Error Codes

Errors are typed and include stable `code` and optional `details` fields.

- `PUBLISHED_ACCOUNT_REQUIRED`: user account is not published on node.
- `INSUFFICIENT_FPC_FEE_JUICE`: FPC lacks FeeJuice for required gas amount.
- `QUOTE_VALIDATION_FAILED`: attestation quote is invalid or mismatched.
- `BALANCE_BOOTSTRAP_FAILED`: user private balance could not be prepared.
- `SPONSORED_TX_FAILED`: sponsorship flow or tx send/invariants failed.

Suggested UI handling:
- show `error.code` for deterministic branching
- show `error.message` to users
- log `error.details` for diagnostics

## v1 Limitations

- Runtime values are fixed (node URL, attestation URL, contract addresses, gas limits).
- Only sponsored `Counter.increment(user)` is supported.
- No local-network mode.
