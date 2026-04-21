# FPC: Fee Payment Contracts for Aztec

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> [!TIP]
> **Scoping this repo with an AI agent?** Give it full context in one shot:
> ```
> curl -sL https://raw.githubusercontent.com/NethermindEth/aztec-fpc/main/docs/public/llms.txt
> ```
> This returns a structured project summary, source code map with line numbers, function index, error codes, and config reference. For the complete docs (~5k lines), replace `llms.txt` with `llms-full.txt`.

Users pay gas in the token they already hold. The operator covers the Fee Juice.

FPC is a smart contract on [Aztec](https://aztec.network/) that sits between users and the protocol's gas layer. Instead of acquiring Fee Juice, users pay the FPC operator in any accepted token (USDC, ETH, app tokens) at a rate locked by a signed quote. One contract instance handles any number of tokens with no redeployment.

**[Read the docs](docs/README.md)** | **[Testnet addresses](docs/reference/testnet-deployment.md)** | **[SDK reference](docs/sdk.md)**

## How it works

| Component | Role |
|---|---|
| **FPC contract** | Verifies operator-signed Schnorr quotes, transfers tokens from user to operator, pays gas to the protocol |
| **Attestation service** | Signs per-user fee quotes, serves wallet discovery at `/.well-known/fpc.json` |
| **Top-up service** | Watches FPC balance on L2, bridges Fee Juice from L1 when it drops below threshold |
| **SDK** | `createPaymentMethod()` for existing users, `executeColdStart()` for L1 onboarding |

## Usage

```typescript
import { FpcClient } from "@nethermindeth/aztec-fpc-sdk";

const fpcClient = new FpcClient({ fpcAddress, operator, node, attestationBaseUrl });

// User already has L2 tokens
const { fee } = await fpcClient.createPaymentMethod({
  wallet, user: userAddress, tokenAddress, estimatedGas,
});
await contract.methods.transfer(recipient, amount).send({ fee });

// User just bridged from L1 — no account, no Fee Juice
const result = await fpcClient.executeColdStart({
  wallet, userAddress, tokenAddress, bridgeAddress, bridgeClaim,
});
```

Two methods. That's the entire SDK surface.

## Quick start

Run the full stack locally in one command:

```bash
git clone --recurse-submodules https://github.com/NethermindEth/aztec-fpc.git
cd aztec-fpc && bun install
docker buildx bake
docker compose --profile full up wait --wait
```

Verify:

```bash
curl http://localhost:3000/health          # attestation
curl http://localhost:3001/ready           # topup
curl http://localhost:3000/accepted-assets # registered tokens
```

For testnet deployment, manual bring-up, or SDK-only integration: **[Quick Start guide](docs/quick-start.md)**.

## Documentation

**[docs/README.md](docs/README.md)** is the entry point. It routes you by role:

<table>
<tr>
<td valign="top">

**Start here**

| You are... | Go to |
|---|---|
| **dApp developer** | [SDK Getting Started](docs/sdk.md) |
| **Wallet team** | [Integrate Wallet](docs/how-to/integrate-wallet.md) |
| **Operator** | [Run an Operator](docs/how-to/run-operator.md) |
| **Auditor** | [Security Model](docs/security.md) |

</td>
<td valign="top" width="60%">

**Full docs**

| Section | Pages |
|---------|-------|
| **Core** | [Architecture](docs/architecture.md) &#183; [Quotes](docs/quote-system.md) &#183; [Security](docs/security.md) |
| **SDK** | [Getting Started](docs/sdk.md) |
| **Contracts** | [All contracts](docs/contracts.md) |
| **Services** | [Attestation + Top-up](docs/services.md) &#183; [Config](docs/operations/configuration.md) |
| **How-to** | [Operator](docs/how-to/run-operator.md) &#183; [Wallet](docs/how-to/integrate-wallet.md) &#183; [Assets](docs/how-to/add-supported-asset.md) &#183; [Cold-start](docs/how-to/cold-start-flow.md) |
| **Ops** | [Deploy](docs/operations/deployment.md) &#183; [Docker](docs/operations/docker.md) &#183; [Test](docs/operations/testing.md) |
| **Reference** | [Glossary](docs/reference/glossary.md) &#183; [Metrics](docs/reference/metrics.md) &#183; [Testnet](docs/reference/testnet-deployment.md) &#183; [Discovery](docs/reference/wallet-discovery.md) |
| **Specs** | [Protocol](docs/specs/spec/protocol-spec.md) &#183; [E2E](docs/specs/spec/e2e-test-spec.md) &#183; [ADR-0001](docs/specs/spec/adr-0001-alpha-asset-model.md) |

</td>
</tr>
</table>

## Repository layout

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
```

## Development

> [!NOTE]
> **Prerequisites:** [Bun](https://bun.sh/) `1.3.11`, [Aztec CLI](https://docs.aztec.network/) `4.2.0-aztecnr-rc.2`

```bash
aztec compile --workspace --force   # compile all Noir contracts
bun run test:contracts              # Noir contract tests
bun run test:ts                     # service + SDK unit tests
bun run ci                          # full pipeline: format, lint, typecheck, build, test
```

Docker integration tests (same flow as CI):

```bash
docker buildx bake
docker compose --profile full up wait --wait
docker compose --profile full down -v --remove-orphans
```

## Security

- **Operator key**: single Schnorr keypair signs all quotes and receives all revenue. Use KMS/HSM in production. Compromise requires contract redeployment (no on-chain key rotation).
- **L1 key**: used only by the top-up service for bridging. Keep minimal ETH balance.
- **Production mode**: `runtime_profile=production` rejects plaintext secrets and requires auth on quote endpoints.

Full threat matrix and production checklist: **[Security Model](docs/security.md)**.

## Support

Questions, bugs, or feedback:

- **Email**: aayush@nethermind.io
- **GitHub**: [Open an issue](https://github.com/NethermindEth/aztec-fpc/issues/new) or [start a discussion](https://github.com/NethermindEth/aztec-fpc/discussions)

## License

[Apache-2.0](LICENSE)

---

<p align="center">Built by <a href="https://nethermind.io/">Nethermind</a></p>
