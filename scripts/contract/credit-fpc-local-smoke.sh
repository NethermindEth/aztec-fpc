#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/credit-fpc-local-smoke.XXXXXX")"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"
source "$REPO_ROOT/scripts/common/local-network.sh"

function cleanup() {
  local node_port="${NODE_PORT:-${CREDIT_FPC_SMOKE_NODE_PORT:-8080}}"
  local l1_port="${L1_PORT:-${CREDIT_FPC_SMOKE_L1_PORT:-8545}}"
  local attestation_port="${FPC_SERVICES_SMOKE_ATTESTATION_PORT:-3300}"
  local topup_ops_port="${FPC_SERVICES_SMOKE_TOPUP_OPS_PORT:-3401}"

  localnet_stop_started "[credit-smoke]"
  test_cleanup_kill_listener_ports \
    "[credit-smoke]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port" \
    3000 \
    3001
  test_cleanup_reset_state "[credit-smoke]" "$REPO_ROOT"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for cmd in aztec bun node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[credit-smoke] ERROR: missing required command '$cmd'" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"

NODE_HOST="${CREDIT_FPC_SMOKE_NODE_HOST:-127.0.0.1}"
NODE_PORT="${CREDIT_FPC_SMOKE_NODE_PORT:-8080}"
L1_HOST="${CREDIT_FPC_SMOKE_L1_HOST:-127.0.0.1}"
L1_PORT="${CREDIT_FPC_SMOKE_L1_PORT:-8545}"
START_LOCAL_NETWORK="${CREDIT_FPC_SMOKE_START_LOCAL_NETWORK:-1}"
STARTUP_TIMEOUT_SECONDS="$(
  localnet_resolve_timeout_seconds \
    "${CREDIT_FPC_SMOKE_STARTUP_TIMEOUT_SECONDS:-${FPC_LOCAL_NETWORK_STARTUP_TIMEOUT_SECONDS:-}}" \
    "90" \
    "CREDIT_FPC_SMOKE_STARTUP_TIMEOUT_SECONDS or FPC_LOCAL_NETWORK_STARTUP_TIMEOUT_SECONDS" \
    "[credit-smoke]"
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
    "${CREDIT_FPC_SMOKE_RESET_LOCAL_STATE:-}" \
    "always" \
    "$START_LOCAL_NETWORK" \
    "$NODE_RUNNING" \
    "$L1_RUNNING" \
    "CREDIT_FPC_SMOKE_RESET_LOCAL_STATE" \
    "[credit-smoke]"
)"
if [[ "$RESET_LOCAL_STATE" == "1" ]]; then
  echo "[credit-smoke] Resetting local wallet/PXE state"
  localnet_reset_wallet_pxe_state "$REPO_ROOT"
fi

if ! localnet_start_or_reuse \
  "[credit-smoke]" \
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
  echo "[credit-smoke] Installing workspace dependencies (tsx not found)" >&2
  bun install
fi

echo "[credit-smoke] Compiling contracts workspace"
aztec compile --workspace --force

echo "[credit-smoke] Running credit_fpc local smoke flow"
AZTEC_NODE_URL="http://${NODE_HOST}:${NODE_PORT}" \
CREDIT_FPC_SMOKE_L1_RPC_URL="http://${L1_HOST}:${L1_PORT}" \
  bunx tsx "$REPO_ROOT/services/attestation/test/credit-fpc-local-smoke.ts"
