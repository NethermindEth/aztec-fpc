#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/credit-fpc-full-lifecycle-e2e.XXXXXX")"
source "$REPO_ROOT/scripts/common/test-cleanup.sh"
AZTEC_PID=""
AZTEC_PGID=""
SCRIPT_PGID="$(ps -o pgid= "$$" 2>/dev/null | tr -d '[:space:]')"
STARTED_LOCAL_NETWORK=0

function usage() {
  cat <<'EOF'
Usage: bun run e2e:full-lifecycle:credit [--help]

Runs the full-lifecycle E2E bootstrap wrapper for Issue #85.

Primary env vars:
- FPC_CREDIT_FULL_E2E_START_LOCAL_NETWORK=1|0
- FPC_CREDIT_FULL_E2E_RESET_LOCAL_STATE=1|0
- FPC_CREDIT_FULL_E2E_NODE_HOST (default 127.0.0.1)
- FPC_CREDIT_FULL_E2E_NODE_PORT (default 8080)
- FPC_CREDIT_FULL_E2E_L1_HOST (default 127.0.0.1)
- FPC_CREDIT_FULL_E2E_L1_PORT (default 8545)

Note: auto-start mode only supports the default endpoints above.
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

  echo "[credit-full-lifecycle-e2e] Stopping aztec local network (pid=$AZTEC_PID)"
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
  local node_port="${NODE_PORT:-${FPC_CREDIT_FULL_E2E_NODE_PORT:-8080}}"
  local l1_port="${L1_PORT:-${FPC_CREDIT_FULL_E2E_L1_PORT:-8545}}"
  local attestation_port="${FPC_CREDIT_FULL_E2E_ATTESTATION_PORT:-3300}"
  local topup_ops_port="${FPC_CREDIT_FULL_E2E_TOPUP_OPS_PORT:-3401}"

  if [[ "$STARTED_LOCAL_NETWORK" -eq 1 ]]; then
    stop_aztec_local_network
  fi
  test_cleanup_kill_listener_ports \
    "[credit-full-lifecycle-e2e]" \
    "$node_port" \
    "$l1_port" \
    "$attestation_port" \
    "$topup_ops_port" \
    3000 \
    3001
  test_cleanup_reset_state "[credit-full-lifecycle-e2e]" "$REPO_ROOT"
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

for cmd in aztec bun node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[credit-full-lifecycle-e2e] ERROR: missing required command '$cmd'" >&2
    exit 1
  fi
done

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

cd "$REPO_ROOT"

NODE_HOST="${FPC_CREDIT_FULL_E2E_NODE_HOST:-127.0.0.1}"
NODE_PORT="${FPC_CREDIT_FULL_E2E_NODE_PORT:-8080}"
L1_HOST="${FPC_CREDIT_FULL_E2E_L1_HOST:-127.0.0.1}"
L1_PORT="${FPC_CREDIT_FULL_E2E_L1_PORT:-8545}"
START_LOCAL_NETWORK="${FPC_CREDIT_FULL_E2E_START_LOCAL_NETWORK:-1}"
if [[ "$START_LOCAL_NETWORK" != "0" && "$START_LOCAL_NETWORK" != "1" ]]; then
  echo "[credit-full-lifecycle-e2e] ERROR: FPC_CREDIT_FULL_E2E_START_LOCAL_NETWORK must be 0 or 1, got '$START_LOCAL_NETWORK'" >&2
  exit 1
fi

NODE_RUNNING=0
L1_RUNNING=0
if has_port "$NODE_HOST" "$NODE_PORT"; then
  NODE_RUNNING=1
fi
if has_port "$L1_HOST" "$L1_PORT"; then
  L1_RUNNING=1
fi

if [[ "$START_LOCAL_NETWORK" == "1" ]]; then
  if [[ "$NODE_RUNNING" -ne "$L1_RUNNING" ]]; then
    echo "[credit-full-lifecycle-e2e] ERROR: partial endpoint availability detected: node=$NODE_RUNNING ($NODE_HOST:$NODE_PORT), l1=$L1_RUNNING ($L1_HOST:$L1_PORT)" >&2
    echo "[credit-full-lifecycle-e2e] ERROR: stop the stale process or ensure both endpoints are reachable before rerunning" >&2
    exit 1
  fi
  if [[ "$NODE_RUNNING" -eq 1 && "$L1_RUNNING" -eq 1 ]]; then
    echo "[credit-full-lifecycle-e2e] Reusing existing local aztec devnet ($NODE_HOST:$NODE_PORT) and anvil ($L1_HOST:$L1_PORT)"
  else
    if [[ "$NODE_HOST" != "127.0.0.1" || "$NODE_PORT" != "8080" || "$L1_HOST" != "127.0.0.1" || "$L1_PORT" != "8545" ]]; then
      echo "[credit-full-lifecycle-e2e] ERROR: auto-start only supports default endpoints (127.0.0.1:8080, 127.0.0.1:8545)" >&2
      echo "[credit-full-lifecycle-e2e] ERROR: pre-start your custom endpoints and set FPC_CREDIT_FULL_E2E_START_LOCAL_NETWORK=0" >&2
      exit 1
    fi
    echo "[credit-full-lifecycle-e2e] Starting aztec local network in background"
    if command -v setsid >/dev/null 2>&1; then
      setsid aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    else
      aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    fi
    AZTEC_PID=$!
    AZTEC_PGID="$(ps -o pgid= "$AZTEC_PID" 2>/dev/null | tr -d '[:space:]')"
    STARTED_LOCAL_NETWORK=1

    if ! wait_for_port "$NODE_HOST" "$NODE_PORT" 180; then
      echo "[credit-full-lifecycle-e2e] ERROR: aztec node did not become reachable on $NODE_HOST:$NODE_PORT" >&2
      tail -n 200 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
    if ! wait_for_port "$L1_HOST" "$L1_PORT" 180; then
      echo "[credit-full-lifecycle-e2e] ERROR: anvil did not become reachable on $L1_HOST:$L1_PORT" >&2
      tail -n 200 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
  fi
else
  if [[ "$NODE_RUNNING" -ne 1 || "$L1_RUNNING" -ne 1 ]]; then
    echo "[credit-full-lifecycle-e2e] ERROR: local network auto-start disabled, but $NODE_HOST:$NODE_PORT or $L1_HOST:$L1_PORT is not reachable" >&2
    exit 1
  fi
fi

RESET_LOCAL_STATE="${FPC_CREDIT_FULL_E2E_RESET_LOCAL_STATE:-}"
if [[ -z "$RESET_LOCAL_STATE" ]]; then
  RESET_LOCAL_STATE="1"
fi
if [[ "$RESET_LOCAL_STATE" != "0" && "$RESET_LOCAL_STATE" != "1" ]]; then
  echo "[credit-full-lifecycle-e2e] ERROR: FPC_CREDIT_FULL_E2E_RESET_LOCAL_STATE must be 0 or 1, got '$RESET_LOCAL_STATE'" >&2
  exit 1
fi
if [[ "$RESET_LOCAL_STATE" == "1" ]]; then
  echo "[credit-full-lifecycle-e2e] Resetting wallet/PXE local state"
  rm -rf "$REPO_ROOT"/wallet_data_* "$REPO_ROOT"/pxe_data_*
  rm -rf "$REPO_ROOT"/services/attestation/wallet_data_* "$REPO_ROOT"/services/attestation/pxe_data_*
fi

if ! bun --cwd "$REPO_ROOT/scripts" -e "import('@aztec/accounts/testing')" >/dev/null 2>&1; then
  echo "[credit-full-lifecycle-e2e] Installing workspace dependencies"
  bun install
fi

echo "[credit-full-lifecycle-e2e] Compiling contracts workspace"
aztec compile --workspace --force

echo "[credit-full-lifecycle-e2e] Building attestation service"
bun run --filter @aztec-fpc/attestation build

echo "[credit-full-lifecycle-e2e] Building topup service"
bun run --filter @aztec-fpc/topup build

echo "[credit-full-lifecycle-e2e] Running full lifecycle E2E runner"
(
  cd "$REPO_ROOT/scripts"
  bun run "./services/credit-fpc-full-lifecycle-e2e.ts" "$@"
)
