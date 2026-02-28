# Alpha Ad-Hoc FPC Operator Runbook (30 Minutes)

Date: 2026-02-27  
Repository root: `/home/ametel/source/aztec-fpc`

## Goal

Spin up a working local FPC operator stack with:

- `Token` + `FPC` + `CreditFPC` deployed
- attestation service running
- top-up service running
- end-to-end fee flow validated

## Prerequisites

1. Aztec CLI installed and on `PATH` (`aztec`, `aztec-wallet`).
2. Bun installed (`bun`).
3. Node.js available (`node`).
4. Repository dependencies installed:

```bash
bun install
```

## Fastest Validation Path (Recommended)

This single flow compiles contracts, deploys contracts, starts services, and validates both FPC modes (`fpc` + `credit`):

```bash
FPC_SERVICES_SMOKE_MODE=both bun run smoke:services:local
```

Expected success signal: script exits `0` and prints service-smoke completion logs without errors.

## Manual Operator Path

Use this when you want explicit deploy output and service config files.

### 1. Start local Aztec network

```bash
aztec start --local-network
```

### 2. Compile and deploy contracts

In another terminal at repo root:

```bash
aztec compile --workspace --force
FPC_LOCAL_OUT=./tmp/deploy-fpc-local.json bun run deploy:fpc:local
```

Deployment output file: `./tmp/deploy-fpc-local.json`

Useful fields in output:

- `fpc_address`
- `credit_fpc_address`
- `accepted_asset`
- `operator`

### 3. Configure and run attestation service

```bash
cd services/attestation
cp config.example.yaml config.yaml
```

Set in `config.yaml`:

- `fpc_address` = deploy output `.fpc_address`
- `accepted_asset_address` = deploy output `.accepted_asset`

Then run:

```bash
bun install
bun run build
bun run start
```

### 4. Configure and run top-up service

In a new terminal:

```bash
cd services/topup
cp config.example.yaml config.yaml
```

Set in `config.yaml`:

- `fpc_address` = deploy output `.fpc_address`
- `aztec_node_url` = `http://localhost:8080`
- `l1_rpc_url` = `http://localhost:8545`

Then run:

```bash
bun install
bun run build
bun run start
```

### 5. Basic health checks

```bash
curl -sS http://localhost:3001/health
curl -sS http://localhost:3001/ready
curl -sS "http://localhost:3000/quote?user=0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72"
```

## Ad-Hoc Dual-Asset Pattern

Current architecture is one accepted asset per deployment. To run two assets, deploy two stacks:

```bash
FPC_LOCAL_OUT=./tmp/deploy-usdc.json bun run deploy:fpc:local
FPC_LOCAL_OUT=./tmp/deploy-eth.json bun run deploy:fpc:local
```

Then run separate attestation/top-up instances per stack with:

- different `fpc_address` and `accepted_asset_address`
- different ports (example: `3000/3001` and `3100/3101`)

## Evidence Checklist

- `deploy-fpc-local` output file exists and has non-zero addresses.
- attestation and top-up processes are healthy.
- `bun run smoke:services:local` passes in `both` mode.
