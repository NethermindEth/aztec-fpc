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
    manifest_path="${FPC_DEPLOY_MANIFEST:-./deployments/devnet-manifest-v2.json}"
    FPC_DEPLOY_MANIFEST="$manifest_path" \
      FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}" \
      FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}" \
      bash scripts/config/generate-service-configs.sh

    if [[ -z "${TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS:-}" && -f "$manifest_path" ]]; then
      sponsored_fpc_address="$(jq -r '.aztec_required_addresses.sponsored_fpc_address // empty' "$manifest_path")"
      if [[ -n "$sponsored_fpc_address" ]]; then
        export TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS="$sponsored_fpc_address"
        echo "[compose-mode] using TOPUP_AUTOCLAIM_SPONSORED_FPC_ADDRESS=$sponsored_fpc_address (from $manifest_path)"
      fi
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
