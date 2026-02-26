# FPC Protocol — Specification

> **Status:** Alpha / MVP
> **Last updated:** 2026-02-26

---

## 1. Overview

The Fee Payment Contract (FPC) lets users pay Aztec L2 transaction fees in a single fixed token instead of the native Fee Juice. An operator runs the FPC, receives fee payments as private notes, and keeps the FPC funded with Fee Juice bridged from L1.

The protocol has three components:

| Component | What it does |
|---|---|
| **FPC** (Aztec.nr contract) | Accepts user tokens via private-to-private transfer, declares itself the transaction's fee payer, covers the protocol's Fee Juice requirement |
| **Attestation Service** (TypeScript) | REST API that signs user-specific exchange-rate quotes; the FPC contract verifies these on-chain |
| **Top-up Service** (TypeScript) | Background process that monitors the FPC's Fee Juice balance and bridges more from L1 when it runs low |

---

## 2. Architecture

```
User
  │  1. GET /quote?user=<address>
  │◄──────────────────────────────────────  Attestation Service
  │  signed quote (rate_num, rate_den, valid_until, signature)
  │
  │  2. Submit tx with fee_entrypoint(...)
  │     + token transfer authwit
  │     + quote signature (from step 1)
  ▼
Aztec L2
  ├─ Setup phase:   FPC.fee_entrypoint
  │                   verifies quote signature (bound to this user)
  │                   transfers tokens: user private → operator private
  │                   declares itself fee_payer
  ├─ Execution:     user's actual tx logic runs
  └─ Fee deduction: protocol deducts tx_fee from FPC's Fee Juice balance

                           ▲
                           │ monitors & bridges when low
                    Top-up Service
                           │
                    L1 SDK portal manager bridge
```

---

## 3. Contract: FPC

### 3.1 Storage

| Field | Type | Description |
|---|---|---|
| `config` | `PublicImmutable<Config>` | Packed immutable config: `operator`, `operator_pubkey_x`, `operator_pubkey_y`, `accepted_asset`. |

The contract keeps one packed immutable config slot and no mutable admin state after deployment.

### 3.2 Quote Format

All quotes are user-specific. The inner hash preimage is:

```
inner_hash = poseidon2([
    DOMAIN_SEPARATOR,    // "FPC" = 0x465043
    fpc_address,
    accepted_asset,      // read from on-chain storage — enforced, not caller-supplied
    rate_num,
    rate_den,
    valid_until,         // unix timestamp (u64)
    user_address,        // always msg_sender — never zero
])
```

The operator signs this hash off-chain with Schnorr (64-byte signature). The user passes signature bytes as `quote_sig` to `fee_entrypoint`, and the FPC verifies it inline with `schnorr::verify_signature` against the stored operator pubkey.

The contract pushes `quote_hash` as a nullifier, so consumed quotes cannot be replayed.

### 3.3 Exchange Rate

The operator sets two values in the attestation service config:
- `market_rate_num / market_rate_den` — the base exchange rate (accepted asset units per 1 FeeJuice)
- `fee_bips` — operator margin in basis points (e.g. 200 = 2%)

The service computes the **final rate**:
```
final_rate_num = market_rate_num × (10000 + fee_bips)
final_rate_den = market_rate_den × 10000
```

Users see only `(final_rate_num, final_rate_den)` in their quote. The contract applies ceiling division so the FPC always collects at least the actual fee cost at the quoted rate:

```
charge = ceil(max_gas_cost_no_teardown × rate_num / rate_den)
```

Policy: the standard `fee_entrypoint` requires `rate_num > 0`. Zero-rate quotes are rejected on-chain to avoid free-transaction quotes.

### 3.4 Payment Flow

#### `fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until, quote_sig)`

```
User private balance →[transfer_private_to_private]→ Operator private balance
```

1. Reads packed `config` from storage (`operator`, signing pubkey, `accepted_asset`)
2. Asserts `rate_num > 0`
3. Verifies Schnorr quote signature and binds `user_address = msg_sender`
4. Asserts quote nullifier does not exist, then pushes it (replay protection)
5. Asserts `anchor_block_timestamp ≤ valid_until`
6. Asserts `(valid_until - anchor_block_timestamp) ≤ 3600` seconds
7. Computes `charge = ceil(max_gas_cost_no_teardown × rate_num / rate_den)` (`rate_den != 0` enforced in fee math)
8. Calls `Token::at(accepted_asset).transfer_private_to_private(sender → operator, charge, nonce)`
9. Calls `set_as_fee_payer()` + `end_setup()`

The token transfer is a private function call that executes in the setup phase, before `end_setup()`. It is irrevocably committed. If the user's app logic subsequently reverts, the fee has still been paid — this is unavoidable in the Aztec FPC model.

No teardown is scheduled. No tokens accumulate in this contract's balance.

### 3.5 Function Reference

| Function | Aztec context | Callable by |
|---|---|---|
| `constructor(operator, operator_pubkey_x, operator_pubkey_y, accepted_asset)` | public | anyone (one-time initializer) |
| `fee_entrypoint(authwit_nonce, rate_num, rate_den, valid_until, quote_sig)` | private | any user (quote binds to caller) |

> There are no admin functions. The contract has no mutable state after construction.

### 3.6 Fee Revenue

All fee payments arrive in the **operator's private balance** directly. The operator is responsible for off-chain accounting and must use their PXE to discover incoming private notes.

The FPC itself holds no token balance. Its only balance is Fee Juice (protocol-level), which the Aztec protocol deducts automatically per transaction and is replenished by the Top-up Service.

---

## 4. Attestation Service

### 4.1 Responsibilities

- Hold the `operator` private key
- Compute final exchange rates (market rate + operator bips)
- Sign user-specific quotes on demand

### 4.2 API Reference

#### `GET /health`
Returns `{ status: "ok" }`. Use for liveness probes.

#### `GET /asset`
Returns the single accepted asset name and address.

```json
{ "name": "humanUSDC", "address": "0x..." }
```

#### `GET /quote?user=<address>`
Returns a user-specific quote for the caller. The `user` address is bound into the quote signature — only that user can use this quote.

```json
{
  "accepted_asset": "0x...",
  "rate_num": "10200",
  "rate_den": "10000000",
  "valid_until": "1740000300",
  "signature": "0x..."
}
```

The user passes `(rate_num, rate_den, valid_until, signature)` to `fee_entrypoint`. Only the token transfer authwit is carried in `authWitnesses`.

### 4.3 Quote Signing Internals

The service uses `computeInnerAuthWitHash` (from `@aztec/stdlib/auth-witness`) to compute the same quote hash as `assert_valid_quote`, then signs the 32-byte hash payload with the operator Schnorr key and returns a 64-byte hex signature.

---

## 5. Top-up Service

### 5.1 Responsibilities

- Periodically read the FPC's Fee Juice balance on L2
- When balance < `threshold`, bridge via `L1FeeJuicePortalManager.bridgeTokensPublic(...)` on L1
- Prevent multiple concurrent bridges with an in-flight guard

### 5.2 Configuration

| Field | Description |
|---|---|
| `fpc_address` | FPC contract on L2 |
| `aztec_node_url` | PXE/node RPC |
| `l1_rpc_url` | L1 Ethereum RPC |
| `l1_operator_private_key` | L1 wallet key (can be supplied via env/config/secret provider) |
| `l1_operator_secret_provider` | Secret source strategy (`auto`, `env`, `config`, `kms`, `hsm`) |
| `runtime_profile` | `development` / `test` / `production` (production rejects plaintext config secrets) |
| `threshold` | Bridge when balance below this (wei) |
| `top_up_amount` | Amount to bridge per event (wei) |
| `check_interval_ms` | Polling interval |

`l1_chain_id` and Fee Juice L1 contract addresses are derived from `nodeInfo` and the service validates that the configured `l1_rpc_url` matches the node's L1 chain id.

### 5.3 Bridge Mechanics

1. Service builds an L1 wallet client and uses `L1FeeJuicePortalManager.new(node, client, logger)`
2. Manager performs Fee Juice token approval and portal deposit, returning L1→L2 message metadata
3. Service waits for L1→L2 message readiness (`waitForL1ToL2MessageReady`) using the returned message hash
4. Service still polls FPC Fee Juice balance and treats positive balance delta as the final fallback/confirmation signal

---

## 6. Deployment Guide

### 6.1 Prerequisites

- Aztec node running and accessible
- This repository checked out with `vendor/aztec-standards` submodule initialized
- L1 Ethereum RPC (Infura, Alchemy, or local node)
- L1 wallet with ETH for bridging
- An Aztec account for the operator

### 6.2 Compile and Deploy the Contract

```bash
# From repo root
aztec compile --workspace --force

# Deploy FPC (manual)
# operator_pubkey_x/y are the operator Schnorr signing pubkey coordinates.
aztec deploy \
  --artifact target/fpc-FPC.json \
  --args <operator_address> <operator_pubkey_x> <operator_pubkey_y> <accepted_asset_address>
```

Record the deployed contract address — you'll need it in both service configs.

### 6.3 Start the Attestation Service

```bash
cd services/attestation
cp config.example.yaml config.yaml
# Edit config.yaml: set fpc_address, accepted_asset_*, rates
# Provide operator key via OPERATOR_SECRET_KEY (recommended) or config.operator_secret_key
bun install
bun run build
bun run start
```

### 6.4 Start the Top-up Service

```bash
cd services/topup
cp config.example.yaml config.yaml
# Edit config.yaml: set fpc_address, aztec_node_url, l1_rpc_url
# Provide bridge key via L1_OPERATOR_PRIVATE_KEY (recommended) or config.l1_operator_private_key
# l1_chain_id and fee juice L1 addresses come from nodeInfo
bun install
bun run build
bun run start
```

### 6.5 Verify Everything Works

```bash
# Check attestation service health
curl http://localhost:3000/health

# Get accepted asset info
curl http://localhost:3000/asset

# Get a quote for your address
curl "http://localhost:3000/quote?user=<your_aztec_address>"
```

---

## 7. Integrating from a Wallet / SDK

```typescript
// 1. Fetch a user-specific quote
const quote = await fetch(`${ATTESTATION_URL}/quote?user=${wallet.getAddress()}`)
  .then(r => r.json());
const quoteSigBytes = Array.from(
  Buffer.from(quote.signature.replace("0x", ""), "hex")
);

// 2. Compute the charge client-side (must match what the contract will compute on-chain)
//    charge = ceil(max_gas_cost_no_teardown * rate_num / rate_den)
//    Use the same gas settings that will be submitted with the tx.
const NONCE = Fr.random();

// 3. Create a token transfer authwit (user authorises FPC to pull the charge)
const tokenAuthwit = await wallet.createAuthWit(wallet.getAddress(), {
  caller: FPC_ADDRESS,
  action: Token.at(ACCEPTED_ASSET).transfer_private_to_private(
    wallet.getAddress(), OPERATOR_ADDRESS, CHARGE, NONCE
  ),
});

// 4. Build fee_entrypoint call and use it as payment method payload
const feeEntrypointCall = await FPC.at(FPC_ADDRESS).methods
  .fee_entrypoint(
    NONCE,
    BigInt(quote.rate_num),
    BigInt(quote.rate_den),
    BigInt(quote.valid_until),
    quoteSigBytes
  )
  .getFunctionCall();

const paymentMethod = {
  getAsset: async () => ProtocolContractAddress.FeeJuice,
  getExecutionPayload: async () =>
    new ExecutionPayload([feeEntrypointCall], [tokenAuthwit], [], [], FPC_ADDRESS),
  getFeePayer: async () => FPC_ADDRESS,
  getGasSettings: () => undefined,
};

// 5. Send user tx with custom fee payment method
const tx = await SomeContract.at(TARGET).someMethod(args).send({
  fee: {
    paymentMethod,
    gasSettings: YOUR_GAS_SETTINGS,
  },
});
```

> **Note:** The wallet must know `OPERATOR_ADDRESS` to construct the token transfer authwit. This can be fetched from the contract's public storage or hardcoded per deployment.

---

## 8. Security Considerations

### Operator key
- The `operator` key receives all fee revenue and signs all quotes. It is a single key with no separation of duties. Compromise allows fake quotes (user overcharge) and, critically, receipt of funds.
- Use a hardware wallet or KMS in production. Services support secret-provider modes (`env`, `kms`, `hsm`); `runtime_profile=production` rejects plaintext config-file secrets.
- There is no on-chain key rotation. If the operator key is compromised, the contract must be redeployed.

### Quote replay
- Quotes are user-specific (`user_address = msg_sender`). A quote signed for user A cannot be used by user B.
- Consumed quotes are nullified on-chain (`push_nullifier(quote_hash)`), so the exact same quote cannot be reused (even by the same user).
- Keep `quote_validity_seconds` short (default service cap is 3600s; practical deployments should use much shorter windows).

### Setup-phase irreversibility
- The token transfer executes directly inside the setup phase, before `end_setup()`. It is irrevocably committed.
- If the user's app logic reverts, the fee has still been paid. This is unavoidable in the Aztec FPC model — users accept this when using any FPC.

### No on-chain asset whitelist
- The accepted asset is fixed at deployment in `accepted_asset`. Any attempt to pay with a different token will fail because the quote inner hash includes `accepted_asset` read from contract storage — a quote signed over the wrong asset address will not verify.

### Top-up service
- The L1 operator key needs ETH for gas and Fee Juice bridging. Keep only the needed float; replenish from a cold wallet.
- The service has a simple in-flight guard. If the process crashes mid-bridge, the L1 tx still completes and L2 will receive the funds.

---

## 9. Known Limitations (Alpha)

- **No key rotation.** The packed config is `PublicImmutable`. Operator key compromise requires redeployment.
- **Operator tracks revenue off-chain.** All payments arrive as private notes in the operator's balance. The operator must use their PXE to discover incoming notes and maintain off-chain accounting.
- **Charge pre-computation required.** Wallets must replicate the `ceil(max_gas_cost_no_teardown × rate_num / rate_den)` calculation client-side to create the correct token transfer authwit. If gas settings differ at submission time, the authwit may not match.
- **No oracle integration.** Rates are set manually in config. A service restart reloads from config.yaml.
- **Top-up service confirmation now combines message readiness + balance checks.** If message checks fail transiently, the balance-delta fallback still prevents blind success reporting.
