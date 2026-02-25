# Aztec Packages Integration Context (LLM-Optimized)

## 0) Scope and snapshot
- Project code reviewed:
  - `services/*`
  - `contracts/fpc/*`
- Upstream source reviewed:
  - `https://github.com/AztecProtocol/aztec-packages`
- Version coupling in this repo:
  - TypeScript deps in services: `4.0.0-devnet.2-patch.1`
  - Noir deps in `contracts/fpc/Nargo.toml`: `v4.0.0-devnet.2-patch.1`

This document is a compact map of exactly which Aztec libraries are used, where they come from upstream, and which invariants must stay aligned.

## 1) Active Aztec import surface in this repo

### 1.1 Runtime service imports
| Import path | Symbols used in this repo | Local callsites | Upstream source anchor |
|---|---|---|---|
| `@aztec/aztec.js/addresses` | `AztecAddress` | `services/attestation/src/server.ts`, `services/topup/src/*` | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/addresses.ts` |
| `@aztec/aztec.js/fields` | `Fr` | `services/attestation/src/index.ts`, `services/attestation/src/signer.ts`, tests | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/fields.ts` |
| `@aztec/aztec.js/node` | `createAztecNodeClient`, `waitForNode`, `AztecNode`, `NodeInfo` | `services/attestation/src/index.ts`, `services/topup/src/index.ts`, smoke tests | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/node.ts`, `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/utils/node.ts` |
| `@aztec/aztec.js/authorization` | `computeAuthWitMessageHash`, `computeInnerAuthWitHash` (re-export), authwit types | `services/attestation/src/signer.ts`, smoke tests | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/authorization.ts`, `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/utils/authwit.ts` |
| `@aztec/aztec.js/utils` | `getFeeJuiceBalance` | `services/topup/src/monitor.ts`, smoke tests | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/utils.ts`, `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/utils/fee_juice.ts` |
| `@aztec/aztec.js/protocol` | `ProtocolContractAddress`, `FeeJuiceContract` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/protocol.ts` |
| `@aztec/aztec.js/contracts` | `Contract` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/contract.ts` |
| `@aztec/aztec.js/abi` | `ContractArtifact` type | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/abi.ts` |
| `@aztec/aztec.js/messaging` | `waitForL1ToL2MessageReady` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/api/messaging.ts`, `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/utils/cross_chain.ts` |
| `@aztec/accounts/schnorr` | `getSchnorrAccountContractAddress`, `SchnorrAccountContract` | `services/attestation/src/index.ts` | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/accounts/src/schnorr/index.ts` |
| `@aztec/accounts/testing` | `getInitialTestAccountsData` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/accounts/src/testing/index.ts` |
| `@aztec/stdlib/auth-witness` | `computeInnerAuthWitHash`, `AuthWitness` type | `services/attestation/src/signer.ts`, tests | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/auth_witness/auth_witness.ts` |
| `@aztec/stdlib/hash` | `deriveStorageSlotInMap`, `computeSecretHash` | `services/topup/src/monitor.ts`, smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/hash/map_slot.ts` |
| `@aztec/stdlib/keys` | `deriveSigningKey` | `services/attestation/src/index.ts` | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/keys/derivation.ts` |
| `@aztec/stdlib/contract` | `CompleteAddress` | `services/attestation/src/index.ts` | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/contract/complete_address.ts` |
| `@aztec/stdlib/abi` | `loadContractArtifact`, `loadContractArtifactForPublic` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/abi/index.ts` |
| `@aztec/stdlib/noir` | `NoirCompiledContract` type | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/noir/index.ts` |
| `@aztec/stdlib/tx` | `ExecutionPayload` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/tx/index.ts` |
| `@aztec/wallets/embedded` | `EmbeddedWallet` | smoke test | `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/wallets/src/embedded/entrypoints/node.ts` |

### 1.2 Noir imports from aztec-packages
| Dependency in `Nargo.toml` | Upstream directory | Used by local code |
|---|---|---|
| `aztec` | `https://github.com/AztecProtocol/aztec-packages/tree/master/noir-projects/aztec-nr/aztec` | `contracts/fpc/src/main.nr`, tests in `contracts/fpc/src/test/*` |
| `token` | `https://github.com/AztecProtocol/aztec-packages/tree/master/noir-projects/noir-contracts/contracts/app/token_contract` | `contracts/fpc/src/main.nr`, `contracts/fpc/src/test/*` |

## 2) Critical compatibility invariants

### 2.1 Authwit hashing must match across TS and Noir
Quote flow relies on exact equivalence between:
- TS (services):
  - `computeInnerAuthWitHash` in `@aztec/stdlib/auth-witness`
  - `computeAuthWitMessageHash` in `@aztec/aztec.js/authorization`
- Noir (contract):
  - `compute_inner_authwit_hash`
  - `assert_inner_hash_valid_authwit`
  - `compute_authwit_message_hash`

Required inner hash preimage order (current contract behavior):
1. `QUOTE_DOMAIN_SEPARATOR` (`0x465043`)
2. `fpc_address`
3. `accepted_asset`
4. `rate_num`
5. `rate_den`
6. `valid_until`
7. `user_address`

Outer hash shape:
- `hash([consumer, chain_id, version, inner_hash])`
- `consumer` must be the FPC contract address.

If order/types/domain separator diverge, quote authwits fail during `fee_entrypoint`.

### 2.2 Fee Juice balance read path has two modes
Implemented in `services/topup/src/monitor.ts`:
- Primary: `@aztec/aztec.js/utils.getFeeJuiceBalance(owner, node)`
- Fallback: direct public storage read using
  - `deriveStorageSlotInMap(mapSlot=1, owner)`
  - `node.getPublicStorageAt('latest', feeJuiceAddress, slot)`

Important upstream note:
- `@aztec/aztec.js/src/api/utils.ts` marks utils as low-usage/possibly deprecated.
- Local fallback is intentional resilience.

### 2.3 FPC fee-payer phase semantics come from `PrivateContext`
`contracts/fpc/src/main.nr` calls:
- `context.set_as_fee_payer()`
- `context.end_setup()` (only when not revertible phase)
- `context.set_expiration_timestamp(valid_until)`

These behaviors are defined in:
- `https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/aztec-nr/aztec/src/context/private_context.nr`

Do not alter call ordering lightly; this is fee-payment protocol coupling, not app-level style.

## 3) Token contract assumptions used by FPC
FPC assumes upstream Token behavior from:
- `https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/noir-contracts/contracts/app/token_contract/src/main.nr`

Used token methods and assumptions:
- `transfer_in_private(from, to, amount, authwit_nonce)`
  - gated by `#[authorize_once("from", "authwit_nonce")]`
  - consumes authwit/nullifier once
- `mint_to_private(to, amount)` used in tests
- `balance_of_private(owner)` used in tests

If token authwit semantics change upstream, FPC tests around replay protection and quote binding must be revisited.

## 4) Test-only Aztec usage in this repo
Not used by production service loops, but used by smoke/e2e-style tests:
- `EmbeddedWallet` (`@aztec/wallets/embedded`)
- `waitForL1ToL2MessageReady` (`@aztec/aztec.js/messaging`)
- `ExecutionPayload` (`@aztec/stdlib/tx`)
- `loadContractArtifactForPublic` fallback for non-transpiled-public-bytecode artifacts
- Noir test helpers:
  - `aztec::test::helpers::test_environment::TestEnvironment`
  - `aztec::test::helpers::authwit::add_private_authwit_from_call`
  - `aztec::test::helpers::txe_oracles::add_authwit`

## 5) Declared direct deps that are currently not directly imported
- `services/attestation/package.json`:
  - `@aztec/pxe` (not imported directly by local source files)
- `services/topup/package.json`:
  - `@aztec/ethereum`, `@aztec/foundation` (not imported directly by local source files)

These may still be intentional for future work or transitive behavior; this section only reflects direct imports in current code.

## 6) Upgrade and drift checklist
When changing Aztec versions or refactoring these integrations, verify all of the following:
1. `contracts/fpc/Nargo.toml` keeps `aztec` and `token` on the exact same release tag.
2. Quote hash preimage order and domain separator remain identical between:
   - `contracts/fpc/src/main.nr`
   - `services/attestation/src/signer.ts`
3. Authwit outer hash still binds `consumer=fpc_address`, `chainId`, and `version`.
4. Fee Juice read path still works when `getFeeJuiceBalance` fails (fallback path test must pass).
5. Smoke test artifact loading still handles the transpilation requirement (`loadContractArtifactForPublic` fallback).
6. Contract tests still prove:
   - quote expiry rejection,
   - quote-to-user binding,
   - one-time transfer authwit usage.

## 7) Fast code navigation pointers
- Local quote signer: `services/attestation/src/signer.ts`
- Local quote endpoint: `services/attestation/src/server.ts`
- Local topup monitor/fallback: `services/topup/src/monitor.ts`
- Local topup bridge loop: `services/topup/src/checker.ts`
- FPC contract core: `contracts/fpc/src/main.nr`
- FPC test wiring: `contracts/fpc/src/test/utils.nr`, `contracts/fpc/src/test/fee_entrypoint.nr`

- Upstream authwit (Noir):
  - `https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/aztec-nr/aztec/src/authwit/auth.nr`
- Upstream private context (Noir):
  - `https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/aztec-nr/aztec/src/context/private_context.nr`
- Upstream token contract (Noir):
  - `https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/noir-contracts/contracts/app/token_contract/src/main.nr`
- Upstream authwit (TS):
  - `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/aztec.js/src/utils/authwit.ts`
  - `https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/stdlib/src/auth_witness/auth_witness.ts`
