#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/always-revert-smoke.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

setup_require_cmds "[always-revert]" aztec bun node
cd "$REPO_ROOT"

setup_node \
  --log-prefix "[always-revert]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "always"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[always-revert] Installing workspace dependencies (tsx not found)" >&2
  bun install
fi

echo "[always-revert] Compiling contracts workspace"
aztec compile

# Deploy contracts WITHOUT bridge flags — this deploys Token, FPC, and Faucet
# (no bridge, no counter). The faucet is deployed automatically when no
# --accepted-asset or bridge address is provided.
echo "[always-revert] Deploying contracts (faucet mode, no bridge)"
FPC_L1_DEPLOYER_KEY="${FPC_L1_DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" \
FPC_OUT="$TMP_DIR/always-revert-manifest.json" \
FPC_L1_RPC_URL="$(setup_l1_rpc_url)" \
FPC_SKIP_CONFIG_GEN=1 \
  bash "$REPO_ROOT/scripts/contract/deploy-fpc.sh"

if [[ ! -f "$TMP_DIR/always-revert-manifest.json" ]]; then
  echo "[always-revert] ERROR: deployment did not produce manifest" >&2
  exit 1
fi

echo "[always-revert] Running always-revert smoke flow"
FPC_COLD_START_MANIFEST="$TMP_DIR/always-revert-manifest.json" \
  bunx tsx "$REPO_ROOT/scripts/always-revert/always-revert-smoke.ts"
