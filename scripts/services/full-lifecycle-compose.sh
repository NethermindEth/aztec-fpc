#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ARTIFACT_DIR="$REPO_ROOT/artifacts/compose-e2e/fpc"
COMPOSE_LOG="$ARTIFACT_DIR/compose.log"

if ! command -v docker >/dev/null 2>&1; then
  echo "[compose-full-lifecycle] ERROR: missing required command 'docker'" >&2
  exit 1
fi

mkdir -p "$ARTIFACT_DIR"

echo "[compose-full-lifecycle] running profile=e2e-fpc service=e2e-fpc"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true

set +e
(
  cd "$REPO_ROOT"
  docker compose --profile "e2e-fpc" up --attach "e2e-fpc" --exit-code-from "e2e-fpc" "e2e-fpc"
)
status=$?
set -e

(
  cd "$REPO_ROOT"
  docker compose --profile "e2e-fpc" logs --no-color >"$COMPOSE_LOG" 2>&1
) || true
(
  cd "$REPO_ROOT"
  docker compose down -v --remove-orphans
) || true

if [[ $status -ne 0 ]]; then
  echo "[compose-full-lifecycle] FAIL (compose_log=$COMPOSE_LOG)"
  exit "$status"
fi

echo "[compose-full-lifecycle] PASS (compose_log=$COMPOSE_LOG)"
