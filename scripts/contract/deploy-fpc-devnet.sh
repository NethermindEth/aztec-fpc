#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

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

cd "${REPO_ROOT}"

if [[ ! -f target/token_contract-Token.json || ! -f target/fpc-FPC.json || ! -f target/credit_fpc-CreditFPC.json ]]; then
  echo "Compiling Aztec workspace artifacts (ephemeral aztec-standards alignment)..."
  bash "$REPO_ROOT/scripts/vendor/run-with-aligned-aztec-standards.sh" -- \
    aztec compile --workspace --force
fi

cmd=(
  bunx tsx scripts/contract/deploy-fpc-devnet.ts
  --node-url "${NODE_URL}"
  --sponsored-fpc-address "${SPONSORED_FPC_ADDRESS}"
  --deployer-alias "${DEPLOYER_ALIAS}"
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
