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

# Generate service configs if manifest was written (skipped for preflight-only).
# Set FPC_SKIP_CONFIG_GEN=1 to handle config generation externally.
if [[ "${FPC_SKIP_CONFIG_GEN:-0}" != "1" ]]; then
  OUT_PATH="${FPC_OUT:-./deployments/devnet-manifest-v2.json}"
  if [[ -f "$OUT_PATH" ]]; then
    FPC_DEPLOY_MANIFEST="$OUT_PATH" \
      FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}" \
      FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}" \
      bash scripts/config/generate-service-configs.sh
  else
    echo "Skipping config generation (manifest not found at $OUT_PATH)."
  fi
fi
