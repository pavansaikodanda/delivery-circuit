#!/usr/bin/env bash
# Usage: HOOK=<incoming webhook url> slack.sh "message text"
# Builds the JSON with jq, so PR titles or Jira text can never break the payload. Never fails the job.
set -uo pipefail
[ -n "${HOOK:-}" ] || { echo "No Slack webhook configured; skipping."; exit 0; }
jq -n --arg t "$1" '{text:$t}' | curl -sS -m 20 -X POST -H 'Content-Type: application/json' -d @- "$HOOK" >/dev/null \
  || echo "Slack post failed (ignored)."
