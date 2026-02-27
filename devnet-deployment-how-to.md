# Devnet Deployment How-To

Date: 2026-02-27
Repository: `aztec-fpc`

This guide explains how to deploy `Token` (optional), `FPC`, and `CreditFPC` to Aztec devnet using:

- `scripts/contract/deploy-fpc-devnet.ts`
- `scripts/contract/deploy-fpc-devnet.sh`

## 1. Prerequisites

From repo root:

```bash
cd /home/ametel/source/aztec-fpc
aztec --version
bun -v
node -v
aztec compile --workspace --force
```

You need:

- A reachable devnet node URL.
- A sponsored FPC address for fee payment.
- A deployer wallet alias and key material.
- Operator secret key material.

## 2. Recommended Wrapper (Shell Script)

One-command preflight/deploy is available via npm script:

```bash
# preflight only
FPC_DEVNET_PREFLIGHT_ONLY=1 bun run deploy:fpc:devnet

# full deploy
bun run deploy:fpc:devnet
```

Default behavior for this one-command path:

- uses `FPC_DEVNET_NODE_URL=https://v4-devnet-2.aztec-labs.com/` if unset
- uses `FPC_DEVNET_SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2` if unset
- writes manifest to `deployments/devnet-manifest-v2.json`
- if key env vars are unset, uses devnet test key `0x1111...1111`
- if alias does not exist, may import/create `accounts:${FPC_DEVNET_DEPLOYER_ALIAS}` in local `aztec-wallet` state

If you want full control, set vars explicitly:

Set environment variables:

```bash
export FPC_DEVNET_NODE_URL="https://v4-devnet-2.aztec-labs.com/"
export FPC_DEVNET_SPONSORED_FPC_ADDRESS="0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2"
export FPC_DEVNET_DEPLOYER_ALIAS="my-wallet"

# Provide exactly one deployer key source:
export FPC_DEVNET_DEPLOYER_PRIVATE_KEY_REF="secret-manager://devnet/l2-deployer"
# or: export FPC_DEVNET_DEPLOYER_PRIVATE_KEY="0x..."

# Provide exactly one operator key source:
export FPC_DEVNET_OPERATOR_SECRET_KEY="0x..."
# or (preflight-only): export FPC_DEVNET_OPERATOR_SECRET_KEY_REF="secret-manager://devnet/operator"
```

Run preflight only:

```bash
export FPC_DEVNET_PREFLIGHT_ONLY=1
bash scripts/contract/deploy-fpc-devnet.sh
```

Run full deployment:

```bash
unset FPC_DEVNET_PREFLIGHT_ONLY
bash scripts/contract/deploy-fpc-devnet.sh
```

Default output manifest path:

- `deployments/devnet-manifest-v2.json`

Override output path if needed:

```bash
export FPC_DEVNET_OUT="./deployments/my-devnet-manifest.json"
```

## 3. Direct TypeScript Command

You can call the script directly:

```bash
bunx tsx scripts/contract/deploy-fpc-devnet.ts \
  --node-url "https://v4-devnet-2.aztec-labs.com/" \
  --sponsored-fpc-address "0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2" \
  --deployer-alias "my-wallet" \
  --deployer-private-key-ref "secret-manager://devnet/l2-deployer" \
  --operator-secret-key "0x..." \
  --out "./deployments/devnet-manifest-v2.json"
```

If you already have an accepted asset token on devnet, skip token deployment:

```bash
--accepted-asset "0x<existing_token_address>"
```

## 4. What the Script Does

1. Runs artifact and node preflight checks.
2. Validates required node/L1/protocol addresses from `node_getNodeInfo`.
3. Registers sponsored FPC in `aztec-wallet` if missing.
4. Resolves deployer account alias (`accounts:<alias>`), creating/importing when possible.
5. Derives operator address/pubkey from operator secret key.
6. Deploys:
   - `Token` (unless `--accepted-asset` is provided),
   - `FPC`,
   - `CreditFPC`.
7. Writes a validated deployment manifest JSON.

## 5. Manifest Output

The manifest includes:

- network metadata (`node_url`, `node_version`, `l1_chain_id`, `rollup_version`)
- required Aztec/L1/protocol addresses from live node info
- deployer alias/address and key material reference/value
- deployed contract addresses
- operator address and pubkeys
- tx hashes for deployment transactions

It is written through `writeDevnetDeployManifest(...)`, which validates schema before writing.

## 6. Current Caveats

- `--operator-secret-key-ref` is supported for preflight-only mode, but full deploy currently requires `--operator-secret-key` (inline) so pubkey derivation can run.
- If deployer alias does not already exist and only `--deployer-private-key-ref` is provided, the script cannot create/import the account and exits with remediation guidance.
- The one-command default path can auto-import a local wallet alias (for example `accounts:my-wallet`) using the default devnet test key. This changes local `aztec-wallet` alias state but does not send deployment txs when `FPC_DEVNET_PREFLIGHT_ONLY=1`.

## 7. Optional L1 Chain Validation

To enforce node/L1 RPC chain-id consistency:

```bash
export FPC_DEVNET_L1_RPC_URL="https://..."
export FPC_DEVNET_VALIDATE_TOPUP_PATH=1
bash scripts/contract/deploy-fpc-devnet.sh
```

## 8. Quick Verification

After deployment:

```bash
jq . deployments/devnet-manifest-v2.json
```

Check these are non-zero:

- `contracts.accepted_asset`
- `contracts.fpc`
- `contracts.credit_fpc`
- `aztec_required_addresses.l1_contract_addresses.*`
- `aztec_required_addresses.protocol_contract_addresses.*`
