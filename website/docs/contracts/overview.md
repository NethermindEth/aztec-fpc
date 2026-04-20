# Contracts Overview [All Noir contracts in the FPC system at a glance]

All smart contracts in the FPC system are written in **Noir** using the **Aztec.nr** framework.

## Contract Map

```
contracts/
├── fpc/                 # Core — FPCMultiAsset
├── faucet/              # Test token dispenser
├── token_bridge/        # L1↔L2 bridge
└── noop/                # Profiling baseline

vendor/                  # Git submodule: aztec-standards
├── Token/               # Standard fungible token
└── GenericProxy/        # Generic proxy contract
```

## At a Glance

| Contract | Purpose | Production? | Key Functions |
|----------|---------|:-----------:|---------------|
| [**FPCMultiAsset**](../contracts/fpc-multi-asset.md) | Core fee payment | Yes | `fee_entrypoint`, `cold_start_entrypoint` |
| [**TokenBridge**](../contracts/token-bridge.md) | L1↔L2 token bridge | Yes | `claim_public`, `claim_private`, `exit_to_l1_public` |
| [**Faucet**](../contracts/faucet.md) | Test token dispenser | Devnet only | `drip`, `admin_drip` |
| **Noop** | Gate count benchmarking | No | `noop` |
| **Token** (vendor) | Standard fungible token | Yes | `transfer_in_public`, `mint_to_public` |

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

```toml title="Nargo.toml"
[workspace]
members = [
    "contracts/fpc",
    "contracts/faucet",
    "contracts/token_bridge",
    "contracts/noop",
    "mock/counter"
]
```


```bash
aztec compile --workspace
```

```bash
aztec test --package fpc
```

```bash
aztec codegen target -o codegen
```


After compilation, TypeScript ABIs are generated into `codegen/` for use by the services and SDK.
