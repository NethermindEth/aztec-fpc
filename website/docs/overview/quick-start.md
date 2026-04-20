---
title: Quick Start
description: Three paths to a running FPC stack. Docker Compose for local dev, manual bring-up for debugging, or the hosted testnet to skip deployment entirely.
---

# Quick Start

Three paths to a working FPC. Pick based on what you need.

| Option | Best for |
|--------|----------|
| [Docker Compose](#option-1-docker-compose) | Local dev, fastest setup |
| [Manual bring-up](#option-2-manual-bring-up) | Debugging, customizing individual services |
| [Hosted testnet](#option-3-hosted-testnet) | SDK integration without any deployment |

---

## Option 1: Docker Compose

One command starts the full stack locally.

**Prerequisites**

- Docker and Docker Compose
- Bun `1.3.11`
- Aztec CLI `4.2.0-aztecnr-rc.2`

```bash
VERSION=4.2.0-aztecnr-rc.2 bash -i <(curl -sL https://install.aztec.network/$VERSION)
```

**Setup**

```bash
git clone https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
git submodule update --init --recursive
bun install
bun run compose:full
```

`compose:full` starts the following services.

| Service | Port |
|---------|------|
| Anvil (L1) | `8545` |
| Aztec node (L2) | `8080` |
| Attestation service | `3000` |
| Top-up service | `3001` |

The FPC contract and test token are deployed automatically as part of startup.

**Verify**

```bash
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/fpc.json
curl http://localhost:3000/accepted-assets
curl http://localhost:3001/ready
```

To run the full service integration test suite after the stack is up:

```bash
bun run smoke:services:compose
```

---

## Option 2: Manual bring-up

Run each component separately. Requires the Aztec CLI and Bun installed.

```bash
# Terminal 1: start a local Aztec network
aztec start --local-network

# Terminal 2: compile and deploy from repo root
aztec compile --workspace --force
export AZTEC_NODE_URL=http://localhost:8080
export FPC_DEPLOYER_SECRET_KEY=0x<your_deployer_key>
export FPC_OPERATOR_SECRET_KEY=0x<your_operator_key>
bun run deploy:fpc
# Manifest written to ./deployments/manifest.json by default.
# Set FPC_OUT=./path/to/manifest.json to change the output path.

# Terminal 3: attestation service
cd services/attestation
cp config.example.yaml config.yaml
# Edit config.yaml: set fpc_address and accepted_asset from the manifest.
OPERATOR_SECRET_KEY=0x<operator_key> bun run start

# Terminal 4: top-up service
cd services/topup
cp config.example.yaml config.yaml
# Edit config.yaml: set fpc_address from the manifest.
L1_OPERATOR_PRIVATE_KEY=0x<l1_key> bun run start
```

> [!NOTE]
> For `aztec start --local-network`, FeeJuice L1 contract addresses are provisioned by the local network bootstrap. Do not add a manual custom L1 FeeJuice deployment step. The top-up service discovers these addresses from the Aztec node's `nodeInfo`.

**Verify**

```bash
curl http://localhost:3000/health
curl http://localhost:3001/ready
```

For a full production walkthrough including Docker images and auto-claim, see [Run an Operator](../how-to/run-operator.md) and [Deployment](../operations/deployment.md).

---

## Option 3: Hosted testnet

No deployment required. The Nethermind-operated testnet FPC is available for SDK integration and testing.

All addresses, URLs, and a live verification check are on the [Testnet Deployment](../reference/testnet-deployment.md) page.

---

## Send a fee-abstracted transaction

Once you have a running FPC (local or testnet), this pattern sends a transaction with fee payment handled by the FPC.

```typescript
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";
import { FpcWallet } from "./scripts/common/fpc-wallet";

// 1. Connect to node and create wallet
const node = createAztecNodeClient("https://rpc.testnet.aztec-labs.com/");
await waitForNode(node);
const wallet = await FpcWallet.create(node, { ephemeral: true });

// 2. Create FPC client
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

// 3. Simulate to get gas estimate
const { estimatedGas } = await someContract.methods
  .someMethod(args)
  .simulate({ from: wallet.getAddress(), fee: { estimateGas: true } });

// 4. Build payment method from quote
const { fee } = await fpcClient.createPaymentMethod({
  wallet,
  user: wallet.getAddress(),
  tokenAddress: AztecAddress.fromString(
    "0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb",
  ),
  estimatedGas,
});

// 5. Send
await someContract.methods.someMethod(args).send({ from: wallet.getAddress(), fee }).wait();
```

**Full runnable example**

`examples/fpc-full-flow.ts` covers cold-start and standard fee payment end-to-end against the testnet deployment. Run it from the repo root:

```bash
bunx tsx examples/fpc-full-flow.ts
```

---

## Where to go next

- [Architecture](../overview/architecture.md) for how the components fit together
- [SDK Getting Started](../sdk/getting-started.md) for cold-start, authwit flow, and error handling
- [Run an Operator](../how-to/run-operator.md) for production deployment
- [Deployment](../operations/deployment.md) for Docker-based deploy to devnet or testnet
