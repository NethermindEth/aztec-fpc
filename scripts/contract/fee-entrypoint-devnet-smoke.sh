#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v aztec >/dev/null 2>&1; then
  echo "[smoke] ERROR: aztec CLI not found in PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[smoke] Installing workspace dependencies (tsx not found)" >&2
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm install
  else
    echo "[smoke] ERROR: neither pnpm nor corepack is available to install dependencies" >&2
    exit 1
  fi
fi

echo "[smoke] Compiling contracts"
aztec compile

echo "[smoke] Running fee entrypoint devnet smoke flow"
"$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/services/attestation/test/fee-entrypoint-devnet-smoke.ts"
