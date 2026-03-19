#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fpc-full-lifecycle-e2e.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

function usage() {
  cat <<'EOF'
Usage: bun run e2e:full-lifecycle:fpc:local [--help]

Runs the full-lifecycle E2E bootstrap wrapper for Issue #85.

Env vars:
- AZTEC_NODE_URL  — if set, use external node (don't start local)
- L1_RPC_URL      — if set, use external L1 (don't start local)
EOF
}

setup_require_cmds "[full-lifecycle-e2e]" aztec bun node

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

cd "$REPO_ROOT"

setup_node \
  --log-prefix "[full-lifecycle-e2e]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if ! bun --cwd "$REPO_ROOT/scripts" -e "import('@aztec/accounts/testing')" >/dev/null 2>&1; then
  echo "[full-lifecycle-e2e] Installing workspace dependencies"
  bun install
fi

echo "[full-lifecycle-e2e] Compiling contracts workspace"
aztec compile --workspace --force

echo "[full-lifecycle-e2e] Running full lifecycle E2E runner"
(
  cd "$REPO_ROOT/scripts"
  bun run "./services/fpc-full-lifecycle-e2e.ts" "$@"
)
