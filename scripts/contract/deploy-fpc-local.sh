#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

AZTEC_NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"
L1_RPC_URL="${L1_RPC_URL:-http://127.0.0.1:8545}"
# Default local-network operator (test0 account).
FPC_LOCAL_OPERATOR="${FPC_LOCAL_OPERATOR:-0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72}"
FPC_LOCAL_OUT="${FPC_LOCAL_OUT:-./tmp/deploy-fpc-local.json}"

cd "${REPO_ROOT}"

# Deploys token (if needed), FPC, and CreditFPC to local devnet.
bunx tsx scripts/contract/deploy-fpc-local.ts \
  --aztec-node-url "${AZTEC_NODE_URL}" \
  --l1-rpc-url "${L1_RPC_URL}" \
  --operator "${FPC_LOCAL_OPERATOR}" \
  --out "${FPC_LOCAL_OUT}" \
  "$@"

# ── Optional: generate per-service configs from master config ─────────────────
FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}"
if [ -f "$FPC_MASTER_CONFIG" ]; then
  FPC_LOCAL_OUT="$FPC_LOCAL_OUT" \
  FPC_MASTER_CONFIG="$FPC_MASTER_CONFIG" \
  FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}" \
    bash scripts/config/generate-service-configs.sh
fi
