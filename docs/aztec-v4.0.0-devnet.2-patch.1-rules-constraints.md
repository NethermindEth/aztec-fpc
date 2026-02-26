# Aztec `v4.0.0-devnet.2-patch.1` Rules And Constraints (LLM-Optimized)

## Source And Scope
- Source URL: `https://docs.aztec.network/developers/docs/resources/migration_notes`
- Version in docs navbar: `Devnet (v4.0.0-devnet.2-patch.1)`
- Scope extracted: new rules/constraints for this version section only (not older historical sections).
- Retrieved on: `2026-02-26`

## Canonical Constraints

Each item is normalized as: `id`, `area`, `severity`, `rule`, `required_action`.

### `AZTEC-4P1-001`
- `area`: Protocol (tx expiry)
- `severity`: high
- `rule`: Use `expiration_timestamp`; `include_by_timestamp` is obsolete.
- `required_action`: Replace `set_tx_include_by_timestamp(...)` with `set_expiration_timestamp(...)`.

### `AZTEC-4P1-002`
- `area`: CLI installation
- `severity`: high
- `rule`: CLI install is dockerless; install command must include explicit version in both env var and URL.
- `required_action`: Use `VERSION=<ver> bash -i <(curl -sL https://install.aztec.network/<ver>)`; stop using legacy `aztec-up <version>` install flow.

### `AZTEC-4P1-003`
- `area`: Wallet package
- `severity`: high
- `rule`: `@aztec/test-wallet` is removed.
- `required_action`: Migrate to `@aztec/wallets` and `EmbeddedWallet.create(...)`.

### `AZTEC-4P1-004`
- `area`: Aztec.nr logging
- `severity`: medium
- `rule`: `aztec::oracle::debug_log` module path is renamed to `aztec::oracle::logging`.
- `required_action`: Update imports/inline paths; replace removed `debug_log_format_slice` with `debug_log_format`.

### `AZTEC-4P1-005`
- `area`: AztecNode validator stats API
- `severity`: medium
- `rule`: Sentinel status labels changed for checkpoint model.
- `required_action`: Update consumers for new values: `checkpoint-mined`, `checkpoint-proposed`, `checkpoint-missed`, `blocks-missed`; update `ValidatorStatusType` to `proposer | attestation`.

### `AZTEC-4P1-006`
- `area`: aztec.js events API
- `severity`: high
- `rule`: `getDecodedPublicEvents` is replaced by `getPublicEvents` with a filter object signature.
- `required_action`: Rename API call and pass `{ fromBlock, toBlock, contractAddress?, txHash? }`.

### `AZTEC-4P1-007`
- `area`: Aztec.nr attributes
- `severity`: medium
- `rule`: `nophasecheck` is renamed to `allow_phase_change`.
- `required_action`: Rename annotations/usages accordingly.

### `AZTEC-4P1-008`
- `area`: AztecNode sibling-path RPC
- `severity`: high
- `rule`: direct sibling-path RPC methods are removed.
- `required_action`: Use membership witness APIs instead (`getNullifierMembershipWitness`, `getNoteHashMembershipWitness`, `getBlockHashMembershipWitness`, `getPublicDataWitness`).

### `AZTEC-4P1-009`
- `area`: Protocol key semantics
- `severity`: critical
- `rule`: `nsk` terminology and domain separator changed to `nhk` (nullifier hiding key); this is protocol-breaking.
- `required_action`: Rename Noir/TS key functions and enums (`NSK_M` -> `NHK_M`) and regenerate dependent constants/flows.

### `AZTEC-4P1-010`
- `area`: Archive witness naming/types
- `severity`: high
- `rule`: `getArchiveMembershipWitness` renamed to `getBlockHashMembershipWitness`; second argument type changed (`Fr` -> `BlockHash`).
- `required_action`: Update AztecNode and aztec.nr callsites/imports.

### `AZTEC-4P1-011`
- `area`: Aztec.nr protocol imports
- `severity`: high
- `rule`: `protocol_types` re-export renamed to `protocol`.
- `required_action`: Rewrite import paths from `dep::aztec::protocol_types::...` to `dep::aztec::protocol::...`.

### `AZTEC-4P1-012`
- `area`: Protocol contract interface crates
- `severity`: high
- `rule`: macro-enabled protocol interfaces moved to `protocol_interface/*_interface` placeholders.
- `required_action`: Update `Nargo.toml` protocol deps to `.../protocol_interface/..._interface`.

### `AZTEC-4P1-013`
- `area`: aztec-nr history API
- `severity`: high
- `rule`: history trait-method API moved to standalone functions.
- `required_action`: Replace method-style calls (e.g. `block_header.prove_*`) with new `assert_*` function calls in new modules.

### `AZTEC-4P1-014`
- `area`: aztec.js tx send flow
- `severity`: critical
- `rule`: legacy chained `.send().wait()` / `.send().getTxHash()` flow is removed in favor of `.send(options)`.
- `required_action`: Use `.send({ from, wait })`; use `NO_WAIT` + `waitForTx(...)` for manual waiting.

### `AZTEC-4P1-015`
- `area`: Deployment send flow
- `severity`: high
- `rule`: `.send().deployed()` is removed.
- `required_action`: Use `.send({ from })` (returns contract) or `.send({ from, wait: { returnReceipt: true } })`.

### `AZTEC-4P1-016`
- `area`: Wallet interface
- `severity`: high
- `rule`: `getTxReceipt()` removed; `sendTx` signature changed to generic wait semantics.
- `required_action`: Refactor interface implementations and callers to new typed `sendTx`/return behavior.

### `AZTEC-4P1-017`
- `area`: aztec-nr import layout
- `severity`: medium
- `rule`: many single-struct intermediate modules were removed.
- `required_action`: Shorten imports (example: `aztec::state_vars::PrivateMutable`).

### `AZTEC-4P1-018`
- `area`: L1 fee model
- `severity`: critical
- `rule`: price direction inverted to `ethPerFeeAsset` (was `feeAssetPerEth`).
- `required_action`: Update field names/config wiring; set `initialEthPerFeeAsset`; use operator env `AZTEC_INITIAL_ETH_PER_FEE_ASSET`.

### `AZTEC-4P1-019`
- `area`: L1 oracle fee modifier
- `severity`: high
- `rule`: `feeAssetPriceModifier` now uses BPS and is constrained to `[-100, +100]` (max +/-1% per checkpoint).
- `required_action`: Convert existing modifier units to BPS and validate range.

### `AZTEC-4P1-020`
- `area`: Wallet batching typing
- `severity`: low
- `rule`: batch method typing is now strict/discriminated across all wallet methods.
- `required_action`: Fix invalid `name`/`args` combinations; leverage expanded batching surface.

### `AZTEC-4P1-021`
- `area`: Wallet metadata APIs
- `severity`: medium
- `rule`: `ContractMetadata` and `ContractClassMetadata` shapes changed; artifact inclusion via `includeArtifact` removed.
- `required_action`: Update metadata readers to new fields (`instance`, `isContractUpdated`, `updatedContractClassId`, `isArtifactRegistered`).

### `AZTEC-4P1-022`
- `area`: Protocol contract access in aztec.js
- `severity`: high
- `rule`: `UnsafeContract` and helper getters (`getFeeJuice`, `getClassRegistryContract`, `getInstanceRegistryContract`) are removed.
- `required_action`: Use typed wrappers from `@aztec/aztec.js/protocol` (e.g., `FeeJuiceContract.at(wallet)`).

### `AZTEC-4P1-023`
- `area`: Aztec.nr contract names
- `severity`: medium
- `rule`: `Router` contract renamed to `PublicChecks`.
- `required_action`: Rename contract references/imports/usages.

### `AZTEC-4P1-024`
- `area`: Aztec Node block lookup API
- `severity`: medium
- `rule`: `getBlockByHash` and `getBlockHeaderByHash` removed.
- `required_action`: Use `getBlock(hash)` and `getBlockHeader(hash)`.

### `AZTEC-4P1-025`
- `area`: Aztec.nr low-level oracle signatures
- `severity`: high
- `rule`: low-level witness/storage oracles now require `BlockHeader` instead of `block_number: u32`.
- `required_action`: Pass `BlockHeader` to affected functions (`get_*_membership_witness`, `storage_read`, etc.).

### `AZTEC-4P1-026`
- `area`: Toolchain
- `severity`: critical
- `rule`: minimum Node.js is now `v24.12.0`.
- `required_action`: Upgrade CI/dev runtime to Node `>=24.12.0`.

### `AZTEC-4P1-027`
- `area`: L1 fee naming
- `severity`: medium
- `rule`: "base fee" terminology changed to "min fee" in contracts/types/errors.
- `required_action`: Rename L1 calls/types (`getManaBaseFeeAt` -> `getManaMinFeeAt`, etc.).

### `AZTEC-4P1-028`
- `area`: aztec.js fee API
- `severity`: medium
- `rule`: `getCurrentBaseFees` renamed to `getCurrentMinFees`.
- `required_action`: Update node API callsites.

### `AZTEC-4P1-029`
- `area`: Aztec.nr fee context API
- `severity`: medium
- `rule`: fee context getters renamed from `base_fee_*` to `min_fee_*`.
- `required_action`: Replace `context.base_fee_per_*` with `context.min_fee_per_*`.

### `AZTEC-4P1-030`
- `area`: Aztec.nr sender API
- `severity`: high
- `rule`: `self.msg_sender()` now returns `AztecAddress` directly and panics when unavailable; optional sender access moved.
- `required_action`: Remove `.unwrap()` on `self.msg_sender()`; use `self.context.maybe_msg_sender()` when optional behavior is needed.

### `AZTEC-4P1-031`
- `area`: Aztec.nr message delivery enums
- `severity`: medium
- `rule`: delivery enum values were renamed.
- `required_action`: Map old names to new names: `UNCONSTRAINED_OFFCHAIN -> OFFCHAIN`, `UNCONSTRAINED_ONCHAIN -> ONCHAIN_UNCONSTRAINED`, `CONSTRAINED_ONCHAIN -> ONCHAIN_CONSTRAINED`.

### `AZTEC-4P1-032`
- `area`: Aztec Node logs API
- `severity`: high
- `rule`: `getLogsByTags` behavior changed; `logsPerTag` pagination removed; API split into private/public endpoints.
- `required_action`: Migrate to `getPrivateLogsByTags` and `getPublicLogsByTagsFromContract`; adjust request/response handling.

### `AZTEC-4P1-033`
- `area`: AVM gas economics
- `severity`: high
- `rule`: multiple public-execution opcode gas costs increased via multipliers.
- `required_action`: Re-estimate gas for public bytecode paths, especially storage/nullifier/note/hash-heavy operations.

### `AZTEC-4P1-034`
- `area`: PXE debug API
- `severity`: medium
- `rule`: `pxe.getNotes(...)` removed from main API; now exposed under debug module.
- `required_action`: Use `pxe.debug.getNotes(...)`.

## Fast Upgrade Gates (Use As CI Checklist)
- Runtime gate: Node.js `>= 24.12.0`.
- Compile gate: no references to removed APIs (`@aztec/test-wallet`, `UnsafeContract`, sibling-path RPCs, `getBlockByHash`, `getCurrentBaseFees`, old fee/base naming).
- Protocol gate: all `nsk`/`NSK_M` and `include_by_timestamp` references replaced.
- Noir gate: imports migrated (`protocol_types`, `debug_log`, history API, message delivery enums, `msg_sender` semantics).
- Integration gate: tx/deploy flows use new `.send(options)` behavior and explicit waiting strategy.
- Ops gate: fee config uses `ethPerFeeAsset` + BPS modifier semantics and valid bounds.
