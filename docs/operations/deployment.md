# Deployment

Deploy the FPC contract and supporting services.

[Source: deploy CLI](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/index.ts#L321) | [Source: configure-token](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/configure-token.ts#L228) | [Source: manifest schema](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/manifest.ts#L15)

Two paths:

- **Docker (recommended)** for testnet, devnet, production. Pre-compiled artifacts. Two-phase: deploy + configure-token.
- **Bun scripts** for local development with Noir, Bun, and `aztec-wallet` already set up.

## Path A: Docker

### Prepare master config

```bash
mkdir -p deployments
cp deployments/fpc-config.example.yaml deployments/fpc-config.yaml
# Edit: tokens, exchange rates, thresholds
```

See [Configuration](./configuration.md#master-config) for all fields.

### Phase 1: deploy FPC, generate per-service configs

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_hex32>
export FPC_OPERATOR_SECRET_KEY=0x<operator_hex32>

docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_OPERATOR_SECRET_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local
```

Output:

```text
deployments/
├── manifest.json                <- TREAT AS SECRET
├── fpc-config.yaml
├── attestation/config.yaml
└── topup/config.yaml
```

Useful flags:
- `--sponsored-fpc-address <addr>` to pay deploy fees via an existing Sponsored FPC.
- `--preflight-only` (or `FPC_PREFLIGHT_ONLY=1`) to validate connectivity without sending transactions.

### Start services between phases

Attestation:

```bash
export OPERATOR_SECRET_KEY=0x<operator_hex32>
docker run -d -e OPERATOR_SECRET_KEY \
  -v ./deployments/attestation/config.yaml:/app/config.yaml \
  -p 3000:3000 nethermind/aztec-fpc-attestation:local
```

Top-up (L1 operator must hold ETH and Fee Juice ERC-20; run `bun run fund:l1:fee-juice` first if needed):

```bash
export L1_OPERATOR_PRIVATE_KEY=0x<l1_key>
docker run -d -e L1_OPERATOR_PRIVATE_KEY \
  -v ./deployments/topup/config.yaml:/app/config.yaml \
  -p 3001:3001 nethermind/aztec-fpc-topup:local
```

### Phase 2: configure tokens

Deploys test tokens (when `address` is omitted in `fpc-config.yaml`) and registers them with the running attestation service.

```bash
export FPC_L1_DEPLOYER_KEY=0x<l1_key>
export ADMIN_API_KEY=<admin_secret>

docker run \
  -e AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
  -e L1_RPC_URL=<L1_RPC_URL> \
  -e FPC_DEPLOYER_SECRET_KEY \
  -e FPC_L1_DEPLOYER_KEY \
  -e FPC_ATTESTATION_URL=http://<attestation_host>:3000 \
  -e ADMIN_API_KEY \
  -v ./deployments:/app/deployments \
  nethermind/aztec-fpc-contract-deployment:local \
  configure-token
```

If the attestation service is on `localhost`, add `--network host`. If all tokens have explicit `address` values, only registration runs (omit L1/L2 deploy keys). Add `--skip-registration` to deploy tokens without registering.

Test-token manifests land in `deployments/tokens/<TokenName>.json` with L2 + L1 addresses, faucet config, and tx hashes.

### Smoke test

```bash
bun run smoke:services:compose       # full compose smoke
# or
bun run smoke:deploy:fpc:devnet       # post-deploy runtime smoke
```

### One-shot for public networks

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<...>
export FPC_OPERATOR_SECRET_KEY=0x<...>
export FPC_L1_DEPLOYER_KEY=0x<...>
export ADMIN_API_KEY=<...>

DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

Reads `.env.${DEPLOYMENT}` for network defaults. Outputs to `deployments/${DEPLOYMENT}/`. Service order: `deploy` → (`attestation` + `topup`) → `configure-token`.

## Path B: Non-Docker

For local development with Noir, Bun, and `aztec-wallet` installed.

```bash
export AZTEC_NODE_URL="https://v4-devnet-2.aztec-labs.com/"
export FPC_DEPLOYER_SECRET_KEY=0x<deployer>
# Optional, defaults to deployer
export FPC_OPERATOR_SECRET_KEY=0x<operator>
# Optional, pay deploy fees via existing sponsored FPC
export FPC_SPONSORED_FPC_ADDRESS=0x...

bun run deploy:fpc
```

Auto-compiles if artifacts are missing. Auto-generates service configs unless `FPC_SKIP_CONFIG_GEN=1`. Manifest at `deployments/manifest.json`.

Reuse an existing token: `export FPC_ACCEPTED_ASSET=0x... && bun run deploy:fpc`.
Preflight only: `FPC_PREFLIGHT_ONLY=1 bun run deploy:fpc`.
Render configs from a manifest: `bun run generate:configs`.

If wallet state errors occur, use a fresh PXE data dir:

```bash
export PXE_DATA_DIR="$(mktemp -d /tmp/aztec-pxe.XXXXXX)"
bun run deploy:fpc
```

## Manifest

The manifest is the canonical deployment output. Services and SDK examples read from it. Validated via `deployManifestSchema` ([source](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/manifest.ts#L15)).

```json
{
  "status": "deploy_ok",
  "generated_at": "2026-03-17T14:37:26.643Z",
  "network": { "node_url": "...", "node_version": "...", "l1_chain_id": 11155111, "rollup_version": 4127419662 },
  "aztec_required_addresses": { "sponsored_fpc_address": "0x..." },
  "deployer_address": "0x...",
  "contracts": { "fpc": "0x..." },
  "operator": { "address": "0x...", "pubkey_x": "0x...", "pubkey_y": "0x..." },
  "tx_hashes": { "fpc_deploy": "0x..." }
}
```

> [!WARNING]
> L1 contract addresses (Fee Juice token, portal, rollup) are not in the manifest. Services discover them from `nodeInfo` at runtime.

Manifest locations:

| Path | Location |
|---|---|
| Docker / Bun (default) | `deployments/manifest.json` |
| Docker Compose public | `deployments/${DEPLOYMENT}/manifest.json` |

## Verify

`verifyDeployment()` ([source](https://github.com/NethermindEth/aztec-fpc/blob/main/contract-deployment/src/verify.ts)) checks:
- FPC contract exists on the node
- FPC immutable config matches manifest's operator and pubkeys
- Contract instance is published with non-zero initialization hash
- Contract class is publicly registered

## Security notes

- Never inline secrets (`-e KEY=VALUE`). Export first, then pass by name (`-e KEY`). Inline values appear in `ps`, `docker inspect`, and shell history.
- `manifest.json` may contain raw private keys. Treat as secret. Never commit.
- Prefer `_REF` variants (KMS, secret manager) over plaintext keys in production.
- Set `runtime_profile: production` in service configs to reject plaintext secrets at startup.

## Next Steps

- [Run an FPC Operator](../how-to/run-operator.md)
- [Docker and CI](./docker.md)
- [Configuration](./configuration.md)
