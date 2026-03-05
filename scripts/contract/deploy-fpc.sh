#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

if [[ ! -f target/token_contract-Token.json || ! -f target/fpc-FPCMultiAsset.json ]]; then
  echo "Compiling Aztec workspace artifacts..."
  aztec compile --workspace --force
fi

bunx tsx scripts/contract/deploy-fpc-devnet.ts "$@"

# Resolve manifest path once for subsequent steps.
_DATA_DIR="${FPC_DATA_DIR:-./deployments}"
OUT_PATH="${FPC_OUT:-$_DATA_DIR/manifest.json}"

# Generate service configs if manifest was written (skipped for preflight-only).
# Set FPC_SKIP_CONFIG_GEN=1 to handle config generation externally.
if [[ "${FPC_SKIP_CONFIG_GEN:-0}" != "1" ]]; then
  if [[ -f "$OUT_PATH" ]]; then
    FPC_DATA_DIR="$_DATA_DIR" \
      FPC_DEPLOY_MANIFEST="$OUT_PATH" \
      bash scripts/config/generate-service-configs.sh
  else
    echo "Skipping config generation (manifest not found at $OUT_PATH)."
  fi
fi

# Verify deployed contracts on the node (skipped for preflight-only).
# Set FPC_SKIP_VERIFY=1 to skip verification.
if [[ "${FPC_SKIP_VERIFY:-0}" != "1" ]]; then
  if [[ -f "$OUT_PATH" ]]; then
    bunx tsx scripts/contract/verify-fpc-devnet-deployment.ts \
      --manifest "$OUT_PATH"
  else
    echo "Skipping verification (manifest not found at $OUT_PATH)."
  fi
fi
