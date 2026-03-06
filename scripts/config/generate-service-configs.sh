#!/usr/bin/env bash
set -euo pipefail

# generate-service-configs.sh
#
# Reads the FPC deploy manifest (JSON) and a master config (YAML), then
# generates per-service config files with the correct contract addresses
# injected.
#
# Environment variables (all optional, with defaults):
#   FPC_DATA_DIR            — root directory for generated artifacts  (default: ./deployments)
#   FPC_DEPLOY_MANIFEST     — path to deploy manifest JSON           (default: $FPC_DATA_DIR/manifest.json)
#   FPC_MASTER_CONFIG       — path to master config YAML             (default: $FPC_DATA_DIR/fpc-config.yaml)
#   FPC_ATTESTATION_CONFIG  — attestation config output path         (default: $FPC_DATA_DIR/attestation/config.yaml)
#   FPC_TOPUP_CONFIG        — topup config output path               (default: $FPC_DATA_DIR/topup/config.yaml)

FPC_DATA_DIR="${FPC_DATA_DIR:-./deployments}"
FPC_DEPLOY_MANIFEST="${FPC_DEPLOY_MANIFEST:-$FPC_DATA_DIR/manifest.json}"
FPC_MASTER_CONFIG="${FPC_MASTER_CONFIG:-$FPC_DATA_DIR/fpc-config.yaml}"
FPC_ATTESTATION_CONFIG="${FPC_ATTESTATION_CONFIG:-$FPC_DATA_DIR/attestation/config.yaml}"
FPC_TOPUP_CONFIG="${FPC_TOPUP_CONFIG:-$FPC_DATA_DIR/topup/config.yaml}"

# ── Dependency checks ──────────────────────────────────────────────────────────

for cmd in jq yq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not found in PATH." >&2
    exit 1
  fi
done

# ── Input validation ──────────────────────────────────────────────────────────

if [ ! -f "$FPC_DEPLOY_MANIFEST" ]; then
  echo "ERROR: Deploy manifest not found: $FPC_DEPLOY_MANIFEST" >&2
  exit 1
fi

if [ ! -f "$FPC_MASTER_CONFIG" ]; then
  echo "ERROR: Master config not found: $FPC_MASTER_CONFIG" >&2
  exit 1
fi

deploy_status=$(jq -r '.status' "$FPC_DEPLOY_MANIFEST")
if [ "$deploy_status" != "deploy_ok" ]; then
  echo "ERROR: Deploy manifest status is '$deploy_status', expected 'deploy_ok'." >&2
  exit 1
fi

# ── Read deploy manifest ───────────────────────────────────────────────────────

export FPC_ADDRESS=$(jq -r '.contracts.fpc // .fpc_address // empty' "$FPC_DEPLOY_MANIFEST")
export ACCEPTED_ASSET=$(jq -r '.contracts.accepted_asset // .accepted_asset // empty' "$FPC_DEPLOY_MANIFEST")

for var in FPC_ADDRESS ACCEPTED_ASSET; do
  val="${!var}"
  if [ -z "$val" ] || [ "$val" = "null" ]; then
    echo "ERROR: Required field missing or null in deploy manifest: $var" >&2
    exit 1
  fi
done

# ── Generate attestation config ───────────────────────────────────────────────

mkdir -p "$(dirname "$FPC_ATTESTATION_CONFIG")"

yq '.attestation' "$FPC_MASTER_CONFIG" \
  | yq '
    .fpc_address = strenv(FPC_ADDRESS) | .fpc_address style="double"
    | .accepted_asset_address = strenv(ACCEPTED_ASSET) | .accepted_asset_address style="double"
  ' \
  > "$FPC_ATTESTATION_CONFIG"

# ── Generate topup config ─────────────────────────────────────────────────────

mkdir -p "$(dirname "$FPC_TOPUP_CONFIG")"

yq '.topup' "$FPC_MASTER_CONFIG" \
  | yq '
    .fpc_address = strenv(FPC_ADDRESS) | .fpc_address style="double"
  ' \
  > "$FPC_TOPUP_CONFIG"

# ── Summary ────────────────────────────────────────────────────────────────────

echo "Service configs generated:"
echo "  attestation: $FPC_ATTESTATION_CONFIG"
echo "  topup:       $FPC_TOPUP_CONFIG"
echo ""
echo "  fpc_address:     $FPC_ADDRESS"
echo "  accepted_asset:  $ACCEPTED_ASSET"
