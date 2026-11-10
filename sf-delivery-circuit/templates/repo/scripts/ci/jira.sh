#!/usr/bin/env bash
# Jira helpers for CI. Credentials only from env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.
#   jira.sh comment <KEY> "text"        add a comment (Jira Rule B transitions on fixed comment texts)
#   jira.sh get <KEY> > story.json      issue with summary, labels, issuelinks and all fields
set -euo pipefail
cmd="$1"; key="$2"
[[ "$key" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]] || { echo "bad key"; exit 1; }
: "${JIRA_BASE_URL:?}" "${JIRA_EMAIL:?}" "${JIRA_API_TOKEN:?}"
base="${JIRA_BASE_URL%/}"
case "$cmd" in
  comment)
    jq -n --arg t "$3" '{body:{type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:$t}]}]}}' \
      | curl -sSf -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H 'Content-Type: application/json' -X POST -d @- \
          "$base/rest/api/3/issue/$key/comment" >/dev/null
    echo "Commented on $key" ;;
  get)
    curl -sSf -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H 'Accept: application/json' "$base/rest/api/3/issue/$key" ;;
  *) echo "usage: jira.sh comment|get <KEY> [text]"; exit 2 ;;
esac
