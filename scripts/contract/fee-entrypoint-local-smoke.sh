#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"

function cleanup() {
  local node_port="${FPC_SMOKE_NODE_PORT:-8080}"
  local l1_port="${FPC_SMOKE_L1_PORT:-8545}"
  local attestation_port="${FPC_SERVICES_SMOKE_ATTESTATION_PORT:-3300}"
  local topup_ops_port="${FPC_SERVICES_SMOKE_TOPUP_OPS_PORT:-3401}"
  test_cleanup_kill_listener_ports \
    "[smoke]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port" \
    3000 \
    3001
  test_cleanup_reset_state "[smoke]" "$REPO_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! command -v aztec >/dev/null 2>&1; then
  echo "[smoke] ERROR: aztec CLI not found in PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ "${FPC_SMOKE_RESET_LOCAL_STATE:-1}" == "1" ]]; then
  echo "[smoke] Resetting local wallet/PXE state"
  rm -rf "$REPO_ROOT"/wallet_data_* "$REPO_ROOT"/pxe_data_*
fi

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[smoke] Installing workspace dependencies (tsx not found)" >&2
  if command -v bun >/dev/null 2>&1; then
    bun install
  else
    echo "[smoke] ERROR: bun is not available to install dependencies" >&2
    exit 1
  fi
fi

echo "[smoke] Compiling contracts"
aztec compile

echo "[smoke] Running fee entrypoint local smoke flow"
bunx tsx "$REPO_ROOT/services/attestation/test/fee-entrypoint-local-smoke.ts"
