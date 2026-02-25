#!/usr/bin/env bash
# Stop the Aztec local network started by setup.sh and clean up temp files.
#
# Usage:
#   ./profiling/teardown.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.aztec-network.pid"

# ── Stop network ─────────────────────────────────────────────────────────────
if [[ -f "$PID_FILE" ]]; then
  NETWORK_PID=$(cat "$PID_FILE")
  if kill -0 "$NETWORK_PID" 2>/dev/null; then
    echo "[teardown] Stopping Aztec local network (PID $NETWORK_PID)..."
    kill "$NETWORK_PID" 2>/dev/null || true
    wait "$NETWORK_PID" 2>/dev/null || true
    echo "[teardown] Network stopped."
  else
    echo "[teardown] Network process $NETWORK_PID already exited."
  fi
  rm -f "$PID_FILE"
else
  echo "[teardown] No PID file found — network was not started by setup.sh."
fi

# ── Clean up temp files ──────────────────────────────────────────────────────
rm -rf /tmp/profile-fpc-pxe
rm -f /tmp/aztec-profile-network.log

echo "[teardown] Cleanup complete."
