# Token Bridge Contract

L1-L2 bridge for moving tokens between Ethereum and Aztec.

**Source:** `contracts/token_bridge/src/main.nr`

## Storage

```noir
struct Storage {
    config: PublicImmutable<Config>,
}
```

| Field | Type | Description |
|-------|------|-------------|
| `token` | `AztecAddress` | The L2 token contract this bridge serves |
| `portal` | `AztecAddress` | The L1 portal contract address |

## Functions

### `constructor`

```noir
#[public]
#[initializer]
fn constructor()
```

Empty initializer. Config must be set via `set_config` before the bridge can process claims.

### `set_config`

```noir
#[public]
fn set_config(token: AztecAddress, portal: AztecAddress)
```

One-time initialization linking the bridge to its L2 token and L1 portal. Call this immediately after deployment.

### `claim_public`

```noir
#[public]
fn claim_public(
    to: AztecAddress,
    amount: Field,
    secret: Field,
    message_leaf_index: Field,
)
```

Claims tokens from an L1-to-L2 deposit into the recipient's **public** balance.

1. Constructs the expected L1-to-L2 message content hash.
2. Consumes the message from the Aztec inbox.
3. Mints `amount` tokens to `to`'s public balance.

> [!NOTE]
>
> FPC cold-start calls `claim_private`, not `claim_public`. The cold-start flow operates entirely in the private domain.

### `claim_private`

```noir
#[public]
fn claim_private(
    to: AztecAddress,
    amount: Field,
    secret: Field,
    message_leaf_index: Field,
)
```

Same as `claim_public` but mints to the recipient's **private** balance. Used by `FPCMultiAsset.cold_start_entrypoint`.

### `exit_to_l1_public`

```noir
#[public]
fn exit_to_l1_public(
    recipient: EthAddress,
    amount: Field,
    caller_on_l1: EthAddress,
    authwit_nonce: Field,
)
```

Burns L2 tokens and sends an L2-to-L1 withdrawal message.

1. Burns `amount` from the caller's public balance.
2. Sends a message to the L1 portal encoding the recipient and amount.
3. The L1 portal releases corresponding ERC-20 tokens after the message is consumed.

## Role in Cold Start

```
User (L1) ──bridge──► L1 Portal ──message──► Aztec Inbox
                                                   │
FPC.cold_start_entrypoint ──► TokenBridge.claim_private(fpc_address, claim_amount, ...)
                                    │
                                    ▼
                              Tokens minted to FPC's private balance
                                    │
                              FPC distributes via transfer_private_to_private:
                              ├──► user gets (claim_amount - aa_payment_amount)
                              └──► operator gets aa_payment_amount
```

The FPC passes its own address (not the user's) as the `to` argument to `claim_private`. Tokens land in the FPC's private balance first, then the FPC distributes them. This design is intentional: the user's account may not exist on L2 yet, so the protocol cannot write notes directly to the user. Routing through the FPC sidesteps the need for an authwit from a non-existent account.
