# FPC Alpha PRD Gap Analysis (as of 2026-03-02)

## Scope
This document compares `local-docs/fpc-prd.md` against the current implementation in this repository (`contracts/`, `services/`, `scripts/`, `docs/`).

Validation performed in this revision:
- Code + docs inspection across contracts/services/deploy/e2e/CI files.
- Architecture decision cross-read on 2026-03-02 against `docs/adr-0001-alpha-asset-model.md`.
- Local test execution re-run on 2026-03-01:
  - `bun run test:ts` (pass)
  - `bun run test:contracts` (pass)

## Executive Summary
The repo is strong on core fee payment flows, attestation signing, top-up automation, test coverage, and deployment tooling.

Main remaining PRD gaps are:
1. ADR-0001 locks Alpha to single-deployment multi-asset support, but current contracts are still single-asset per deployment.
2. No wallet discovery mechanism for attestation endpoints.
3. "USDC + ETH variants" Alpha done criteria are not met under the locked model.
4. Operator docs must consistently label one-deployment-per-asset as interim only until ADR-0001 implementation lands.

## Requirement Matrix

| PRD Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Monorepo with contracts/services/docs and deployability | Partial | Repo has `contracts/`, `services/`, `docs/`, Docker/build/deploy scripts (`README.md`, `docker-compose.yaml`) | PRD-recommended `/infra` directory is not present; infra content exists but is spread across root/docs/scripts |
| FPC accepts configurable set of tokens (multi-asset) | Missing (P0 per ADR-0001) | `FPC` and `CreditFPC` each store one immutable `accepted_asset` (`contracts/fpc/src/main.nr:54-60`, `contracts/credit_fpc/src/main.nr:41-47`) | No multi-asset storage/model |
| Admin controls to add/remove accepted assets | Missing | No admin mutators in contract interfaces; constructor fixes asset once (`contracts/fpc/src/main.nr:78-95`, `contracts/credit_fpc/src/main.nr:58-75`) | Cannot add/remove assets post-deploy |
| Configurable fee/margin (bips) | Partial | Margin is configurable in attestation config (`services/attestation/src/config.ts:69-73`) and applied at quote time (`services/attestation/src/server.ts:354-357`) | Config is off-chain per service instance, not on-chain/admin-managed |
| Ability to transfer accumulated paid tokens to designated address | Partial (design divergence) | Charges transfer directly user private -> configured operator private (`contracts/fpc/src/main.nr:135-137`, `contracts/credit_fpc/src/main.nr:104-106`) | Destination is set at deploy via immutable `operator`; no post-deploy destination change or treasury sweep API |
| Attestation service with manually set prices for MVP | Partial (single-pair instance) | Quote API + manual rates + bips (`services/attestation/src/server.ts:271-393`, `services/attestation/src/config.ts:66-73`) | ADR-0001 requires one deployment to support multiple assets and per-asset pricing in one service instance |
| FPC verifies attestations on-chain | Implemented | Quote hash + Schnorr verification + replay protection in both contracts (`contracts/fpc/src/main.nr:156-170`, `contracts/credit_fpc/src/main.nr:183-199`) | None for current single-asset model |
| Top-up service monitors Fee Juice and bridges below threshold | Implemented | Balance monitor + threshold trigger + bridge + confirmation (`services/topup/src/index.ts:114-150`, `services/topup/src/checker.ts:49-123`, `services/topup/src/confirm.ts:85-217`) | None for current scope |
| Wallet discovery mechanism (open question in PRD) | Missing / unresolved | PRD still marks discovery unresolved (`local-docs/fpc-prd.md:70-73`); no wallet->attestation discovery implementation found in repo | No registry/well-known mapping/wallet-sdk integration path |
| Unit tests for contracts and services | Implemented | Local runs pass (`bun run test:ts`, `bun run test:contracts` on 2026-03-01); CI runs contract + TS tests (`.github/workflows/build-contract.yml:56-66`, `.github/workflows/ts-packages.yml:25-35`) | None |
| E2E tests for full flow | Implemented (local harness) | Full lifecycle runners exist for FPC and CreditFPC with negative scenarios (`scripts/services/fpc-full-lifecycle-e2e.ts:1846-1879`, `scripts/services/credit-fpc-full-lifecycle-e2e.ts:2086-2119`), and are wired as scripts (`package.json:49-50`) | Full-lifecycle e2e is not wired into CI workflows; CI runs smoke flows (`.github/workflows/spec-services-smoke.yml:66-70`, `.github/workflows/spec-credit-fpc-smoke.yml:66-99`, `.github/workflows/spec-fee-entrypoint-smoke.yml`) |
| Docker setup for local stack/deployability | Implemented | `docker-compose.yaml`, `docker-bake.hcl`, service Dockerfiles, CI docker workflows | None material |
| Clear docs to run your own FPC | Partial | Strong run/deploy docs exist (`README.md`, `devnet-deployment-how-to.md`, service READMEs, AWS guide) | Must keep all docs aligned to ADR-0001 and avoid presenting multi-instance single-asset setup as Alpha done |
| Alpha done: deployed and accepting at least USDC/ETH variants | Missing under ADR-0001 | Deployed manifest shows one accepted asset address (`deployments/devnet-manifest-v2.json:35-39`) | No repo evidence that one contract deployment accepts both a USDC variant and an ETH variant simultaneously |
| Alpha done: attestation service running with manual prices | Implemented | Service supports manual fixed rates + bips and quote issuance (`services/attestation/src/config.ts:69-73`, `services/attestation/src/server.ts:353-393`) | None |
| Alpha done: top-up service keeping FPC funded | Implemented | Top-up loop, persistence/reconciliation, and confirmation logic are implemented and tested (`services/topup/src/index.ts`, `services/topup/src/reconcile.ts`, `services/topup/test/*`) | None |
| Alpha done: tested against testnet | Partial | Devnet deployment + verification + postdeploy smoke tooling documented (`devnet-deployment-how-to.md:6-17`, `devnet-deployment-how-to.md:226-230`) | No continuous/automated "testnet acceptance" evidence in CI; execution appears manual |
| Out-of-scope items not implemented (oracle/zkTLS/decentralized feeds/UI) | Aligned | Current architecture remains centralized/manual and infra-focused | None |

## Highest-Priority Gaps (What Still Needs To Be Done)

### P0
1. Implement ADR-0001 multi-asset model in contracts and services.
- Add multi-asset support in one deployment (allowlist + admin lifecycle + asset-specific quote handling).
- Remove reliance on one-deployment-per-asset as the primary model.

2. Implement wallet discovery mechanism.
- Define how wallet-sdk maps an FPC/payment method to attestation base URL.
- Candidate paths from PRD: registry contract, well-known URL convention, or temporary hardcoded mapping.

3. Close alpha acceptance criteria mismatch for USDC+ETH variants.
- Demonstrate one deployment handling at least one USDC variant and one ETH variant in the same runtime stack.

### P1
4. Clarify treasury/revenue destination model.
- Current design sends revenue directly to immutable operator private balance.
- If treasury and signer need separation, add explicit destination controls or an intermediate treasury/sweep flow.

5. Provide stronger testnet validation evidence.
- Add repeatable testnet checklist artifacts and/or scheduled CI smoke against target network.

6. Align operator and product docs to ADR-0001 scope.
- Keep current multi-instance runbooks explicitly marked as interim.
- Link operator docs to ADR-0001 as source of truth for Alpha model.

### P2
7. Infra packaging cleanup.
- Optional but useful: consolidate Docker/IaC into a dedicated `/infra` folder to match PRD recommendation.

8. Terminology cleanup.
- Remove stale "MultiAssetFPC" wording where implementation is single-asset-per-instance.

## What Is Already Solid
- Core FPC/CreditFPC quote security model (user binding, replay protection, signature verification).
- Top-up bridge lifecycle with persistence/reconciliation and readiness endpoints.
- Good automated test coverage for contracts and services; local test suites pass.
- Deployment/verification/smoke tooling for local and devnet workflows.

## Decision Status
Decision is now locked by `docs/adr-0001-alpha-asset-model.md`:
- Alpha model = single deployment with multi-asset support.
- Multi-instance (one deployment per asset) remains an interim workaround only.
