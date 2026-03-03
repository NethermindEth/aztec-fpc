# FPC Chaos / Adversarial Test Suite

This folder contains the **FPC chaos and adversarial test suite**: scripted tests that exercise the Fee Payment Contract (FPC), attestation service, and topup service under edge cases and adversarial conditions. They are intended for local development, CI, and validation of **deployed** endpoints (e.g. after an AWS deploy).

## What gets tested

- **API** – HTTP surface of the attestation (and optionally topup) service: health, `/asset`, `/quote` validation, bad inputs, rate limiting, auth (when configured).
- **On-chain** – Quote replay, expiry, signature binding, teardown gas, authwit mismatches, wrong FPC/asset in quote, etc., against a live Aztec node and deployed FPC.
- **Stress** – Sequential fee-paid transactions and quote burst consistency (in `full` mode).

Test modes:

| Mode      | What runs                          | Use case                          |
|-----------|------------------------------------|-----------------------------------|
| `api`     | API tests only                     | Safe against any endpoint (incl. prod) |
| `onchain` | API + on-chain security tests      | Node + operator key + FPC required    |
| `full`    | API + on-chain + stress tests      | Full validation (local or staging)     |

---

## Running the tests

### 1. Self-contained local run (recommended)

Deploys contracts, starts attestation and topup, funds the FPC via the bridge, then runs the full suite. No manual env or manifest needed.

```bash
# From repo root
bun run chaos:local
```

Optional env (defaults are fine for a fresh local network):

- `FPC_CHAOS_LOCAL_START_NETWORK=1` (default) – start Aztec local network automatically. Set to `0` if you already have a node + anvil.
- `FPC_CHAOS_LOCAL_CHAOS_MODE=full` (default) – use `api` or `onchain` to run a subset.
- `FPC_CHAOS_LOCAL_REPORT_PATH=/path/to/report.json` – write JSON report to a file.

Requires: `aztec`, `bun`, `node` in `PATH`.

---

### 2. Against a deployed endpoint (e.g. devnet / AWS)

Use the **manifest** so addresses and node URL come from a single file. For the reference devnet deployment, the manifest is:

- **Manifest:** [`deployments/devnet-manifest-v2.json`](../../deployments/devnet-manifest-v2.json)  
  (see also [AWS deployment guide](../../docs/services-aws-deployment-guide.md))

#### API-only (safe for production)

No operator secret; only hits attestation (and optionally topup) HTTP APIs. Use this against live devnet or production attestation/topup URLs.

```bash
# From repo root – attestation URL is required
export FPC_CHAOS_ATTESTATION_URL="https://<your-attestation-host>"
export FPC_CHAOS_MANIFEST="./deployments/devnet-manifest-v2.json"

bun run chaos:api
```

If the deployed attestation uses API key or trusted-header auth:

```bash
export FPC_CHAOS_QUOTE_AUTH_API_KEY="<your-api-key>"
# or
export FPC_CHAOS_QUOTE_AUTH_HEADER="x-your-header"
export FPC_CHAOS_QUOTE_AUTH_VALUE="<secret-value>"

bun run chaos:api
```

Optional: set `FPC_CHAOS_TOPUP_URL="https://<your-topup-host>"` to run topup health/ready checks.

#### On-chain or full (devnet / staging)

Requires the **operator secret key** (same key that backs the attestation signer) and a reachable Aztec node. The manifest supplies `fpc_address`, `accepted_asset`, `operator_address`, and `aztec_node_url`; you only need to set the attestation/topup URLs and operator secret.

```bash
export FPC_CHAOS_MODE=onchain   # or full
export FPC_CHAOS_ATTESTATION_URL="https://<your-attestation-host>"
export FPC_CHAOS_TOPUP_URL="https://<your-topup-host>"
export FPC_CHAOS_MANIFEST="./deployments/devnet-manifest-v2.json"
export FPC_CHAOS_OPERATOR_SECRET_KEY="0x<hex>"

bun run chaos:onchain   # or: bun run chaos:full
```

For **devnet**, the manifest already contains the correct node URL and contract addresses; you only need to point `FPC_CHAOS_ATTESTATION_URL` (and optionally `FPC_CHAOS_TOPUP_URL`) at your deployed services and provide the operator key.

---

### 3. Against an already-running local setup

If you started the Aztec network and services yourself (e.g. attestation on 3000, topup on 3001, node on 8080), run the suite without the local orchestrator:

```bash
export FPC_CHAOS_MODE=full
export FPC_CHAOS_ATTESTATION_URL="http://localhost:3000"
export FPC_CHAOS_TOPUP_URL="http://localhost:3001"
export FPC_CHAOS_NODE_URL="http://127.0.0.1:8080"
export FPC_CHAOS_MANIFEST="./deployments/devnet-manifest-v2.json"
export FPC_CHAOS_OPERATOR_SECRET_KEY="0x<hex>"

bun run chaos:full
```

You can omit the manifest and set addresses explicitly:

```bash
export FPC_CHAOS_FPC_ADDRESS="0x..."
export FPC_CHAOS_ACCEPTED_ASSET="0x..."
# ... and FPC_CHAOS_OPERATOR_SECRET_KEY, FPC_CHAOS_NODE_URL
```

---

## npm/bun scripts (from repo root)

| Command          | Description |
|------------------|-------------|
| `bun run chaos:local`  | Self-contained: start network (optional), deploy, start services, fund FPC, run full suite. |
| `bun run chaos:api`    | Run API-only tests (env: `FPC_CHAOS_ATTESTATION_URL` + optional manifest). |
| `bun run chaos:onchain`| Run API + on-chain tests (requires node, operator key, manifest or addresses). |
| `bun run chaos:full`   | Run API + on-chain + stress tests. |

---

## Files in this folder

| File                    | Purpose |
|-------------------------|---------|
| `fpc-chaos-test.ts`     | Main test suite (API, on-chain, stress). Consumed by the shell wrapper and by `fpc-chaos-local.ts`. |
| `fpc-chaos-test.sh`     | Shell wrapper: optional local network startup, compile, then runs `fpc-chaos-test.ts` with `FPC_CHAOS_*` env. |
| `fpc-chaos-local.sh`    | Local bootstrap: start Aztec network (optional), compile, build services, then run `fpc-chaos-local.ts`. |
| `fpc-chaos-local.ts`    | Orchestrator: deploy FPC + token, start attestation + topup, wait for FPC funding, then run `fpc-chaos-test.ts`. |

---

## Environment variables (summary)

- **Required for all:** `FPC_CHAOS_ATTESTATION_URL`
- **For onchain/full:** `FPC_CHAOS_NODE_URL`, `FPC_CHAOS_FPC_ADDRESS`, `FPC_CHAOS_ACCEPTED_ASSET`, `FPC_CHAOS_OPERATOR_SECRET_KEY` (or use `FPC_CHAOS_MANIFEST` to supply addresses and node URL)
- **Optional:** `FPC_CHAOS_TOPUP_URL`, `FPC_CHAOS_MANIFEST`, `FPC_CHAOS_REPORT_PATH`, `FPC_CHAOS_FAIL_FAST=1`, `FPC_CHAOS_MODE`, tuning vars (see header of `fpc-chaos-test.ts`)

Full list and defaults are in the comment block at the top of `fpc-chaos-test.ts`.

---

## Deployment reference

- **Manifest (devnet):** [`deployments/devnet-manifest-v2.json`](../../deployments/devnet-manifest-v2.json) – node URL, FPC, accepted asset, operator address.
- **AWS / production:** [`docs/services-aws-deployment-guide.md`](../../docs/services-aws-deployment-guide.md) – how attestation and topup are deployed and configured; use the same manifest (or your own) when pointing chaos tests at those endpoints.
