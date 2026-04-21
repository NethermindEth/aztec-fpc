# FPC: Fee Payment Contracts for Aztec

> **Using an AI agent?** Give it full project context in one command:
> ```
> curl -sL https://raw.githubusercontent.com/NethermindEth/aztec-fpc/main/docs/public/llms.txt
> ```
> For the complete docs (~5k lines): replace `llms.txt` with `llms-full.txt`.

> **Developer?** Start here: **[FPC Documentation](docs/README.md)** -- overview, component map, quick code example, and persona-based routing to the page you need.

## What FPC Does

Every Aztec transaction costs gas in Fee Juice. Users don't have Fee Juice. FPC pays it for them. The user pays the operator in whatever token they hold (USDC, ETH, app tokens). The operator keeps the spread.

One contract, any number of tokens, no redeployment to add a new asset.

| Component | What it does |
|---|---|
| **FPC contract** (`FPCMultiAsset`) | Verifies operator-signed quotes, transfers tokens from user to operator, pays gas |
| **Attestation service** | Signs per-user fee quotes, serves wallet discovery metadata |
| **Top-up service** | Monitors FPC balance, bridges Fee Juice from L1 when low |
| **SDK** (`@nethermindeth/aztec-fpc-sdk`) | 2 methods: `createPaymentMethod()` and `executeColdStart()` |

## Quick Start

```bash
git clone --recurse-submodules https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc
bun install
docker buildx bake
bun run compose:full
```

Verify:

```bash
curl http://localhost:3000/health          # attestation
curl http://localhost:3001/ready           # topup
curl http://localhost:3000/accepted-assets # registered tokens
```

For testnet deployment, manual bring-up, or SDK-only integration, see [Quick Start](docs/quick-start.md).

## Documentation

**[Full documentation](docs/README.md)** -- architecture, SDK reference, contract reference, operator guides, and more.

| Section | Key pages |
|---------|-----------|
| **Getting started** | [Quick Start](docs/quick-start.md), [SDK](docs/sdk.md), [Architecture](docs/architecture.md) |
| **Contracts** | [FPCMultiAsset, Faucet, TokenBridge](docs/contracts.md) |
| **Services** | [Attestation + Top-up](docs/services.md), [Configuration](docs/operations/configuration.md) |
| **How-to** | [Run an Operator](docs/how-to/run-operator.md), [Integrate Wallet](docs/how-to/integrate-wallet.md), [Cold-Start Flow](docs/how-to/cold-start-flow.md) |
| **Operations** | [Deployment](docs/operations/deployment.md), [Docker](docs/operations/docker.md), [Testing](docs/operations/testing.md) |
| **Reference** | [Glossary](docs/reference/glossary.md), [Metrics](docs/reference/metrics.md), [Testnet Deployment](docs/reference/testnet-deployment.md) |
| **Security** | [Security Model](docs/security.md), [Quote System](docs/quote-system.md) |
| **Specs** | [Protocol Spec](docs/specs/spec/protocol-spec.md), [E2E Test Spec](docs/specs/spec/e2e-test-spec.md), [ADR-0001](docs/specs/spec/adr-0001-alpha-asset-model.md) |

## Repository Layout

```text
aztec-fpc/
├── contracts/
│   ├── fpc/                   ← FPCMultiAsset (Noir)
│   ├── faucet/                ← Test token dispenser
│   ├── token_bridge/          ← L1-L2 bridge
│   └── noop/                  ← Profiling baseline
├── services/
│   ├── attestation/           ← Quote-signing REST service
│   └── topup/                 ← Fee Juice bridge daemon
├── sdk/                       ← TypeScript SDK
├── scripts/
│   ├── contract/              ← Deploy + smoke wrappers
│   ├── services/              ← Service bootstrap scripts
│   └── tests/                 ← Integration and E2E suites
├── vendor/
│   └── aztec-standards/       ← Git submodule (token contract)
└── docs/                      ← Documentation (start with README.md)
    ├── how-to/                ← Task-oriented guides
    ├── operations/            ← Deployment, config, Docker, testing
    ├── reference/             ← Glossary, metrics, test matrix, testnet
    ├── specs/                 ← Protocol specs, ADRs, operator runbooks
    └── public/                ← llms.txt, llms-full.txt for AI agents
```

## Development

Prerequisites: Bun `1.3.11`, [Aztec CLI](https://docs.aztec.network/) `4.2.0-aztecnr-rc.2`

```bash
aztec compile --workspace --force   # compile all Noir contracts
bun run test:contracts              # contract tests
bun run test:ts                     # service + SDK tests
bun run ci                          # full CI pipeline (format, lint, typecheck, build, test)
```

Docker integration tests (same as CI):

```bash
docker buildx bake
docker compose --profile full up wait --wait
docker compose --profile full down -v --remove-orphans
```

## Security

- **Operator key**: single Schnorr key, signs all quotes, receives all revenue. Use KMS/HSM in production. Compromise requires contract redeployment (no on-chain rotation).
- **L1 operator key**: used only by the top-up service for bridging. Keep minimal ETH balance.
- **Runtime profile**: set `runtime_profile=production` to reject plaintext secrets and require auth on quote endpoints.

See [Security Model](docs/security.md) for the full threat matrix and production checklist.

## License

Apache-2.0
