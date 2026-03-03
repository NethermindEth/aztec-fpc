#!/usr/bin/env bash
set -euo pipefail

L1_RPC_URL="${L1_RPC_URL:-http://anvil:8545}"
FPC_DEPLOY_MANIFEST="${FPC_DEPLOY_MANIFEST:-/app/configs/deploy-manifest.json}"
L1_FEE_JUICE_FUNDER_PRIVATE_KEY="${L1_FEE_JUICE_FUNDER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
L1_OPERATOR_PRIVATE_KEY_TOPUP="${L1_OPERATOR_PRIVATE_KEY_TOPUP:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
L1_OPERATOR_PRIVATE_KEY_CREDIT="${L1_OPERATOR_PRIVATE_KEY_CREDIT:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
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

TOPUP_OPERATOR_ADDRESS="$(cast wallet address --private-key "$L1_OPERATOR_PRIVATE_KEY_TOPUP")"
CREDIT_OPERATOR_ADDRESS="$(cast wallet address --private-key "$L1_OPERATOR_PRIVATE_KEY_CREDIT")"

echo "[fund-l1-fee-juice] token=$FEE_JUICE_TOKEN_ADDRESS amount=$L1_FEE_JUICE_FUND_AMOUNT_WEI"
echo "[fund-l1-fee-juice] topup_operator=$TOPUP_OPERATOR_ADDRESS"
echo "[fund-l1-fee-juice] credit_operator=$CREDIT_OPERATOR_ADDRESS"

cast send "$FEE_JUICE_TOKEN_ADDRESS" "mint(address,uint256)" "$TOPUP_OPERATOR_ADDRESS" "$L1_FEE_JUICE_FUND_AMOUNT_WEI" \
  --rpc-url "$L1_RPC_URL" \
  --private-key "$L1_FEE_JUICE_FUNDER_PRIVATE_KEY" >/dev/null

if [ "$CREDIT_OPERATOR_ADDRESS" != "$TOPUP_OPERATOR_ADDRESS" ]; then
  cast send "$FEE_JUICE_TOKEN_ADDRESS" "mint(address,uint256)" "$CREDIT_OPERATOR_ADDRESS" "$L1_FEE_JUICE_FUND_AMOUNT_WEI" \
    --rpc-url "$L1_RPC_URL" \
    --private-key "$L1_FEE_JUICE_FUNDER_PRIVATE_KEY" >/dev/null
fi

TOPUP_BALANCE="$(cast call "$FEE_JUICE_TOKEN_ADDRESS" "balanceOf(address)(uint256)" "$TOPUP_OPERATOR_ADDRESS" --rpc-url "$L1_RPC_URL")"
CREDIT_BALANCE="$(cast call "$FEE_JUICE_TOKEN_ADDRESS" "balanceOf(address)(uint256)" "$CREDIT_OPERATOR_ADDRESS" --rpc-url "$L1_RPC_URL")"

echo "[fund-l1-fee-juice] funded topup_balance=$TOPUP_BALANCE credit_balance=$CREDIT_BALANCE"
