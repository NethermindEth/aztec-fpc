# Devnet Deployment How-To

> [!CAUTION]
> **This document is deprecated.** It may contain outdated function names, wrong default values, or references to scripts that no longer exist. For accurate, source-verified documentation, see [docs/README.md](../../README.md).


> Non-Docker deployment flow for Aztec devnet using shell scripts and `bun`.
> For Docker-based deployment, see [aztec-deployer-user-guide.md](../aztec-deployer-user-guide.md).

Scripts used:

- `scripts/contract/deploy-fpc.sh` — recommended wrapper
- `contract-deployment/src/index.ts` — advanced/manual TypeScript entrypoint
- `contract-deployment/src/verify.ts` — post-deploy verification (programmatic API)
- `scripts/contract/devnet-postdeploy-smoke.ts` — post-deploy runtime smoke

## 1. One Command Deploy

From repo root:

```bash
bun run deploy:fpc
```

This command deploys:

- `Token` (unless you provide `FPC_ACCEPTED_ASSET`)
- `FPC`

It writes the manifest to:

- `deployments/devnet-manifest-v2.json`

## 2. One Command Preflight

To run checks only (no contract deploy txs):

```bash
FPC_PREFLIGHT_ONLY=1 bun run deploy:fpc
```

## 3. Current Defaults

If unset, wrapper defaults are:

- `FPC_SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2`
- `FPC_OUT=./deployments/devnet-manifest-v2.json`

Required env vars (no defaults — deployment fails if missing):

- `AZTEC_NODE_URL` — Aztec node URL
- `FPC_DEPLOYER_SECRET_KEY` (or `FPC_DEPLOYER_SECRET_KEY_REF`) — deployer secret key

Key behavior when operator key env vars are unset:

- sets operator key equal to deployer key

Artifact behavior:

- wrapper aligns `vendor/aztec-standards` version pins before deploy
- if contract artifacts are missing, wrapper runs `aztec compile --workspace --force` automatically

## 4. Explicit Configuration

If you want explicit control, set env vars before running:

```bash
export AZTEC_NODE_URL="https://v4-devnet-2.aztec-labs.com/"
export FPC_SPONSORED_FPC_ADDRESS="0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2"
export FPC_OUT="./deployments/devnet-manifest-v2.json"
```

Deployer key material (set exactly one):

```bash
export FPC_DEPLOYER_SECRET_KEY="0x..."
# or
export FPC_DEPLOYER_SECRET_KEY_REF="secret-manager://devnet/l2-deployer"
```

Operator key material (set exactly one):

```bash
export FPC_OPERATOR_SECRET_KEY="0x..."
# or (preflight-only use-case)
export FPC_OPERATOR_SECRET_KEY_REF="secret-manager://devnet/operator"
```

Then run:

```bash
bun run deploy:fpc
```

## 5. Reuse Existing Accepted Asset

To skip Token deployment and reuse an existing token:

```bash
export FPC_ACCEPTED_ASSET="0x<existing_token_address>"
bun run deploy:fpc
```

## 6. Optional L1 Chain Validation

To enforce node/L1 RPC chain-id match:

```bash
export L1_RPC_URL="https://..."
export FPC_VALIDATE_TOPUP_PATH=1
bun run deploy:fpc
```

## 7. Direct Script (Advanced)

Manual TypeScript invocation:

```bash
bunx tsx contract-deployment/src/index.ts \
  --node-url "https://v4-devnet-2.aztec-labs.com/" \
  --sponsored-fpc-address "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2" \
  --deployer-secret-key "0x..." \
  --operator-secret-key "0x..." \
  --out "./deployments/devnet-manifest-v2.json"
```

## 8. What Gets Written

Manifest contains:

- network metadata (`node_url`, `node_version`, `l1_chain_id`, `rollup_version`)
- required Aztec/L1/protocol addresses from live `node_getNodeInfo`
- deployer address and key material (`private_key` or `private_key_ref`)
- deployed contract addresses
- operator address and pubkeys
- tx hashes

The output is schema-validated via `writeDevnetDeployManifest(...)`.

## 9. Post-Deploy Verification

Post-deploy verification is available programmatically via `verifyDeployment()` from `contract-deployment/src/verify.ts`. It can be called after deployment with a manifest and node client.

Checks performed:

- contract existence on node for `fpc`
- FPC immutable verification against manifest operator/pubkeys
- contract instance readiness (published instance + non-zero initialization hash)
- contract class readiness (class publicly registered)

## 10. Render Service Configs From Manifest

Render `services/attestation/config.yaml` and `services/topup/config.yaml` from the canonical manifest:

```bash
bun run generate:configs
```

If your local `.env` stores the L1 key as `L1_ADDRESS_PK`, map it before running:

```bash
set -a; source .env; set +a
export L1_OPERATOR_PRIVATE_KEY="$L1_ADDRESS_PK"
```

Build validation:

```bash
bun run attestation:build
bun run topup:build
```

Notes:

- Script default manifest is `./deployments/devnet-manifest-v2.json`.
- Topup bridge addresses are intentionally not written; topup resolves them dynamically from `node_getNodeInfo`.

## 11. Post-Deploy Runtime Smoke

Run runtime validation against deployed contracts in the manifest:

```bash
set -a; source .env; set +a
export L1_OPERATOR_PRIVATE_KEY="$L1_ADDRESS_PK"
export L1_RPC_URL="https://sepolia.infura.io/v3/<key>"
bunx tsx scripts/contract/devnet-postdeploy-smoke.ts \
  --manifest ./deployments/devnet-manifest-v2.json
```

What this validates:

- one successful FPC fee path tx
- L1 FeeJuice bridge/topup path to FPC

Optional explicit operator override (only needed when manifest fallback is not usable):

```bash
export FPC_OPERATOR_SECRET_KEY="0x..."
```

## 12. Current Caveats

- Full deploy currently needs `--operator-secret-key` (inline). `--operator-secret-key-ref` is only workable in preflight-only mode.
- If you run with one-command defaults, local `aztec-wallet` alias state can change due to account import/creation.
- Preflight-only mode does not deploy contracts.
- Devnet can be transiently unstable (reorg/timeout class errors). The deploy script now retries wallet deploy calls by default.

## 13. Retry/Debug Env Knobs

Deploy retry behavior:

```bash
export FPC_WALLET_DEPLOY_RETRIES=6
export FPC_WALLET_DEPLOY_RETRY_BACKOFF_MS=3000
```

Use an isolated wallet data dir for troubleshooting:

```bash
export FPC_WALLET_DATA_DIR="$(mktemp -d /tmp/aztec-wallet-devnet.XXXXXX)"
# or equivalent:
export AZTEC_WALLET_DATA_DIR="$(mktemp -d /tmp/aztec-wallet-devnet.XXXXXX)"
```

Then run:

```bash
bun run deploy:fpc
```

## 14. Quick Verify Manifest

```bash
jq . deployments/devnet-manifest-v2.json
```

Check non-zero:

- `contracts.fpc`
