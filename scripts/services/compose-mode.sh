#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-infra}"
shift || true
EXTRA_ARGS=("$@")

function usage() {
  cat <<'EOF'
Usage: bash scripts/services/compose-mode.sh [infra|full|services-devnet] [docker compose up args...]

Modes:
- infra: start only infra/services (no test profile).
- full: run compose with test profile and fail on smoke test failure.
- services-devnet: generate configs from devnet manifest, then run only attestation+topup compose.

Examples:
  bash scripts/services/compose-mode.sh infra -d
  bash scripts/services/compose-mode.sh full
  bash scripts/services/compose-mode.sh services-devnet -d
EOF
}

function require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[compose-mode] ERROR: missing required command '$1'" >&2
    exit 1
  fi
}

require_cmd docker

case "$MODE" in
infra)
  (
    cd "$REPO_ROOT"
    docker compose up "${EXTRA_ARGS[@]}"
  )
  ;;
services-devnet)
  (
    cd "$REPO_ROOT"
    require_cmd bun
    # Keep preflight env resolution aligned with docker compose runtime values.
    if [[ -f ./.env ]]; then
      set -a
      # shellcheck disable=SC1091
      source ./.env
      set +a
    fi
    manifest_path="${FPC_DEPLOY_MANIFEST:-./deployments/devnet-manifest-v2.json}"
    FPC_DEPLOY_MANIFEST="$manifest_path" \
      FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}" \
      FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}" \
      bash scripts/config/generate-service-configs.sh

    if [[ "${TOPUP_AUTOCLAIM_USE_SPONSORED:-1}" == "0" ]]; then
      export TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS=" "
      echo "[compose-mode] TOPUP_AUTOCLAIM_USE_SPONSORED=0; disabling sponsored auto-claim (fee_juice only)"
    elif [[ -z "${TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS:-}" && -f "$manifest_path" ]]; then
      sponsored_fpc_address="$(jq -r '.aztec_required_addresses.sponsored_fpc_address // empty' "$manifest_path")"
      if [[ -n "$sponsored_fpc_address" ]]; then
        export TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS="$sponsored_fpc_address"
        echo "[compose-mode] using TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS=$sponsored_fpc_address (from $manifest_path)"
      fi
    fi

    export TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY="${TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY:-1}"

    if [[ -f "$manifest_path" ]]; then
      if [[ -n "${TOPUP_AUTOCLAIM_SECRET_KEY:-}" ]]; then
        echo "[compose-mode] using caller-provided TOPUP_AUTOCLAIM_SECRET_KEY (manifest deployment_accounts.l2_deployer.private_key ignored)"
      elif [[ "${TOPUP_AUTOCLAIM_USE_OPERATOR_SECRET_KEY}" == "1" && -n "${OPERATOR_SECRET_KEY:-}" ]]; then
        export TOPUP_AUTOCLAIM_SECRET_KEY="$OPERATOR_SECRET_KEY"
        echo "[compose-mode] using TOPUP_AUTOCLAIM_SECRET_KEY from OPERATOR_SECRET_KEY (.env)"
      else
        l2_deployer_private_key="$(jq -r '.deployment_accounts.l2_deployer.private_key // empty' "$manifest_path")"
        if [[ -n "$l2_deployer_private_key" ]]; then
          echo "[compose-mode] using TOPUP_AUTOCLAIM_SECRET_KEY from deployment_accounts.l2_deployer.private_key (from $manifest_path)"
          export TOPUP_AUTOCLAIM_SECRET_KEY="$l2_deployer_private_key"
        fi
      fi
    fi

    if [[ "${TOPUP_AUTOCLAIM_ENABLED:-1}" != "0" && "${TOPUP_AUTOCLAIM_BOOTSTRAP_ACCOUNT:-0}" == "1" ]]; then
      echo "[compose-mode] bootstrapping auto-claim claimer account before preflight"
      bunx tsx scripts/services/bootstrap-topup-autoclaim-account.ts --manifest "$manifest_path"
    fi

    if [[ "${TOPUP_AUTOCLAIM_ENABLED:-1}" != "0" ]]; then
      echo "[compose-mode] running auto-claim claimer preflight"
      bunx tsx scripts/services/preflight-topup-autoclaim.ts --manifest "$manifest_path"
    fi

    docker compose -f docker-compose.services-devnet.yaml up "${EXTRA_ARGS[@]}"
  )
  ;;
full)
  if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    echo "[compose-mode] ERROR: extra docker compose args are only supported in infra mode" >&2
    exit 1
  fi
  (
    cd "$REPO_ROOT"
    docker compose --profile full up --attach smoke --exit-code-from smoke smoke
  )
  ;;
--help|-h)
  usage
  ;;
*)
  echo "[compose-mode] ERROR: mode must be one of infra|full|services-devnet, got '$MODE'" >&2
  usage
  exit 1
  ;;
esac
