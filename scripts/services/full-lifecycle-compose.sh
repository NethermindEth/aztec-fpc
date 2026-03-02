#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-both}"

function usage() {
  cat <<'EOF'
Usage: bash scripts/services/full-lifecycle-compose.sh [fpc|credit|both]

Runs compose-backed full-lifecycle E2E using docker-compose profiles:
- e2e-fpc
- e2e-credit

Artifacts are written under:
- artifacts/compose-e2e/fpc
- artifacts/compose-e2e/credit
EOF
}

function require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[compose-full-lifecycle] ERROR: missing required command '$1'" >&2
    exit 1
  fi
}

function run_variant() {
  local name="$1"
  local profile="$2"
  local service="$3"
  local artifact_subdir="$4"
  local artifact_dir="$REPO_ROOT/artifacts/compose-e2e/$artifact_subdir"
  local compose_log="$artifact_dir/compose.log"
  local status=0

  mkdir -p "$artifact_dir"

  echo "[compose-full-lifecycle] running variant=$name profile=$profile service=$service"
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true

  set +e
  (
    cd "$REPO_ROOT"
    docker compose --profile "$profile" up --attach "$service" --exit-code-from "$service" "$service"
  )
  status=$?
  set -e

  (
    cd "$REPO_ROOT"
    docker compose --profile "$profile" logs --no-color >"$compose_log" 2>&1
  ) || true
  (
    cd "$REPO_ROOT"
    docker compose down -v --remove-orphans
  ) || true

  if [[ $status -ne 0 ]]; then
    echo "[compose-full-lifecycle] FAIL variant=$name (compose_log=$compose_log)"
    return "$status"
  fi

  echo "[compose-full-lifecycle] PASS variant=$name (compose_log=$compose_log)"
}

if [[ "${MODE}" == "--help" || "${MODE}" == "-h" ]]; then
  usage
  exit 0
fi

require_cmd docker

case "$MODE" in
fpc)
  run_variant "fpc" "e2e-fpc" "e2e-fpc" "fpc"
  ;;
credit)
  run_variant "credit" "e2e-credit" "e2e-credit" "credit"
  ;;
both)
  run_variant "fpc" "e2e-fpc" "e2e-fpc" "fpc"
  run_variant "credit" "e2e-credit" "e2e-credit" "credit"
  ;;
*)
  echo "[compose-full-lifecycle] ERROR: mode must be one of fpc|credit|both, got '$MODE'" >&2
  usage
  exit 1
  ;;
esac
