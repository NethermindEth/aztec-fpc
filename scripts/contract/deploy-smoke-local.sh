#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-smoke-local.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

resolve_default_fpc_artifact() {
  if [[ -n "${FPC_ARTIFACT:-}" ]]; then
    printf "%s\n" "${FPC_ARTIFACT}"
    return
  fi

  local multi_asset_path="$REPO_ROOT/target/fpc-FPCMultiAsset.json"
  if [[ -f "$multi_asset_path" ]]; then
    printf "%s\n" "$multi_asset_path"
    return
  fi
  printf "%s\n" "$multi_asset_path"
}

setup_require_cmds "[deploy-smoke]" aztec bun node
cd "$REPO_ROOT"

# Defer block-producer startup until after deployments complete to avoid
# transient anchor-hash races in wallet deploy simulation.
export NODESETUP_DISABLE_BLOCK_PRODUCER=1
setup_node \
  --log-prefix "[deploy-smoke]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[deploy-smoke] Installing workspace dependencies"
  bun install
fi

echo "[deploy-smoke] Compiling contracts workspace"
aztec compile --workspace --force

DEPLOY_OUTPUT="${FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT:-$TMP_DIR/deploy-fpc-local.json}"
FPC_ARTIFACT="$(resolve_default_fpc_artifact)"
# Defaults use sandbox test account 0 (well-known keys from aztec local devnet TEST_ACCOUNTS)
OPERATOR_SECRET_KEY="${FPC_LOCAL_OPERATOR_SECRET_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"
DEPLOYER_SECRET_KEY="${FPC_LOCAL_DEPLOYER_SECRET_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"
DEPLOYER_ALIAS="${FPC_LOCAL_DEPLOYER_ALIAS:-test0}"

# Local network can briefly return stale anchor hashes while blocks are advancing.
# Use more retries/backoff for wallet deploy/send steps to smooth transient failures.
export FPC_WALLET_DEPLOY_RETRIES="${FPC_WALLET_DEPLOY_RETRIES:-8}"
export FPC_WALLET_DEPLOY_RETRY_BACKOFF_MS="${FPC_WALLET_DEPLOY_RETRY_BACKOFF_MS:-3000}"
export FPC_WALLET_SEND_RETRIES="${FPC_WALLET_SEND_RETRIES:-8}"
export FPC_WALLET_SEND_RETRY_BACKOFF_MS="${FPC_WALLET_SEND_RETRY_BACKOFF_MS:-3000}"
echo "[deploy-smoke] wallet retry policy: deploy=${FPC_WALLET_DEPLOY_RETRIES}/${FPC_WALLET_DEPLOY_RETRY_BACKOFF_MS}ms send=${FPC_WALLET_SEND_RETRIES}/${FPC_WALLET_SEND_RETRY_BACKOFF_MS}ms"

echo "[deploy-smoke] Running local deploy command (variant-specific FPC)"
cmd=(
  bunx tsx "$REPO_ROOT/scripts/contract/deploy-fpc-devnet.ts"
  --node-url "$AZTEC_NODE_URL"
  --l1-rpc-url "$L1_RPC_URL"
  --deployer-alias "$DEPLOYER_ALIAS"
  --deployer-secret-key "$DEPLOYER_SECRET_KEY"
  --operator-secret-key "$OPERATOR_SECRET_KEY"
  --fpc-artifact "$FPC_ARTIFACT"
  --out "$DEPLOY_OUTPUT"
)
if [[ -n "${FPC_LOCAL_ACCEPTED_ASSET:-}" ]]; then
  cmd+=(--accepted-asset "${FPC_LOCAL_ACCEPTED_ASSET}")
fi
"${cmd[@]}"

if [[ ! -f "$DEPLOY_OUTPUT" ]]; then
  echo "[deploy-smoke] ERROR: deploy output was not generated at $DEPLOY_OUTPUT" >&2
  exit 1
fi

BP_SCRIPT="$REPO_ROOT/scripts/services/block-producer.sh"
if [[ -f "$BP_SCRIPT" ]]; then
  echo "[deploy-smoke] Starting block-producer after deploy phase"
  AZTEC_NODE_URL="$AZTEC_NODE_URL" BLOCK_PRODUCER_LOOP_SLEEP_SECONDS="${BLOCK_PRODUCER_LOOP_SLEEP_SECONDS:-2}" \
    bash "$BP_SCRIPT" >"$TMP_DIR/block-producer.log" 2>&1 &
  _NODESETUP_BLOCK_PRODUCER_PID=$!
  echo "[deploy-smoke] block-producer started (pid=$_NODESETUP_BLOCK_PRODUCER_PID)"
fi

echo "[deploy-smoke] Running relay-aware local smoke checks"
smoke_cmd=(
  bunx tsx "$REPO_ROOT/scripts/contract/devnet-postdeploy-smoke.ts"
  --manifest "$DEPLOY_OUTPUT"
  --l1-rpc-url "$L1_RPC_URL"
  --operator-secret-key "$OPERATOR_SECRET_KEY"
  --l1-operator-private-key "${FPC_DEPLOY_SMOKE_L1_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
)
if [[ -n "${_NODESETUP_BLOCK_PRODUCER_PID:-}" && "${FPC_DEPLOY_SMOKE_STOP_BLOCK_PRODUCER_AFTER_TOPUP:-0}" == "1" ]]; then
  smoke_cmd+=(--stop-block-producer-pid "$_NODESETUP_BLOCK_PRODUCER_PID")
fi
FPC_DEVNET_SMOKE_ALLOW_DEGRADED="${FPC_DEVNET_SMOKE_ALLOW_DEGRADED:-1}" "${smoke_cmd[@]}"

echo "[deploy-smoke] PASS: full local deploy smoke flow succeeded"
