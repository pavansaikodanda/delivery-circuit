#!/usr/bin/env bash
# Jira helpers for CI on the self-hosted runner, through the Atlassian CLI (acli) signed in by the runner's
# service user ('acli jira auth login --web'). No API token, no Jira credentials in GitHub.
#   jira.sh get <KEY>  > story.json     the work item with all fields (acli jira workitem view --json --fields '*all')
#   jira.sh comment <KEY> "text"        add a comment (Jira automation may transition on fixed comment texts)
#   jira.sh status                      exit 0 when acli is signed in
# The JSON shape of acli --json is not documented: callers read it defensively (.fields.x // .x). VERIFY on install.
set -euo pipefail
cmd="${1:-}"; key="${2:-}"
command -v acli >/dev/null 2>&1 || { echo "jira.sh: acli is not installed on this runner" >&2; exit 3; }
if [ "$cmd" = status ]; then acli jira auth status >/dev/null 2>&1; exit $?; fi
[[ "$key" =~ ^[A-Z][A-Z0-9_]+-[0-9]+$ ]] || { echo "jira.sh: bad key" >&2; exit 1; }
case "$cmd" in
  get)
    acli jira workitem view "$key" --json --fields '*all' ;;
  comment)
    text="${3:-}"
    [ -n "$text" ] || { echo "jira.sh: empty comment" >&2; exit 1; }
    body=$(mktemp)
    trap 'rm -f "$body"' EXIT
    printf '%s\n' "$text" > "$body"
    acli jira workitem comment create --key "$key" --body-file "$body" >/dev/null
    echo "Commented on $key" ;;
  *) echo "usage: jira.sh get|comment <KEY> [text] | jira.sh status" >&2; exit 2 ;;
esac
