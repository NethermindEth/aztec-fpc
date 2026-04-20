---
title: Testnet Deployment
description: Verified addresses and URLs for the Nethermind-operated FPC on Aztec testnet, sourced from the deployment manifest and config files checked into the repository.
---

# Testnet Deployment

Addresses and configuration for the Nethermind-operated FPC on Aztec testnet.

Every value below is annotated with the repo file and JSON path it was read from. To re-verify any value, open the source file and check the path yourself.

> [!NOTE]
> **When to use this**
>
> - Learning the SDK without running your own stack
> - Wallet development against a known FPC
> - Prototyping a cold-start flow end-to-end
> - Running the [`examples/fpc-full-flow.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/examples/fpc-full-flow.ts) example
>
> This deployment is not suitable for production.

## Source Files

All values are drawn from files checked into the repository:

| File | Path in repo |
|------|-------------|
| Deployment manifest | [`deployments/testnet/manifest.json`](https://github.com/NethermindEth/aztec-fpc/blob/main/deployments/testnet/manifest.json) |
| Attestation config | [`deployments/testnet/attestation/config.yaml`](https://github.com/NethermindEth/aztec-fpc/blob/main/deployments/testnet/attestation/config.yaml) |
| Top-up config | [`deployments/testnet/topup/config.yaml`](https://github.com/NethermindEth/aztec-fpc/blob/main/deployments/testnet/topup/config.yaml) |
| Shared FPC config | [`deployments/testnet/fpc-config.yaml`](https://github.com/NethermindEth/aztec-fpc/blob/main/deployments/testnet/fpc-config.yaml) |

## L2 Addresses

| Variable | Address | Source |
|----------|---------|--------|
| `AZTEC_NODE_URL` | `https://rpc.testnet.aztec-labs.com/` | `manifest.json` → `network.node_url` |
| `FPC_ADDRESS` | `0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f` | `manifest.json` → `contracts.fpc` |
| `OPERATOR_ADDRESS` | `0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974` | `manifest.json` → `operator.address` |
| `TOKEN_ADDRESS` (FpcAcceptedAsset) | `0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb` | `manifest.json` → `contracts.accepted_asset` |
| `BRIDGE_ADDRESS` | `0x19b200d772d3e9068921e6f5df7530271229e958acc9efc2c637afe64db9763f` | `manifest.json` → `contracts.bridge` |
| `FAUCET_ADDRESS` | `0x291b988c66f0314b3e2758fe7c85b85f39c3007a9478ccc46f443f8b48783db4` | `manifest.json` → `contracts.faucet` |

> [!NOTE]
> The `ATTESTATION_URL` (`https://aztec-fpc-testnet.staging-nethermind.xyz/`) is an operational endpoint not recorded in the manifest. Verify liveness with the health check in [Quick Verification](#quick-verification) below.

## L1 Addresses (Sepolia, chain ID 11155111)

| Contract | Address | Source |
|----------|---------|--------|
| Token portal | `0x57a426552a472e953ecc1342f25b17cc192326be` | `manifest.json` → `l1_contracts.token_portal` |
| ERC-20 | `0xf49de848d9c00c4dfb088b2e6ba2dac81e34aa5d` | `manifest.json` → `l1_contracts.erc20` |

> [!NOTE]
> The L1 RPC URL (`https://ethereum-sepolia-rpc.publicnode.com`) is a public Sepolia endpoint used in examples. It is not recorded in the manifest. Any Sepolia RPC will work.

## Operator Public Key

| Field | Value | Source |
|-------|-------|--------|
| `pubkey_x` | `0x137514cff4c383c6fd6dcf3b914c1651e221525553ee2a87c4629e8d3e23074e` | `manifest.json` → `operator.pubkey_x` |
| `pubkey_y` | `0x17700f56ba224e972fa101a7c43862113556dd716ba4f3f1d6b2579397908488` | `manifest.json` → `operator.pubkey_y` |

## Network Metadata

| Field | Value | Source |
|-------|-------|--------|
| Aztec node version | `4.1.0-rc.2` | `manifest.json` → `network.node_version` |
| L1 chain | Sepolia (`11155111`) | `manifest.json` → `network.l1_chain_id` |
| Manifest generated | 2026-03-17 | `manifest.json` → `generated_at` |

> [!WARNING]
> **network_id from the live discovery document**
>
> The live discovery document at `/.well-known/fpc.json` reports its own `network_id`. This value is not in the manifest; it is set by the attestation service at runtime. Per the [wallet discovery spec](../reference/wallet-discovery.md), lookup is an exact case-sensitive match on the tuple `(network_id, asset_address, fpc_address)`. Always fetch the discovery document to confirm the current `network_id` before hardcoding it in wallet integrations.

> [!WARNING]
> **Addresses may rotate**
>
> The discovery document at [`/.well-known/fpc.json`](https://aztec-fpc-testnet.staging-nethermind.xyz/.well-known/fpc.json) is the live source of truth. If any value above drifts from the discovery document, the discovery document wins.

## Quick Verification

Cross-check the repo files against the live service:

```bash
# Liveness
curl https://aztec-fpc-testnet.staging-nethermind.xyz/health

# Discovery document (authoritative for FPC address, network_id, supported assets)
curl https://aztec-fpc-testnet.staging-nethermind.xyz/.well-known/fpc.json

# Accepted assets and current pricing
curl https://aztec-fpc-testnet.staging-nethermind.xyz/accepted-assets

# Verify manifest matches repo (run from repo root)
cat deployments/testnet/manifest.json | jq '.contracts'
```

## Notes on FpcAcceptedAsset

The accepted token (`0x07348d12...`) is a test token with no real-world peg. It was deployed by the `configure-token` phase of the testnet stack. The name `FpcAcceptedAsset` is the label the operator registered in the attestation service (source: `fpc-config.yaml` → `tokens[0].name`). To receive tokens, call `drip(recipient)` on the faucet contract (`0x291b988c...db4`). Tokens land in the recipient's public balance and must be shielded before use with the FPC.

## Mainnet Support

Nethermind does not operate a public FPC on Aztec Alpha Mainnet. Teams deploying to mainnet must run their own stack.

> [!WARNING]
> **Alpha Mainnet context**
>
> Aztec Alpha Mainnet is in early access. Keep key management strict and monitor the [Aztec security advisories](https://github.com/AztecProtocol/aztec-packages/security/advisories) for updates before deploying.
