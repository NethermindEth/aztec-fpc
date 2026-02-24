# FPC Implementation Plan

> **For:** Engineering team
> **Scope:** Alpha deployment — FPC contract + Attestation Service + Top-up Service
> **Reference:** [spec.md](spec.md)

---

## Personnel

| Role | Count | Responsibilities |
|---|---|---|
| **Aztec Engineer** | 1 | Contract compilation + testing, aztec.js integration, authwit signing verification |
| **Backend Engineer** | 1 | TypeScript services, L1 bridge integration, deployment scripting |

Minimum viable: 2 engineers. Tasks in Phase 2 can run in parallel to save calendar time.

---

## Phases

### Phase 1 — Contract (Aztec Engineer, ~1 week)

| Task | Notes |
|---|---|
| Compile `FPC` against local aztec-packages | Verify Nargo.toml path deps, resolve any API diffs from reference contracts |
| Unit tests for `fee_juice_to_asset` (rate math, overflow, ceiling div) | Critical — test edge cases (zero fee, max u128, fee_bips at extremes) |
| Integration test `fee_entrypoint` on local devnet | Deploy token mock + FPC; run one tx, verify operator receives private note |
| **Deliverable:** Contract compiles + payment flow passes on devnet | |

### Phase 2 — Services (Backend Engineer, ~1 week, parallel with Phase 1)

| Task | Notes |
|---|---|
| Verify authwit signing API in `signer.ts` against actual aztec.js version | `computeInnerAuthWitHash` import path + `wallet.createAuthWit` signature — flagged in code as a verification point |
| Wire up attestation service to local devnet; test `GET /quote` → tx submission | End-to-end: quote → user tx with the returned authwit |
| Verify Fee Juice balance read in `monitor.ts` | `pxe.getBalance` API for Fee Juice — fallback path in code needs to be resolved |
| Locate `FeeJuicePortal` ABI and address from deployment manifest; test bridge call on testnet | `bridge.ts` uses a minimal ABI stub — swap for full artifact from `@aztec/l1-artifacts` if available |
| **Deliverable:** Both services start, connect to devnet, and produce/consume valid quotes | |

### Phase 3 — End-to-end Integration (~3 days, both engineers)

| Task | Notes |
|---|---|
| Deploy FPC + run both services against Aztec testnet | Use real humanUSDC portal token address |
| Test top-up trigger: drain FPC Fee Juice below threshold, confirm auto-bridge fires | |
| Test quote expiry: submit quote after `valid_until`, confirm tx rejected | |
| **Deliverable:** Full stack running on testnet | |

### Phase 4 — Hardening (~3 days, Aztec Engineer lead)

| Task | Notes |
|---|---|
| Internal security review of contract | Focus: overflow paths, authwit binding, quote replay window |
| Replace TODO stubs | KMS integration comments, Fee Juice balance fallback, bridge confirmation polling |
| Write operator runbook | How to monitor balance, respond to top-up failure, redeploy if key compromised |
| **Deliverable:** Documented, reviewable codebase ready for external operator (Raven House) | |

---

## Open Questions (need resolution before Phase 1 can close)

| # | Question | Owner |
|---|---|---|
| 1 | What is the exact `computeInnerAuthWitHash` import path for this aztec-packages version? (flagged in `signer.ts`) | Aztec Engineer |
| 2 | What is the deployed `FeeJuicePortal` address on testnet, and is the ABI in `@aztec/l1-artifacts`? | Backend Engineer |
| 3 | What is the correct API for reading the FPC's Fee Juice balance from the PXE? (`monitor.ts` has a fallback stub) | Aztec Engineer |
| 4 | What is the `OPERATOR_ADDRESS` exposure story for wallet SDK integration? (wallets need it to build the token transfer authwit) | Protocol/Ops |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| aztec.js authwit API differs from what's coded | Medium | Medium — service rewrite, contract unaffected | Resolve Q1 in Phase 2 day 1 |
| Top-up bridge fails silently | Low | High — FPC runs dry | Phase 4: add alerting on bridge failure (Slack/PagerDuty hook in `index.ts`) |
| Operator key leaked | Low | High — key rotation requires redeployment | Use KMS in production; monitor for unauthorized quotes |

---

## Not in Scope (Alpha)

- On-chain oracle / zkTLS price feeds
- Key rotation without redeployment (both fields are `PublicImmutable`)
- Exact/refund payment flows (no teardown, no refunds)
- Multi-asset support (single `accepted_asset` fixed at deploy)
- Multi-operator attestation service
- Persistent rate storage (in-memory only; restart reloads config)
- Automated L2 bridge confirmation (fixed sleep cooldown)
