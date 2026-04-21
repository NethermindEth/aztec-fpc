#!/usr/bin/env bash
# Generates docs/public/llms-full.txt from all docs/*.md files.
# Run from the repo root: bash scripts/generate-llms-full.sh

set -euo pipefail

DOCS_DIR="docs"
OUT="$DOCS_DIR/public/llms-full.txt"

# Ordered list of doc files to include (matches the documentation table in README.md)
FILES=(
  "README.md"
  "quick-start.md"
  "architecture.md"
  "security.md"
  "quote-system.md"
  "sdk.md"
  "contracts.md"
  "services.md"
  "how-to/run-operator.md"
  "how-to/integrate-wallet.md"
  "how-to/add-supported-asset.md"
  "how-to/cold-start-flow.md"
  "operations/configuration.md"
  "operations/deployment.md"
  "operations/docker.md"
  "operations/testing.md"
  "reference/metrics.md"
  "reference/e2e-test-matrix.md"
  "reference/testnet-deployment.md"
  "reference/wallet-discovery.md"
)

# --- Pass 1: concatenate all files into a temp file ---
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

for f in "${FILES[@]}"; do
  src="$DOCS_DIR/$f"
  if [[ ! -f "$src" ]]; then
    echo "WARNING: $src not found, skipping" >&2
    continue
  fi
  printf '\n<!-- FILE: %s -->\n\n' "$f" >> "$TMPFILE"
  cat "$src" >> "$TMPFILE"
  printf '\n' >> "$TMPFILE"
done

# --- Pass 2: build TOC from FILE markers ---
TOC_LINES=()
while IFS= read -r line; do
  lineno=$(echo "$line" | cut -d: -f1)
  marker=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/<!-- FILE: //' | sed 's/ -->//')
  # Derive a human-readable section name from the filename
  section=$(echo "$marker" | sed 's/\.md$//' | sed 's|how-to/||' | sed 's|operations/|Ops: |' | sed 's|reference/|Ref: |' | sed 's|-| |g' | sed 's|/| |g')
  TOC_LINES+=("| $marker | $lineno |")
done < <(grep -n '<!-- FILE:' "$TMPFILE")

# --- Write final output ---
{
  cat <<'HEADER'
# Aztec FPC - Full Documentation

> Auto-generated from docs/. Do not edit manually.
> Regenerate with: bash scripts/generate-llms-full.sh

## Table of Contents (line numbers for fast navigation)

| File | Line |
|------|:----:|
HEADER

  # Offset TOC line numbers by the header size
  HEADER_LINES=14  # lines before the first FILE marker (header + TOC table header)
  HEADER_LINES=$((HEADER_LINES + ${#TOC_LINES[@]}))  # plus one row per TOC entry
  HEADER_LINES=$((HEADER_LINES + 2))  # separator + blank line

  # Re-scan with correct offsets
  line_offset=$((HEADER_LINES + 1))
  while IFS= read -r line; do
    raw_lineno=$(echo "$line" | cut -d: -f1)
    marker=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/<!-- FILE: //' | sed 's/ -->//')
    actual_lineno=$((raw_lineno + line_offset))
    printf '| %s | %d |\n' "$marker" "$actual_lineno"
  done < <(grep -n '<!-- FILE:' "$TMPFILE")

  echo ""
  echo "---"
  cat "$TMPFILE"
} > "$OUT"

echo "Generated $OUT ($(wc -l < "$OUT") lines)"
