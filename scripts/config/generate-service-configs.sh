#!/usr/bin/env bash
set -euo pipefail

# generate-service-configs.sh
#
# Reads the FPC deploy manifest (JSON) and a master config (YAML), then
# generates per-service config files with the correct contract addresses
# injected.
#
# Environment variables (all optional, with defaults):
#   FPC_DEPLOY_MANIFEST — path to deploy manifest JSON
#   FPC_MASTER_CONFIG  — path to master config YAML  (default: ./fpc-config.yaml)
#   FPC_CONFIGS_OUT    — output directory             (default: ./configs)

# Manifest resolution priority:
# 1) explicit FPC_DEPLOY_MANIFEST
# 2) FPC_LOCAL_OUT (used by local deploy scripts/compose deploy service)
# 3) ./configs/deploy-manifest.json (compose output in this repo)
# 4) ./deployments/devnet-manifest-v2.json (devnet workflow default)
# 5) legacy fallback ./tmp/deploy-fpc-local-manifest.json
if [ -n "${FPC_DEPLOY_MANIFEST:-}" ]; then
  FPC_DEPLOY_MANIFEST="${FPC_DEPLOY_MANIFEST}"
elif [ -n "${FPC_LOCAL_OUT:-}" ]; then
  FPC_DEPLOY_MANIFEST="${FPC_LOCAL_OUT}"
elif [ -f "./configs/deploy-manifest.json" ]; then
  FPC_DEPLOY_MANIFEST="./configs/deploy-manifest.json"
elif [ -f "./deployments/devnet-manifest-v2.json" ]; then
  FPC_DEPLOY_MANIFEST="./deployments/devnet-manifest-v2.json"
else
  FPC_DEPLOY_MANIFEST="./tmp/deploy-fpc-local-manifest.json"
fi

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
