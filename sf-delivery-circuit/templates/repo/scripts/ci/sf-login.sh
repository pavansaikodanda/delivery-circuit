#!/usr/bin/env bash
# Usage: SF_JWT_KEY=... SF_CLIENT_ID=... SF_USERNAME=... SF_URL=... sf-login.sh <alias> [--set-default]
# JWT login without ever writing the key into the workspace or printing it.
set -euo pipefail
: "${SF_JWT_KEY:?}" "${SF_CLIENT_ID:?}" "${SF_USERNAME:?}" "${SF_URL:?}"
KEYFILE=$(mktemp)
trap 'rm -f "$KEYFILE"' EXIT
printf '%s\n' "$SF_JWT_KEY" > "$KEYFILE"
sf org login jwt --client-id "$SF_CLIENT_ID" --username "$SF_USERNAME" --jwt-key-file "$KEYFILE" \
  --instance-url "$SF_URL" --alias "$1" ${2:-} >/dev/null
echo "Logged in to org alias $1"
