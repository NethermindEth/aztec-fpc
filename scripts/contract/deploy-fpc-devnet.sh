#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

MODE="${FPC_DEPLOY_ENV:-devnet}"

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

resolve_default_fpc_artifact() {
  if [[ -n "${FPC_FPC_ARTIFACT:-}" ]]; then
    printf "%s\n" "${FPC_FPC_ARTIFACT}"
    return
  fi

  local multi_asset_path="$REPO_ROOT/target/fpc-FPCMultiAsset.json"
  if [[ -f "$multi_asset_path" ]]; then
    printf "%s\n" "$multi_asset_path"
    return
  fi
  printf "%s\n" "$multi_asset_path"
}

case "${FPC_VARIANT:-}" in
  "")
    FPC_ARTIFACT="$(resolve_default_fpc_artifact)"
    ;;
  fpc)
    FPC_ARTIFACT="$REPO_ROOT/target/fpc-FPCMultiAsset.json"
    ;;
  credit)
    FPC_ARTIFACT="$REPO_ROOT/target/credit_fpc-BackedCreditFPC.json"
    ;;
  *)
    echo "ERROR: FPC_VARIANT must be 'fpc' or 'credit' (got '${FPC_VARIANT}')" >&2
    exit 1
    ;;
esac

if [[ "$MODE" != "devnet" && "$MODE" != "local" ]]; then
  echo "ERROR: FPC_DEPLOY_ENV must be 'devnet' or 'local' (got '$MODE')" >&2
  exit 1
fi

cd "${REPO_ROOT}"

if [[ ! -f target/token_contract-Token.json || ! -f target/credit_fpc-BackedCreditFPC.json || ! -f target/fpc-FPCMultiAsset.json ]]; then
  echo "Compiling Aztec workspace artifacts..."
  aztec compile --workspace --force
  if [[ -z "${FPC_VARIANT:-}" ]]; then
    FPC_ARTIFACT="$(resolve_default_fpc_artifact)"
  fi
fi

if [[ "$MODE" == "local" ]]; then
  source "$REPO_ROOT/scripts/common/node-setup.sh"

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-fpc-local.XXXXXX")"
  setup_require_cmds "[deploy-fpc-local]" aztec bun node curl

  setup_node \
    --log-prefix "[deploy-fpc-local]" \
    --repo-root "$REPO_ROOT" \
    --tmp-dir "$TMP_DIR" \
    --reset-mode "if-starting"

  NODE_URL="$AZTEC_NODE_URL"
  OUT_PATH="${FPC_LOCAL_OUT:-./tmp/deploy-fpc-local-manifest.json}"
  # Defaults match aztec local-network TEST_ACCOUNTS account #0.
  DEPLOYER_ALIAS="${FPC_LOCAL_DEPLOYER_ALIAS:-test0}"
  DEPLOYER_PRIVATE_KEY="${FPC_LOCAL_DEPLOYER_PRIVATE_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"
  OPERATOR_SECRET_KEY="${FPC_LOCAL_OPERATOR_SECRET_KEY:-0x2153536ff6628eee01cf4024889ff977a18d9fa61d0e414422f7681cf085c281}"

  cmd=(
    bunx tsx scripts/contract/deploy-fpc-devnet.ts
    --environment local
    --node-url "${NODE_URL}"
    --l1-rpc-url "${L1_RPC_URL}"
    --deployer-alias "${DEPLOYER_ALIAS}"
    --deployer-private-key "${DEPLOYER_PRIVATE_KEY}"
    --operator-secret-key "${OPERATOR_SECRET_KEY}"
    --fpc-artifact "${FPC_ARTIFACT}"
    --out "${OUT_PATH}"
  )

  if [[ -n "${FPC_LOCAL_ACCEPTED_ASSET:-}" ]]; then
    cmd+=(--accepted-asset "${FPC_LOCAL_ACCEPTED_ASSET}")
  fi

  cmd+=("$@")
  "${cmd[@]}"

  FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}"
  if [[ -f "$OUT_PATH" && -f "$FPC_MASTER_CONFIG" ]]; then
    if ensure_tool_on_path jq && ensure_tool_on_path yq; then
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
