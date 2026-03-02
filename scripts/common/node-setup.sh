#!/usr/bin/env bash
#
# scripts/common/node-setup.sh
#
# Shared utility for setting up a local aztec node + anvil (L1).
# Provides a single setup_node call that handles config resolution,
# cleanup traps, state reset, network start-or-reuse, and RPC readiness.
#
# Env vars:
#   AZTEC_NODE_URL  — if set, reuse external node (don't start local)
#   L1_RPC_URL      — if set, reuse external L1 (don't start local)
#
# When neither is set, a local network is started at the defaults
# (http://127.0.0.1:8080 and http://127.0.0.1:8545).

_NODESETUP_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_NODESETUP_INITIALIZED=0

_NODESETUP_LOG_PREFIX=""
_NODESETUP_REPO_ROOT=""
_NODESETUP_TMP_DIR=""
_NODESETUP_NODE_PORT=""
_NODESETUP_L1_PORT=""
_NODESETUP_STARTED_LOCAL=0

function _nodesetup_parse_host_port() {
  local url="$1"
  local stripped="${url#http://}"
  stripped="${stripped#https://}"
  stripped="${stripped%%/*}"
  local host="${stripped%%:*}"
  local port="${stripped##*:}"
  if [[ "$port" == "$host" ]]; then
    port="80"
  fi
  printf '%s %s\n' "$host" "$port"
}

function _nodesetup_cleanup() {
  if [[ "$_NODESETUP_STARTED_LOCAL" -eq 1 ]]; then
    localnet_stop_started "$_NODESETUP_LOG_PREFIX"
    test_cleanup_kill_listener_ports \
      "$_NODESETUP_LOG_PREFIX" \
      "$_NODESETUP_NODE_PORT" \
      "$_NODESETUP_L1_PORT" \
      3000 \
      3001 \
      3300 \
      3401
    test_cleanup_reset_state "$_NODESETUP_LOG_PREFIX" "$_NODESETUP_REPO_ROOT"
  fi
  rm -rf "$_NODESETUP_TMP_DIR"
}

function setup_require_cmds() {
  local log_prefix="$1"
  shift
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "$log_prefix ERROR: missing required command '$cmd'" >&2
      exit 1
    fi
  done
}

# setup_node — one-call setup for local aztec node + anvil.
#
# Usage:
#   setup_node \
#     --log-prefix "[smoke]" \
#     --repo-root "$REPO_ROOT" \
#     --tmp-dir "$TMP_DIR" \
#     --reset-mode "always"
#
# After calling, AZTEC_NODE_URL and L1_RPC_URL are set and exported.
function setup_node() {
  local log_prefix="" repo_root="" tmp_dir="" reset_mode="always"

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --log-prefix)
        log_prefix="$2"
        shift 2
        ;;
      --repo-root)
        repo_root="$2"
        shift 2
        ;;
      --tmp-dir)
        tmp_dir="$2"
        shift 2
        ;;
      --reset-mode)
        reset_mode="$2"
        shift 2
        ;;
      *)
        echo "setup_node: unknown argument '$1'" >&2
        return 1
        ;;
    esac
  done

  if [[ -z "$log_prefix" || -z "$repo_root" || -z "$tmp_dir" ]]; then
    echo "setup_node: --log-prefix, --repo-root, and --tmp-dir are required" >&2
    return 1
  fi

  # Store state for cleanup
  _NODESETUP_LOG_PREFIX="$log_prefix"
  _NODESETUP_REPO_ROOT="$repo_root"
  _NODESETUP_TMP_DIR="$tmp_dir"

  # Determine whether to start local network based on env vars
  local start_local_network="1"
  local default_node_url="http://127.0.0.1:8080"
  local default_l1_rpc_url="http://127.0.0.1:8545"

  if [[ -n "${AZTEC_NODE_URL:-}" || -n "${L1_RPC_URL:-}" ]]; then
    start_local_network="0"
  fi

  AZTEC_NODE_URL="${AZTEC_NODE_URL:-$default_node_url}"
  L1_RPC_URL="${L1_RPC_URL:-$default_l1_rpc_url}"
  export AZTEC_NODE_URL L1_RPC_URL

  # ── External network mode: just export URLs, no local lifecycle ──
  if [[ "$start_local_network" == "0" ]]; then
    echo "$log_prefix Using external network: AZTEC_NODE_URL=$AZTEC_NODE_URL L1_RPC_URL=$L1_RPC_URL"
    _NODESETUP_INITIALIZED=1
    return 0
  fi

  # ── Local network mode: source helpers, manage lifecycle ──
  # local-network.sh and test-cleanup.sh require tools (ps, lsof/ss) that
  # may not be present in slim Docker images, so only source them when we
  # actually need to manage a local network.
  source "$_NODESETUP_COMMON_DIR/local-network.sh"
  source "$_NODESETUP_COMMON_DIR/test-cleanup.sh"

  # Parse host:port from URLs
  local node_hp l1_hp
  node_hp="$(_nodesetup_parse_host_port "$AZTEC_NODE_URL")"
  l1_hp="$(_nodesetup_parse_host_port "$L1_RPC_URL")"
  local node_host="${node_hp%% *}"
  local node_port="${node_hp##* }"
  local l1_host="${l1_hp%% *}"
  local l1_port="${l1_hp##* }"

  _NODESETUP_NODE_PORT="$node_port"
  _NODESETUP_L1_PORT="$l1_port"
  _NODESETUP_STARTED_LOCAL=1

  # Install cleanup trap
  trap _nodesetup_cleanup EXIT
  trap 'exit 130' INT TERM

  # Port status check
  local node_running=0 l1_running=0
  if localnet_has_port "$node_host" "$node_port"; then
    node_running=1
  fi
  if localnet_has_port "$l1_host" "$l1_port"; then
    l1_running=1
  fi

  # State reset
  local reset_value
  reset_value="$(
    localnet_resolve_reset_state_flag \
      "" \
      "$reset_mode" \
      "$start_local_network" \
      "$node_running" \
      "$l1_running" \
      "RESET_LOCAL_STATE" \
      "$log_prefix"
  )"
  if [[ "$reset_value" == "1" ]]; then
    echo "$log_prefix Resetting local wallet/PXE state"
    localnet_reset_wallet_pxe_state "$repo_root"
  fi

  # Start or reuse network
  if ! localnet_start_or_reuse \
    "$log_prefix" \
    "$start_local_network" \
    "$node_host" \
    "$node_port" \
    "$l1_host" \
    "$l1_port" \
    "$tmp_dir/aztec-local-network.log" \
    "90"; then
    exit 1
  fi

  # Wait for JSON-RPC readiness
  echo "$log_prefix Waiting for Aztec JSON-RPC readiness at $AZTEC_NODE_URL (timeout 90s)"
  if ! localnet_wait_for_aztec_node_ready "$AZTEC_NODE_URL" "90"; then
    echo "$log_prefix ERROR: Aztec node not ready at $AZTEC_NODE_URL within 90s" >&2
    localnet_tail_log 200
    exit 1
  fi
  echo "$log_prefix Aztec node ready at $AZTEC_NODE_URL"

  _NODESETUP_INITIALIZED=1
}

function setup_node_url() {
  printf '%s\n' "$AZTEC_NODE_URL"
}

function setup_l1_rpc_url() {
  printf '%s\n' "$L1_RPC_URL"
}
