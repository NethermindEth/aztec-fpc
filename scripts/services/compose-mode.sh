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
    FPC_DEPLOY_MANIFEST="${FPC_DEPLOY_MANIFEST:-./deployments/devnet-manifest-v2.json}" \
      FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}" \
      FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}" \
      bash scripts/config/generate-service-configs.sh
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
