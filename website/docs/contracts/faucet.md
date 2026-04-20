# Faucet Contract

A public token dispenser for test environments. Distributes tokens with per-recipient cooldowns.

**Source:** `contracts/faucet/src/main.nr`

> [!WARNING]
>
> The Faucet is a test-support contract for devnet and testnet only. Do not deploy in production.

## Storage

```noir
struct Storage {
    config: PublicImmutable<Config>,
    last_drip: Map<AztecAddress, PublicMutable<u64>>,
}
```

| Field | Type | Description |
|-------|------|-------------|
| `config` | `PublicImmutable<Config>` | Token address, admin, drip amount, cooldown duration |
| `last_drip` | `Map<AztecAddress, PublicMutable<u64>>` | Per-recipient timestamp of last drip |

## Constructor

```noir
#[public]
#[initializer]
fn constructor(
    token: AztecAddress,
    admin: AztecAddress,
    drip_amount: u128,
    cooldown_seconds: u64,
)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `AztecAddress` | Token contract to dispense from |
| `admin` | `AztecAddress` | Address with `admin_drip` privilege |
| `drip_amount` | `u128` | Amount per drip in base units |
| `cooldown_seconds` | `u64` | Minimum seconds between drips per recipient |

## Functions

### `drip`

```noir
#[external("public")]
fn drip(recipient: AztecAddress)
```

Transfers `drip_amount` to the recipient's public balance. Reverts if the cooldown has not elapsed since the recipient's last drip.

### `admin_drip`

```noir
#[external("public")]
fn admin_drip(recipient: AztecAddress, amount: u128)
```

Operator bypass: no cooldown, arbitrary amount. Only callable by the configured `admin`. Does not update `last_drip`, so it never blocks the recipient's regular drip cooldown.

### `get_config`

```noir
#[external("utility")]
unconstrained fn get_config() -> Config
```

Returns the faucet's configuration. Unconstrained utility function.

### `get_last_drip`

```noir
#[external("utility")]
unconstrained fn get_last_drip(recipient: AztecAddress) -> u64
```

Returns the unix timestamp of the recipient's last drip. Uninitialized entries return `0`, so the first drip always succeeds.

## Limitations

- Public transfers only. The faucet does not support private drips.
- The faucet must hold a sufficient public balance of the configured token. If the balance runs out, `drip` reverts.
- No mechanism exists to change the `drip_amount` or `cooldown_seconds` after deployment. Redeploy to change parameters.
