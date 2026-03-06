#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

if [[ ! -f target/token_contract-Token.json || ! -f target/fpc-FPCMultiAsset.json ]]; then
  echo "Compiling Aztec workspace artifacts..."
  aztec compile --workspace --force
fi

bun run scripts/contract/deploy-fpc-devnet.ts "$@"

# Generate service configs if manifest was written (skipped for preflight-only).
# Set FPC_SKIP_CONFIG_GEN=1 to handle config generation externally.
if [[ "${FPC_SKIP_CONFIG_GEN:-0}" != "1" ]]; then
  _DATA_DIR="${FPC_DATA_DIR:-./deployments}"
  OUT_PATH="${FPC_OUT:-$_DATA_DIR/manifest.json}"
  if [[ -f "$OUT_PATH" ]]; then
    FPC_DATA_DIR="$_DATA_DIR" \
      FPC_DEPLOY_MANIFEST="$OUT_PATH" \
      bash scripts/config/generate-service-configs.sh
  else
    echo "Skipping config generation (manifest not found at $OUT_PATH)."
  fi
fi
