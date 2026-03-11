#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBMODULE_PATH="${1:-vendor/aztec-standards}"
REFRESH_CMD="git submodule sync --recursive && git submodule update --init --recursive"

cd "$REPO_ROOT"

status_line="$(git submodule status -- "$SUBMODULE_PATH" 2>/dev/null || true)"
if [[ -z "$status_line" ]]; then
  echo "[submodule-check] ERROR: '$SUBMODULE_PATH' is not registered as a submodule in this repo." >&2
  exit 1
fi

status_prefix="${status_line:0:1}"
expected_tag="$(tr -d '[:space:]' < "$REPO_ROOT/.aztecrc")"
actual_commit="$(git -C "$SUBMODULE_PATH" rev-parse HEAD 2>/dev/null || true)"
actual_tag="$(git -C "$SUBMODULE_PATH" describe --tags --exact-match HEAD 2>/dev/null || true)"

case "$status_prefix" in
  "-")
    echo "[submodule-check] ERROR: '$SUBMODULE_PATH' is not initialized." >&2
    echo "[submodule-check] Run: $REFRESH_CMD" >&2
    exit 1
    ;;
  "U")
    echo "[submodule-check] ERROR: '$SUBMODULE_PATH' has merge conflicts." >&2
    exit 1
    ;;
esac

if [[ -z "$expected_tag" || -z "$actual_commit" ]]; then
  echo "[submodule-check] ERROR: could not resolve the expected tag or actual commit for '$SUBMODULE_PATH'." >&2
  exit 1
fi

if [[ "$actual_tag" != "$expected_tag" ]]; then
  echo "[submodule-check] ERROR: '$SUBMODULE_PATH' is checked out at $actual_commit (tag: ${actual_tag:-none}), but this repo expects tag '$expected_tag'." >&2
  echo "[submodule-check] Run: $REFRESH_CMD" >&2
  exit 1
fi
