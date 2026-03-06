#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

function find_inaccessible_dirs() {
  find . -type d \( ! -readable -o ! -executable \) -print 2>/dev/null
}

function is_cleanup_candidate() {
  local dir="$1"
  case "$dir" in
    ./artifacts/* | ./tmp/* | ./pxe_data_* | ./wallet_data_* | ./scripts/*/pxe_data_* | \
      ./scripts/*/wallet_data_* | ./services/*/pxe_data_* | ./services/*/wallet_data_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

mapfile -t inaccessible_dirs < <(find_inaccessible_dirs)

if [[ ${#inaccessible_dirs[@]} -gt 0 ]]; then
  cleanup_candidates=()
  unsupported_inaccessible=()
  for dir in "${inaccessible_dirs[@]}"; do
    if is_cleanup_candidate "$dir"; then
      cleanup_candidates+=("$dir")
    else
      unsupported_inaccessible+=("$dir")
    fi
  done

  if [[ ${#unsupported_inaccessible[@]} -gt 0 ]]; then
    echo "[test-contracts] Found inaccessible directories outside cleanup-safe paths:"
    for dir in "${unsupported_inaccessible[@]}"; do
      echo "  - $dir"
    done
    echo "[test-contracts] Refusing to auto-delete these paths. Fix ownership/permissions and rerun."
    exit 1
  fi

  if [[ ${#cleanup_candidates[@]} -gt 0 ]]; then
    echo "[test-contracts] Found inaccessible ephemeral directories that break aztec compile:"
    for dir in "${cleanup_candidates[@]}"; do
      echo "  - $dir"
    done

    if command -v docker >/dev/null 2>&1; then
      echo "[test-contracts] Attempting cleanup via docker root helper"
      docker run --rm -v "$REPO_ROOT:/repo" alpine:3.20 sh -lc '
        set -eu
        for dir in "$@"; do
          cleaned="${dir#./}"
          rm -rf "/repo/$cleaned" || true
        done
      ' cleanup "${cleanup_candidates[@]}"
    else
      echo "[test-contracts] docker is not available; cannot auto-clean inaccessible directories"
    fi
  fi

  mapfile -t inaccessible_after_cleanup < <(find_inaccessible_dirs)
  if [[ ${#inaccessible_after_cleanup[@]} -gt 0 ]]; then
    echo "[test-contracts] Still inaccessible after cleanup attempt:"
    for dir in "${inaccessible_after_cleanup[@]}"; do
      echo "  - $dir"
    done
    echo "[test-contracts] Fix ownership/permissions, then rerun. Example:"
    echo "  sudo chown -R \$USER:\$USER ./artifacts ./tmp"
    exit 1
  fi
fi

aztec compile --workspace --force
aztec test --package fpc
