#!/usr/bin/env bash
# Compile contracts and benchmark the FPC contract.
#
# Benchmarks:
#   fpc        — FPC.fee_entrypoint
#   cold_start — FPC.cold_start_entrypoint
#
# Produces structured JSON (profiling/benchmarks/*.benchmark.json) and
# human-readable console summaries (gate counts, gas, proving time).
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

# Preflight checks
if [[ ! -d "$SCRIPT_DIR/node_modules/@aztec" ]]; then
  echo "[profile] ERROR: Aztec SDK packages not installed. Run ./profiling/setup.sh first." >&2
  exit 1
fi

NODE_PATH="$SCRIPT_DIR/node_modules"
export NODE_PATH

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

# Step 1: Cleanup and compile contracts
echo "[profile] Cleaning stale artifacts..."
rm -rf "$REPO_ROOT/target"

echo "[profile] Compiling contracts..."
(cd "$REPO_ROOT" && aztec compile)

# Step 2: Benchmark each variant in its own process
# Running benchmarks in separate processes avoids a bb.js socket corruption
# issue: the CLI's post-benchmark cleanup destroys all active sockets, which
# breaks the bb native backend for any subsequent benchmark in the same process.

echo ""
echo "[profile] Running benchmark: fpc ..."
AZTEC_NODE_URL="$NODE_URL" L1_RPC_URL="$L1_URL" \
  node "$SCRIPT_DIR/runner.mjs" \
    --config "$REPO_ROOT/Nargo.toml" \
    --output-dir "$SCRIPT_DIR/benchmarks" \
    --contracts fpc
echo "[profile] Finished benchmark: fpc"

echo ""
echo "[profile] Running benchmark: cold_start ..."
AZTEC_NODE_URL="$NODE_URL" L1_RPC_URL="$L1_URL" \
  node "$SCRIPT_DIR/runner.mjs" \
    --config "$REPO_ROOT/Nargo.toml" \
    --output-dir "$SCRIPT_DIR/benchmarks" \
    --contracts cold_start
echo "[profile] Finished benchmark: cold_start"

echo ""
echo "[profile] Benchmark JSONs saved to profiling/benchmarks/"
echo "[profile] Done!"
