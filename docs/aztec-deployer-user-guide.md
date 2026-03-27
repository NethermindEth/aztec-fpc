# Aztec FPC — Deployer & User Guide

> Single reference for deploying, operating, and integrating with the Nethermind Fee Payment Contract (FPC) on Aztec testnet.
>
> **Placeholders** are marked `<PLACEHOLDER>` — fill them at deployment time.

### Compatibility

| Dependency | Version |
|------------|---------|
| Aztec | `4.1.0-rc.4` |
| Bun | `1.3.11` |
| `@aztec/*` npm packages | Match the Aztec version above |

Install the required Aztec CLI:

```bash
VERSION=4.1.0-rc.4 bash -i <(curl -sL https://install.aztec.network/$VERSION)
```

> Your `@aztec/*` SDK dependencies (e.g. `@aztec/aztec.js`, `@aztec/entrypoints`) must match this version. Mismatched versions will cause serialisation or ABI errors at runtime.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [For Deployers](#for-deployers)
   - [Prerequisites](#deployer-prerequisites)
   - [1. Deploy FPC Contract](#1-deploy-fpc-contract)
   - [2. Configure & Start the Attestation Service](#2-configure--start-the-attestation-service)
   - [3. Configure Tokens](#3-configure-tokens)
   - [4. Configure & Start the Top-up Service](#4-configure--start-the-top-up-service)
   - [5. Verify the Deployment](#5-verify-the-deployment)
   - [Docker Compose (All-in-One)](#docker-compose-all-in-one)
4. [For Users (SDK Integration)](#for-users-sdk-integration)
   - [Prerequisites](#user-prerequisites)
   - [Install the SDK](#install-the-sdk)
   - [Pay Fees with an Existing Balance](#pay-fees-with-an-existing-balance)
   - [Cold Start (Bridge from L1 + Pay in One Tx)](#cold-start-bridge-from-l1--pay-in-one-tx)
5. [API Reference — Attestation Service](#api-reference--attestation-service)
6. [Debugging & Troubleshooting](#debugging--troubleshooting)
7. [Security Notes](#security-notes)

---

## Overview

The FPC lets users pay Aztec transaction fees in an accepted token (e.g. USDC) instead of native Fee Juice. An operator runs two services alongside the on-chain contract:

| Component | Role |
|-----------|------|
| **FPC Contract** (`FPCMultiAsset`) | On-chain fee payer; verifies operator-signed quotes, transfers tokens, pays Fee Juice to the protocol |
| **Attestation Service** | REST API that signs per-user fee quotes with the operator's Schnorr key |
| **Top-up Service** | Monitors the FPC's Fee Juice balance on L2 and bridges more from L1 when it drops below a threshold |
| **SDK** (`@aztec-fpc/sdk`) | TypeScript client that handles quote fetching, auth-witness construction, and tx submission for app developers |

---

## Architecture

```
User App (SDK)
     │
     │  GET /quote
     ▼
Attestation Service ──signs──▶ Operator Schnorr Key
     │
     │  signed quote
     ▼
User builds tx with fee_entrypoint payload
     │
     │  submit tx
     ▼
Aztec Network
     │
     ├── FPC Contract verifies quote signature
     ├── Transfers accepted_asset (user → operator, private)
     └── Protocol deducts Fee Juice from FPC balance
                    ▲
                    │ bridge when low
              Top-up Service ──bridge──▶ L1 Fee Juice Portal
```

---

## For Deployers

### Deployer Prerequisites

- Docker
- An Aztec node endpoint: `<AZTEC_NODE_URL>`
- An L1 RPC endpoint: `<L1_RPC_URL>` (for top-up and optionally test-token deploy)
- A deployer L2 secret key
- An operator L2 secret key (or same as deployer)
- An L1 private key (for the top-up service and optional test-token deploy)

### 1. Deploy FPC Contract

The `nethermind/aztec-fpc-contract-deployment` Docker image ships pre-compiled artifacts — no local Noir/Bun needed.

Deployment is a two-phase process. This step deploys the FPC contract only. Token deployment and registration happen separately in [step 3](#3-configure-tokens), after the attestation service is running.

#### Docker Image Tags

All examples below use the `:local` tag, which is the default when building locally. To build images from source:

```bash
# Build all images with default :local tag
docker buildx bake

# Build with a custom tag
TAG=v0.1.0 docker buildx bake

# Build with a custom registry + tag
REGISTRY=ghcr.io/ TAG=v0.1.0 docker buildx bake
```

Available images: `nethermind/aztec-fpc-contract-deployment`, `nethermind/aztec-fpc-attestation`, `nethermind/aztec-fpc-topup`, `nethermind/aztec-fpc-test`.

Replace `:local` with the appropriate tag if using pre-built images from a registry.

#### Deploy FPC

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_hex32>
export FPC_OPERATOR_SECRET_KEY=0x<operator_hex32>

mkdir -p deployments

docker run \
  -e AZTEC_NODE_URL=<AZTEC_NODE_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local
```

#### Deploy using a sponsored FPC for fee payment

```bash
docker run \
  -e AZTEC_NODE_URL=<AZTEC_NODE_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  --sponsored-fpc-address <EXISTING_FPC_ADDRESS>
```

#### Output

After FPC deployment, `./deployments/` contains:

```
deployments/
├── manifest.json                ← FPC deployment manifest (TREAT AS SECRET)
├── fpc-config.yaml              ← master config (your copy)
├── attestation/
│   └── config.yaml              ← generated attestation config
└── topup/
    └── config.yaml              ← generated topup config
```

After token configuration ([step 3](#3-configure-tokens)), a `tokens/` directory is added:

```
deployments/
└── tokens/
    └── FpcAcceptedAsset.json    ← test token manifest (one per deployed token)
```

> **Note:** If you provide a `fpc-config.yaml` before deploying, the container auto-generates per-service configs. Otherwise, deployment succeeds but config generation is skipped.

#### Master Config

Copy the example and edit before deploying:

```bash
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
```

Key fields:

| Section | Field | Description |
|---------|-------|-------------|
| `tokens` | `name` / `symbol` | Token identity (used for test token deployment and attestation registration) |
| `tokens` | `address` | Existing token address (omit to deploy a test token) |
| `tokens` | `market_rate_num` / `market_rate_den` | Exchange rate: accepted_asset per 1 FeeJuice |
| `tokens` | `fee_bips` | Operator margin in basis points (200 = 2%) |
| `attestation` | `quote_validity_seconds` | Quote TTL (default 300) |
| `attestation` | `quote_auth_mode` | Auth mode: `disabled`, `api_key`, `trusted_header`, etc. |
| `topup` | `threshold` | Bridge when FPC balance drops below this (wei) |
| `topup` | `top_up_amount` | Amount to bridge each time (wei) |
| `topup` | `check_interval_ms` | Balance poll interval (default 60000) |

#### Preflight Check (Dry Run)

Validate node connectivity and deployer state without submitting transactions:

```bash
docker run -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  --node-url <AZTEC_NODE_URL> \
  --preflight-only
```

---

### 2. Configure & Start the Attestation Service

The attestation service signs per-user fee quotes. It runs as `nethermind/aztec-fpc-attestation`.

#### Minimal config.yaml

If you ran contract deployment with a master config, `deployments/attestation/config.yaml` is already generated. Otherwise, create one:

```yaml
runtime_profile: "production"
network_id: "<NETWORK_ID>"                     # e.g. "aztec-testnet"
fpc_address: "<FPC_ADDRESS>"
contract_variant: "fpc-v1"
aztec_node_url: "<AZTEC_NODE_URL>"
quote_validity_seconds: 300
port: 3000

# Operator key — use env var in production
operator_secret_provider: "env"                # reads OPERATOR_SECRET_KEY env var

# Token
accepted_asset_name: "<TOKEN_NAME>"            # e.g. "humanUSDC"
accepted_asset_address: "<TOKEN_ADDRESS>"

# Exchange rate: accepted_asset per 1 FeeJuice
market_rate_num: <RATE_NUM>                    # e.g. 1
market_rate_den: <RATE_DEN>                    # e.g. 1000
fee_bips: <FEE_BIPS>                           # e.g. 200 (= 2%)

# Auth (required for production)
quote_auth_mode: "api_key"                     # or "trusted_header", etc.
# quote_auth_api_key: set via env or fill here for dev

# Rate limiting
quote_rate_limit_enabled: true
quote_rate_limit_max_requests: 60
quote_rate_limit_window_seconds: 60

# Multi-asset support (optional)
# If omitted, a single asset is derived from accepted_asset_* + market_rate_* above.
# Per-asset pricing fields are optional; omitted values inherit from the top-level defaults.
# supported_assets:
#   - address: "<TOKEN_ADDRESS>"
#     name: "humanUSDC"
#     market_rate_num: 1
#     market_rate_den: 1000
#     fee_bips: 200
#   - address: "<SECOND_TOKEN_ADDRESS>"
#     name: "ravenETH"
#     market_rate_num: 3
#     market_rate_den: 1000
#     fee_bips: 25

# Public base URL override (set when behind a reverse proxy)
# quote_base_url: "https://attestation.example.com"

# PXE data directory for operator note persistence (recommended for production)
# pxe_data_directory: "./.attestation-pxe"
```

> **Reverse proxy note:** If the attestation service sits behind a reverse proxy, set `quote_base_url` so that `/.well-known/fpc.json` returns the correct public URL. Without this, the discovery response derives its base URL from request headers, which may not reflect the external hostname.

#### Run

```bash
export OPERATOR_SECRET_KEY=0x<operator_hex32>

docker run -d \
  -e OPERATOR_SECRET_KEY \
  -v ./deployments/attestation/config.yaml:/app/config.yaml \
  -p 3000:3000 \
  nethermind/aztec-fpc-attestation:local
```

#### Verify

```bash
# Health check
curl http://localhost:3000/health

# Discovery metadata
curl http://localhost:3000/.well-known/fpc.json

# Supported assets
curl http://localhost:3000/accepted-assets

# Request a quote (example)
curl "http://localhost:3000/quote?user=<USER_ADDRESS>&accepted_asset=<TOKEN_ADDRESS>&fj_amount=1000000000"
```

---

### 3. Configure Tokens

Once the attestation service is running, use the `configure-token` subcommand to deploy test tokens (if needed) and register them with the attestation service.

The `configure-token` subcommand reads the `tokens` section from `fpc-config.yaml`. For each token:
- If `address` is provided, it registers the existing token with the attestation service.
- If `address` is omitted, it first deploys a full test token stack (L1 ERC20 + L2 Token + Bridge + Faucet), then registers it.

#### Configure tokens (deploy test tokens + register)

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_hex32>
export FPC_L1_DEPLOYER_KEY=0x<l1_key>
export ADMIN_API_KEY=<admin_secret>

docker run \
  -e AZTEC_NODE_URL=<AZTEC_NODE_URL> \
  -e L1_RPC_URL=<L1_RPC_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_L1_DEPLOYER_KEY \
  -e FPC_ATTESTATION_URL=<ATTESTATION_URL> \
  -e ADMIN_API_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token
```

> If the attestation service is on `localhost`, add `--network host` so the container can reach the host network.

#### Register existing tokens only

If all tokens in `fpc-config.yaml` have explicit `address` values, no L1/L2 deployment keys are needed:

```bash
export ADMIN_API_KEY=<admin_secret>

docker run \
  -e FPC_ATTESTATION_URL=<ATTESTATION_URL> \
  -e ADMIN_API_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token
```

#### Deploy tokens without registration

Deploy test tokens only, skipping attestation registration (useful when attestation is not yet running):

```bash
docker run \
  -e AZTEC_NODE_URL=<AZTEC_NODE_URL> \
  -e L1_RPC_URL=<L1_RPC_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_L1_DEPLOYER_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token --skip-registration
```

#### Output

Test token manifests are written to `deployments/tokens/<TokenName>.json` and contain:
- L2 addresses: token, bridge, faucet, counter
- L1 addresses: ERC20, token portal
- Faucet configuration and deployment tx hashes

---

### 4. Configure & Start the Top-up Service

The top-up service monitors the FPC's Fee Juice balance and bridges from L1 when it drops below a threshold.

#### L1 Funding Prerequisite

The top-up service bridges Fee Juice from L1 to L2. Its L1 operator account must hold:

- **ETH** — to pay L1 gas for bridge transactions
- **Fee Juice token balance** — the ERC-20 that gets bridged to L2

Fund the L1 operator account before starting the service. The repo includes a helper script:

```bash
export AZTEC_NODE_URL=<AZTEC_NODE_URL>
export L1_RPC_URL=<L1_RPC_URL>
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>
bun run fund:l1:fee-juice
```

This checks the operator's L1 Fee Juice token balance and mints up to the target if below. The L1 Fee Juice token and portal addresses are auto-discovered from the connected Aztec node.

#### Minimal config.yaml

```yaml
runtime_profile: "production"
fpc_address: "<FPC_ADDRESS>"
aztec_node_url: "<AZTEC_NODE_URL>"
l1_rpc_url: "<L1_RPC_URL>"

# L1 operator key — use env var in production
l1_operator_secret_provider: "env"             # reads L1_OPERATOR_PRIVATE_KEY env var

# Thresholds (in wei)
threshold: "1000000000000000000"               # 1 FeeJuice — bridge when below this
top_up_amount: "10000000000000000000"          # 10 FeeJuice — amount to bridge each time

# LMDB-backed persistent state directory for crash recovery
data_dir: ".topup-data"

# Polling
check_interval_ms: 60000                       # check every 60s
ops_port: 3001                                 # health/metrics port

# Confirmation polling after an L1 bridge tx is mined (tune for slow networks)
confirmation_timeout_ms: 180000                # max wait for L2 settlement (default 180s)
confirmation_poll_initial_ms: 1000             # initial poll interval (default 1s)
confirmation_poll_max_ms: 15000                # max poll interval with backoff (default 15s)
```

#### Auto-Claim

After the top-up service bridges Fee Juice from L1, the tokens must be claimed on L2. Auto-claim handles this automatically. Configure via environment variables:

| Env var | Description |
|---------|-------------|
| `TOPUP_AUTOCLAIM_ENABLED` | Enable auto-claim (default: `1`; set `0` to disable) |
| `TOPUP_AUTOCLAIM_SECRET_KEY` | L2 secret key for the claimer account (required in production) |
| `TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS` | Use a sponsored FPC to pay claim tx fees (recommended) |

In `development` profile, if `TOPUP_AUTOCLAIM_SECRET_KEY` is not set, the service falls back to the first test account from `@aztec/accounts/testing`. In `production`, an explicit secret key is required.

#### Run

```bash
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>

docker run -d \
  -e L1_OPERATOR_PRIVATE_KEY \
  -v ./deployments/topup/config.yaml:/app/config.yaml \
  -p 3001:3001 \
  nethermind/aztec-fpc-topup:local
```

#### Verify

```bash
# Health
curl http://localhost:3001/health

# Readiness (200 = ready, 503 = not ready)
curl http://localhost:3001/ready

# Prometheus metrics
curl http://localhost:3001/metrics
```

---

### 5. Verify the Deployment

Run the post-deploy smoke test to confirm the full flow works end-to-end.

> These commands require a local repo checkout with dependencies installed (`bun install` from the repo root).

```bash
# Fee-entrypoint negative-path smoke (requires pre-deployed contracts + node)
FPC_COLD_START_MANIFEST=path/to/manifest.json FPC_ATTESTATION_URL=http://localhost:3000 bun run smoke:fee-entrypoint

# Services smoke (attestation + topup + contract, via docker compose)
bun run smoke:services:compose
```

---

### Docker Compose (All-in-One)

For testnet deployments, use the public compose file:

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_key>
export FPC_OPERATOR_SECRET_KEY=0x<operator_key>
export FPC_L1_DEPLOYER_KEY=0x<l1_key>
export ADMIN_API_KEY=<admin_secret>

DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

The compose file reads network defaults from `.env.testnet` and mounts `deployments/${DEPLOYMENT}/` as the data directory. The service dependency chain is:

1. `deploy` — deploys the FPC contract, writes manifest and service configs.
2. `attestation` + `topup` — start once deploy completes.
3. `configure-token` — deploys test tokens (if needed) and registers them with the running attestation service.

After the run, all output lives in `deployments/testnet/`.

---

## For Users (SDK Integration)

> For a complete runnable example covering cold-start and FPC-paid deployment, see [`examples/fpc-full-flow.ts`](../examples/fpc-full-flow.ts). Run it from the repo root with:
>
> ```bash
> bun run examples/fpc-full-flow.ts
> ```

### User Prerequisites

- An Aztec wallet / account
- The deployed FPC details (provided by the operator):

| Value | Testnet | Description |
|-------|---------|-------------|
| `<AZTEC_NODE_URL>` | `https://rpc.testnet.aztec-labs.com/` | Aztec node RPC URL |
| `<ATTESTATION_URL>` | `https://aztec-fpc-testnet.staging-nethermind.xyz/` | Attestation service base URL |
| `<FPC_ADDRESS>` | `0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f` | Deployed FPC contract address |
| `<OPERATOR_ADDRESS>` | `0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974` | Operator's Aztec address |
| `<TOKEN_ADDRESS>` | `0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb` | Accepted token address |

### Install the SDK

The SDK is not yet published to npm. Install from a local clone:

```bash
git clone https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
git submodule update --init --recursive
aztec compile --workspace --force
bun install && bun run build

cd /path/to/your-app
bun add /absolute/path/to/aztec-fpc/sdk
```

### Pay Fees with an Existing Balance

Use `createPaymentMethod` when the user already has L2 tokens and wants to pay fees through the FPC.

```ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@aztec-fpc/sdk";

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

**What happens under the hood:**

1. SDK fetches current gas prices from the node and computes `fj_amount` (with a gas buffer)
2. SDK fetches a signed quote from `GET <ATTESTATION_URL>/quote`
3. SDK builds a token transfer auth-witness (user → operator) for the quoted `aa_payment_amount`
4. SDK builds the `fee_entrypoint` call payload with the quote signature
5. Returns `fee` options ready to attach to any Aztec tx — you send the tx yourself

### Cold Start (Bridge from L1 + Pay in One Tx)

Use `executeColdStart` when the user has bridged tokens from L1 but has **no existing L2 balance** to pay fees.

```ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1ToL2TokenPortalManager } from "@aztec/aztec.js/ethereum";
import { Fr } from "@aztec/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger } from "@aztec/foundation/log";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FpcClient } from "@aztec-fpc/sdk";

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

**What happens:** The code above bridges tokens from L1 and waits for the message to land on L2. Then `executeColdStart`:

1. Fetches current gas prices and computes `fj_amount` (using fixed cold-start gas limits)
2. Fetches a signed cold-start quote from `GET <ATTESTATION_URL>/cold-start-quote`
3. Builds the `cold_start_entrypoint` call that atomically claims bridged tokens and pays the FPC fee
4. Proves, sends, and waits for the tx — returns the result once mined

> **Where to find `<BRIDGE_ADDRESS>`:** If test tokens were deployed via `configure-token`, the bridge address is recorded in the token manifest (`tokens/<TokenName>.json`). For production tokens with an existing address, obtain the bridge address from the token's deployment records or the operator.

---

## API Reference — Attestation Service

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe (returns 200) |
| `GET` | `/.well-known/fpc.json` | Discovery metadata (network, FPC address, supported assets, endpoints) |
| `GET` | `/accepted-assets` | List of supported assets with pricing |
| `GET` | `/quote` | Request a signed fee quote |
| `GET` | `/cold-start-quote` | Request a signed cold-start quote (includes claim fields) |
| `GET` | `/metrics` | Prometheus metrics |

### `GET /quote`

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `user` | `string` | User's Aztec address |
| `accepted_asset` | `string` | Token address to pay with |
| `fj_amount` | `string` | Fee Juice amount (u128, computed from gas estimate) |

**Response:**

```json
{
  "accepted_asset": "<TOKEN_ADDRESS>",
  "fj_amount": "1000000000",
  "aa_payment_amount": "1023000",
  "valid_until": "1700000000",
  "signature": "0x<128-hex-chars>"
}
```

### Admin Endpoints

Admin endpoints are **disabled by default**. Enable them by setting `admin_api_key` in the attestation config. All admin requests require the configured API key header.

```yaml
admin_api_key: "<ADMIN_SECRET>"
admin_api_key_header: "x-admin-api-key"    # default header name
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/asset-policies` | List all supported asset policies |
| `PUT` | `/admin/asset-policies/:assetAddress` | Add or update an asset policy |
| `DELETE` | `/admin/asset-policies/:assetAddress` | Remove an asset (fails if it's the last one) |
| `GET` | `/admin/operator-balances` | Show operator's private token balances |
| `POST` | `/admin/sweeps` | Sweep operator tokens to a destination |

#### `PUT /admin/asset-policies/:assetAddress`

```json
{
  "name": "humanUSDC",
  "market_rate_num": 1,
  "market_rate_den": 1000,
  "fee_bips": 200
}
```

All fields (`name`, `market_rate_num`, `market_rate_den`, `fee_bips`) are required.

#### `POST /admin/sweeps`

```json
{
  "accepted_asset": "<TOKEN_ADDRESS>",
  "destination": "<DESTINATION_ADDRESS>",
  "amount": "5000000"
}
```

- `destination` is optional if `treasury_destination_address` is configured.
- `amount` is optional — omit to sweep the full operator balance.
- Returns `{ acceptedAsset, destination, sweptAmount, balanceBefore, balanceAfter, txHash }`.

### `GET /cold-start-quote`

Used by the cold-start flow when the user has no existing L2 balance. The attestation service validates that `claim_amount >= aa_payment_amount` before signing.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `user` | `string` | User's Aztec address |
| `accepted_asset` | `string` | Token address to pay with |
| `fj_amount` | `string` | Fee Juice amount (u128) |
| `claim_amount` | `string` | Amount being claimed from the L1→L2 bridge (u128) |
| `claim_secret_hash` | `string` | Claim secret hash (0x-prefixed hex) |

**Response:**

```json
{
  "accepted_asset": "<TOKEN_ADDRESS>",
  "fj_amount": "1000000000",
  "aa_payment_amount": "1023000",
  "valid_until": "1700000000",
  "claim_amount": "5000000000",
  "claim_secret_hash": "0xabc123...",
  "signature": "0x<128-hex-chars>"
}
```

> The cold-start quote uses a different domain separator (`0x46504373` / `"FPCs"`) to prevent cross-entrypoint replay. The hash preimage includes all regular quote fields plus `claim_amount` and `claim_secret_hash`.

### Quote Pricing Formula

```
final_rate_num = market_rate_num × (10000 + fee_bips)
final_rate_den = market_rate_den × 10000

aa_payment_amount = ceil(fj_amount × final_rate_num / final_rate_den)
```

Example: if `market_rate_num=1`, `market_rate_den=1000`, `fee_bips=200` (2%):
- 1 FeeJuice = 0.001 × 1.02 = 0.00102 accepted_asset

---

## Debugging & Troubleshooting

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Quote request returns 401/403 | Auth mode enabled; missing API key | Pass the API key header configured in `quote_auth_mode` |
| Quote request returns 429 | Rate limited | Wait for the window to reset, or raise `quote_rate_limit_max_requests` |
| Tx reverts with "invalid quote" | Quote expired or wrong FPC/token address | Check `valid_until` vs current block timestamp; verify addresses match the deployed contract |
| Tx reverts with authwit error | Auth-witness mismatch | Ensure the nonce and transfer call match exactly what the FPC expects |
| Top-up service not bridging | Balance above threshold | Check `GET <TOPUP_URL>/metrics` for `topup_balance_checks_total`; lower `threshold` if needed |
| Top-up bridge stuck | L1 tx pending or L2 message not yet available | Check `data_dir` LMDB store for in-flight state; check L1 tx status |
| Cold start fails | Claim details don't match L1→L2 message | Verify `claimSecret`, `claimSecretHash`, and `messageLeafIndex` from the bridge tx |
| `PUBLISHED_ACCOUNT_REQUIRED` | User account not deployed on L2 | Deploy the user's account contract first, or use cold-start which doesn't require it |

### Health & Metrics Endpoints

| Service | Health | Readiness | Metrics |
|---------|--------|-----------|---------|
| Attestation | `GET <ATTESTATION_URL>/health` | — | `GET <ATTESTATION_URL>/metrics` |
| Top-up | `GET <TOPUP_URL>/health` | `GET <TOPUP_URL>/ready` | `GET <TOPUP_URL>/metrics` |

### Key Prometheus Metrics

**Attestation:**
- `attestation_quote_requests_total{outcome}` — total quotes issued / rejected
- `attestation_quote_errors_total{error_type}` — errors by type
- `attestation_quote_latency_seconds{outcome}` — quote signing latency

**Top-up:**
- `topup_bridge_events_total{event}` — bridge lifecycle (submitted, confirmed, timeout, aborted, failed)
- `topup_balance_checks_total{outcome}` — balance check results
- `topup_readiness_status` — 1 = ready, 0 = not ready

### Logs

Both services use structured JSON logging. Set `LOG_LEVEL=debug` for verbose output.

### Re-generate Service Configs

If you need to update configs after editing `fpc-config.yaml`:

```bash
docker run -v ./deployments:/app/deployments \
  --entrypoint bash \
  nethermind/aztec-fpc-contract-deployment:local \
  scripts/config/generate-service-configs.sh
```

---

## Security Notes

- **Never pass secrets as CLI arguments or inline `-e KEY=VALUE`.** Export them first and pass by name (`-e FPC_DEPLOYER_SECRET_KEY`). Inline values are visible in `ps`, `docker inspect`, and shell history.
- The deployment manifest (`manifest.json`) may contain raw private keys. **Treat it as secret material.**
- In production, set `runtime_profile: "production"` — this rejects plaintext secrets in config files and requires `quote_auth_mode != disabled`.
- Prefer KMS/HSM secret providers (`operator_secret_ref`, `l1_operator_secret_ref`) over plaintext keys.
- Enable rate limiting on the attestation service in all environments.
- The top-up service's L1 operator key has the ability to spend ETH for bridging. Restrict its funding to the minimum required operational balance.
- Do not commit manifests or config files containing plaintext keys to version control.

---

## Deployment Checklist

```
[ ] Aztec version 4.1.0-rc.4 installed (or matching node version)
[ ] Aztec node accessible at <AZTEC_NODE_URL>
[ ] L1 RPC accessible at <L1_RPC_URL>
[ ] Deployer and operator keys generated and secured
[ ] Master config (fpc-config.yaml) edited with tokens and exchange rates
[ ] Docker images built or pulled (docker buildx bake or use registry tag)
[ ] FPC contract deployed; manifest.json generated
[ ] L1 operator account funded with ETH + Fee Juice tokens
[ ] Attestation service running and /health returns 200
[ ] quote_base_url set if behind a reverse proxy
[ ] Tokens configured (configure-token completed; token manifests in tokens/)
[ ] Top-up service running and /ready returns 200
[ ] Auto-claim configured (TOPUP_AUTOCLAIM_SECRET_KEY set)
[ ] Smoke test passing (docker compose smoke profile)
[ ] Publish to users:
    [ ] ATTESTATION_URL: <ATTESTATION_URL>
    [ ] FPC_ADDRESS: <FPC_ADDRESS>
    [ ] OPERATOR_ADDRESS: <OPERATOR_ADDRESS>
    [ ] TOKEN_ADDRESS: <TOKEN_ADDRESS>
    [ ] AZTEC_NODE_URL: <AZTEC_NODE_URL>
    [ ] BRIDGE_ADDRESS: <BRIDGE_ADDRESS> (from tokens/<TokenName>.json; required for cold-start)
```