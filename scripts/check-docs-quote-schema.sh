#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FILES=(
  "README.md"
  "docs/spec.md"
  "docs/ALPHA-ADHOC-FPC-OPERATOR-RUNBOOK.md"
)

FAILED=0

check_stale_pattern() {
  local pattern="$1"
  local description="$2"

  local matches
  matches="$(rg -n "$pattern" "${FILES[@]}" || true)"
  if [[ -n "$matches" ]]; then
    echo "ERROR: stale quote schema pattern detected: $description"
    echo "$matches"
    FAILED=1
  fi
}

check_stale_pattern '"rate_num"[[:space:]]*:' 'JSON response field "rate_num"'
check_stale_pattern '"rate_den"[[:space:]]*:' 'JSON response field "rate_den"'
check_stale_pattern 'quote\.rate_num' 'SDK usage of quote.rate_num'
check_stale_pattern 'quote\.rate_den' 'SDK usage of quote.rate_den'
check_stale_pattern '\(rate_num, rate_den, valid_until, signature\)' \
  'tuple form (rate_num, rate_den, valid_until, signature)'
check_stale_pattern 'signed quote \(rate_num, rate_den' \
  'signed quote (rate_num, rate_den, ...)'

quote_examples="$(rg -n '/quote\?user=' "${FILES[@]}" || true)"
if [[ -n "$quote_examples" ]]; then
  missing_fj_amount="$(printf '%s\n' "$quote_examples" | rg -v 'fj_amount=' || true)"
  if [[ -n "$missing_fj_amount" ]]; then
    echo "ERROR: /quote examples must include fj_amount query parameter"
    echo "$missing_fj_amount"
    FAILED=1
  fi
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "Docs quote schema guard: FAILED"
  exit 1
fi

echo "Docs quote schema guard: PASSED"
