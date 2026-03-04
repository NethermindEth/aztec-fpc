#!/usr/bin/env bash
#
# deploy-fpc-local-mode.sh
#
# Starts a local Aztec node + anvil, then runs the FPC deploy flow via
# deploy-fpc.sh.  Intended for standalone local development (outside
# docker-compose, which manages its own node).
#
# Environment variables (all optional):
#   FPC_LOCAL_DEPLOYER_ALIAS          default: test0
#   FPC_LOCAL_DEPLOYER_SECRET_KEY     default: sandbox test account #0
#   FPC_LOCAL_OPERATOR_SECRET_KEY     default: sandbox test account #0
#   FPC_LOCAL_DATA_DIR                default: ./tmp/local-deploy
#   FPC_LOCAL_OUT                     manifest output override (default: $FPC_LOCAL_DATA_DIR/manifest.json)
#   FPC_LOCAL_ACCEPTED_ASSET          skip Token deploy if set
#   FPC_LOCAL_STRICT_CONFIG_GEN       set to 1 to fail if config gen fails
#   PXE_PROVER                        default: wasm
#   CRS_PATH                          default: $HOME/.bb-crs
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

source "$REPO_ROOT/scripts/common/node-setup.sh"

ensure_tool_on_path() {
  local tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    return 0
  fi

  local candidate
  for candidate in \
    "/snap/bin/$tool" \
    "/usr/local/bin/$tool" \
    "/usr/bin/$tool" \
    "/bin/$tool" \
    "/opt/homebrew/bin/$tool" \
    "/home/linuxbrew/.linuxbrew/bin/$tool"; do
    if [[ -x "$candidate" ]]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      return 0
    fi
  done

  return 1
}

export PXE_PROVER="${PXE_PROVER:-wasm}"
export CRS_PATH="${CRS_PATH:-$HOME/.bb-crs}"
mkdir -p "$CRS_PATH"
echo "[deploy-fpc-local] prover backend: PXE_PROVER=${PXE_PROVER} CRS_PATH=${CRS_PATH}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-fpc-local.XXXXXX")"
setup_require_cmds "[deploy-fpc-local]" aztec bun node curl

cd "$REPO_ROOT"

setup_node \
  --log-prefix "[deploy-fpc-local]" \
  --repo-root "$REPO_ROOT" \
  --tmp-dir "$TMP_DIR" \
  --reset-mode "if-starting"

# ── Map FPC_LOCAL_* → FPC_* so deploy-fpc.sh / the TS script picks them up ──
LOCAL_TEST_KEY="0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281"

export FPC_NODE_URL="${AZTEC_NODE_URL}"
export FPC_L1_RPC_URL="${L1_RPC_URL}"
export FPC_DEPLOYER_ALIAS="${FPC_LOCAL_DEPLOYER_ALIAS:-test0}"
export FPC_DEPLOYER_SECRET_KEY="${FPC_LOCAL_DEPLOYER_SECRET_KEY:-$LOCAL_TEST_KEY}"
export FPC_OPERATOR_SECRET_KEY="${FPC_LOCAL_OPERATOR_SECRET_KEY:-$LOCAL_TEST_KEY}"
export FPC_DATA_DIR="${FPC_LOCAL_DATA_DIR:-./tmp/local-deploy}"
export FPC_OUT="${FPC_LOCAL_OUT:-$FPC_DATA_DIR/manifest.json}"

if [[ -n "${FPC_LOCAL_ACCEPTED_ASSET:-}" ]]; then
  export FPC_ACCEPTED_ASSET="${FPC_LOCAL_ACCEPTED_ASSET}"
fi

# ── Run the deploy (skip built-in config gen; local mode handles it below) ──
FPC_SKIP_CONFIG_GEN=1 bash "$SCRIPT_DIR/deploy-fpc.sh" "$@"

# ── Config generation (best-effort unless strict) ──
OUT_PATH="${FPC_OUT}"
FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-$FPC_DATA_DIR/fpc-config.yaml}"

if [[ -f "$OUT_PATH" && -f "$FPC_MASTER_CONFIG" ]]; then
  if ensure_tool_on_path jq && ensure_tool_on_path yq; then
    if ! FPC_DATA_DIR="$FPC_DATA_DIR" \
      FPC_DEPLOY_MANIFEST="$OUT_PATH" \
      FPC_MASTER_CONFIG="$FPC_MASTER_CONFIG" \
      bash scripts/config/generate-service-configs.sh; then
      if [[ "${FPC_LOCAL_STRICT_CONFIG_GEN:-0}" == "1" ]]; then
        echo "[deploy-fpc-local] ERROR: service config generation failed and strict mode is enabled (FPC_LOCAL_STRICT_CONFIG_GEN=1)" >&2
        exit 1
      fi
      echo "[deploy-fpc-local] WARN: service config generation failed; deployment manifest is still valid at $OUT_PATH" >&2
    fi
  else
    if [[ "${FPC_LOCAL_STRICT_CONFIG_GEN:-0}" == "1" ]]; then
      echo "[deploy-fpc-local] ERROR: service config generation requires jq and yq in PATH (strict mode enabled)" >&2
      exit 1
    fi
    echo "[deploy-fpc-local] WARN: skipping service config generation because jq/yq are not both available in PATH" >&2
  fi
fi
