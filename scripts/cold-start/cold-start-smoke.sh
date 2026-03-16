#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cold-start-local-smoke.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

setup_require_cmds "[cold-start]" aztec bun node
cd "$REPO_ROOT"

setup_node \
  --log-prefix "[cold-start]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[cold-start] Installing workspace dependencies (tsx not found)" >&2
  bun install
fi

echo "[cold-start] Compiling contracts workspace"
aztec compile

# Deploy contracts (Token, FPC, Bridge + L1 TestERC20, TokenPortal).
# All env var defaults and CLI parsing are handled by the deploy script.
echo "[cold-start] Deploying contracts"
FPC_L1_DEPLOYER_KEY="${FPC_L1_DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" \
FPC_OUT="$TMP_DIR/cold-start-manifest.json" \
FPC_L1_RPC_URL="$(setup_l1_rpc_url)" \
  bash "$REPO_ROOT/scripts/contract/deploy-fpc.sh" "$@"

if [[ ! -f "$TMP_DIR/cold-start-manifest.json" ]]; then
  echo "[cold-start] ERROR: deployment did not produce manifest" >&2
  exit 1
fi

echo "[cold-start] Running cold-start local smoke flow"
FPC_COLD_START_MANIFEST="$TMP_DIR/cold-start-manifest.json" \
FPC_SMOKE_L1_RPC_URL="$(setup_l1_rpc_url)" \
  bunx tsx "$REPO_ROOT/scripts/cold-start/cold-start-smoke.ts"
