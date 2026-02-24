# Codex Implementation Plan

## Implementation Plan (Concise)

Scope note: this MVP excludes all exact/refund payment flows. Only no-refund flows are in scope.

1. Stabilize Core Services (Week 1)
- Fix top-up FeeJuice address resolution logic.
- Remove hardcoded L1 mainnet assumption; make chain configurable.
- Add strict input validation for `POST /admin/rates`.
- Pin Aztec/SDK dependency versions and lockfiles.

2. Build Test Coverage (Weeks 2-3)
- Add contract + service integration tests for the 3 no-refund fee entrypoints.
- Cover quote expiry/replay, charge calculation correctness, and bridge trigger behavior.
- Add CI pipeline: compile, typecheck, lint, tests.

3. Operational Hardening (Week 4)
- Replace plaintext key handling with secrets manager/KMS integration.
- Add structured logging, metrics, alerts, and retry/backoff policies.
- Replace fixed bridge cooldown with real L1->L2 confirmation checks.
- Produce deployment/runbook docs.

4. Pilot and Production Readiness (Weeks 5-6)
- Run staging/pilot with real traffic patterns.
- Resolve defects and tune thresholds/rate operations.
- Final security review and go-live checklist.

## Estimated Personnel Required

1. Aztec/Noir Engineer (1 FTE)
2. Backend Engineer (1 FTE)
3. Protocol/Infra Engineer (1 FTE)
4. QA/SDET (0.5-1 FTE)
5. DevOps/SRE (0.5 FTE)

Total: ~4.0-4.5 FTE over 4-6 weeks for production-grade E2E completion.
