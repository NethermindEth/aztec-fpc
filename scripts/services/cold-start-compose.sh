#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="$REPO_ROOT/artifacts/compose-smoke/cold-start"
COMPOSE_LOG="$ARTIFACT_DIR/compose.log"

if ! command -v docker >/dev/null 2>&1; then
  echo "[compose-cold-start] ERROR: missing required command 'docker'" >&2
  exit 1
fi

mkdir -p "$ARTIFACT_DIR"

echo "[compose-cold-start] running service=smoke-cold-start"

(
  cd "$REPO_ROOT"
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker compose rm -sf smoke-cold-start >/dev/null 2>&1 || true
)

set +e
(
  cd "$REPO_ROOT"
  docker compose up --attach smoke-cold-start --exit-code-from smoke-cold-start smoke-cold-start
)
status=$?
set -e

(
  cd "$REPO_ROOT"
  docker compose logs --no-color >"$COMPOSE_LOG" 2>&1
) || true
(
  cd "$REPO_ROOT"
  docker compose down -v --remove-orphans
) || true

if [[ $status -ne 0 ]]; then
  echo "[compose-cold-start] FAIL (compose_log=$COMPOSE_LOG)"
  exit "$status"
fi

echo "[compose-cold-start] PASS (compose_log=$COMPOSE_LOG)"
