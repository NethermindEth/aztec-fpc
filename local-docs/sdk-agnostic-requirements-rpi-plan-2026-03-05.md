# SDK Agnostic Sponsorship: Requirements Research + Implementation Plan (RPI)

Date: 2026-03-05  
Scope: `sdk` and `services/attestation`  
Goal: make SDK usable with any attestation URL, any FPC on-chain address (ABI fixed), any target contracts/calls, and any accepted token, while leveraging attestation-side discovery.

## Research (Compressing Truth)

### Authoritative files read

- `sdk/src/client.ts`
- `sdk/src/types.ts`
- `sdk/src/defaults.ts`
- `sdk/src/internal/contracts.ts`
- `sdk/src/internal/quote.ts`
- `sdk/src/internal/fee-payment.ts`
- `sdk/src/internal/balance-bootstrap.ts`
- `sdk/test/increment.test.ts`
- `sdk/test/quote.test.ts`
- `services/attestation/src/server.ts`
- `services/attestation/src/config.ts`
- `services/attestation/src/index.ts`
- `services/attestation/src/fpc-immutables.ts`
- `services/attestation/test/server.test.ts`
- `contracts/fpc/src/main.nr`

### Verified current behavior

1. SDK is hardcoded to a single environment.
- `sdk/src/defaults.ts:1-33` fixes node URL, attestation URL, token/FPC/faucet/counter/operator addresses, gas limits, and timeout.

2. SDK API is counter-specific, not generic.
- Public API only exports `createSponsoredCounterClient` (`sdk/src/index.ts:1-11`).
- Type surface only supports `increment()` and counter-specific result fields (`sdk/src/types.ts:4-21`).
- Runtime flow always executes `counter.methods.increment(user)` (`sdk/src/client.ts:113-122`).

3. SDK assumes a fixed set of contracts/artifacts.
- `sdk/src/internal/contracts.ts:58-63` hardcodes token/fpc/faucet/counter artifact list.
- `resolveRuntimeAddresses` always pulls addresses from defaults (`sdk/src/internal/contracts.ts:114-125`).
- Node URL is fixed via defaults (`sdk/src/internal/contracts.ts:207-208`).

4. SDK quote flow is URL+`/quote` only; it does not discover accepted tokens.
- Quote URL builder always appends `/quote` and requires `accepted_asset` as caller input (`sdk/src/internal/quote.ts:20-35`).
- Current caller always uses default token from attached context (`sdk/src/client.ts:58-63`).

5. Attestation service already supports multi-asset quoting.
- `/quote` validates selected `accepted_asset` against configured `supported_assets` (`services/attestation/src/server.ts:395-420`).
- Config resolves `supported_assets` with per-asset policy and validation (`services/attestation/src/config.ts:437-491`).

6. Attestation discovery already exposes `supported_assets`, but there is no dedicated plural token endpoint.
- `/.well-known/fpc.json` returns `supported_assets` (`services/attestation/src/server.ts:294-308`).
- Existing `/asset` endpoint returns only single legacy `accepted_asset_*` (`services/attestation/src/server.ts:318-321`).

7. On-chain FPC contract supports per-quote asset selection.
- `fee_entrypoint(accepted_asset, ...)` takes accepted asset as argument (`contracts/fpc/src/main.nr:73-80`).
- Quote hash binds `accepted_asset` (`contracts/fpc/src/main.nr:135-143`).

8. Attestation startup verification still requires `accepted_asset` input for legacy hash compatibility.
- Startup path passes `acceptedAsset` into immutable verification (`services/attestation/src/index.ts:63-85`).
- Verifier computes both v2 and legacy constructor hashes (`services/attestation/src/fpc-immutables.ts:125-134`).

9. SDK sponsorship path is bound to one default FPC address today, while ABI assumptions are fixed.
- FPC address currently resolves from defaults (`sdk/src/internal/contracts.ts:120`, `sdk/src/defaults.ts:6-27`).
- Sponsorship call shape uses fixed `fee_entrypoint(...)` ABI (`sdk/src/internal/fee-payment.ts:30-37`, `sdk/src/internal/fee-payment.ts:74-83`).

### Manual validation run

Commands run:

```bash
# Attestation tests including discovery/multi-asset/unsupported accepted_asset behavior
cd services/attestation
bun run test -- --test-name-pattern "returns wallet discovery metadata|returns configured multi-asset discovery metadata|returns accepted asset metadata|returns 400 for unsupported accepted_asset"

# SDK tests showing counter/quote assumptions are current baseline
cd sdk
bun run test test/quote.test.ts test/increment.test.ts
```

Result: all targeted tests passed.

### Assumptions eliminated

- Not assuming contract is single-asset: contract and server both support multi-asset quote selection.
- Not assuming service lacks discoverability: discovery already has `supported_assets`; gap is SDK consumption and dedicated accepted-tokens endpoint.
- Not assuming SDK is parameterized: it is currently fixed to one contract set and one call shape.

---

## Requirements (Compressing Intent)

### Functional requirements

R1. SDK must allow caller-provided `attestationBaseUrl` per client instance.

R2. SDK must support selecting accepted token dynamically from attestation service metadata.
- Support explicit token selection by address.
- Support strategy-based selection (default/first/filter callback).

R3. SDK must support arbitrary target contract calls (not only `Counter.increment`).
- Caller provides call builder/executor.
- SDK injects sponsorship fee configuration and returns generic receipt + sponsorship metadata.

R4. SDK must support caller-provided contract bindings/artifacts and addresses for:
- FPC
- accepted token contract
- optional faucet (for private-balance bootstrap)
- any target contract(s)

R4.a FPC ABI remains fixed; agnosticism requirement is for on-chain FPC address and deployment instance.
- SDK must not silently pin a single network-specific FPC address.
- SDK must accept explicit FPC address input and/or resolve it from attestation discovery (`fpc_address`) when caller opts in.

R5. Attestation service must expose a dedicated endpoint for accepted tokens list.
- Endpoint returns all currently supported assets.
- SDK should use this endpoint when available.
- Discovery endpoint should advertise the new endpoint.

R6. Backward compatibility must be preserved initially.
- `createSponsoredCounterClient` remains available as a thin wrapper over the generic API.
- `/asset` endpoint remains for compatibility while new endpoint is introduced.

R7. Quote validation must remain strict.
- Must verify returned `accepted_asset` and `fj_amount` against requested values.
- Must validate signature format/length.

R8. Existing security controls remain intact.
- `/quote` auth and rate-limit behavior unchanged.
- New token-discovery endpoint should be read-only and safe without quote auth.

### Non-functional requirements

N1. No hidden defaults required for production use; defaults can exist only as optional convenience.

N2. Errors remain typed/stable for caller branching.

N3. Tests must cover both compatibility path (legacy counter client) and agnostic path.

N4. Documentation must clearly separate:
- generic API
- legacy convenience API
- token-discovery behavior and fallback order

---

## Implementation Plan (Exact Steps + Validation + Failure Modes)

### Step 1: Add accepted-tokens endpoint in attestation service

Status: [x] Completed on 2026-03-05.

Files:
- `services/attestation/src/server.ts`
- `services/attestation/test/server.test.ts`

Changes:
1. Add `GET /accepted-assets` returning array from `config.supported_assets` (address + name).
2. Add endpoint entry to discovery response (`/.well-known/fpc.json`) under `endpoints.accepted_assets`.
3. Keep existing `/asset` unchanged for backward compatibility.

Validation:
- Add/adjust tests in `services/attestation/test/server.test.ts`:
  - returns accepted-assets list
  - discovery includes `endpoints.accepted_assets`
  - `/asset` still returns single legacy object
- Run:
```bash
cd services/attestation
bun run test
```

Failure modes made explicit:
- If endpoint path mismatches discovery field, SDK fallback will be triggered.
- If endpoint accidentally includes pricing internals, public API contract broadens unintentionally.

### Step 2: Introduce SDK attestation discovery client

Status: [x] Completed on 2026-03-05.

Files:
- `sdk/src/internal/quote.ts` (or split into `internal/attestation-discovery.ts` + `internal/quote.ts`)
- `sdk/src/types.ts`
- `sdk/test/quote.test.ts` (or new discovery test file)

Changes:
1. Add discovery fetch flow:
- fetch `/.well-known/fpc.json`
- resolve token-list endpoint via `endpoints.accepted_assets`
- resolve `fpc_address` for optional SDK-side defaulting when caller does not pass explicit FPC address
- fallback order:
  1) new `/accepted-assets` endpoint
  2) `supported_assets` from discovery payload
  3) legacy `/asset` single entry
2. Add typed DTOs for discovery and accepted-assets payload.
3. Add token selection helper (`selectAcceptedAsset`) that supports:
- explicit address
- default first-supported
- caller strategy callback

Validation:
- Unit tests for each fallback path and malformed payload handling.
- Keep quote validation tests passing.
- Run:
```bash
cd sdk
bun run test
```

Failure modes:
- 404/invalid discovery JSON.
- Empty accepted-assets list.
- caller-selected token not supported.
- discovery `fpc_address` missing/invalid when caller expects discovery-driven FPC resolution.

### Step 3: Generalize SDK runtime configuration and contract attachment

Status: [x] Completed on 2026-03-05.

Files:
- `sdk/src/defaults.ts`
- `sdk/src/internal/contracts.ts`
- `sdk/src/types.ts`

Changes:
1. Replace hard dependency on `SDK_DEFAULTS` in attach flow with explicit input config.
2. Introduce config types for:
- node URL
- fpc address + artifact
- operator address
- accepted token artifact/address (selected at runtime)
- optional faucet artifact/address
- optional target contract registrations
3. Make FPC address source explicit:
- either caller-provided FPC address
- or discovery-resolved `fpc_address` (from Step 2), with deterministic precedence rules.
4. Keep defaults as optional helper factory for devnet convenience only.

Validation:
- Add tests verifying user-provided addresses/artifacts are used and defaults are not forced.
- Run `bun run test` in `sdk`.

Failure modes:
- Missing artifact for a required registered contract.
- address parse failures from caller inputs.
- ambiguous FPC address source precedence causing mismatched quote/fee payer target.

### Step 4: Introduce generic sponsored execution API

Files:
- `sdk/src/client.ts`
- `sdk/src/types.ts`
- `sdk/src/index.ts`
- `sdk/test/increment.test.ts` (plus new generic execution tests)

Changes:
1. Add generic API (example shape):
```ts
executeSponsoredCall<T>(input: {
  wallet: AccountWallet;
  account: AztecAddress | string;
  sponsorship: SponsorshipConfig;
  buildCall: (ctx: SponsoredCallContext) => Promise<{ send(args: SendArgs): Promise<T> }>;
  postChecks?: (ctx: SponsoredPostCheckContext<T>) => Promise<void>;
}): Promise<SponsoredExecutionResult<T>>
```
2. Keep existing sponsorship core:
- FeeJuice sufficiency check
- quote fetch/validate
- authwit + `fee_entrypoint` payload generation
3. Make target call fully caller-defined via `buildCall`.

Validation:
- New tests for arbitrary mock target calls.
- Ensure old `increment` behavior still works via wrapper.

Failure modes:
- `buildCall` returns invalid interaction object.
- caller post-check throws (surface as typed error with context).

### Step 5: Rebuild legacy counter client on top of generic API

Files:
- `sdk/src/client.ts`
- `sdk/src/index.ts`
- `sdk/test/increment.test.ts`

Changes:
1. Implement `createSponsoredCounterClient` as convenience wrapper that maps into generic API.
2. Keep returned fields currently used by consumers (`counterBefore`, `counterAfter`, `expectedCharge`, etc.).

Validation:
- Existing increment tests stay green with minimal rewrites.
- Add one test asserting wrapper delegates to generic flow.

Failure modes:
- Wrapper drift where counter-specific invariants diverge from prior behavior.

### Step 6: Docs and migration notes

Files:
- `sdk/README.md`
- `services/attestation/README.md`
- `services/attestation/config.example.yaml`

Changes:
1. Document new SDK generic API + token selection behavior.
2. Document new `/accepted-assets` endpoint and discovery field.
3. Mark `/asset` as legacy compatibility endpoint.
4. Provide migration examples from `createSponsoredCounterClient` to generic `executeSponsoredCall`.

Validation:
- Manually execute example snippets against typecheck.
- Run:
```bash
cd sdk && bun run typecheck
cd services/attestation && bun run typecheck
```

Failure modes:
- Docs mention endpoint names that do not match implementation.

---

## Delivery sequencing

1. Service endpoint + tests.
2. SDK discovery/token selection.
3. SDK config + generic execution API.
4. Legacy wrapper compatibility.
5. Docs + migration notes.

This order keeps the system shippable at each stage and enables early integration testing once Step 2 lands.

## Exit criteria

- SDK can run sponsored tx with caller-provided attestation URL, FPC address, token, contracts, and call builder.
- SDK can also resolve FPC address from attestation discovery when configured to do so.
- SDK can discover accepted tokens from attestation service without hardcoded token address.
- Attestation service has an explicit accepted-tokens endpoint and discovery advertises it.
- Legacy `createSponsoredCounterClient` remains functional.
- Full test suites pass for `sdk` and `services/attestation`.
