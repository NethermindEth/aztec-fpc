#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"

MODE="${FPC_DEPLOY_ENV:-devnet}"

function cleanup() {
  local node_port="${FPC_DEVNET_SMOKE_NODE_PORT:-8080}"
  local l1_port="${FPC_DEVNET_SMOKE_L1_PORT:-8545}"
  local attestation_port="${FPC_SERVICES_SMOKE_ATTESTATION_PORT:-3300}"
  local topup_ops_port="${FPC_SERVICES_SMOKE_TOPUP_OPS_PORT:-3401}"
  test_cleanup_kill_listener_ports \
    "[deploy-postdeploy-smoke]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port" \
    3000 \
    3001
  test_cleanup_reset_state "[deploy-postdeploy-smoke]" "$REPO_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$REPO_ROOT"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[deploy-postdeploy-smoke] Installing workspace dependencies"
  bun install
fi

if [[ "$MODE" == "local" ]]; then
  bunx tsx "$REPO_ROOT/scripts/contract/deploy-fpc-local-smoke-mode.ts" "$@"
  exit 0
fi

if [[ "$MODE" != "devnet" ]]; then
  echo "[deploy-postdeploy-smoke] ERROR: FPC_DEPLOY_ENV must be 'devnet' or 'local' (got '$MODE')" >&2
  exit 1
fi

bunx tsx "$REPO_ROOT/scripts/contract/devnet-postdeploy-smoke.ts" "$@"
