---
title: Testnet Deployment
description: Verified addresses and URLs for the Nethermind-operated FPC on Aztec testnet. Cross-checked against the live deployment manifest and the running attestation service.
---

# Testnet Deployment

Addresses and configuration for the Nethermind-operated FPC on Aztec testnet. All values below are verified against `deployments/testnet/manifest.json` (generated 2026-03-17) and the live attestation service.

> [!NOTE]
> **When to use this**
>
> - Learning the SDK without running your own stack
> - Wallet development against a known FPC
> - Prototyping a cold-start flow end-to-end
> - Running the [`examples/fpc-full-flow.ts`](https://github.com/NethermindEth/aztec-fpc/blob/main/examples/fpc-full-flow.ts) example
>
> This deployment is not suitable for production. See [Run an Operator](../how-to/run-operator.md).


## L2 addresses

| Variable | Address |
|----------|---------|
| `AZTEC_NODE_URL` | `https://rpc.testnet.aztec-labs.com/` |
| `ATTESTATION_URL` | `https://aztec-fpc-testnet.staging-nethermind.xyz/` |
| `FPC_ADDRESS` | `0x1be2cae678e1eddd712682948119b3fe2c3ff3f381d78ebea06162f21487d60f` |
| `OPERATOR_ADDRESS` | `0x0aa818ff7e9bb59334e0106eeeacc5ce8d32610d34917b213f305a30a87cf974` |
| `TOKEN_ADDRESS` (FpcAcceptedAsset) | `0x07348d12aae72d1c2ff67cb2bf6b0e54f2ac39484f21cad7247d4e27b4822afb` |
| `BRIDGE_ADDRESS` | `0x19b200d772d3e9068921e6f5df7530271229e958acc9efc2c637afe64db9763f` |
| `FAUCET_ADDRESS` | `0x291b988c66f0314b3e2758fe7c85b85f39c3007a9478ccc46f443f8b48783db4` |

## L1 addresses (Sepolia, chain ID 11155111)

| Contract | Address |
|----------|---------|
| Token portal | `0x57a426552a472e953ecc1342f25b17cc192326be` |
| ERC-20 | `0xf49de848d9c00c4dfb088b2e6ba2dac81e34aa5d` |
| L1 RPC | `https://ethereum-sepolia-rpc.publicnode.com` |

## Operator public key

| Field | Value |
|-------|-------|
| `pubkey_x` | `0x137514cff4c383c6fd6dcf3b914c1651e221525553ee2a87c4629e8d3e23074e` |
| `pubkey_y` | `0x17700f56ba224e972fa101a7c43862113556dd716ba4f3f1d6b2579397908488` |

## Network metadata

| Field | Value | Source |
|-------|-------|--------|
| Aztec node version | `4.1.0-rc.2` | `manifest.json` |
| L1 chain | Sepolia (`11155111`) | `manifest.json` |
| `network_id` in fpc.json | `aztec-alpha-local` | live `/.well-known/fpc.json` |
| Manifest generated | 2026-03-17 | `manifest.json` |

> [!WARNING]
> **network_id is "aztec-alpha-local"**
>
> The live discovery document reports `network_id: "aztec-alpha-local"`. Per the [wallet discovery spec](../reference/wallet-discovery.md), lookup is an exact case-sensitive match on the tuple `(network_id, asset_address, fpc_address)`. Wallets integrating against this deployment must use `"aztec-alpha-local"` as the `network_id` — not `"aztec-testnet"` or any other value.


> [!WARNING]
> **Addresses may rotate**
>
> The discovery document at [`/.well-known/fpc.json`](https://aztec-fpc-testnet.staging-nethermind.xyz/.well-known/fpc.json) is the live source of truth. If any value above drifts from the discovery document, the discovery document wins.


## Quick verification

```bash
# Liveness
curl https://aztec-fpc-testnet.staging-nethermind.xyz/health

# Discovery document — authoritative for FPC address, network_id, supported assets
curl https://aztec-fpc-testnet.staging-nethermind.xyz/.well-known/fpc.json

# Accepted assets and current pricing
curl https://aztec-fpc-testnet.staging-nethermind.xyz/accepted-assets
```

## Notes on FpcAcceptedAsset

The accepted token (`0x07348d12...`) is a test token with no real-world peg. It is deployed by the `configure-token` phase of the testnet stack. The name `FpcAcceptedAsset` is the label the operator registered in the attestation service. To receive tokens, call `drip(recipient)` on the faucet contract (`0x291b988c...db4`) — tokens land in the recipient's public balance and must be shielded before use with the FPC.

## Mainnet support

Nethermind does not operate a public FPC on Aztec Alpha Mainnet. Teams deploying to mainnet must run their own stack. See [Run an Operator](../how-to/run-operator.md).

> [!WARNING]
> **Alpha Mainnet context**
>
> Aztec Alpha Mainnet is in early access. Keep key management strict and monitor the [Aztec security advisories](https://github.com/AztecProtocol/aztec-packages/security/advisories) for updates before deploying.

