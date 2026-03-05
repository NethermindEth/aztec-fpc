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
- Balance bootstrap flow with faucet and shield retries.
- Sponsored fee-payment construction (`authwit`, `fee_entrypoint`, payment method payload).
- Post-transaction invariant checks and typed `SponsoredIncrementResult`.
- Unit test coverage for quote validation, bootstrap logic, fee payment construction, and increment invariants.
- README usage guide and v1 limitations documentation.
- Package `LICENSE` for publish readiness.

### Changed
- Root workspace quality gates now include `sdk` formatting, linting, typecheck, and tests.

### Fixed
- Artifact resolution now verifies required artifact files and falls back to the package `artifacts` directory when a repository-level `artifacts/` directory exists but does not contain SDK artifacts.
