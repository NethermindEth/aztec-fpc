# `@aztec-fpc/sponsored-counter-sdk`

Scaffold package for the sponsored counter SDK.

Current status:
- Step 1 scaffold complete (workspace package skeleton and bundled artifacts).
- Runtime behavior implementation is added in later steps of `local-docs/SDK_PLAN.md`.

## Install

```bash
bun add @aztec-fpc/sponsored-counter-sdk
```

## Usage

```ts
import { createSponsoredCounterClient } from "@aztec-fpc/sponsored-counter-sdk";

const client = await createSponsoredCounterClient({
  wallet,
  account,
});

await client.increment();
```
