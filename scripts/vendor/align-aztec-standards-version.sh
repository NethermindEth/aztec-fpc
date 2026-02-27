#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUBMODULE_DIR="$REPO_ROOT/vendor/aztec-standards"
TARGET_VERSION="$(tr -d '\n' < "$REPO_ROOT/.aztecrc")"
TARGET_TAG="v${TARGET_VERSION}"

if [[ ! -d "$SUBMODULE_DIR" ]]; then
  echo "[align-aztec-standards] vendor/aztec-standards not found; skipping"
  exit 0
fi

if [[ ! -f "$SUBMODULE_DIR/src/token_contract/Nargo.toml" ]]; then
  echo "[align-aztec-standards] Nargo files missing in vendor/aztec-standards; skipping"
  exit 0
fi

if command -v rg >/dev/null 2>&1; then
  mapfile -t nargo_files < <(rg --files "$SUBMODULE_DIR" -g '**/Nargo.toml')
else
  mapfile -t nargo_files < <(find "$SUBMODULE_DIR" -type f -name 'Nargo.toml')
fi

for file in "${nargo_files[@]}"; do
  if grep -q 'https://github.com/AztecProtocol/aztec-packages/' "$file"; then
    sed -E -i "s#(git = \"https://github.com/AztecProtocol/aztec-packages/\", tag = \")v[^\"]+(\", directory = )#\\1${TARGET_TAG}\\2#g" "$file"
  fi
done

echo "[align-aztec-standards] aligned aztec-packages tags to ${TARGET_TAG}"
