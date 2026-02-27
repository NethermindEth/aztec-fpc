#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v aztec >/dev/null 2>&1; then
  echo "[credit-smoke] ERROR: aztec CLI not found in PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ "${CREDIT_FPC_SMOKE_RESET_LOCAL_STATE:-1}" == "1" ]]; then
  echo "[credit-smoke] Resetting local wallet/PXE state"
  rm -rf "$REPO_ROOT"/wallet_data_* "$REPO_ROOT"/pxe_data_*
fi

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[credit-smoke] Installing workspace dependencies (tsx not found)" >&2
  if command -v bun >/dev/null 2>&1; then
    bun install
  else
    echo "[credit-smoke] ERROR: bun is not available to install dependencies" >&2
    exit 1
  fi
fi

echo "[credit-smoke] Compiling contracts workspace"
aztec compile --workspace --force

echo "[credit-smoke] Running credit_fpc devnet smoke flow"
bunx tsx "$REPO_ROOT/services/attestation/test/credit-fpc-devnet-smoke.ts"
