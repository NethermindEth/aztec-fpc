#!/usr/bin/env bash

function _collect_listener_pids() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    local port=""
    for port in "$@"; do
      lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    done | sort -u
    return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    local port=""
    for port in "$@"; do
      ss -ltnp "( sport = :$port )" 2>/dev/null \
        | sed -n 's/.*pid=\([0-9]\+\).*/\1/p'
    done | sort -u
    return 0
  fi
}

function test_cleanup_kill_listener_ports() {
  local log_prefix="$1"
  shift
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local pids
  pids="$(_collect_listener_pids "$@" | tr '\n' ' ' | xargs)"
  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  echo "$log_prefix Cleanup: stopping listeners on ports ($*) [pids: $pids]"
  kill $pids >/dev/null 2>&1 || true
  sleep 1

  local remaining
  remaining="$(_collect_listener_pids "$@" | tr '\n' ' ' | xargs)"
  if [[ -n "${remaining:-}" ]]; then
    echo "$log_prefix Cleanup: force-stopping remaining listener pids: $remaining"
    kill -9 $remaining >/dev/null 2>&1 || true
  fi
}

function test_cleanup_reset_state() {
  local log_prefix="$1"
  local repo_root="$2"

  echo "$log_prefix Cleanup: removing persisted wallet/PXE state"
  rm -rf "$repo_root"/wallet_data_* "$repo_root"/pxe_data_*
  rm -rf "$repo_root"/scripts/wallet_data_* "$repo_root"/scripts/pxe_data_*
  rm -rf "$repo_root"/services/attestation/wallet_data_* "$repo_root"/services/attestation/pxe_data_*
  rm -f "$repo_root"/.topup-bridge-state.json
  rm -f "$repo_root"/services/topup/.topup-bridge-state.json
}
