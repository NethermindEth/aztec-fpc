#!/usr/bin/env bash
set -euo pipefail

L1_RPC_URL="${L1_RPC_URL:?L1_RPC_URL is required}"
AZTEC_NODE_URL="${AZTEC_NODE_URL:?AZTEC_NODE_URL is required}"
L1_OPERATOR_PRIVATE_KEY="${L1_OPERATOR_PRIVATE_KEY:?L1_OPERATOR_PRIVATE_KEY is required}"
L1_FEE_JUICE_FUND_AMOUNT_WEI="${L1_FEE_JUICE_FUND_AMOUNT_WEI:-1000000000000000000000}"

FEE_JUICE_TOKEN_ADDRESS="$(
  cast rpc node_getNodeInfo --rpc-url "$AZTEC_NODE_URL" \
    | grep -oE '"(feeJuiceAddress|feeJuice)"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]+"' \
    | head -n1 \
    | sed -E 's/.*"(0x[0-9a-fA-F]+)".*/\1/'
)"

if [ -z "${FEE_JUICE_TOKEN_ADDRESS:-}" ]; then
  echo "ERROR: could not resolve feeJuiceAddress from node_getNodeInfo at $AZTEC_NODE_URL" >&2
  exit 1
fi

OPERATOR_ADDRESS="$(cast wallet address --private-key "$L1_OPERATOR_PRIVATE_KEY")"

echo "[fund-l1-fee-juice] token=$FEE_JUICE_TOKEN_ADDRESS"
echo "[fund-l1-fee-juice] amount=$L1_FEE_JUICE_FUND_AMOUNT_WEI"
echo "[fund-l1-fee-juice] operator=$OPERATOR_ADDRESS"

cast send "$FEE_JUICE_TOKEN_ADDRESS" "mint(address,uint256)" "$OPERATOR_ADDRESS" "$L1_FEE_JUICE_FUND_AMOUNT_WEI" \
  --rpc-url "$L1_RPC_URL" \
  --private-key "$L1_OPERATOR_PRIVATE_KEY" >/dev/null

BALANCE="$(cast call "$FEE_JUICE_TOKEN_ADDRESS" "balanceOf(address)(uint256)" "$OPERATOR_ADDRESS" --rpc-url "$L1_RPC_URL")"
echo "[fund-l1-fee-juice] funded balance=$BALANCE"
