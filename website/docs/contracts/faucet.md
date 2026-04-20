# Faucet Contract [Test token dispenser with per-recipient cooldowns]

A public token dispenser for test environments. Distributes tokens with per-recipient cooldowns.

**Source:** `contracts/faucet/src/main.nr`

> [!WARNING]
>
> The Faucet is a **test-support contract** for devnet/testnet only. Not intended for production.


## Storage

```noir
struct Storage {
    config: PublicImmutable<Config>,
    last_drip: Map<AztecAddress, PublicMutable<u64>>,
}
```

| Field | Type | Description |
|-------|------|-------------|
| `config` | `PublicImmutable<Config>` | Token, admin, drip amount, cooldown |
| `last_drip` | `Map<AztecAddress, PublicMutable<u64>>` | Per-recipient cooldown tracking |

## Constructor Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `AztecAddress` | Token contract to dispense |
| `admin` | `AztecAddress` | Address with `admin_drip` privilege |
| `drip_amount` | `u128` | Amount per drip (base units) |
| `cooldown_seconds` | `u64` | Minimum time between drips per recipient |

## Functions

### `drip`

```noir
#[external("public")]
fn drip(recipient: AztecAddress)
```

Transfers `drip_amount` to the recipient's public balance if the cooldown has elapsed since their last drip.

### `admin_drip`

```noir
#[external("public")]
fn admin_drip(recipient: AztecAddress, amount: u128)
```

Operator bypass — no cooldown, any amount. Only callable by the configured `admin`. Does not update `last_drip`, so it never blocks the recipient's regular drip cooldown.

### `get_config`

```noir
#[external("utility")]
unconstrained fn get_config() -> Config
```

Read the faucet's configuration (unconstrained utility).

### `get_last_drip`

```noir
#[external("utility")]
unconstrained fn get_last_drip(recipient: AztecAddress) -> u64
```

Returns the unix timestamp of the recipient's last drip. Uninitialized entries return `0`, so the first drip is always allowed.
