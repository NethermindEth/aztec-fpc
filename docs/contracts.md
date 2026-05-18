# Contracts

All smart contracts in the FPC system are written in Noir using the Aztec.nr framework.

> [!NOTE]
> This page is the contract-level overview for developers and auditors. For architectural context, see [architecture.md](architecture.md). For SDK usage, see [sdk.md](sdk.md). Implementation details for individual contracts live in their source-folder READMEs ([`contracts/fpc/README.md`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/README.md), [`contracts/faucet/README.md`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/faucet/README.md)).

**On this page:**
[Contract Map](#contract-map) | [Dependency Graph](#dependency-graph) | [Build System](#build-system)

---

## Contract Map

```
contracts/
├── fpc/                 # Core: FPCMultiAsset
├── faucet/              # Test token dispenser
├── token_bridge/        # L1-L2 bridge
└── noop/                # Profiling baseline

vendor/                  # Git submodule: aztec-standards
├── Token/               # Standard fungible token
└── GenericProxy/        # Generic proxy contract
```

| Contract | Purpose | Source | Details |
|---|---|---|---|
| **FPCMultiAsset** | Fee payment contract. Verifies operator-signed quotes, transfers tokens user → operator, declares the FPC as fee payer. | [`contracts/fpc/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/src/main.nr) | [`contracts/fpc/README.md`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/fpc/README.md) |
| **Faucet** | Public token dispenser for testnet/devnet. Cooldown-gated drips. | [`contracts/faucet/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/faucet/src/main.nr) | [`contracts/faucet/README.md`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/faucet/README.md) |
| **TokenBridge** | L1-L2 bridge. Used by `cold_start_entrypoint` for the private bridge claim. | [`contracts/token_bridge/src/main.nr`](https://github.com/NethermindEth/aztec-fpc/blob/main/contracts/token_bridge/src/main.nr) | |

For the on-chain quote-verification spec (preimages, domain separators, signature format): [Quote System](./quote-system.md). For the setup-phase invariant: [Security](./security.md#trust-assumptions).

## Dependency Graph

```
FPCMultiAsset
    │
    ├──► Token (vendor)         transfers user tokens to operator
    ├──► TokenBridge             claims bridged tokens in cold_start
    └──► Fee Juice (protocol)   declares fee payer

Faucet
    └──► Token (vendor)         transfers drip amounts

TokenBridge
    └──► Token (vendor)         mints/burns on claim/exit
```

## Build System

Contracts are compiled as a Noir workspace:

```toml
# Nargo.toml
[workspace]
members = [
    "contracts/fpc",
    "contracts/faucet",
    "contracts/noop",
    "contracts/token_bridge",
    "mock/counter",
    "vendor/aztec-standards/src/generic_proxy",
    "vendor/aztec-standards/src/token_contract",
]
```

Compile all contracts:

```bash
aztec compile --workspace
```

Run tests for the FPC contract:

```bash
aztec test --package fpc
```

Generate TypeScript ABIs:

```bash
aztec codegen target -o codegen
```

After compilation, TypeScript ABIs are generated into `codegen/` for use by the services and SDK.

## Next Steps

- [Quote System](./quote-system.md) for preimage and signing.
- [SDK](./sdk.md) for transactions that call the entrypoints.
- [Testing](./operations/testing.md) for the full test suite.
