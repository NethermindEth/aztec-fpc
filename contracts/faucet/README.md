# Faucet

`Faucet` is a public token dispenser for FPC testing. It lets anyone claim a fixed `drip_amount` of the accepted asset per cooldown window, so that testers can acquire the token needed to pay FPC fees without needing minter access.

The contract is intentionally minimal: all state is public, all functions are public, and it does not participate in fee payment itself.

## What This Contract Does

`Faucet` stores:

- immutable config (`token`, `admin`, `drip_amount`, `cooldown_seconds`) packed into a `PublicImmutable<Config>`, and
- per-recipient last-drip timestamps in `Map<AztecAddress, PublicMutable<u64>>`.

### `drip` flow

`drip(recipient)`:

1. Reads immutable config.
2. If `cooldown_seconds > 0`, reads `last_drip[recipient]` and asserts `now - last >= cooldown_seconds`.
3. Writes the current timestamp to `last_drip[recipient]`.
4. Calls `Token.transfer_public_to_public(this_address, recipient, drip_amount, 0)`.

Tokens land in the recipient's **public** balance. Recipients who want to use the FPC must subsequently shield them:

```
Token.transfer_public_to_private(recipient, drip_amount, secret_hash)
```

Anyone may call `drip`. There is no authwit requirement because the Faucet is calling the token from its own public balance (`msg_sender == from`).

Setting `cooldown_seconds = 0` at deploy time disables rate-limiting entirely (useful for CI).

### `admin_drip` flow

`admin_drip(recipient, amount)`:

1. Asserts `msg_sender == config.admin`.
2. Calls `Token.transfer_public_to_public(this_address, recipient, amount, 0)`.

Bypasses the cooldown and allows a custom amount. Intended for deployment scripts and smoke tests. Does **not** update `last_drip[recipient]`, so an admin drip never interferes with the recipient's regular drip cooldown.

## Setup

### 1. Deploy the token

Deploy `Token` with `constructor_with_minter(name, symbol, decimals, admin, minter)`. The operator address becomes both admin and minter.

### 2. Deploy the Faucet

```
Faucet.constructor(
    token:             <token_address>,
    admin:             <operator_address>,
    drip_amount:       <amount_in_base_units>,
    cooldown_seconds:  <seconds>   // 0 to disable rate-limiting
)
```

The Faucet is **not** the token minter. It only holds a public balance and transfers from it.

### 3. Fund the Faucet

After deployment, the operator (token minter) must mint tokens directly to the Faucet's public balance:

```
Token.mint_to_public(faucet_address, initial_supply)
```

This is a one-time setup step. The Faucet cannot mint tokens itself; topping it up later requires another `mint_to_public` from the minter.

The deploy scripts handle steps 2 and 3 automatically. The default `initial_supply` is `drip_amount * 100` (configurable via `FPC_FAUCET_INITIAL_SUPPLY`).

## Relationship to the FPC

`Faucet` is a test-support contract, not a fee-payment contract. It sits outside the FPC protocol:

```
Faucet.drip(user)
  └─ Token.transfer_public_to_public(faucet → user)
       user shields tokens
  └─ Token.transfer_public_to_private(user, amount, secret_hash)
       user pays FPC fee
  └─ FPC.fee_entrypoint(...)
```

The accepted asset used by the FPC and the token held by the Faucet are the same contract.

## Deploy Script Integration

The deploy scripts read three env vars:

| Variable | Default | Description |
|---|---|---|
| `FPC_FAUCET_DRIP_AMOUNT` | `1000000000000000000` (1 token) | Tokens per drip in base units |
| `FPC_FAUCET_COOLDOWN_SECONDS` | `0` | Per-recipient cooldown (0 = disabled) |
| `FPC_FAUCET_INITIAL_SUPPLY` | `drip_amount * 100` | Tokens minted to faucet at deploy |

Local mode writes the deployed address to `deploy.faucet.address` in the output JSON. Devnet mode writes it to `contracts.faucet` in the unified manifest alongside `faucet_config`.

## Implementation Notes

**Why not make the Faucet the minter?**
If the Faucet were the minter, it would need to be passed as the `minter` arg during token deployment — but the Faucet's address is not known until after it is deployed, and the Faucet needs the token address at its own deploy time. Making the operator the minter and having it top up the Faucet breaks the circular dependency cleanly.

**Why `transfer_public_to_public` instead of `mint_to_public`?**
`mint_to_public` requires `msg_sender == minter`. The Faucet is not the minter, so it cannot call `mint_to_public`. Instead it pre-holds a funded public balance and transfers from it. This also makes the Faucet's token supply finite and visible on-chain.

**Why public state for `last_drip`?**
`drip` is a public function. Public functions cannot read or write private state, so the cooldown map must be public. Uninitialized entries read as 0, which means the first drip for any address always succeeds.

## Public Interface

- `constructor(token, admin, drip_amount, cooldown_seconds)` (`public`, initializer)
- `drip(recipient)` (`public`)
- `admin_drip(recipient, amount)` (`public`)
- `get_config() -> Config` (`utility`)
- `get_last_drip(recipient) -> u64` (`utility`)
