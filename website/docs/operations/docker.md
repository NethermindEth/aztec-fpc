# Docker & CI [Container builds, compose orchestration, and CI pipeline]

Container builds, compose orchestration, and CI pipeline.

## Docker Images

Built via Docker Buildx Bake (`docker-bake.hcl`):

| Image | Source | Purpose |
|-------|--------|---------|
| `attestation` | `services/attestation/` | Quote-signing REST API |
| `topup` | `services/topup/` | Fee Juice bridge daemon |
| `deploy` | `contract-deployment/` | Contract deployment CLI |
| `configure-token` | `contract-deployment/` | Token setup + registration |

```bash
# Build all images
bun run docker:build
```

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
| `deploy` | Deploys FPC + tokens | — | aztec-node |
| `configure-token` | Registers tokens | — | deploy, attestation |
| `attestation` | Quote API | 3000 | deploy |
| `topup` | Bridge daemon | 3001 | deploy |
| `block-producer` | Local blocks | — | aztec-node |

### Startup Order

```
anvil → aztec-node → deploy → attestation → configure-token
                        │
                        ├──→ topup
                        └──→ block-producer

                     (after configure-token)
                        └──→ tests-*
```

## Integration Test Services

Seven test suites run as compose services:

| Service | Test Suite |
|---------|-----------|
| `tests-services` | Health + API smoke |
| `tests-cold-start` | Full cold-start flow |
| `tests-cold-start-validation` | Cold-start edge-case validation |
| `tests-fee-entrypoint-validation` | Fee entrypoint validation |
| `tests-concurrent` | Concurrent transaction stress |
| `tests-same-token-transfer` | Same-token transfer |
| `tests-always-revert` | Revert behavior |

## CI Pipeline

```bash
bun run ci
```

Runs in order:

1. **`format`** — Biome format check
2. **`lint`** — Biome lint
3. **`typecheck`** — TypeScript type checking
4. **`build`** — Build all TypeScript packages
5. **`test`** — Run contract + TS tests

## Build Configuration Files

| File | Purpose |
|------|---------|
| `docker-bake.hcl` | Buildx multi-target config |
| `Nargo.toml` | Noir workspace members |
| `biome.json` | Code formatter/linter |
| `vitest.config.ts` | TypeScript test runner |
| `.aztecrc` | Aztec CLI config |
| `tsconfig.base.json` | Shared TypeScript config |
