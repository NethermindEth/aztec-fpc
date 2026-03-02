#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/credit-fpc-local-smoke.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

setup_require_cmds "[credit-smoke]" aztec bun node
cd "$REPO_ROOT"

setup_node \
  --log-prefix "[credit-smoke]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[credit-smoke] Installing workspace dependencies (tsx not found)" >&2
  bun install
fi

echo "[credit-smoke] Compiling contracts workspace"
aztec compile --workspace --force

echo "[credit-smoke] Running credit_fpc local smoke flow"
CREDIT_FPC_SMOKE_L1_RPC_URL="$(setup_l1_rpc_url)" \
  bunx tsx "$REPO_ROOT/services/attestation/test/credit-fpc-local-smoke.ts"
