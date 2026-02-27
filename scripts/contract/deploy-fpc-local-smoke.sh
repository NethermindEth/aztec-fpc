#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-fpc-local-smoke.XXXXXX")"
AZTEC_PID=""
AZTEC_PGID=""
SCRIPT_PGID="$(ps -o pgid= "$$" 2>/dev/null | tr -d '[:space:]')"
STARTED_LOCAL_NETWORK=0

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

  echo "[deploy-smoke] Stopping aztec local network (pid=$AZTEC_PID)"
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
    echo "[deploy-smoke] ERROR: missing required command '$cmd'" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"

NODE_HOST="${FPC_DEPLOY_SMOKE_NODE_HOST:-127.0.0.1}"
NODE_PORT="${FPC_DEPLOY_SMOKE_NODE_PORT:-8080}"
L1_HOST="${FPC_DEPLOY_SMOKE_L1_HOST:-127.0.0.1}"
L1_PORT="${FPC_DEPLOY_SMOKE_L1_PORT:-8545}"
START_LOCAL_NETWORK="${FPC_DEPLOY_SMOKE_START_LOCAL_NETWORK:-1}"

NODE_RUNNING=0
L1_RUNNING=0
if has_port "$NODE_HOST" "$NODE_PORT"; then
  NODE_RUNNING=1
fi
if has_port "$L1_HOST" "$L1_PORT"; then
  L1_RUNNING=1
fi

if [[ "$START_LOCAL_NETWORK" == "1" ]]; then
  if [[ "$NODE_RUNNING" -eq 1 && "$L1_RUNNING" -eq 1 ]]; then
    echo "[deploy-smoke] Reusing existing local aztec devnet ($NODE_HOST:$NODE_PORT) and anvil ($L1_HOST:$L1_PORT)"
  else
    echo "[deploy-smoke] Starting aztec local network in background"
    if command -v setsid >/dev/null 2>&1; then
      setsid aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    else
      aztec start --local-network >"$TMP_DIR/aztec-local-network.log" 2>&1 &
    fi
    AZTEC_PID=$!
    AZTEC_PGID="$(ps -o pgid= "$AZTEC_PID" 2>/dev/null | tr -d '[:space:]')"
    STARTED_LOCAL_NETWORK=1

    if ! wait_for_port "$NODE_HOST" "$NODE_PORT" 180; then
      echo "[deploy-smoke] ERROR: aztec node did not become reachable on $NODE_HOST:$NODE_PORT" >&2
      tail -n 200 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
    if ! wait_for_port "$L1_HOST" "$L1_PORT" 180; then
      echo "[deploy-smoke] ERROR: anvil did not become reachable on $L1_HOST:$L1_PORT" >&2
      tail -n 200 "$TMP_DIR/aztec-local-network.log" >&2 || true
      exit 1
    fi
  fi
else
  if [[ "$NODE_RUNNING" -ne 1 || "$L1_RUNNING" -ne 1 ]]; then
    echo "[deploy-smoke] ERROR: local network auto-start disabled, but $NODE_HOST:$NODE_PORT or $L1_HOST:$L1_PORT is not reachable" >&2
    exit 1
  fi
fi

RESET_LOCAL_STATE="${FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE:-}"
if [[ -z "$RESET_LOCAL_STATE" ]]; then
  if [[ "$STARTED_LOCAL_NETWORK" -eq 1 ]]; then
    RESET_LOCAL_STATE=1
  else
    RESET_LOCAL_STATE=0
  fi
fi
if [[ "$RESET_LOCAL_STATE" != "0" && "$RESET_LOCAL_STATE" != "1" ]]; then
  echo "[deploy-smoke] ERROR: FPC_DEPLOY_SMOKE_RESET_LOCAL_STATE must be 0 or 1, got '$RESET_LOCAL_STATE'" >&2
  exit 1
fi
if [[ "$RESET_LOCAL_STATE" == "1" ]]; then
  echo "[deploy-smoke] Resetting wallet/PXE local state"
  rm -rf "$REPO_ROOT"/wallet_data_* "$REPO_ROOT"/pxe_data_*
  rm -rf "$REPO_ROOT"/services/attestation/wallet_data_* "$REPO_ROOT"/services/attestation/pxe_data_*
fi

if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "[deploy-smoke] Installing workspace dependencies"
  bun install
fi

echo "[deploy-smoke] Compiling contracts workspace"
aztec compile --workspace --force

DEPLOY_OUTPUT="${FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT:-$TMP_DIR/deploy-fpc-local.json}"
AZTEC_NODE_URL="http://${NODE_HOST}:${NODE_PORT}"
L1_RPC_URL="http://${L1_HOST}:${L1_PORT}"

echo "[deploy-smoke] Running local deploy command (FPC + CreditFPC)"
AZTEC_NODE_URL="$AZTEC_NODE_URL" \
L1_RPC_URL="$L1_RPC_URL" \
FPC_LOCAL_OUT="$DEPLOY_OUTPUT" \
  bun run deploy:fpc:local

if [[ ! -f "$DEPLOY_OUTPUT" ]]; then
  echo "[deploy-smoke] ERROR: deploy output was not generated at $DEPLOY_OUTPUT" >&2
  exit 1
fi

echo "[deploy-smoke] Running relay-aware first-use smoke checks (FPC + CreditFPC)"
NODE_PATH="$REPO_ROOT/services/attestation/node_modules${NODE_PATH:+:$NODE_PATH}" \
AZTEC_NODE_URL="$AZTEC_NODE_URL" \
FPC_DEPLOY_SMOKE_L1_RPC_URL="$L1_RPC_URL" \
FPC_DEPLOY_SMOKE_DEPLOY_OUTPUT="$DEPLOY_OUTPUT" \
  bunx tsx "$REPO_ROOT/scripts/contract/deploy-fpc-local-smoke.ts"

echo "[deploy-smoke] PASS: full local deploy smoke flow succeeded"
