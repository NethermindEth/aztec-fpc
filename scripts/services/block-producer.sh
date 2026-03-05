#!/usr/bin/env bash
set -euo pipefail

: "${AZTEC_NODE_URL:?AZTEC_NODE_URL is required}"

if [[ -z "${SPONSORED_FPC_ADDRESS:-}" ]]; then
  echo "block-producer: resolving canonical SponsoredFPC address..."
  SPONSORED_FPC_ADDRESS=$(aztec get-canonical-sponsored-fpc-address | grep -oP '0x[0-9a-f]+')
fi
echo "block-producer: registering SponsoredFPC contract..."
aztec-wallet register-contract "${SPONSORED_FPC_ADDRESS}" SponsoredFPC

echo "block-producer: advancing chain continuously (fpc=${SPONSORED_FPC_ADDRESS})"

while true; do
  echo "block-producer: sending create-account transaction..."
  aztec-wallet create-account \
    --payment "method=fpc-sponsored,fpc=${SPONSORED_FPC_ADDRESS}" \
    2>&1 || echo "block-producer: transaction failed, retrying..."
done
