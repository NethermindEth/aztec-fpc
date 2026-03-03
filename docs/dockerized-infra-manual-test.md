# Dockerized Infra Manual Test (User Actions Only)

This guide is a copy/paste sequence for:
- running dockerized infra with `bun run compose:infra`
- validating sponsored transactions via `FPC.fee_entrypoint(...)` in [main.nr](/home/ametel/source/aztec-fpc/contracts/fpc/src/main.nr)
- deploying `CreditFPC` as well (so it is not missing from your deployment set)

Run everything from repo root:

```bash
cd /home/ametel/source/aztec-fpc
set -euo pipefail
```

## 1. Clean Start

```bash
docker compose down -v --remove-orphans || true
```

## 2. Build Fresh Local Images

Do this to avoid stale container code.

```bash
bun run docker:build
```

## 3. Start Infra (Default: deploys FPC + CreditFPC)

```bash
bun run compose:infra -- -d
docker compose ps
```

`deploy` now defaults to `PXE_PROVER=wasm` with a persistent CRS cache volume (`deploy-crs-cache`) to avoid native-prover CRS download failures.

Wait for core endpoints:

```bash
for i in $(seq 1 90); do
  curl -fsS http://localhost:3000/health >/dev/null && \
  curl -fsS http://localhost:3001/health >/dev/null && \
  curl -fsS http://localhost:3001/ready >/dev/null && break
  sleep 2
done
```

## 4. Check Deployment Output

```bash
node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync("configs/deploy-manifest.json","utf8")); console.log(JSON.stringify({status:m.status, fpc:m.fpc_address ?? m.contracts?.fpc, credit_fpc:m.credit_fpc_address ?? m.contracts?.credit_fpc ?? null, accepted_asset:m.accepted_asset ?? m.contracts?.accepted_asset}, null, 2));'
```

Expected: both `fpc` and `credit_fpc` are non-null.

## 5. Deploy Behavior In Compose

`deploy` service in `docker-compose.yaml` now defaults to:

```yaml
FPC_VARIANT: "${FPC_VARIANT:-both}"
```

Override examples:

```bash
# only FPC
FPC_VARIANT=fpc bun run compose:infra -- -d

# only CreditFPC
FPC_VARIANT=credit bun run compose:infra -- -d

# if you explicitly want native prover (not recommended for flaky networks)
PXE_PROVER=native bun run compose:infra -- -d
```

## 6. Deploy Mock Counter Contract

This repo now includes a mock counter Noir package at:
- [mock/counter/src/main.nr](/home/ametel/source/aztec-fpc/mock/counter/src/main.nr)

Deploy it with the manual helper script and capture the deployed address:

```bash
cd /home/ametel/source/aztec-fpc
aztec compile --workspace --force

COUNTER_ADDRESS="$(
  bunx tsx ./scripts/manual-fpc-sponsored-user-tx.ts --deploy-counter-only \
    | awk -F= '/^counter=/{print $2}' \
    | tail -n1
)"

echo "counter=$COUNTER_ADDRESS"
test -n "$COUNTER_ADDRESS"
```

Note:
- the helper script defaults to ephemeral embedded-wallet state (`EMBEDDED_WALLET_EPHEMERAL=1`) to avoid stale-anchor errors after node restarts.
- set `EMBEDDED_WALLET_EPHEMERAL=0` only if you explicitly want persistent wallet/PXE local state.
- if you need to manually force local block progression, run:
  - `bunx tsx ./scripts/advance-local-network-blocks.ts`

## 7. Reproduce Sponsored User Tx Against Counter (No Repo Smoke Scripts)

Goal:
- execute a normal user call (`y.x()`) = `Counter.increment(...)`
- pay fees via `FPC.fee_entrypoint(...)`
- have protocol Fee Juice charged to `fpc_address`
- while waiting for topup, the script auto-advances local blocks using [advance-local-network-blocks.ts](/home/ametel/source/aztec-fpc/scripts/advance-local-network-blocks.ts)

Important CLI note:
- `aztec-wallet send --payment method=fpc-private|fpc-public` targets the canonical paymaster ABI (`fee_entrypoint_private/public`), not this repo's custom `FPCMultiAsset.fee_entrypoint(...)`.
- so for this repo's FPC, use the dedicated manual script:
  - [manual-fpc-sponsored-user-tx.ts](/home/ametel/source/aztec-fpc/scripts/manual-fpc-sponsored-user-tx.ts)

Run:

```bash
cd /home/ametel/source/aztec-fpc
MOCK_COUNTER_ADDRESS="$COUNTER_ADDRESS" \
bunx tsx ./scripts/manual-fpc-sponsored-user-tx.ts
```

Optional overrides:

```bash
AZTEC_NODE_URL=http://localhost:8080 \
QUOTE_BASE_URL=http://localhost:3000 \
EMBEDDED_WALLET_EPHEMERAL=1 \
MOCK_COUNTER_ADDRESS="$COUNTER_ADDRESS" \
RELAY_ADVANCE_BLOCKS=2 \
RELAY_ADVANCE_EVERY_POLLS=5 \
DA_GAS_LIMIT=1000000 \
L2_GAS_LIMIT=1000000 \
bunx tsx ./scripts/manual-fpc-sponsored-user-tx.ts
```

Expected terminal output includes:
- `PASS: sponsored Counter.increment tx via FPCMultiAsset fee_entrypoint`
- `tx_fee_juice=...`
- matching `expected_charge`, `user_debited`, and `operator_credited`
- `counter_before=...` and `counter_after=...` where `counter_after = counter_before + 1`

If you see `FPC Fee Juice balance is still zero ...`:
- wait for topup to bridge and claim Fee Juice, then rerun Step 7
- verify topup readiness with `curl -fsS http://localhost:3001/ready`
- optionally force relay progress with `bunx tsx ./scripts/advance-local-network-blocks.ts`

## 8. Verify Quote Response Shape (No `rate_num` / `rate_den`)

```bash
TEST_USER='0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72'
ASSET="$(curl -fsS http://localhost:3000/asset | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c);process.stdin.on(\"end\",()=>process.stdout.write(JSON.parse(d).address));')"
QUOTE_JSON="$(curl -fsS \"http://localhost:3000/quote?user=${TEST_USER}&accepted_asset=${ASSET}&fj_amount=1000000\")"
echo "$QUOTE_JSON" | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c);process.stdin.on(\"end\",()=>{const q=JSON.parse(d); console.log(q); if(\"rate_num\" in q || \"rate_den\" in q){process.exit(1);} });'
```

If this fails, rebuild images again and restart:

```bash
docker compose down -v --remove-orphans || true
bun run docker:build
bun run compose:infra -- -d
```

## 9. Cleanup

```bash
docker compose down -v --remove-orphans
```
