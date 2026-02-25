# FPC Gate Count Profiling

Profiles the gate count of `FPC.fee_entrypoint` using the Aztec workspace's private proving infrastructure.

## Prerequisites

- A running Aztec devbox node at `http://127.0.0.1:8080`
- Compiled FPC + Token artifacts at `../target/`

## Steps

### 1. Compile the contracts

```bash
cd /path/to/aztec-fpc
aztec-nargo compile
```

Produces `target/fpc-FPC.json` and `target/token_contract-Token.json`.

---

### 2. Deploy using the workspace deploy script

```bash
cd /path/to/aztec-packages/yarn-project
node /path/to/aztec-fpc/profiling/deploy-fpc.mjs
```

This uses a custom deploy script rather than `aztec-wallet deploy` because the devbox binary and the workspace code compute contract class IDs differently (raw nargo format vs normalised artifact). Deploying from workspace code ensures the class IDs match at profile time.

**What the script does:**
- Starts an embedded PXE
- Registers test0 (admin/minter) and test1 (operator) accounts
- Normalises the raw nargo artifacts via `loadContractArtifact()`
- Deploys `Token(admin, "TestToken", "TST", 18)`
- Deploys `FPC(operator, tokenAddress)`
- Prints the two deployed addresses

---

### 3. Update addresses in the profile script

Copy the printed addresses into the constants at the top of `profile-fpc.mjs` (in the aztec-packages workspace):

```js
const TOKEN_ADDRESS = '0x...';
const FPC_ADDRESS   = '0x...';
```

---

### 4. Run the profile

```bash
cd /path/to/aztec-packages/yarn-project
node /path/to/aztec-fpc/profiling/profile-fpc.mjs
```

**What the script does:**
1. Connects to the node and starts an embedded PXE
2. Registers test0 (user/minter) and test1 (operator) accounts
3. Registers Token and FPC contracts in the PXE
4. Fetches current min fees and computes `charge` (tokens the FPC will collect)
5. Mints `charge + 1000` tokens to the user
6. Creates a **quote authwit** — operator signs a fee-quote allowing FPC to consume it
7. Creates a **transfer authwit** — user authorises FPC to pull `charge` tokens on their behalf
8. Builds a `CustomFPCPaymentMethod` wrapping those authwits and gas settings
9. Calls `.profile()` on a dummy `Token.transfer_in_private(user→user, 1, nonce=0)` with the FPC as fee payer, triggering the full `fee_entrypoint` execution path
10. Prints a gate-count table per function in the execution trace

---

## Output

```
=== Gate Count Profile ===

Function                                                     Own gates    Subtotal
────────────────────────────────────────────────────────────────────────────────────────
SchnorrAccount.entrypoint                                    ...          ...
Token.transfer_in_private                                    ...          ...
FPC.fee_entrypoint                                           ...          ...
...
────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                                     ...
```

---

## Gotchas

| Issue | Fix |
|---|---|
| `Artifact does not match expected class id` | Deploy with `deploy-fpc.mjs` (workspace packages) instead of `aztec-wallet deploy`; use `loadContractArtifact()` to normalise raw nargo format |
| `Failed to get a note 'self.is_some()'` in `SchnorrAccount.verify_private_authwit` | Add `additionalScopes: [operatorAddress]` to the `.profile()` call so the PXE can decrypt the operator's `signing_public_key` note during the nested call |
| `Invalid authwit nonce` in `Token.transfer_in_private` | When `from == msg_sender`, the token contract requires `nonce=0` (no authwit path) |
