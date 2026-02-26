#!/usr/bin/env bash
# Compile contracts, deploy, and profile FPC.fee_entrypoint gate count.
#
# Run ./profiling/setup.sh once first, then re-run this after every contract change.
#
# Usage:
#   ./profiling/run.sh
#
# Environment:
#   AZTEC_NODE_URL  â€” override node endpoint (default http://127.0.0.1:8080)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"

# â”€â”€ Preflight checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if [[ ! -d "$SCRIPT_DIR/node_modules/@aztec" ]]; then
  echo "[profile] ERROR: Aztec SDK packages not installed. Run ./profiling/setup.sh first." >&2
  exit 1
fi

node_is_up() {
  local code
  code=$(curl -s --max-time 3 --connect-timeout 2 -o /dev/null -w "%{http_code}" "$NODE_URL" 2>/dev/null)
  [[ "$code" != "000" ]]
}

if ! node_is_up; then
  echo "[profile] ERROR: No Aztec node at $NODE_URL" >&2
  echo "  Run ./profiling/setup.sh to start one, or set AZTEC_NODE_URL." >&2
  exit 1
fi

# â”€â”€ Step 1: Compile contracts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
echo "[profile] Compiling contracts..."
(cd "$REPO_ROOT" && aztec compile)

# â”€â”€ Step 2: Deploy + profile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
echo ""
echo "[profile] Running gate count profiler..."
AZTEC_NODE_URL="$NODE_URL" node "$SCRIPT_DIR/profile-gates.mjs"

echo ""
echo "[profile] Done!"
