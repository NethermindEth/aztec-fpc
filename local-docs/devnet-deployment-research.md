# Devnet Deployment Runbook (Exhaustive For Deployment)

Date: 2026-02-27
Repository: `aztec-fpc`
Scope: exhaustive deployment requirements and steps for `FPC` and `CreditFPC` on Aztec devnet.

Implementation tracker:
- `local-docs/devnet-deployment-implementation-plan.md`
- `devnet-deployment-how-to.md`

## 1) What "Exhaustive" Means Here

This document is exhaustive for deployment in this repository and pin line:
- prerequisites and version pinning,
- required inputs and secrets,
- required addresses (manual vs auto-discovered),
- exact deployment order,
- post-deploy validation gates,
- deployment failure modes and recovery actions,
- deployment done criteria.

Out of scope:
- long-term production operations (on-call, incident response, key rotation policy details),
- contract redesign.

## 2) Authoritative Sources Used

Code-first sources (primary):
- `contracts/fpc/src/main.nr`
- `contracts/credit_fpc/src/main.nr`
- `scripts/contract/deploy-fpc-local.ts`
- `services/attestation/src/index.ts`
- `services/attestation/src/fpc-immutables.ts`
- `services/topup/src/index.ts`
- `services/topup/src/bridge.ts`
- `services/topup/src/monitor.ts`
- `services/topup/src/config.ts`
- `package.json`
- `contracts/fpc/Nargo.toml`
- `contracts/credit_fpc/Nargo.toml`

External sources (secondary):
- Devnet guide: <https://docs.aztec.network/developers/getting_started_on_devnet>
- Live node info (`node_getNodeInfo`) from `https://v4-devnet-2.aztec-labs.com/`

## 3) Validated Environment Snapshot (2026-02-27)

- `aztec --version`: `4.0.0-devnet.2-patch.2`
- `node -v`: `v24.14.0`
- `bun -v`: `1.3.9`
- Required artifacts present:
  - `target/token_contract-Token.json`
  - `target/fpc-FPC.json`
  - `target/credit_fpc-CreditFPC.json`
- Live devnet node reports:
  - `nodeVersion=4.0.0-devnet.2-patch.2`
  - `l1ChainId=11155111`
  - `rollupVersion=615022430`

Note: repo/tooling pin (`4.0.0-devnet.2-patch.2`) vs live node (`4.0.0-devnet.2-patch.2`) is a deployment risk and must be treated as a preflight gate.

## 4) Constructor Truth (Hard Requirements)

`FPC` constructor arguments:
1. `operator: AztecAddress`
2. `operator_pubkey_x: Field`
3. `operator_pubkey_y: Field`
4. `accepted_asset: AztecAddress`

`CreditFPC` constructor arguments:
1. `operator: AztecAddress`
2. `operator_pubkey_x: Field`
3. `operator_pubkey_y: Field`
4. `accepted_asset: AztecAddress`

Both constructors enforce:
- non-zero operator,
- non-zero accepted asset,
- pubkey on curve check.

Implication: deployment is blocked unless operator signing key -> pubkey derivation is done correctly.

## 5) Address Inventory (Required vs Optional)

## 5.1 Manually Required Inputs (you must provide/store)

- `NODE_URL` (devnet RPC URL)
- `SPONSORED_FPC_ADDRESS` (for sponsored fee payment in wallet flow)
- deployment account alias/address and signing secret (L2 deployer)
- deployed `fpc_address` (L2)
- deployed `credit_fpc_address` (L2) if CreditFPC is used
- deployed `accepted_asset_address` (L2 token)
- operator L2 signing secret (for quote signer)
- topup L1 operator private key
- `l1_rpc_url`

## 5.2 Auto-Discovered At Runtime (do not hardcode in app config)

From `node_getNodeInfo`:
- `l1ContractAddresses.feeJuicePortalAddress`
- `l1ContractAddresses.feeJuiceAddress`
- `protocolContractAddresses.feeJuice`
- `l1ChainId`

Used by topup service automatically in:
- `services/topup/src/index.ts`
- `services/topup/src/monitor.ts`
- `services/topup/src/bridge.ts`

## 5.3 Useful but Not Required for app startup config

- `rollupAddress`, `inboxAddress`, `outboxAddress`, `registryAddress`,
- protocol `instanceRegistry`, `classRegistry`, `multiCallEntrypoint`.

Useful for debugging/integration checks; not required as explicit config for current app code path.

## 5.4 Current Devnet Values (Validated 2026-02-27)

Network:
- `NODE_URL=https://v4-devnet-2.aztec-labs.com/`
- `SPONSORED_FPC_ADDRESS (guide)=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2`

L1 fee-related:
- `feeJuiceAddress=0x35d0186d1fd53b72996475d965c5ed171d52b986`
- `feeJuicePortalAddress=0x516e3f74fd1c19b24da0706d28b5a30578f054ab`
- `feeAssetHandlerAddress=0xed9c5557d2e0abcc7c7fca958ee4292199413494`

L2 protocol:
- `feeJuice=0x0000000000000000000000000000000000000000000000000000000000000005`
- `instanceRegistry=0x0000000000000000000000000000000000000000000000000000000000000002`
- `classRegistry=0x0000000000000000000000000000000000000000000000000000000000000003`
- `multiCallEntrypoint=0x0000000000000000000000000000000000000000000000000000000000000004`

Rollup plumbing (L1):
- `rollupAddress=0xcd1a7be18501092f3ba8d80ce5629501ba178de0`
- `inboxAddress=0xef5730d1e07b306aecbe01400630d61e3ccb68af`
- `outboxAddress=0x34fc558b6f97e50149bcc140060bbe3f7d04bc59`

Clarification on "token portal":
- There is no single repository-fixed portal address for your custom accepted asset token.
- The only mandatory fee bridge in this app flow is FeeJuice bridge handled by `L1FeeJuicePortalManager`.

## 6) Required Secrets and Config Fields

Attestation service (`services/attestation/config.yaml`):
- `fpc_address`
- `aztec_node_url`
- `accepted_asset_address`
- `operator_secret_key` (or provider-ref/env)
- optional `operator_address` override

Topup service (`services/topup/config.yaml`):
- `fpc_address`
- `aztec_node_url`
- `l1_rpc_url`
- `l1_operator_private_key` (or provider-ref/env)
- `threshold`
- `top_up_amount`

Deployment actor secrets (must be tracked in deployment records):
- L2 deployment account secret/key material used to send deploy txs.
- L1 topup operator private key (if topup is part of target environment).

Security note:
- For production-like environments, store raw keys in an encrypted secret manager and save references in manifest.
- If you explicitly store raw private keys in deployment JSON, treat that file as a secret.

## 7) Deployment Preflight Checklist (Must Pass)

1. Toolchain
- Aztec CLI installed and version-compatible with devnet.
- Node `>=24.12.0` (repo has `v24.14.0` validated).
- Bun installed.

2. Source and artifacts
- Submodules initialized (`vendor/aztec-standards`).
- `aztec compile --workspace --force` succeeds.
- target artifacts exist for token/FPC/CreditFPC.

3. Network
- `NODE_URL` reachable.
- `node_getNodeInfo` responds.
- `l1ChainId` from node info matches your `l1_rpc_url` chain.

4. Payment readiness
- Sponsored FPC registered in wallet for devnet flow.
- Deployment account created with sponsored payment method.

5. Constructor readiness
- Operator secret resolved.
- Operator pubkey x/y derived and recorded.
- Accepted asset strategy chosen:
  - deploy token now, or
  - reuse existing token address.

## 8) Canonical Deployment Sequence

## 8.0 Create Aztec deployer address/account (devnet)

CLI path (sponsored):
```bash
export NODE_URL=https://v4-devnet-2.aztec-labs.com/
export SPONSORED_FPC_ADDRESS=0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2

aztec-wallet register-contract \
  --node-url "$NODE_URL" \
  --alias sponsoredfpc \
  "$SPONSORED_FPC_ADDRESS" SponsoredFPC \
  --salt 0

aztec-wallet create-account \
  --node-url "$NODE_URL" \
  --alias my-wallet \
  --payment method=fpc-sponsored,fpc=$SPONSORED_FPC_ADDRESS
```

Result:
- creates a deploy-capable Aztec account/address.
- this account/address must be persisted in the deployment manifest.

## 8.2 Deploy accepted asset token

Option A (deploy new token):
- deploy token contract and capture `accepted_asset_address`.

Option B (reuse existing):
- supply known `accepted_asset_address`.

## 8.3 Deploy FPC

Provide constructor args:
- `operator`
- `operator_pubkey_x`
- `operator_pubkey_y`
- `accepted_asset_address`

## 8.4 Deploy CreditFPC

Provide same constructor arg pattern:
- `operator`
- `operator_pubkey_x`
- `operator_pubkey_y`
- `accepted_asset_address`

## 8.5 Persist deployment output

Persist JSON containing at least:
- timestamp,
- node URL and node version,
- chain IDs,
- full `node_getNodeInfo` address sets used at deployment time:
  - `l1ContractAddresses`
  - `protocolContractAddresses`
- accepted asset,
- FPC address,
- CreditFPC address,
- operator address,
- deployment sender account address/alias,
- deployment sender key material (or encrypted key reference),
- tx hashes (deploy + initialization where relevant),
- payment mode used.

Minimum manifest structure:
```json
{
  "status": "deploy_ok",
  "generated_at": "2026-02-27T00:00:00.000Z",
  "network": {
    "node_url": "https://v4-devnet-2.aztec-labs.com/",
    "node_version": "4.0.0-devnet.2-patch.2",
    "l1_chain_id": 11155111,
    "rollup_version": 615022430
  },
  "aztec_required_addresses": {
    "l1_contract_addresses": {
      "registryAddress": "0x...",
      "rollupAddress": "0x...",
      "inboxAddress": "0x...",
      "outboxAddress": "0x...",
      "feeJuiceAddress": "0x...",
      "feeJuicePortalAddress": "0x...",
      "feeAssetHandlerAddress": "0x..."
    },
    "protocol_contract_addresses": {
      "instanceRegistry": "0x...",
      "classRegistry": "0x...",
      "multiCallEntrypoint": "0x...",
      "feeJuice": "0x..."
    },
    "sponsored_fpc_address": "0x..."
  },
  "deployment_accounts": {
    "l2_deployer": {
      "alias": "my-wallet",
      "address": "0x...",
      "private_key": "0x... OR OMIT",
      "private_key_ref": "secret-manager://... OR OMIT"
    },
    "l1_topup_operator": {
      "address": "0x...",
      "private_key": "0x... OR OMIT",
      "private_key_ref": "secret-manager://... OR OMIT"
    }
  },
  "contracts": {
    "accepted_asset": "0x...",
    "fpc": "0x...",
    "credit_fpc": "0x..."
  },
  "operator": {
    "address": "0x...",
    "pubkey_x": "0x...",
    "pubkey_y": "0x..."
  },
  "tx_hashes": {
    "accepted_asset_deploy": "0x...",
    "fpc_deploy": "0x...",
    "credit_fpc_deploy": "0x..."
  }
}
```

## 9) Post-Deploy Verification Gates (Mandatory)

1. Deployment transaction status:
- each deploy tx mined/accepted.

2. Contract metadata readiness:
- `isContractInitialized=true`
- `isContractPublished=true` for public paths.

3. Class metadata readiness:
- `isContractClassPubliclyRegistered=true` for contracts with public functions.

4. Immutable correctness:
- run `verifyFpcImmutablesOnStartup` equivalent check for deployed FPC:
  - operator,
  - operator pubkey x/y,
  - accepted asset.

5. Service startup validity:
- Attestation service starts and immutable verification passes.
- Topup service starts, resolves FeeJuice addresses from node info, and passes L1 chain ID check.

6. Functional smoke:
- one FPC fee-payment tx succeeds,
- one CreditFPC `pay_and_mint` then `pay_with_credit` succeeds (if CreditFPC is part of deployment target).

## 10) Bridge Contracts: Exact Requirement Statement

For this app deployment:
- You must ensure FeeJuice bridge path is valid on connected network.
- You do not manually configure L1 FeeJuice portal/token addresses in service config.
- Topup resolves them from `node_getNodeInfo` and bridges using SDK `L1FeeJuicePortalManager`.

Therefore:
- L1/L2 bridge contracts are required for successful runtime behavior,
- but explicit manual bridge-address configuration is not required in current code.

## 11) Implemented Entry Points (Finalized Command Paths)

The repository now exposes the devnet deployment lifecycle through stable command paths:

- `bun run deploy:fpc:devnet`
  - wrapper: `scripts/contract/deploy-fpc-devnet.sh`
  - implementation: `scripts/contract/deploy-fpc-devnet.ts`
- `bun run verify:deploy:fpc:devnet`
  - implementation: `scripts/contract/verify-fpc-devnet-deployment.ts`
- `bun run render:config:devnet`
  - implementation: `scripts/services/render-config-from-manifest.ts`
- `bun run smoke:deploy:fpc:devnet`
  - implementation: `scripts/contract/devnet-postdeploy-smoke.ts`

Canonical manifest path consumed by verify/render/smoke defaults:

- `deployments/devnet-manifest-v2.json`

Current operator documentation source of truth:

- `devnet-deployment-how-to.md`

## 12) Failure Modes and Recovery

- Version mismatch / unstable API:
  - re-check CLI and node versions; prefer exact compatibility pin.
- Sponsored payment failures:
  - re-register sponsored FPC, recreate account with `--payment method=fpc-sponsored,...`.
- Constructor/pubkey mismatch:
  - re-derive pubkey from operator secret, redeploy.
- `accepted_asset` mismatch with service config:
  - update config or redeploy contracts with intended token.
- Topup startup failures:
  - fix `l1_rpc_url` chain mismatch or invalid L1 key.
- Deployment mined but unusable:
  - verify metadata/class registration and immutable hash.

## 13) Deployment Done Criteria (Strict)

Deployment is complete only if all are true:
1. Token (accepted asset), FPC, and CreditFPC addresses are deployed and recorded.
2. Immutable verification for FPC passes with intended operator/pubkey/asset.
3. Attestation config and topup config updated with deployed addresses and valid secrets.
4. Topup successfully resolves node info fee addresses and passes chain validation.
5. End-to-end smoke transactions pass for intended fee-payment paths.
6. Deployment artifact JSON (addresses + tx hashes + versions) is committed/stored.
7. Manifest includes deployment accounts and key material/secret references used for deployment.

## 14) Do We Need An L1 Sepolia Account?

Deployment-only answer:
- If deploying with sponsored fees (`fpc-sponsored`) on devnet, an L1 account is not strictly required for contract deployment transactions.

Application runtime answer:
- Yes, if you run topup bridging, you need an L1 Sepolia account and private key.
- That account must have Sepolia ETH for L1 gas.
- The topup service uses this key to submit FeeJuice bridge transactions through `L1FeeJuicePortalManager`.

## External Links

- <https://docs.aztec.network/developers/getting_started_on_devnet>
