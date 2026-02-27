# Devnet Deployment How-To

Date: 2026-02-27
Repository: `aztec-fpc`

This is the current deployment flow for Aztec devnet using:

- `scripts/contract/deploy-fpc-devnet.sh` (recommended)
- `scripts/contract/deploy-fpc-devnet.ts` (advanced/manual)
- `scripts/contract/verify-fpc-devnet-deployment.ts` (post-deploy verification)

## 1. One Command Deploy

From repo root:

```bash
cd /home/ametel/source/aztec-fpc
bun run deploy:fpc:devnet
```

This command deploys:

- `Token` (unless you provide `FPC_DEVNET_ACCEPTED_ASSET`)
- `FPC`
- `CreditFPC`

It writes the manifest to:

- `deployments/devnet-manifest-v2.json`

## 2. One Command Preflight

To run checks only (no contract deploy txs):

```bash
cd /home/ametel/source/aztec-fpc
FPC_DEVNET_PREFLIGHT_ONLY=1 bun run deploy:fpc:devnet
```

## 3. Current Defaults

If unset, wrapper defaults are:

- `FPC_DEVNET_NODE_URL=https://v4-devnet-2.aztec-labs.com/`
- `FPC_DEVNET_SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2`
- `FPC_DEVNET_DEPLOYER_ALIAS=my-wallet`
- `FPC_DEVNET_OUT=./deployments/devnet-manifest-v2.json`

Key behavior when key env vars are unset:

- uses default devnet test key `0x1111111111111111111111111111111111111111111111111111111111111111`
- sets operator key equal to deployer key
- may import/create local wallet alias `accounts:${FPC_DEVNET_DEPLOYER_ALIAS}`

Artifact behavior:

- wrapper aligns `vendor/aztec-standards` version pins before deploy
- if contract artifacts are missing, wrapper runs `aztec compile --workspace --force` automatically

## 4. Explicit Configuration

If you want explicit control, set env vars before running:

```bash
export FPC_DEVNET_NODE_URL="https://v4-devnet-2.aztec-labs.com/"
export FPC_DEVNET_SPONSORED_FPC_ADDRESS="0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2"
export FPC_DEVNET_DEPLOYER_ALIAS="my-wallet"
export FPC_DEVNET_OUT="./deployments/devnet-manifest-v2.json"
```

Deployer key material (set exactly one):

```bash
export FPC_DEVNET_DEPLOYER_PRIVATE_KEY="0x..."
# or
export FPC_DEVNET_DEPLOYER_PRIVATE_KEY_REF="secret-manager://devnet/l2-deployer"
```

Operator key material (set exactly one):

```bash
export FPC_DEVNET_OPERATOR_SECRET_KEY="0x..."
# or (preflight-only use-case)
export FPC_DEVNET_OPERATOR_SECRET_KEY_REF="secret-manager://devnet/operator"
```

Then run:

```bash
bun run deploy:fpc:devnet
```

## 5. Reuse Existing Accepted Asset

To skip Token deployment and reuse an existing token:

```bash
export FPC_DEVNET_ACCEPTED_ASSET="0x<existing_token_address>"
bun run deploy:fpc:devnet
```

## 6. Optional L1 Chain Validation

To enforce node/L1 RPC chain-id match:

```bash
export FPC_DEVNET_L1_RPC_URL="https://..."
export FPC_DEVNET_VALIDATE_TOPUP_PATH=1
bun run deploy:fpc:devnet
```

## 7. Direct Script (Advanced)

Manual TypeScript invocation:

```bash
bunx tsx scripts/contract/deploy-fpc-devnet.ts \
  --node-url "https://v4-devnet-2.aztec-labs.com/" \
  --sponsored-fpc-address "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2" \
  --deployer-alias "my-wallet" \
  --deployer-private-key "0x..." \
  --operator-secret-key "0x..." \
  --out "./deployments/devnet-manifest-v2.json"
```

## 8. What Gets Written

Manifest contains:

- network metadata (`node_url`, `node_version`, `l1_chain_id`, `rollup_version`)
- required Aztec/L1/protocol addresses from live `node_getNodeInfo`
- deployer alias/address and key material (`private_key` or `private_key_ref`)
- deployed contract addresses
- operator address and pubkeys
- tx hashes

The output is schema-validated via `writeDevnetDeployManifest(...)`.

## 9. Post-Deploy Verification (Step 5)

Run verifier against the deployment manifest:

```bash
cd /home/ametel/source/aztec-fpc
bunx tsx scripts/contract/verify-fpc-devnet-deployment.ts \
  --manifest ./deployments/devnet-manifest-v2.json
```

Checks performed:

- contract existence on node for `accepted_asset`, `fpc`, `credit_fpc`
- FPC immutable verification against manifest operator/pubkeys/accepted asset
- contract instance readiness (published instance + non-zero initialization hash)
- contract class readiness (class publicly registered)

Tuning flags:

```bash
bunx tsx scripts/contract/verify-fpc-devnet-deployment.ts \
  --manifest ./deployments/devnet-manifest-v2.json \
  --max-attempts 20 \
  --poll-ms 3000 \
  --node-ready-timeout-ms 45000
```

## 10. Render Service Configs From Manifest (Step 6)

Render `services/attestation/config.yaml` and `services/topup/config.yaml` from the canonical manifest:

```bash
cd /home/ametel/source/aztec-fpc
export FPC_DEVNET_L1_RPC_URL="https://sepolia.infura.io/v3/<key>"
export L1_OPERATOR_PRIVATE_KEY="0x..."
bun run render:config:devnet
```

Equivalent explicit command (with overrides):

```bash
bun run render:config:devnet -- \
  --l1-rpc-url "https://sepolia.infura.io/v3/<key>" \
  --l1-operator-private-key "0x..." \
  --accepted-asset-name "humanUSDC"
```

Build validation:

```bash
bun run attestation:build
bun run topup:build
```

Notes:

- Script default manifest is `./deployments/devnet-manifest-v2.json`.
- Topup bridge addresses are intentionally not written; topup resolves them dynamically from `node_getNodeInfo`.

## 11. Current Caveats

- Full deploy currently needs `--operator-secret-key` (inline). `--operator-secret-key-ref` is only workable in preflight-only mode.
- If you run with one-command defaults, local `aztec-wallet` alias state can change due to account import/creation.
- Preflight-only mode does not deploy contracts.
- Devnet can be transiently unstable (reorg/timeout class errors). The deploy script now retries wallet deploy calls by default.

## 12. Retry/Debug Env Knobs

Deploy retry behavior:

```bash
export FPC_WALLET_DEPLOY_RETRIES=6
export FPC_WALLET_DEPLOY_RETRY_BACKOFF_MS=3000
```

Use an isolated wallet data dir for troubleshooting:

```bash
export FPC_DEVNET_WALLET_DATA_DIR="$(mktemp -d /tmp/aztec-wallet-devnet.XXXXXX)"
# or equivalent:
export AZTEC_WALLET_DATA_DIR="$(mktemp -d /tmp/aztec-wallet-devnet.XXXXXX)"
```

Then run:

```bash
bun run deploy:fpc:devnet
```

## 13. Quick Verify Manifest

```bash
jq . deployments/devnet-manifest-v2.json
```

Check non-zero:

- `contracts.accepted_asset`
- `contracts.fpc`
- `contracts.credit_fpc`
- `aztec_required_addresses.l1_contract_addresses.*`
- `aztec_required_addresses.protocol_contract_addresses.*`
