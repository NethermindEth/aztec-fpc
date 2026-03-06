#!/usr/bin/env bash
set -euo pipefail

L1_RPC_URL="${L1_RPC_URL:-http://anvil:8545}"
FPC_DATA_DIR="${FPC_DATA_DIR:-./deployments}"
FPC_DEPLOY_MANIFEST="${FPC_DEPLOY_MANIFEST:-$FPC_DATA_DIR/manifest.json}"
L1_FEE_JUICE_FUNDER_PRIVATE_KEY="${L1_FEE_JUICE_FUNDER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
L1_OPERATOR_PRIVATE_KEY="${L1_OPERATOR_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
L1_FEE_JUICE_FUND_AMOUNT_WEI="${L1_FEE_JUICE_FUND_AMOUNT_WEI:-1000000000000000000000}"

if [ -n "${L1_FEE_JUICE_TOKEN_ADDRESS:-}" ]; then
  FEE_JUICE_TOKEN_ADDRESS="${L1_FEE_JUICE_TOKEN_ADDRESS}"
else
  if [ ! -f "$FPC_DEPLOY_MANIFEST" ]; then
    echo "ERROR: missing deploy manifest at $FPC_DEPLOY_MANIFEST" >&2
    exit 1
  fi

  FEE_JUICE_TOKEN_ADDRESS="$(
    grep -oE '"feeJuiceAddress"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]+"' "$FPC_DEPLOY_MANIFEST" \
      | head -n1 \
      | sed -E 's/.*"(0x[0-9a-fA-F]+)".*/\1/'
  )"
fi

if [ -z "${FEE_JUICE_TOKEN_ADDRESS:-}" ]; then
  echo "ERROR: could not resolve feeJuiceAddress from manifest or L1_FEE_JUICE_TOKEN_ADDRESS" >&2
  exit 1
fi

OPERATOR_ADDRESS="$(cast wallet address --private-key "$L1_OPERATOR_PRIVATE_KEY")"

echo "[fund-l1-fee-juice] token=$FEE_JUICE_TOKEN_ADDRESS amount=$L1_FEE_JUICE_FUND_AMOUNT_WEI"
echo "[fund-l1-fee-juice] operator=$OPERATOR_ADDRESS"

cast send "$FEE_JUICE_TOKEN_ADDRESS" "mint(address,uint256)" "$OPERATOR_ADDRESS" "$L1_FEE_JUICE_FUND_AMOUNT_WEI" \
  --rpc-url "$L1_RPC_URL" \
  --private-key "$L1_FEE_JUICE_FUNDER_PRIVATE_KEY" >/dev/null

BALANCE="$(cast call "$FEE_JUICE_TOKEN_ADDRESS" "balanceOf(address)(uint256)" "$OPERATOR_ADDRESS" --rpc-url "$L1_RPC_URL")"
echo "[fund-l1-fee-juice] funded balance=$BALANCE"
