#!/usr/bin/env bash
set -euo pipefail

# generate-service-configs.sh
#
# Reads the FPC deploy output (JSON) and a master config (YAML), then
# generates per-service config files with the correct contract addresses
# injected.
#
# Environment variables (all optional, with defaults):
#   FPC_LOCAL_OUT      — path to deploy output JSON  (default: ./tmp/deploy-fpc-local.json)
#   FPC_MASTER_CONFIG  — path to master config YAML  (default: ./fpc-config.yaml)
#   FPC_CONFIGS_OUT    — output directory             (default: ./configs)

FPC_LOCAL_OUT="${FPC_LOCAL_OUT:-./tmp/deploy-fpc-local.json}"
FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-./fpc-config.yaml}"
FPC_CONFIGS_OUT="${FPC_CONFIGS_OUT:-./configs}"

# ── Dependency checks ──────────────────────────────────────────────────────────

for cmd in jq yq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not found in PATH." >&2
    exit 1
  fi
done

# ── Input validation ──────────────────────────────────────────────────────────

if [ ! -f "$FPC_LOCAL_OUT" ]; then
  echo "ERROR: Deploy output not found: $FPC_LOCAL_OUT" >&2
  exit 1
fi

if [ ! -f "$FPC_MASTER_CONFIG" ]; then
  echo "ERROR: Master config not found: $FPC_MASTER_CONFIG" >&2
  exit 1
fi

deploy_status=$(jq -r '.status' "$FPC_LOCAL_OUT")
if [ "$deploy_status" != "deploy_ok" ]; then
  echo "ERROR: Deploy output status is '$deploy_status', expected 'deploy_ok'." >&2
  exit 1
fi

# ── Read deploy output ─────────────────────────────────────────────────────────

export FPC_ADDRESS=$(jq -r '.fpc_address' "$FPC_LOCAL_OUT")
export ACCEPTED_ASSET=$(jq -r '.accepted_asset' "$FPC_LOCAL_OUT")

for var in FPC_ADDRESS ACCEPTED_ASSET; do
  val="${!var}"
  if [ -z "$val" ] || [ "$val" = "null" ]; then
    echo "ERROR: Required field missing or null in deploy output: $var" >&2
    exit 1
  fi
done

# ── Generate attestation config ───────────────────────────────────────────────

mkdir -p "$FPC_CONFIGS_OUT/attestation"

yq '.attestation' "$FPC_MASTER_CONFIG" \
  | yq '
    .fpc_address = strenv(FPC_ADDRESS) | .fpc_address style="double"
    | .accepted_asset_address = strenv(ACCEPTED_ASSET) | .accepted_asset_address style="double"
  ' \
  > "$FPC_CONFIGS_OUT/attestation/config.yaml"

# ── Generate topup config ─────────────────────────────────────────────────────

mkdir -p "$FPC_CONFIGS_OUT/topup"

yq '.topup' "$FPC_MASTER_CONFIG" \
  | yq '
    .fpc_address = strenv(FPC_ADDRESS) | .fpc_address style="double"
  ' \
  > "$FPC_CONFIGS_OUT/topup/config.yaml"

# ── Summary ────────────────────────────────────────────────────────────────────

echo "Service configs generated:"
echo "  attestation: $FPC_CONFIGS_OUT/attestation/config.yaml"
echo "  topup:       $FPC_CONFIGS_OUT/topup/config.yaml"
echo ""
echo "  fpc_address:     $FPC_ADDRESS"
echo "  accepted_asset:  $ACCEPTED_ASSET"
