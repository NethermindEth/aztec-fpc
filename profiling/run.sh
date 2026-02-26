#!/usr/bin/env bash
# Compile contracts, deploy, and profile CreditFPC gate counts.
# Profiles both pay_and_mint and pay_with_credit flows.
#
# Run ./profiling/setup.sh once first, then re-run this after every contract change.
#
# Usage:
#   ./profiling/run.sh
#
# Environment:
#   AZTEC_NODE_URL  — override node endpoint (default http://127.0.0.1:8080)
#   L1_RPC_URL      — override L1 endpoint used for Fee Juice bridging (default http://127.0.0.1:8545)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"

# ── Preflight checks ─────────────────────────────────────────────────────────
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

# ── Step 1: Compile contracts ─────────────────────────────────────────────────
echo "[profile] Compiling contracts..."
(cd "$REPO_ROOT" && aztec compile)

# ── Step 2: Deploy + profile (pay_and_mint + pay_with_credit) ─────────────────
echo ""
echo "[profile] Running gate count profiler (pay_and_mint + pay_with_credit)..."
AZTEC_NODE_URL="$NODE_URL" node "$SCRIPT_DIR/profile-gates.mjs"

echo ""
echo "[profile] Done!"
