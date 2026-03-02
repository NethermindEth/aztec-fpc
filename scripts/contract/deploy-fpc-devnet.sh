#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

MODE="${FPC_DEPLOY_ENV:-devnet}"
FPC_ARTIFACT="${FPC_FPC_ARTIFACT:-$REPO_ROOT/target/fpc-FPC.json}"

if [[ "$MODE" != "devnet" && "$MODE" != "local" ]]; then
  echo "ERROR: FPC_DEPLOY_ENV must be 'devnet' or 'local' (got '$MODE')" >&2
  exit 1
fi

cd "${REPO_ROOT}"

if [[ ! -f target/token_contract-Token.json || ! -f target/fpc-FPC.json || ! -f target/credit_fpc-CreditFPC.json ]]; then
  echo "Compiling Aztec workspace artifacts..."
  aztec compile --workspace --force
fi

if [[ "$MODE" == "local" ]]; then
  source "$REPO_ROOT/scripts/common/test-cleanup.sh"
  source "$REPO_ROOT/scripts/common/local-network.sh"

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-fpc-local.XXXXXX")"

  function cleanup() {
    local node_port="${NODE_PORT:-${FPC_LOCAL_DEPLOY_NODE_PORT:-8080}}"
    local l1_port="${L1_PORT:-${FPC_LOCAL_DEPLOY_L1_PORT:-8545}}"
    local attestation_port="${FPC_SERVICES_SMOKE_ATTESTATION_PORT:-3300}"
    local topup_ops_port="${FPC_SERVICES_SMOKE_TOPUP_OPS_PORT:-3401}"

    localnet_stop_started "[deploy-fpc-local]"
    test_cleanup_kill_listener_ports \
      "[deploy-fpc-local]" \
      "$node_port" \
      "$l1_port" \
      "$attestation_port" \
      "$topup_ops_port" \
      3000 \
      3001
    test_cleanup_reset_state "[deploy-fpc-local]" "$REPO_ROOT"
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  for cmd in aztec bun node curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "[deploy-fpc-local] ERROR: missing required command '$cmd'" >&2
      exit 1
    fi
  done

  NODE_HOST="${FPC_LOCAL_DEPLOY_NODE_HOST:-127.0.0.1}"
  NODE_PORT="${FPC_LOCAL_DEPLOY_NODE_PORT:-8080}"
  L1_HOST="${FPC_LOCAL_DEPLOY_L1_HOST:-127.0.0.1}"
  L1_PORT="${FPC_LOCAL_DEPLOY_L1_PORT:-8545}"
  START_LOCAL_NETWORK="${FPC_LOCAL_DEPLOY_START_LOCAL_NETWORK:-1}"
  STARTUP_TIMEOUT_SECONDS="$(
    localnet_resolve_timeout_seconds \
      "${FPC_LOCAL_DEPLOY_STARTUP_TIMEOUT_SECONDS:-${FPC_LOCAL_NETWORK_STARTUP_TIMEOUT_SECONDS:-}}" \
      "90" \
      "FPC_LOCAL_DEPLOY_STARTUP_TIMEOUT_SECONDS or FPC_LOCAL_NETWORK_STARTUP_TIMEOUT_SECONDS" \
      "[deploy-fpc-local]"
  )"
  RPC_READY_TIMEOUT_SECONDS="$(
    localnet_resolve_timeout_seconds \
      "${FPC_LOCAL_DEPLOY_RPC_READY_TIMEOUT_SECONDS:-${FPC_LOCAL_NETWORK_RPC_READY_TIMEOUT_SECONDS:-}}" \
      "90" \
      "FPC_LOCAL_DEPLOY_RPC_READY_TIMEOUT_SECONDS or FPC_LOCAL_NETWORK_RPC_READY_TIMEOUT_SECONDS" \
      "[deploy-fpc-local]"
  )"
  NODE_RUNNING=0
  L1_RUNNING=0
  if localnet_has_port "$NODE_HOST" "$NODE_PORT"; then
    NODE_RUNNING=1
  fi
  if localnet_has_port "$L1_HOST" "$L1_PORT"; then
    L1_RUNNING=1
  fi
  RESET_LOCAL_STATE="$(
    localnet_resolve_reset_state_flag \
      "${FPC_LOCAL_DEPLOY_RESET_LOCAL_STATE:-}" \
      "if-starting" \
      "$START_LOCAL_NETWORK" \
      "$NODE_RUNNING" \
      "$L1_RUNNING" \
      "FPC_LOCAL_DEPLOY_RESET_LOCAL_STATE" \
      "[deploy-fpc-local]"
  )"
  if [[ "$RESET_LOCAL_STATE" == "1" ]]; then
    echo "[deploy-fpc-local] Resetting wallet/PXE local state"
    localnet_reset_wallet_pxe_state "$REPO_ROOT"
  fi

  if ! localnet_start_or_reuse \
    "[deploy-fpc-local]" \
    "$START_LOCAL_NETWORK" \
    "$NODE_HOST" \
    "$NODE_PORT" \
    "$L1_HOST" \
    "$L1_PORT" \
    "$TMP_DIR/aztec-local-network.log" \
    "$STARTUP_TIMEOUT_SECONDS"; then
    exit 1
  fi

  NODE_URL="${AZTEC_NODE_URL:-http://${NODE_HOST}:${NODE_PORT}}"
  echo "[deploy-fpc-local] Waiting for Aztec JSON-RPC readiness at $NODE_URL (timeout ${RPC_READY_TIMEOUT_SECONDS}s)"
  if ! localnet_wait_for_aztec_node_ready "$NODE_URL" "$RPC_READY_TIMEOUT_SECONDS"; then
    echo "[deploy-fpc-local] ERROR: Aztec node did not become ready at $NODE_URL within ${RPC_READY_TIMEOUT_SECONDS}s" >&2
    localnet_tail_log 200
    exit 1
  fi

  L1_RPC_URL="${L1_RPC_URL:-http://${L1_HOST}:${L1_PORT}}"
  OUT_PATH="${FPC_LOCAL_OUT:-./tmp/deploy-fpc-local-manifest.json}"
  OPERATOR="${FPC_LOCAL_OPERATOR:-0x089323ce9a610e9f013b661ce80dde444b554e9f6ed9f5167adb234668f0af72}"

  cmd=(
    bunx tsx scripts/contract/deploy-fpc-devnet.ts
    --environment local
    --node-url "${NODE_URL}"
    --l1-rpc-url "${L1_RPC_URL}"
    --operator "${OPERATOR}"
    --fpc-artifact "${FPC_ARTIFACT}"
    --out "${OUT_PATH}"
  )

  if [[ "${FPC_LOCAL_REUSE:-0}" == "1" ]]; then
    cmd+=(--reuse)
  fi
  if [[ -n "${FPC_LOCAL_ACCEPTED_ASSET:-}" ]]; then
    cmd+=(--accepted-asset "${FPC_LOCAL_ACCEPTED_ASSET}")
  fi

  cmd+=("$@")
  "${cmd[@]}"

  FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}"
  if [[ -f "$OUT_PATH" && -f "$FPC_MASTER_CONFIG" ]]; then
    if command -v jq >/dev/null 2>&1 && command -v yq >/dev/null 2>&1; then
      if ! FPC_DEPLOY_MANIFEST="$OUT_PATH" \
        FPC_MASTER_CONFIG="$FPC_MASTER_CONFIG" \
        FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}" \
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

  exit 0
fi

NODE_URL="${FPC_DEVNET_NODE_URL:-https://v4-devnet-2.aztec-labs.com/}"
SPONSORED_FPC_ADDRESS="${FPC_DEVNET_SPONSORED_FPC_ADDRESS:-0x09a4df73aa47f82531a038d1d51abfc85b27665c4b7ca751e2d4fa9f19caffb2}"
DEPLOYER_ALIAS="${FPC_DEVNET_DEPLOYER_ALIAS:-my-wallet}"
OUT_PATH="${FPC_DEVNET_OUT:-./deployments/devnet-manifest-v2.json}"
DEFAULT_TEST_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"

DEPLOYER_PRIVATE_KEY="${FPC_DEVNET_DEPLOYER_PRIVATE_KEY:-}"
DEPLOYER_PRIVATE_KEY_REF="${FPC_DEVNET_DEPLOYER_PRIVATE_KEY_REF:-}"
OPERATOR_SECRET_KEY="${FPC_DEVNET_OPERATOR_SECRET_KEY:-}"
OPERATOR_SECRET_KEY_REF="${FPC_DEVNET_OPERATOR_SECRET_KEY_REF:-}"

if [[ -n "${DEPLOYER_PRIVATE_KEY}" && -n "${DEPLOYER_PRIVATE_KEY_REF}" ]]; then
  echo "ERROR: Set only one of FPC_DEVNET_DEPLOYER_PRIVATE_KEY or FPC_DEVNET_DEPLOYER_PRIVATE_KEY_REF" >&2
  exit 1
fi
if [[ -z "${DEPLOYER_PRIVATE_KEY}" && -z "${DEPLOYER_PRIVATE_KEY_REF}" ]]; then
  DEPLOYER_PRIVATE_KEY="${DEFAULT_TEST_KEY}"
  echo "WARN: No deployer key provided. Using default devnet test key." >&2
fi
if [[ -n "${OPERATOR_SECRET_KEY}" && -n "${OPERATOR_SECRET_KEY_REF}" ]]; then
  echo "ERROR: Set only one of FPC_DEVNET_OPERATOR_SECRET_KEY or FPC_DEVNET_OPERATOR_SECRET_KEY_REF" >&2
  exit 1
fi
if [[ -z "${OPERATOR_SECRET_KEY}" && -z "${OPERATOR_SECRET_KEY_REF}" ]]; then
  if [[ -n "${DEPLOYER_PRIVATE_KEY}" ]]; then
    OPERATOR_SECRET_KEY="${DEPLOYER_PRIVATE_KEY}"
  else
    OPERATOR_SECRET_KEY="${DEFAULT_TEST_KEY}"
  fi
  echo "WARN: No operator key provided. Using deployer key as operator key for devnet." >&2
fi

cmd=(
  bunx tsx scripts/contract/deploy-fpc-devnet.ts
  --environment devnet
  --node-url "${NODE_URL}"
  --sponsored-fpc-address "${SPONSORED_FPC_ADDRESS}"
  --deployer-alias "${DEPLOYER_ALIAS}"
  --fpc-artifact "${FPC_ARTIFACT}"
  --out "${OUT_PATH}"
)

if [[ -n "${DEPLOYER_PRIVATE_KEY}" ]]; then
  cmd+=(--deployer-private-key "${DEPLOYER_PRIVATE_KEY}")
else
  cmd+=(--deployer-private-key-ref "${DEPLOYER_PRIVATE_KEY_REF}")
fi

if [[ -n "${OPERATOR_SECRET_KEY}" ]]; then
  cmd+=(--operator-secret-key "${OPERATOR_SECRET_KEY}")
else
  cmd+=(--operator-secret-key-ref "${OPERATOR_SECRET_KEY_REF}")
fi

if [[ -n "${FPC_DEVNET_L1_RPC_URL:-}" ]]; then
  cmd+=(--l1-rpc-url "${FPC_DEVNET_L1_RPC_URL}")
fi
if [[ "${FPC_DEVNET_VALIDATE_TOPUP_PATH:-0}" == "1" ]]; then
  cmd+=(--validate-topup-path)
fi
if [[ -n "${FPC_DEVNET_ACCEPTED_ASSET:-}" ]]; then
  cmd+=(--accepted-asset "${FPC_DEVNET_ACCEPTED_ASSET}")
fi
if [[ "${FPC_DEVNET_PREFLIGHT_ONLY:-0}" == "1" ]]; then
  cmd+=(--preflight-only)
fi

cmd+=("$@")
"${cmd[@]}"
