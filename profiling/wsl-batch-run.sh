#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  if command -v nvm >/dev/null 2>&1; then
    nvm install 22
    nvm use 22
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[fatal] node missing in WSL"
  exit 2
fi

node -v
npm -v
docker --version

[ -e contracts/vendor ] || ln -s ../vendor contracts/vendor

"$HOME/.nargo/bin/nargo" --version
"$HOME/.nargo/bin/nargo" compile --package alt_fpc
"$HOME/.nargo/bin/nargo" compile --package token_contract

NODE_URL="${AZTEC_NODE_URL:-http://127.0.0.1:8080}"
code="$(curl -s --max-time 3 --connect-timeout 2 -o /dev/null -w "%{http_code}" "$NODE_URL" 2>/dev/null || true)"
if [[ "$code" == "000" || -z "$code" ]]; then
  echo "[wsl] starting aztec local network"
  aztec start --local-network >/tmp/aztec-profile-network.log 2>&1 &
  echo $! >/tmp/aztec-profile-network.pid
  for _ in $(seq 1 120); do
    code="$(curl -s --max-time 3 --connect-timeout 2 -o /dev/null -w "%{http_code}" "$NODE_URL" 2>/dev/null || true)"
    if [[ "$code" != "000" && -n "$code" ]]; then
      echo "[wsl] node ready"
      break
    fi
    sleep 5
  done
fi

AZTEC_NODE_URL="$NODE_URL" ./profiling/run-alt-fpc.sh pay_and_mint
