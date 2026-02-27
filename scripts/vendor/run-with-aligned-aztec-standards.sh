#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUBMODULE_DIR="$REPO_ROOT/vendor/aztec-standards"
ALIGN_SCRIPT="$SCRIPT_DIR/align-aztec-standards-version.sh"

if [[ "${1:-}" != "--" ]]; then
  echo "Usage: $0 -- <command> [args...]" >&2
  exit 1
fi
shift

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 -- <command> [args...]" >&2
  exit 1
fi

if [[ ! -d "$SUBMODULE_DIR/.git" && ! -f "$SUBMODULE_DIR/.git" ]]; then
  echo "[run-with-aligned-aztec-standards] vendor/aztec-standards not found; running command without alignment" >&2
  "$@"
  exit $?
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aztec-standards-align.XXXXXX")"
cleanup() {
  if [[ -d "$TMP_DIR/backup" ]]; then
    (
      cd "$SUBMODULE_DIR"
      while IFS= read -r rel; do
        mkdir -p "$(dirname "$rel")"
        cp "$TMP_DIR/backup/$rel" "$rel"
      done < "$TMP_DIR/files.list"
    )
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

(
  cd "$SUBMODULE_DIR"
  git ls-files '*Nargo.toml' > "$TMP_DIR/files.list"
  while IFS= read -r rel; do
    mkdir -p "$TMP_DIR/backup/$(dirname "$rel")"
    cp "$rel" "$TMP_DIR/backup/$rel"
  done < "$TMP_DIR/files.list"
)

bash "$ALIGN_SCRIPT"
"$@"
