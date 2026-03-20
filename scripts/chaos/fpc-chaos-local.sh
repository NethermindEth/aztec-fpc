#!/usr/bin/env bash
# FPC Chaos Local – shell bootstrap wrapper
#
# Handles:
#   1. (Optional) Start aztec local network + wait for readiness
#   2. Compile contracts
#   3. Build services
#   4. Hand off to fpc-chaos-local.ts for deploy / service start / chaos run
#
# Usage:
#   bash scripts/chaos/fpc-chaos-local.sh [--help]
#   bun run chaos:local
#
# Key env vars (all optional):
#   FPC_CHAOS_LOCAL_START_NETWORK=1|0   auto-start aztec local network (default 1)
#   FPC_CHAOS_LOCAL_NODE_URL            default http://127.0.0.1:8080
#   FPC_CHAOS_LOCAL_L1_RPC_URL          default http://127.0.0.1:8545
#   FPC_CHAOS_LOCAL_CHAOS_MODE          api|onchain|full (default full)
#   FPC_CHAOS_LOCAL_REPORT_PATH         write JSON report to this path
#   (…any other FPC_CHAOS_LOCAL_* vars forwarded directly to the TypeScript runner)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fpc-chaos-local.XXXXXX")"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"
AZTEC_PID=""
AZTEC_PGID=""
SCRIPT_PGID="$(ps -o pgid= "$$" 2>/dev/null | tr -d '[:space:]')"
STARTED_LOCAL_NETWORK=0
BLOCK_PRODUCER_PID=""

function usage() {
  cat <<'EOF'
Usage: bun run chaos:local [--help]

Fully self-contained FPC chaos test runner.
Deploys contracts, starts services, funds FPC, runs chaos tests.

Key env vars:
- FPC_CHAOS_LOCAL_START_NETWORK=1|0  (default 1) auto-start aztec local network
- FPC_CHAOS_LOCAL_NODE_URL           (default http://127.0.0.1:8080)
- FPC_CHAOS_LOCAL_L1_RPC_URL         (default http://127.0.0.1:8545)
- FPC_CHAOS_LOCAL_CHAOS_MODE         api|onchain|full (default full)
- FPC_CHAOS_LOCAL_REPORT_PATH        path to write JSON report

Note: auto-start requires default endpoints (127.0.0.1:8080, 127.0.0.1:8545).
      Set FPC_CHAOS_LOCAL_START_NETWORK=0 to bring your own node.
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
  echo "[chaos-local] Stopping aztec local network (pid=$AZTEC_PID)"
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
  local node_port
  node_port="${FPC_CHAOS_LOCAL_NODE_PORT:-8080}"
  local l1_port
  l1_port="${FPC_CHAOS_LOCAL_L1_PORT:-8545}"
  local attestation_port
  attestation_port="${FPC_CHAOS_LOCAL_ATTESTATION_PORT:-3300}"
  local topup_ops_port
  topup_ops_port="${FPC_CHAOS_LOCAL_TOPUP_OPS_PORT:-3401}"

  if [[ -n "$BLOCK_PRODUCER_PID" ]] && kill -0 "$BLOCK_PRODUCER_PID" >/dev/null 2>&1; then
    kill "$BLOCK_PRODUCER_PID" >/dev/null 2>&1 || true
    wait "$BLOCK_PRODUCER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$STARTED_LOCAL_NETWORK" -eq 1 ]]; then
    stop_aztec_local_network
  fi
  test_cleanup_kill_listener_ports \
    "[chaos-local]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port"
  test_cleanup_reset_state "[chaos-local]" "$REPO_ROOT"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

function has_port() {
  local host="$1" port="$2"
  (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1
}

function wait_for_port() {
  local host="$1" port="$2" timeout_seconds="$3"
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

# ── Argument handling ──────────────────────────────────────────────────────────
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

# ── Prerequisite check ─────────────────────────────────────────────────────────
for cmd in aztec bun node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[chaos-local] ERROR: missing required command '$cmd'" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"

# ── Network config ─────────────────────────────────────────────────────────────
NODE_HOST="127.0.0.1"
NODE_PORT="${FPC_CHAOS_LOCAL_NODE_PORT:-8080}"
L1_HOST="127.0.0.1"
L1_PORT="${FPC_CHAOS_LOCAL_L1_PORT:-8545}"
START_NETWORK="${FPC_CHAOS_LOCAL_START_NETWORK:-1}"

if [[ "$START_NETWORK" != "0" && "$START_NETWORK" != "1" ]]; then
  echo "[chaos-local] ERROR: FPC_CHAOS_LOCAL_START_NETWORK must be 0 or 1, got '$START_NETWORK'" >&2
  exit 1
fi

NODE_RUNNING=0
L1_RUNNING=0
has_port "$NODE_HOST" "$NODE_PORT" && NODE_RUNNING=1
has_port "$L1_HOST" "$L1_PORT"    && L1_RUNNING=1

# ── Start local network if requested ──────────────────────────────────────────
if [[ "$START_NETWORK" == "1" ]]; then
  if [[ "$NODE_RUNNING" -ne "$L1_RUNNING" ]]; then
    echo "[chaos-local] ERROR: partial endpoint availability: node=$NODE_RUNNING ($NODE_HOST:$NODE_PORT), l1=$L1_RUNNING ($L1_HOST:$L1_PORT)" >&2
    echo "[chaos-local] Stop the stale process or ensure both endpoints are reachable before rerunning." >&2
    exit 1
  fi

  if [[ "$NODE_RUNNING" -eq 1 && "$L1_RUNNING" -eq 1 ]]; then
    echo "[chaos-local] Reusing existing local aztec devnet ($NODE_HOST:$NODE_PORT) and anvil ($L1_HOST:$L1_PORT)"
  else
    echo "[chaos-local] Starting aztec local network in background..."
    if command -v setsid >/dev/null 2>&1; then
      setsid aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    else
      aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    fi
    AZTEC_PID=$!
    AZTEC_PGID="$(ps -o pgid= "$AZTEC_PID" 2>/dev/null | tr -d '[:space:]')"
    STARTED_LOCAL_NETWORK=1

    echo "[chaos-local] Waiting for aztec node on $NODE_HOST:$NODE_PORT (up to 180s)..."
    if ! wait_for_port "$NODE_HOST" "$NODE_PORT" 180; then
      echo "[chaos-local] ERROR: aztec node did not become reachable on $NODE_HOST:$NODE_PORT" >&2
      tail -n 200 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
    echo "[chaos-local] Waiting for anvil on $L1_HOST:$L1_PORT..."
    if ! wait_for_port "$L1_HOST" "$L1_PORT" 180; then
      echo "[chaos-local] ERROR: anvil did not become reachable on $L1_HOST:$L1_PORT" >&2
      tail -n 200 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
    echo "[chaos-local] Local network ready."

    echo "[chaos-local] Starting block-producer in background..."
    AZTEC_NODE_URL="http://${NODE_HOST}:${NODE_PORT}" \
      bash "$REPO_ROOT/scripts/services/block-producer.sh" \
      >"$TMP_DIR/block-producer.log" 2>&1 &
    BLOCK_PRODUCER_PID=$!
  fi
else
  if [[ "$NODE_RUNNING" -ne 1 || "$L1_RUNNING" -ne 1 ]]; then
    echo "[chaos-local] ERROR: START_NETWORK=0 but $NODE_HOST:$NODE_PORT or $L1_HOST:$L1_PORT is not reachable." >&2
    exit 1
  fi
fi

# ── Build ──────────────────────────────────────────────────────────────────────
if ! bun --cwd "$REPO_ROOT/scripts" -e "import('@aztec/accounts/testing')" >/dev/null 2>&1; then
  echo "[chaos-local] Installing workspace dependencies..."
  bun install
fi

echo "[chaos-local] Compiling contracts workspace..."
aztec compile --workspace --force

echo "[chaos-local] Building attestation service..."
bun run --filter @nethermindeth/aztec-fpc-attestation build

echo "[chaos-local] Building topup service..."
bun run --filter @nethermindeth/aztec-fpc-topup build

# ── Run orchestrator ───────────────────────────────────────────────────────────
echo "[chaos-local] Handing off to TypeScript orchestrator..."
(
  cd "$REPO_ROOT/scripts/chaos"
  bun run "./fpc-chaos-local.ts" "$@"
)
