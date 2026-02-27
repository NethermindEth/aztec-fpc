#!/usr/bin/env bash
# One-time profiling environment setup.
#
# Installs Aztec SDK npm packages and starts a local Aztec network.
# Run this once before iterating with run.sh.
#
# Usage:
#   ./profiling/setup.sh
#
# Environment:
#   AZTEC_NODE_URL  — override node endpoint (default http://127.0.0.1:8080)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"
PID_FILE="$SCRIPT_DIR/.aztec-network.pid"

# ── Prerequisite checks ──────────────────────────────────────────────────────
AZTEC_VERSION=$(tr -d '\n' < "$REPO_ROOT/.aztecrc")

check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[setup] ERROR: $1 not found. $2" >&2
    exit 1
  fi
}

check_cmd aztec "Install with: VERSION=$AZTEC_VERSION bash -i <(curl -sL https://install.aztec.network/$AZTEC_VERSION)"
check_cmd node  "Node.js >=20 is required (usually bundled with the Aztec toolchain)."

echo "[setup] Aztec version: $AZTEC_VERSION"

# ── Step 1: Initialize git submodules (vendor/aztec-standards) ────────────────
echo "[setup] Initializing git submodules..."
(cd "$REPO_ROOT" && git submodule update --init)
echo "[setup] Submodules initialized."

# ── Step 2: Install profiling npm dependencies ────────────────────────────────
AZTEC_PKGS=(
  "@aztec/aztec.js"
  "@aztec/accounts"
  "@aztec/constants"
  "@aztec/foundation"
  "@aztec/protocol-contracts"
  "@aztec/pxe"
  "@aztec/stdlib"
  "@aztec/wallet-sdk"
)

# Non-Aztec packages needed for benchmarking (viem for L1 bridging,
# aztec-benchmark for the structured profiler).
EXTRA_PKGS=(
  "@defi-wonderland/aztec-benchmark@${AZTEC_VERSION}"
  "viem"
)

install_deps() {
  local versioned=()
  for pkg in "${AZTEC_PKGS[@]}"; do
    versioned+=("${pkg}@${AZTEC_VERSION}")
  done

  cd "$SCRIPT_DIR"
  if command -v npm >/dev/null 2>&1; then
    npm install "${versioned[@]}" "${EXTRA_PKGS[@]}"
  elif command -v bun >/dev/null 2>&1; then
    bun add "${versioned[@]}" "${EXTRA_PKGS[@]}"
  else
    echo "[setup] ERROR: npm or bun is required to install dependencies." >&2
    exit 1
  fi
}

INSTALLED_VERSION=""
if [[ -d "$SCRIPT_DIR/node_modules/@aztec/aztec.js" ]]; then
  INSTALLED_VERSION=$(node -e "console.log(require('$SCRIPT_DIR/node_modules/@aztec/aztec.js/package.json').version)" 2>/dev/null || echo "")
fi

if [[ "$INSTALLED_VERSION" != "$AZTEC_VERSION" ]]; then
  echo "[setup] Installing Aztec SDK packages ($AZTEC_VERSION)..."
  install_deps
else
  echo "[setup] Aztec SDK packages up to date ($AZTEC_VERSION)"
fi

# ── Step 3: Start Aztec local network ────────────────────────────────────────
node_is_up() {
  local code
  code=$(curl -s --max-time 3 --connect-timeout 2 -o /dev/null -w "%{http_code}" "$NODE_URL" 2>/dev/null)
  [[ "$code" != "000" ]]
}

if node_is_up; then
  echo "[setup] Aztec node already running at $NODE_URL"
else
  # Clean up stale PID file if the process is gone
  if [[ -f "$PID_FILE" ]]; then
    OLD_PID=$(cat "$PID_FILE")
    if ! kill -0 "$OLD_PID" 2>/dev/null; then
      rm -f "$PID_FILE"
    fi
  fi

  NETWORK_LOG="/tmp/aztec-profile-network.log"

  dump_logs() {
    echo "" >&2
    echo "[setup] ── Last 30 lines of network log ──" >&2
    tail -n 30 "$NETWORK_LOG" >&2 2>/dev/null || echo "(no log output)" >&2
    echo "[setup] ── Full log: $NETWORK_LOG ──" >&2
  }

  echo "[setup] Starting Aztec local network..."
  echo "[setup] Logs: $NETWORK_LOG"
  aztec start --local-network > "$NETWORK_LOG" 2>&1 &
  NETWORK_PID=$!
  echo "$NETWORK_PID" > "$PID_FILE"

  echo -n "[setup] Waiting for node to be ready"
  for i in $(seq 1 120); do
    if node_is_up; then
      echo " ready!"
      break
    fi
    if ! kill -0 "$NETWORK_PID" 2>/dev/null; then
      echo " failed!"
      rm -f "$PID_FILE"
      echo "[setup] ERROR: Aztec network process exited unexpectedly." >&2
      dump_logs
      exit 1
    fi
    echo -n "."
    sleep 5
  done

  if ! node_is_up; then
    echo " timeout!"
    echo "[setup] ERROR: Node not ready after 10 minutes." >&2
    dump_logs
    exit 1
  fi

  echo "[setup] Network PID $NETWORK_PID written to $PID_FILE"
fi

echo ""
echo "[setup] Ready! Iterate with:  ./profiling/run.sh"
echo "[setup] When done:            ./profiling/teardown.sh"
