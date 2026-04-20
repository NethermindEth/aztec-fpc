# Docker and CI

Container builds, compose orchestration, and CI pipeline for the FPC stack.

[Source: docker-bake.hcl](https://github.com/NethermindEth/aztec-fpc/blob/main/docker-bake.hcl) |
[Source: docker-compose.yaml](https://github.com/NethermindEth/aztec-fpc/blob/main/docker-compose.yaml)

## Docker Images

Five images are built via Docker Buildx Bake ([`docker-bake.hcl`](https://github.com/NethermindEth/aztec-fpc/blob/main/docker-bake.hcl)):

| Image | Bake Target | Source | Purpose |
|-------|-------------|--------|---------|
| `nethermind/aztec-fpc-attestation` | `attestation` | `services/attestation/` | Quote-signing REST API |
| `nethermind/aztec-fpc-topup` | `topup` | `services/topup/` | Fee Juice bridge daemon |
| `nethermind/aztec-fpc-contract-deployment` | `deploy` | `contract-deployment/` | Contract deployment CLI + token configuration |
| `nethermind/aztec-fpc-contract-artifact` | `contract` | `scripts/contract/` | Compiled contract artifacts (utility image used by block-producer) |
| `nethermind/aztec-fpc-test` | `test` | `scripts/tests/` | Integration test runner |

### Building images

```bash
# Build all images with default :local tag
docker buildx bake

# Build a single target
docker buildx bake deploy

# Custom tag
TAG=v0.1.0 docker buildx bake

# Custom registry + tag
REGISTRY=ghcr.io/ TAG=v0.1.0 docker buildx bake
```

The shorthand `bun run docker:build` also builds all images.

## Docker Compose

### Infrastructure Only

```bash
bun run compose:infra
```

| Service | Role | Port |
|---------|------|------|
| `anvil` | Local L1 (Foundry) | 8545 |
| `aztec-node` | Aztec sandbox | 8080 |

### Full Stack

```bash
bun run compose:full
```

Adds to infrastructure:

| Service | Role | Port | Depends On |
|---------|------|------|------------|
| `deploy` | Deploys FPC + generates configs | | aztec-node |
| `fund-l1-fee-juice` | Funds L1 operator with Fee Juice ERC-20 | | aztec-node |
| `configure-token` | Deploys test tokens + registers with attestation | | fund-l1-fee-juice |
| `attestation` | Quote API | 3000 | deploy |
| `topup` | Bridge daemon | 3001 | deploy, fund-l1-fee-juice |
| `block-producer` | Local block production | | aztec-node |

### Startup Order

```
anvil -> aztec-node -> deploy -> attestation
                   |         |-> topup (also waits for fund-l1-fee-juice)
                   |-> fund-l1-fee-juice -> configure-token
                   |-> block-producer

                      (after configure-token)
                         |-> tests-*
```

### Docker Compose for Public Networks

For deploying to devnet or testnet, use `docker-compose.public.yaml`. This runs the full stack (FPC deployment, token configuration, attestation, and top-up) in one command.

```bash
export FPC_DEPLOYER_SECRET_KEY=0x<deployer_key>
export FPC_OPERATOR_SECRET_KEY=0x<operator_key>
export FPC_L1_DEPLOYER_KEY=0x<l1_key>
export ADMIN_API_KEY=<admin_secret>

DEPLOYMENT=testnet docker compose -f docker-compose.public.yaml up -d
```

The compose file reads network defaults (node URL, L1 RPC) from `.env.${DEPLOYMENT}` (e.g., `.env.testnet`) and mounts `deployments/${DEPLOYMENT}/` as the data directory.

## Integration Test Services

Seven test suites run as Docker Compose services against the full stack:

| Service | Test Suite |
|---------|-----------|
| `tests-services` | Health endpoints + API smoke |
| `tests-cold-start` | Full cold-start flow (bridge, claim, pay) |
| `tests-cold-start-validation` | Cold-start edge-case validation |
| `tests-fee-entrypoint-validation` | Fee entrypoint validation (nullifier, transfers) |
| `tests-concurrent` | Concurrent transaction stress |
| `tests-same-token-transfer` | Pay fee in same token being transferred |
| `tests-always-revert` | Revert behavior (FPC still gets paid when app logic reverts) |

All test services depend on `configure-token` completing before they start.

## CI Pipeline

```bash
bun run ci
```

Runs in order:

1. **`format`**: Biome format (auto-fix)
2. **`biome:ci`**: Biome CI check (no auto-fix, fails on violations)
3. **`lint`**: Biome lint
4. **`build`**: Build all TypeScript packages
5. **`typecheck`**: TypeScript type checking
6. **`test:ts`**: TypeScript service + SDK tests
7. **`test:contracts`**: Compile Noir workspace + run contract tests

## Build Configuration Files

| File | Purpose |
|------|---------|
| `docker-bake.hcl` | Buildx multi-target config |
| `Nargo.toml` | Noir workspace members |
| `biome.json` | Code formatter and linter |
| `vitest.config.ts` | TypeScript test runner |
| `.aztecrc` | Aztec CLI config |
| `tsconfig.base.json` | Shared TypeScript config |

## Security Notes

- **Never pass secrets as CLI arguments or inline `-e KEY=VALUE`.** Export secrets first and pass by name. Non-secret values like `AZTEC_NODE_URL` and `L1_RPC_URL` are fine to pass inline.
- The deployment manifest (`manifest.json`) may contain raw private keys. Treat it as secret material.
- Do not commit manifests with plaintext keys to version control.
