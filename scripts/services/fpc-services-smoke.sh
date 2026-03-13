#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fpc-services-smoke.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

setup_require_cmds "[services-smoke]" aztec bun node
cd "$REPO_ROOT"

setup_node \
  --log-prefix "[services-smoke]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if ! bun --cwd "$REPO_ROOT/scripts" -e "import('@aztec/accounts/testing')" >/dev/null 2>&1; then
  echo "[services-smoke] Installing workspace dependencies"
  bun install
fi

echo "[services-smoke] Compiling contracts workspace"
aztec compile --workspace --force

echo "[services-smoke] Building attestation service"
bun run --filter @aztec-fpc/attestation build

echo "[services-smoke] Building topup service"
bun run --filter @aztec-fpc/topup build

echo "[services-smoke] Building SDK"
bun run --filter @aztec-fpc/sdk build

echo "[services-smoke] Running services end-to-end smoke"
bun run "$REPO_ROOT/scripts/services/fpc-services-smoke.ts"
