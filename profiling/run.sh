#!/usr/bin/env bash
# Compile contracts and benchmark FPC.fee_entrypoint via aztec-benchmark.
#
# Produces both structured JSON (profiling/benchmarks/fpc.benchmark.json) and
# a human-readable console summary (gate counts, gas, proving time).
#
# For CreditFPC profiling (pay_and_mint + pay_with_credit), use run_credit_fpc.sh.
#
# Run ./profiling/setup.sh once first, then re-run this after every contract change.
#
# Usage:
#   ./profiling/run.sh
#
# Environment:
#   AZTEC_NODE_URL  — override node endpoint (default http://127.0.0.1:8080)
#   L1_RPC_URL      — L1 (anvil) endpoint  (default http://127.0.0.1:8545)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"
L1_URL="${L1_RPC_URL:-http://127.0.0.1:8545}"

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

# ── Step 2: Benchmark via aztec-benchmark (JSON + console output) ─────────────
echo ""
echo "[profile] Running FPC benchmark (aztec-benchmark)..."
AZTEC_NODE_URL="$NODE_URL" L1_RPC_URL="$L1_URL" \
  npx --prefix "$SCRIPT_DIR" aztec-benchmark \
    --config "$REPO_ROOT/Nargo.toml" \
    --output-dir "$SCRIPT_DIR/benchmarks"

echo ""
echo "[profile] Benchmark JSON saved to profiling/benchmarks/"
echo "[profile] Done!"
