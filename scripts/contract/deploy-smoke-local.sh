#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-smoke-local.XXXXXX")"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"
source "$REPO_ROOT/scripts/common/local-network.sh"

resolve_default_fpc_artifact() {
  if [[ -n "${FPC_FPC_ARTIFACT:-}" ]]; then
    printf "%s\n" "${FPC_FPC_ARTIFACT}"
    return
  fi

  local multi_asset_path="$REPO_ROOT/target/fpc-FPCMultiAsset.json"
  local legacy_path="$REPO_ROOT/target/fpc-FPC.json"
  if [[ -f "$multi_asset_path" ]]; then
    printf "%s\n" "$multi_asset_path"
    return
  fi
  if [[ -f "$legacy_path" ]]; then
    printf "%s\n" "$legacy_path"
    return
  fi
  printf "%s\n" "$multi_asset_path"
}

function cleanup() {
  local node_port="${NODE_PORT:-${FPC_DEPLOY_SMOKE_NODE_PORT:-8080}}"
  local l1_port="${L1_PORT:-${FPC_DEPLOY_SMOKE_L1_PORT:-8545}}"
  local attestation_port="${FPC_SERVICES_SMOKE_ATTESTATION_PORT:-3300}"
  local topup_ops_port="${FPC_SERVICES_SMOKE_TOPUP_OPS_PORT:-3401}"

  localnet_stop_started "[deploy-smoke]"
  test_cleanup_kill_listener_ports \
    "[deploy-smoke]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port" \
    3000 \
    3001
  test_cleanup_reset_state "[deploy-smoke]" "$REPO_ROOT"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for cmd in aztec bun node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[deploy-smoke] ERROR: missing required command '$cmd'" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"

NODE_HOST="${FPC_DEPLOY_SMOKE_NODE_HOST:-127.0.0.1}"
NODE_PORT="${FPC_DEPLOY_SMOKE_NODE_PORT:-8080}"
L1_HOST="${FPC_DEPLOY_SMOKE_L1_HOST:-127.0.0.1}"
L1_PORT="${FPC_DEPLOY_SMOKE_L1_PORT:-8545}"
START_LOCAL_NETWORK="${FPC_DEPLOY_SMOKE_START_LOCAL_NETWORK:-1}"
STARTUP_TIMEOUT_SECONDS="$(
  localnet_resolve_timeout_seconds \
    "${FPC_DEPLOY_SMOKE_STARTUP_TIMEOUT_SECONDS:-${FPC_LOCAL_NETWORK_STARTUP_TIMEOUT_SECONDS:-}}" \
    "90" \
    "FPC_DEPLOY_SMOKE_STARTUP_TIMEOUT_SECONDS or FPC_LOCAL_NETWORK_STARTUP_TIMEOUT_SECONDS" \
    "[deploy-smoke]"
)"

NODE_RUNNING=0
L1_RUNNING=0
if localnet_has_port "$NODE_HOST" "$NODE_PORT"; then
  NODE_RUNNING=1
fi
if localnet_has_port "$L1_HOST" "$L1_PORT"; then
  L1_RUNNING=1
fi

RESET_LOCAL_STATE="$(
  localnet_resolve_reset_state_flag \
    "${FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE:-}" \
    "if-starting" \
    "$START_LOCAL_NETWORK" \
    "$NODE_RUNNING" \
    "$L1_RUNNING" \
    "FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE" \
    "[deploy-smoke]"
)"
if [[ "$RESET_LOCAL_STATE" == "1" ]]; then
  echo "[deploy-smoke] Resetting wallet/PXE local state"
  localnet_reset_wallet_pxe_state "$REPO_ROOT"
fi

if ! localnet_start_or_reuse \
  "[deploy-smoke]" \
  "$START_LOCAL_NETWORK" \
  "$NODE_HOST" \
  "$NODE_PORT" \
  "$L1_HOST" \
  "$L1_PORT" \
  "$TMP_DIR/aztec-local-network.log" \
  "$STARTUP_TIMEOUT_SECONDS"; then
  exit 1
fi

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[deploy-smoke] Installing workspace dependencies"
  bun install
fi

echo "[deploy-smoke] Compiling contracts workspace"
aztec compile --workspace --force

DEPLOY_OUTPUT="${FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT:-$TMP_DIR/deploy-fpc-local.json}"
AZTEC_NODE_URL="http://${NODE_HOST}:${NODE_PORT}"
L1_RPC_URL="http://${L1_HOST}:${L1_PORT}"
FPC_ARTIFACT="$(resolve_default_fpc_artifact)"
# Defaults use sandbox test account 0 (well-known keys from aztec local devnet TEST_ACCOUNTS)
OPERATOR_SECRET_KEY="${FPC_LOCAL_OPERATOR_SECRET_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"
DEPLOYER_PRIVATE_KEY="${FPC_LOCAL_DEPLOYER_PRIVATE_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"
DEPLOYER_ALIAS="${FPC_LOCAL_DEPLOYER_ALIAS:-test0}"

echo "[deploy-smoke] Running local deploy command (variant-specific FPC)"
cmd=(
  bunx tsx "$REPO_ROOT/scripts/contract/deploy-fpc-devnet.ts"
  --environment local
  --node-url "$AZTEC_NODE_URL"
  --l1-rpc-url "$L1_RPC_URL"
  --deployer-alias "$DEPLOYER_ALIAS"
  --deployer-private-key "$DEPLOYER_PRIVATE_KEY"
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

echo "[deploy-smoke] Running relay-aware local smoke checks"
bunx tsx "$REPO_ROOT/scripts/contract/devnet-postdeploy-smoke.ts" \
  --manifest "$DEPLOY_OUTPUT" \
  --l1-rpc-url "$L1_RPC_URL" \
  --operator-secret-key "$OPERATOR_SECRET_KEY" \
  --l1-operator-private-key "${FPC_DEPLOY_SMOKE_L1_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

echo "[deploy-smoke] PASS: full local deploy smoke flow succeeded"
