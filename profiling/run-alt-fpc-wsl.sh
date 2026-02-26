#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Use Windows Node from WSL.
node() {
  /mnt/c/Program\ Files/nodejs/node.exe "$@"
}
export -f node

NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"
SCENARIO="${1:-pay_and_mint}"

node_up() {
  local code
  code=$(curl -s --max-time 3 --connect-timeout 2 -o /dev/null -w "%{http_code}" "$NODE_URL" 2>/dev/null || true)
  [[ "$code" != "000" && -n "$code" ]]
}

if ! node_up; then
  echo "[wsl-profiler] starting aztec local network..."
  aztec start --local-network >/tmp/aztec-profile-network.log 2>&1 &
  echo $! >/tmp/aztec-profile-network.pid
  for _ in $(seq 1 120); do
    if node_up; then
      echo "[wsl-profiler] node ready"
      break
    fi
    sleep 5
  done
fi

./profiling/run-alt-fpc.sh "$SCENARIO"
