#!/usr/bin/env bash
# FPC Chaos / Adversarial Test Suite – shell wrapper
#
# Wraps fpc-chaos-test.ts.  Accepts all FPC_CHAOS_* environment variables
# (see the TypeScript file for the full list).
#
# Usage examples
# --------------
# API-only against devnet services (safe for production):
#   FPC_CHAOS_ATTESTATION_URL=https://<host> \
#   FPC_CHAOS_MANIFEST=./deployments/devnet-manifest-v2.json \
#   bash scripts/services/fpc-chaos-test.sh
#
# Full suite against a running local network (mode defaults to api; set full for onchain+stress):
#   FPC_CHAOS_MODE=full \
#   FPC_CHAOS_ATTESTATION_URL=http://localhost:3000 \
#   FPC_CHAOS_TOPUP_URL=http://localhost:3001 \
#   FPC_CHAOS_NODE_URL=http://localhost:8080 \
#   FPC_CHAOS_MANIFEST=./deployments/devnet-manifest-v2.json \
#   FPC_CHAOS_OPERATOR_SECRET_KEY=0x<hex> \
#   bash scripts/services/fpc-chaos-test.sh
#
# Optional: start a local network automatically before running:
#   FPC_CHAOS_START_LOCAL_NETWORK=1 FPC_CHAOS_MODE=full ... bash scripts/services/fpc-chaos-test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fpc-chaos-test.XXXXXX")"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"

STARTED_LOCAL_NETWORK=0
AZTEC_PID=""
AZTEC_PGID=""
SCRIPT_PGID="$(ps -o pgid= "$$" 2>/dev/null | tr -d '[:space:]')"

function usage() {
  cat <<'EOF'
Usage: bash scripts/services/fpc-chaos-test.sh [--help]

Runs the FPC chaos / adversarial test suite.

Key env vars:
  FPC_CHAOS_MODE                 api|onchain|full  (default: api)
  FPC_CHAOS_ATTESTATION_URL      required
  FPC_CHAOS_TOPUP_URL            optional
  FPC_CHAOS_NODE_URL             required for mode=onchain|full
  FPC_CHAOS_MANIFEST             path to manifest JSON
  FPC_CHAOS_OPERATOR_SECRET_KEY  required for mode=onchain|full
  FPC_CHAOS_REPORT_PATH          write JSON report here
  FPC_CHAOS_FAIL_FAST            1 = stop on first failure
  FPC_CHAOS_RATE_LIMIT_BURST     burst size for rate-limit test (default: 70)
  FPC_CHAOS_CONCURRENT_TXS       concurrent txs for stress test (default: 3)

Network bootstrap (optional):
  FPC_CHAOS_START_LOCAL_NETWORK  1 = start aztec local-network automatically (default: 0)
  FPC_CHAOS_NODE_HOST            node hostname (default: 127.0.0.1)
  FPC_CHAOS_NODE_PORT            node port (default: 8080)
  FPC_CHAOS_L1_HOST              L1 hostname (default: 127.0.0.1)
  FPC_CHAOS_L1_PORT              L1 port (default: 8545)

Full env var reference: see scripts/services/fpc-chaos-test.ts
EOF
}

function wait_for_pid_exit() {
  local pid="$1"
  local timeout_seconds="$2"
  local start_ts
  start_ts="$(date +%s)"
  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( "$(date +%s)" - start_ts > timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
  return 0
}

function stop_aztec_local_network() {
  if [[ -z "$AZTEC_PID" ]] || ! kill -0 "$AZTEC_PID" >/dev/null 2>&1; then
    return
  fi
  echo "[fpc-chaos] Stopping aztec local network (pid=$AZTEC_PID)"
  if [[ -n "$AZTEC_PGID" && "$AZTEC_PGID" != "$SCRIPT_PGID" ]]; then
    kill -TERM -- "-$AZTEC_PGID" >/dev/null 2>&1 || true
    if ! wait_for_pid_exit "$AZTEC_PID" 10; then
      kill -KILL -- "-$AZTEC_PGID" >/dev/null 2>&1 || true
    fi
  else
    kill "$AZTEC_PID" >/dev/null 2>&1 || true
    if ! wait_for_pid_exit "$AZTEC_PID" 10; then
      kill -9 "$AZTEC_PID" >/dev/null 2>&1 || true
    fi
  fi
  wait "$AZTEC_PID" >/dev/null 2>&1 || true
}

function cleanup() {
  if [[ "$STARTED_LOCAL_NETWORK" -eq 1 ]]; then
    stop_aztec_local_network
  fi
  test_cleanup_kill_listener_ports "[fpc-chaos]" \
    "${FPC_CHAOS_NODE_PORT:-8080}" \
    "${FPC_CHAOS_L1_PORT:-8545}"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

function has_port() {
  local host="$1"
  local port="$2"
  (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1
}

function wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout_seconds="$3"
  local start_ts
  start_ts="$(date +%s)"
  while true; do
    if has_port "$host" "$port"; then
      return 0
    fi
    if (( "$(date +%s)" - start_ts > timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

# ── Argument parsing ──────────────────────────────────────────────────────────
for arg in "$@"; do
  if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
    usage
    exit 0
  fi
done

# ── Dependency checks ─────────────────────────────────────────────────────────
for cmd in bun; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[fpc-chaos] ERROR: missing required command '$cmd'" >&2
    exit 1
  fi
done

# Check aztec only when we need the node
CHAOS_MODE="${FPC_CHAOS_MODE:-api}"
if [[ "$CHAOS_MODE" == "onchain" || "$CHAOS_MODE" == "full" ]]; then
  if ! command -v aztec >/dev/null 2>&1; then
    echo "[fpc-chaos] WARNING: 'aztec' not found; required for mode=$CHAOS_MODE" >&2
  fi
fi

# ── Optional local network startup ───────────────────────────────────────────
START_LOCAL_NETWORK="${FPC_CHAOS_START_LOCAL_NETWORK:-0}"
NODE_HOST="${FPC_CHAOS_NODE_HOST:-127.0.0.1}"
NODE_PORT="${FPC_CHAOS_NODE_PORT:-8080}"
L1_HOST="${FPC_CHAOS_L1_HOST:-127.0.0.1}"
L1_PORT="${FPC_CHAOS_L1_PORT:-8545}"

if [[ "$START_LOCAL_NETWORK" == "1" ]]; then
  if ! command -v aztec >/dev/null 2>&1; then
    echo "[fpc-chaos] ERROR: aztec not found but FPC_CHAOS_START_LOCAL_NETWORK=1" >&2
    exit 1
  fi

  NODE_RUNNING=0
  L1_RUNNING=0
  has_port "$NODE_HOST" "$NODE_PORT" && NODE_RUNNING=1
  has_port "$L1_HOST" "$L1_PORT" && L1_RUNNING=1

  if [[ "$NODE_RUNNING" -eq 1 && "$L1_RUNNING" -eq 1 ]]; then
    echo "[fpc-chaos] Reusing existing local network ($NODE_HOST:$NODE_PORT, $L1_HOST:$L1_PORT)"
  else
    echo "[fpc-chaos] Starting aztec local network in background"
    if command -v setsid >/dev/null 2>&1; then
      setsid aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    else
      aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    fi
    AZTEC_PID=$!
    AZTEC_PGID="$(ps -o pgid= "$AZTEC_PID" 2>/dev/null | tr -d '[:space:]')"
    STARTED_LOCAL_NETWORK=1

    if ! wait_for_port "$NODE_HOST" "$NODE_PORT" 180; then
      echo "[fpc-chaos] ERROR: node did not become ready on $NODE_HOST:$NODE_PORT" >&2
      tail -n 100 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
    echo "[fpc-chaos] Local network ready"
  fi
fi

# ── Compile contracts if in onchain/full mode ─────────────────────────────────
if [[ "$CHAOS_MODE" == "onchain" || "$CHAOS_MODE" == "full" ]]; then
  if command -v aztec >/dev/null 2>&1; then
    echo "[fpc-chaos] Compiling contracts"
    cd "$REPO_ROOT"
    aztec compile --workspace --force
  fi
fi

# ── Run ───────────────────────────────────────────────────────────────────────
cd "$REPO_ROOT"

echo "[fpc-chaos] Running chaos test suite (mode=$CHAOS_MODE)"
(
  cd "$REPO_ROOT/scripts"
  bun run "./services/fpc-chaos-test.ts" "$@"
)
