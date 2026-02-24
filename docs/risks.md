# FPC Risk Register

These are AI generated and indicative

## Scope

This register captures the key risks for the current private-only, single-asset FPC design and implementation.

## Risks

| Risk | Likelihood | Impact | Why it matters | Mitigation |
|---|---|---|---|---|
| Top-up monitor reads wrong FeeJuice address / balance | Medium | High | If balance reads fail or are wrong, top-ups may not trigger and the FPC can run out of FeeJuice. | Fix FeeJuice address discovery and remove invalid fallback behavior in `services/topup/src/monitor.ts`; add tests against real node info shape. |
| L1 bridge chain hardcoded to mainnet | Medium | High | Bridge calls can fail or route incorrectly on testnet/local deployments. | Make chain ID/network explicit config in `services/topup/src/bridge.ts` and validate at startup. |
| Single immutable operator key (no on-chain rotation) | Low | High | The same key signs quotes and receives all private fee revenue; compromise requires contract redeploy. | Use KMS/HSM-backed key management, short quote TTL, compromise runbook, and planned redeploy procedure. |
| Same-user quote replay within validity window | Medium | Medium | User-specific quotes prevent cross-user replay but can still be reused by the same user until expiry. | Keep `quote_validity_seconds` short (for example <= 5 minutes); optionally track per-user nonce usage off-chain. |
| Private revenue/accounting operational burden | Medium | Medium | Fees arrive as private notes; operator must reliably discover notes and reconcile accounting off-chain. | Operate stable PXE/indexing, automate reconciliation, and add daily completeness checks and alerts. |
| Wallet authwit mismatch from gas-setting drift | Medium | Medium | Wallet must precompute charge for token authwit; if tx gas settings differ, fee auth fails. | Standardize client gas-setting policy, expose SDK helper for exact charge computation, and add integration tests for mismatch scenarios. |
| Quote API leaks user addresses at service layer | Medium | Medium | `/quote?user=...` plus request logs can expose address metadata even if on-chain transfer is private. | Redact query params in logs, minimize retention, and consider POST body transport for user address. |

## References

- `contracts/multi_asset_fpc/src/main.nr`
- `services/attestation/src/server.ts`
- `services/topup/src/monitor.ts`
- `services/topup/src/bridge.ts`
- `docs/spec.md`
