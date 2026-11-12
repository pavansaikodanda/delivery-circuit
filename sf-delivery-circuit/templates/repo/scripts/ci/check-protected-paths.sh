#!/usr/bin/env bash
# Usage: check-protected-paths.sh <file-with-changed-paths> [allowed ...]
# Fails if a story PR touches a protected path (patterns in protected-paths.txt).
# An allowed entry ending in "/" exempts that folder (docs/plans/ACME-12/); any other entry exempts exactly that
# file (tests/ACME-12.tc.json). Matching is literal, not a regex.
set -euo pipefail
list="$1"; shift || true
hits=$(grep -E -f "$(dirname "$0")/protected-paths.txt" "$list" || true)
out=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  exempt=0
  for allow in "$@"; do
    if [[ "$allow" == */ ]]; then [[ "$path" == "$allow"* ]] && exempt=1
    else [[ "$path" == "$allow" ]] && exempt=1; fi
  done
  [ "$exempt" = 1 ] || out+="$path"$'\n'
done <<<"$hits"
if [ -n "$out" ]; then
  echo "This story PR touches protected files (change them in a separate PR that code owners review):"
  printf '%s' "$out"; exit 1
fi
echo "Protected paths OK"
