# Research: Compressing Truth

Date: 2026-03-09

Goal:

- Understand how `services/attestation` actually works today.
- Identify the authoritative files and real execution flows.
- Remove assumptions before adding multi-asset admin controls and treasury sweeps.

Authoritative files read:

- `services/attestation/src/server.ts`
- `services/attestation/src/config.ts`
- `services/attestation/src/index.ts`
- `services/attestation/src/fpc-immutables.ts`
- `contracts/fpc/src/main.nr`
- `services/attestation/test/server.test.ts`
- `services/attestation/test/fee-entrypoint-local-smoke.ts`
- `scripts/manual-fpc-sponsored-user-tx-devnet.ts`
- `sdk/src/internal/contracts.ts`
- `node_modules/@aztec/wallets/src/embedded/embedded_wallet.ts`

What the code proved:

1. Contract-side multi-asset support already exists.
   - `contracts/fpc/src/main.nr` defines `fee_entrypoint(accepted_asset, ...)`.
   - `assert_valid_quote(...)` hashes `accepted_asset` into the signed preimage.
   - No contract storage tracks an accepted-asset allowlist or fee bips.
   - Conclusion: add/remove assets and fee margins must be service policy, not Noir storage, if `contracts/` cannot change.

2. The existing attestation service was only partially multi-asset.
   - `services/attestation/src/config.ts` already had `supported_assets`, per-asset `market_rate_*`, and `fee_bips`.
   - `services/attestation/src/server.ts` already required `accepted_asset` on `/quote`.
   - But discovery/quote policy came only from startup config, so there was no runtime admin control or persistence.

3. Treasury movement is a PXE/account reconstruction problem, not just an HTTP problem.
   - User payments land in the operator's private token balance via `Token::transfer_private_to_private(...)`.
   - Spending those notes later requires reconstructing the operator wallet with the real account salt.
   - `services/attestation/src/index.ts` previously only needed the operator secret for signing quotes.
   - `node_modules/@aztec/wallets/src/embedded/embedded_wallet.ts` shows `createSchnorrAccount(secret, salt, ...)` and `registerSender(...)`.
   - Conclusion: sweeps need `operator_account_salt` whenever the operator account was not deployed with salt `0`.

4. Private note discovery needs sender registration support.
   - `services/attestation/src/config.ts` already documented `pxe_data_directory` for `registerSender()` and note discovery, but nothing used it.
   - `EmbeddedWallet.registerSender(...)` persists senders and forwards to PXE.
   - Conclusion: quote issuance is the natural place to register the quoted user as a sender so later operator balance reads/sweeps can rediscover incoming private notes.

5. Artifact/contract registration must be explicit in this repo.
   - `sdk/src/internal/contracts.ts` and `scripts/manual-fpc-sponsored-user-tx-devnet.ts` both show the same pattern:
     - load token artifact from `target/token_contract-Token.json`
     - fetch contract instance from node
     - `wallet.registerContract(instance, artifact)`
     - `Contract.at(address, artifact, wallet)`
   - Conclusion: treasury sweep code should reuse this exact pattern, not assume `Contract.at()` auto-registers.

Implemented service-side model:

- Effective accepted-asset policy is now stored in `asset_policy_state_path`.
- Config `supported_assets` is only the bootstrap set for first boot.
- Admin API mutates the persisted policy set:
  - `GET /admin/asset-policies`
  - `PUT /admin/asset-policies/:assetAddress`
  - `DELETE /admin/asset-policies/:assetAddress`
- Treasury operations are manual and authenticated:
  - `GET /admin/operator-balances`
  - `POST /admin/sweeps`
- Sweeps move private balance from operator to a designated Aztec address with `transfer_private_to_private`.

Constraints that remain true:

- The contract still does not enforce an allowlist. The service is the policy gate.
- Fee margin is still off-chain quote policy (`computeFinalRate(...)`), not on-chain state.
- If `pxe_data_directory` is not configured, sender registration is skipped and treasury note rediscovery is less reliable across restarts.
- If `operator_address` differs from the zero-salt derived address and `operator_account_salt` is missing, sweeps cannot safely reconstruct the correct operator wallet.

Manual validation run:

- `bun run typecheck`
- `bun run test`
- `bun run build`

Observed result:

- Service package typecheck passed.
- Service tests passed, including new runtime asset-policy and manual sweep coverage.
- Production bundle built successfully.
