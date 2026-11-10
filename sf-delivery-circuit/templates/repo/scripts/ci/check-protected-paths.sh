#!/usr/bin/env bash
# Usage: check-protected-paths.sh <file-with-changed-paths> [allowed-prefix ...]
# Fails if an AI change touches a protected path. Allowed prefixes (e.g. docs/plans/ABC-12/) are exempt.
set -euo pipefail
list="$1"; shift || true
hits=$(grep -E -f "$(dirname "$0")/protected-paths.txt" "$list" || true)
for allow in "$@"; do hits=$(printf '%s\n' "$hits" | grep -v "^${allow}" || true); done
hits=$(printf '%s\n' "$hits" | sed '/^$/d')
if [ -n "$hits" ]; then
  echo "AI change touches protected files:"; printf '%s\n' "$hits"; exit 1
fi
echo "Protected paths OK"
