#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fee-entrypoint-local-smoke.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

setup_require_cmds "[smoke]" aztec bun node
cd "$REPO_ROOT"

bash "$REPO_ROOT/scripts/common/check-submodule-pin.sh"

setup_node \
  --log-prefix "[smoke]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[smoke] Installing workspace dependencies (tsx not found)" >&2
  bun install
fi

echo "[smoke] Compiling contracts workspace"
aztec compile

echo "[smoke] Running fee entrypoint local smoke flow"
FPC_SMOKE_L1_RPC_URL="$(setup_l1_rpc_url)" \
  bunx tsx "$REPO_ROOT/services/attestation/test/fee-entrypoint-local-smoke.ts"
