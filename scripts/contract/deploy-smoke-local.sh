#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-smoke-local.XXXXXX")"
source "$REPO_ROOT/scripts/common/node-setup.sh"

setup_require_cmds "[deploy-smoke]" aztec bun node
cd "$REPO_ROOT"

setup_node \
  --log-prefix "[deploy-smoke]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "if-starting"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[deploy-smoke] Installing workspace dependencies"
  bun install
fi

echo "[deploy-smoke] Compiling contracts workspace"
aztec compile --workspace --force

DEPLOY_OUTPUT="${FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT:-$TMP_DIR/deploy-fpc-local.json}"
# Defaults use sandbox test account 0 (well-known keys from aztec local devnet TEST_ACCOUNTS)
OPERATOR_SECRET_KEY="${FPC_LOCAL_OPERATOR_SECRET_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"
DEPLOYER_SECRET_KEY="${FPC_LOCAL_DEPLOYER_SECRET_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"

echo "[deploy-smoke] Running local deploy command (variant-specific FPC)"
bunx tsx "$REPO_ROOT/contract-deployment/src/index.ts" \
  --node-url "$AZTEC_NODE_URL" \
  --deployer-secret-key "$DEPLOYER_SECRET_KEY" \
  --operator-secret-key "$OPERATOR_SECRET_KEY" \
  --out "$DEPLOY_OUTPUT"

if [[ ! -f "$DEPLOY_OUTPUT" ]]; then
  echo "[deploy-smoke] ERROR: deploy output was not generated at $DEPLOY_OUTPUT" >&2
  exit 1
fi

L1_DEPLOYER_KEY="${FPC_DEPLOY_SMOKE_L1_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
TOKEN_DATA_DIR="$TMP_DIR/tokens"
mkdir -p "$TOKEN_DATA_DIR"

echo "[deploy-smoke] Deploying test token (skip-registration mode)"
FPC_DATA_DIR="$TMP_DIR" \
  FPC_DEPLOYER_SECRET_KEY="$DEPLOYER_SECRET_KEY" \
  FPC_L1_DEPLOYER_KEY="$L1_DEPLOYER_KEY" \
  L1_RPC_URL="$L1_RPC_URL" \
  AZTEC_NODE_URL="$AZTEC_NODE_URL" \
  bunx tsx "$REPO_ROOT/contract-deployment/src/configure-token.ts" \
    --config "$REPO_ROOT/deployments/local/fpc-config.yaml" \
    --skip-registration

TEST_TOKEN_MANIFEST="$TMP_DIR/tokens/FpcAcceptedAsset.json"
if [[ ! -f "$TEST_TOKEN_MANIFEST" ]]; then
  echo "[deploy-smoke] ERROR: test token manifest was not generated at $TEST_TOKEN_MANIFEST" >&2
  exit 1
fi

echo "[deploy-smoke] Running relay-aware local smoke checks"
FPC_TEST_TOKEN_MANIFEST="$TEST_TOKEN_MANIFEST" \
  bunx tsx "$REPO_ROOT/scripts/contract/devnet-postdeploy-smoke.ts" \
    --manifest "$DEPLOY_OUTPUT" \
    --l1-rpc-url "$L1_RPC_URL" \
    --operator-secret-key "$OPERATOR_SECRET_KEY" \
    --l1-operator-private-key "$L1_DEPLOYER_KEY"

echo "[deploy-smoke] PASS: full local deploy smoke flow succeeded"
