# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial `@aztec-fpc/sdk` package scaffolding with Bun/TypeScript build and test setup.
- Public v1 API surface:
  - `createSponsoredCounterClient({ wallet, account })`
  - `client.increment()`
- Bundled contract artifacts for token, FPC, faucet, and counter contracts.
- Fixed default runtime configuration for devnet URLs, addresses, and gas limits.
- Typed SDK error model with stable error codes:
  - `PublishedAccountRequiredError`
  - `InsufficientFpcFeeJuiceError`
  - `QuoteValidationError`
  - `BalanceBootstrapError`
  - `SponsoredTxFailedError`
- Contract attach and published-account validation flow.
- Quote retrieval and strict quote validation logic.
- Attestation discovery helpers with accepted-asset fallback order:
  - `endpoints.accepted_assets`
  - discovery `supported_assets`
  - legacy `/asset`
- Accepted-asset selection helper supporting explicit address, default-first, and callback strategy.
- Discovery FPC-address resolution helper for optional discovery-driven FPC configuration.
- Runtime sponsorship configuration types (`SponsoredRuntimeConfig`) for explicit node/FPC/token/operator/faucet/target wiring.
- Devnet convenience runtime factory (`createDevnetRuntimeConfig`) so defaults are optional rather than implicit.
- Generic execution API: `executeSponsoredCall({ wallet, account, sponsorship, buildCall, postChecks })`.
- Generic execution result metadata (`txHash`, `txFeeJuice`, `expectedCharge`, `userDebited`, `quoteValidUntil`) for non-counter call flows.
- Legacy `createSponsoredCounterClient` now delegates to `executeSponsoredCall` while preserving the existing increment result fields (`counterBefore`, `counterAfter`, `expectedCharge`, `userDebited`, etc.).
- Balance bootstrap flow with faucet and shield retries.
- Sponsored fee-payment construction (`authwit`, `fee_entrypoint`, payment method payload).
- Post-transaction invariant checks and typed `SponsoredIncrementResult`.
- Unit test coverage for quote validation, bootstrap logic, fee payment construction, and increment invariants.
- README usage guide and v1 limitations documentation.
- Package `LICENSE` for publish readiness.

### Changed
- Root workspace quality gates now include `sdk` formatting, linting, typecheck, and tests.
- RPI Step 1: attestation discovery contract now includes `endpoints.accepted_assets`, and attestation exposes `GET /accepted-assets` (SDK integration prerequisite while preserving legacy `/asset`).

### Fixed
- Artifact resolution now verifies required artifact files and falls back to the package `artifacts` directory when a repository-level `artifacts/` directory exists but does not contain SDK artifacts.
- Contract attach flow now enforces deterministic FPC precedence and rejects explicit/discovery address mismatches.
- Generic execution now surfaces typed failures for invalid `buildCall` interactions, failed post-checks, and malformed receipt metadata.
