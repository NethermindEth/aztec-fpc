#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"

function cleanup() {
  local node_port="${FPC_DEVNET_SMOKE_NODE_PORT:-8080}"
  local l1_port="${FPC_DEVNET_SMOKE_L1_PORT:-8545}"
  local attestation_port="${FPC_SERVICES_SMOKE_ATTESTATION_PORT:-3300}"
  local topup_ops_port="${FPC_SERVICES_SMOKE_TOPUP_OPS_PORT:-3401}"
  test_cleanup_kill_listener_ports \
    "[devnet-postdeploy-smoke]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port" \
    3000 \
    3001
  test_cleanup_reset_state "[devnet-postdeploy-smoke]" "$REPO_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$REPO_ROOT"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[devnet-postdeploy-smoke] Installing workspace dependencies"
  bun install
fi

bunx tsx "$REPO_ROOT/scripts/contract/devnet-postdeploy-smoke.ts" "$@"
