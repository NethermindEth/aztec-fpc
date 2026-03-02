#!/usr/bin/env bash

LOCALNET_AZTEC_PID=""
LOCALNET_AZTEC_PGID=""
LOCALNET_SCRIPT_PGID="$(ps -o pgid= "$$" 2>/dev/null | tr -d '[:space:]')"
LOCALNET_STARTED=0
LOCALNET_NODE_RUNNING=0
LOCALNET_L1_RUNNING=0
LOCALNET_LOG_PATH=""

function localnet_wait_for_pid_exit() {
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

function localnet_stop_started() {
  local log_prefix="$1"

  if [[ "${LOCALNET_STARTED:-0}" -ne 1 ]]; then
    return
  fi
  if [[ -z "${LOCALNET_AZTEC_PID:-}" ]] || ! kill -0 "$LOCALNET_AZTEC_PID" >/dev/null 2>&1; then
    return
  fi

  echo "$log_prefix Stopping aztec local network (pid=$LOCALNET_AZTEC_PID)"
  if [[ -n "${LOCALNET_AZTEC_PGID:-}" && "${LOCALNET_AZTEC_PGID:-}" != "${LOCALNET_SCRIPT_PGID:-}" ]]; then
    kill -TERM -- "-$LOCALNET_AZTEC_PGID" >/dev/null 2>&1 || true
    if ! localnet_wait_for_pid_exit "$LOCALNET_AZTEC_PID" 10; then
      kill -KILL -- "-$LOCALNET_AZTEC_PGID" >/dev/null 2>&1 || true
    fi
  else
    kill "$LOCALNET_AZTEC_PID" >/dev/null 2>&1 || true
    if ! localnet_wait_for_pid_exit "$LOCALNET_AZTEC_PID" 10; then
      kill -9 "$LOCALNET_AZTEC_PID" >/dev/null 2>&1 || true
    fi
  fi
  wait "$LOCALNET_AZTEC_PID" >/dev/null 2>&1 || true
  LOCALNET_STARTED=0
}

function localnet_has_port() {
  local host="$1"
  local port="$2"
  (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1
}

function localnet_wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout_seconds="$3"
  local start_ts
  start_ts="$(date +%s)"

  while true; do
    if localnet_has_port "$host" "$port"; then
      return 0
    fi
    if (( "$(date +%s)" - start_ts > timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

function localnet_tail_log() {
  local line_count="${1:-200}"
  if [[ -n "${LOCALNET_LOG_PATH:-}" && -f "${LOCALNET_LOG_PATH:-}" ]]; then
    tail -n "$line_count" "$LOCALNET_LOG_PATH" >&2 || true
  fi
}

function localnet_start_or_reuse() {
  local log_prefix="$1"
  local start_local_network="$2"
  local node_host="$3"
  local node_port="$4"
  local l1_host="$5"
  local l1_port="$6"
  local log_path="$7"
  local startup_timeout="${8:-90}"

  LOCALNET_LOG_PATH="$log_path"
  LOCALNET_NODE_RUNNING=0
  LOCALNET_L1_RUNNING=0

  if localnet_has_port "$node_host" "$node_port"; then
    LOCALNET_NODE_RUNNING=1
  fi
  if localnet_has_port "$l1_host" "$l1_port"; then
    LOCALNET_L1_RUNNING=1
  fi

  if [[ "$start_local_network" != "0" && "$start_local_network" != "1" ]]; then
    echo "$log_prefix ERROR: start_local_network must be 0 or 1, got '$start_local_network'" >&2
    return 1
  fi

  if [[ "$start_local_network" == "1" ]]; then
    if [[ "$LOCALNET_NODE_RUNNING" -eq 1 && "$LOCALNET_L1_RUNNING" -eq 1 ]]; then
      echo "$log_prefix Reusing existing local aztec devnet ($node_host:$node_port) and anvil ($l1_host:$l1_port)"
      return 0
    fi

    echo "$log_prefix Starting aztec local network in background"
    if command -v setsid >/dev/null 2>&1; then
      setsid aztec start --local-network >"$LOCALNET_LOG_PATH" 2>&1 &
    else
      aztec start --local-network >"$LOCALNET_LOG_PATH" 2>&1 &
    fi
    LOCALNET_AZTEC_PID=$!
    LOCALNET_AZTEC_PGID="$(ps -o pgid= "$LOCALNET_AZTEC_PID" 2>/dev/null | tr -d '[:space:]')"
    LOCALNET_STARTED=1

    echo "$log_prefix Waiting for aztec node port on $node_host:$node_port (timeout ${startup_timeout}s)"
    if ! localnet_wait_for_port "$node_host" "$node_port" "$startup_timeout"; then
      echo "$log_prefix ERROR: aztec node did not become reachable on $node_host:$node_port" >&2
      localnet_tail_log 200
      return 1
    fi
    echo "$log_prefix Waiting for anvil port on $l1_host:$l1_port (timeout ${startup_timeout}s)"
    if ! localnet_wait_for_port "$l1_host" "$l1_port" "$startup_timeout"; then
      echo "$log_prefix ERROR: anvil did not become reachable on $l1_host:$l1_port" >&2
      localnet_tail_log 200
      return 1
    fi

    LOCALNET_NODE_RUNNING=1
    LOCALNET_L1_RUNNING=1
    return 0
  fi

  if [[ "$LOCALNET_NODE_RUNNING" -ne 1 || "$LOCALNET_L1_RUNNING" -ne 1 ]]; then
    echo "$log_prefix ERROR: local network auto-start disabled, but $node_host:$node_port or $l1_host:$l1_port is not reachable" >&2
    return 1
  fi
}

function localnet_is_aztec_node_ready() {
  local node_url="$1"
  local ready_response node_info_response

  ready_response="$(curl -sS --max-time 5 \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"node_isReady","params":[]}' \
    "$node_url" 2>/dev/null || true)"
  if ! grep -Eq '"result"[[:space:]]*:[[:space:]]*true' <<< "$ready_response"; then
    return 1
  fi

  node_info_response="$(curl -sS --max-time 5 \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' \
    "$node_url" 2>/dev/null || true)"
  if grep -Eq '"error"[[:space:]]*:' <<< "$node_info_response"; then
    return 1
  fi
  if ! grep -Eq '"result"[[:space:]]*:' <<< "$node_info_response"; then
    return 1
  fi
  if grep -Eq '"result"[[:space:]]*:[[:space:]]*null' <<< "$node_info_response"; then
    return 1
  fi

  return 0
}

function localnet_wait_for_aztec_node_ready() {
  local node_url="$1"
  local timeout_seconds="$2"
  local start_ts
  start_ts="$(date +%s)"

  while true; do
    if localnet_is_aztec_node_ready "$node_url"; then
      return 0
    fi
    if (( "$(date +%s)" - start_ts > timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

function localnet_resolve_reset_state_flag() {
  local provided_value="$1"
  local default_mode="$2"
  local start_local_network="$3"
  local node_running="$4"
  local l1_running="$5"
  local env_name="$6"
  local log_prefix="$7"
  local resolved_value="$provided_value"

  if [[ -z "$resolved_value" ]]; then
    case "$default_mode" in
      always)
        resolved_value="1"
        ;;
      if-starting)
        if [[ "$start_local_network" == "1" && ! ( "$node_running" -eq 1 && "$l1_running" -eq 1 ) ]]; then
          resolved_value="1"
        else
          resolved_value="0"
        fi
        ;;
      never)
        resolved_value="0"
        ;;
      *)
        echo "$log_prefix ERROR: unsupported reset default mode '$default_mode'" >&2
        return 1
        ;;
    esac
  fi

  if [[ "$resolved_value" != "0" && "$resolved_value" != "1" ]]; then
    echo "$log_prefix ERROR: $env_name must be 0 or 1, got '$resolved_value'" >&2
    return 1
  fi

  printf '%s\n' "$resolved_value"
}

function localnet_resolve_timeout_seconds() {
  local provided_value="$1"
  local default_value="$2"
  local env_name="$3"
  local log_prefix="$4"
  local resolved_value="$provided_value"

  if [[ -z "$resolved_value" ]]; then
    resolved_value="$default_value"
  fi

  if [[ ! "$resolved_value" =~ ^[0-9]+$ ]] || [[ "$resolved_value" -le 0 ]]; then
    echo "$log_prefix ERROR: $env_name must be a positive integer (got '$resolved_value')" >&2
    return 1
  fi

  printf '%s\n' "$resolved_value"
}

function localnet_reset_wallet_pxe_state() {
  local repo_root="$1"

  rm -rf "$repo_root"/wallet_data_* "$repo_root"/pxe_data_*
  rm -rf "$repo_root"/services/attestation/wallet_data_* "$repo_root"/services/attestation/pxe_data_*
}
