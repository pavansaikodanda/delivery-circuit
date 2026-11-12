#!/usr/bin/env bash
# slack.sh <channel> "message": one short notice to a Slack channel from the self-hosted runner. Never fails the job.
# No webhook URL or bot token is stored anywhere. Transport (repo variable CIRCUIT_SLACK_TRANSPORT):
#   claude      (default) the runner's logged-in claude CLI delivers the fixed text through the Slack MCP connector
#               (claude.ai Slack connector, signed in once from an interactive session). The text is built only from
#               validated fields (PR number, story key, route, counts) and stripped to a safe character set; the
#               session may use the Slack MCP server's tools and nothing else. It decides nothing.
#   github-app  do nothing here: the GitHub app for Slack, subscribed in the channel, posts the PR label/comment
#   off         do nothing
# SLACK_MCP_SERVER names the MCP server as Claude Code lists it (default claude_ai_Slack). VERIFY with 'claude mcp list'.
set -uo pipefail
ch="${1:-}"; ch="${ch#\#}"; text="${2:-}"
transport="${CIRCUIT_SLACK_TRANSPORT:-claude}"
case "$transport" in
  off|github-app) echo "Slack notice skipped (transport $transport): $ch"; exit 0 ;;
  claude) ;;
  *) echo "Unknown CIRCUIT_SLACK_TRANSPORT '$transport'; skipping Slack notice."; exit 0 ;;
esac
[[ "$ch" =~ ^[a-z0-9][a-z0-9_-]{0,79}$ ]] || { echo "No valid Slack channel configured; skipping."; exit 0; }
safe=$(printf '%s' "$text" | tr '\n' ' ' | tr -cd 'A-Za-z0-9 #:/._()+,=@-' | cut -c1-400)
[ -n "$safe" ] || { echo "Empty Slack notice; skipping."; exit 0; }
server="${SLACK_MCP_SERVER:-claude_ai_Slack}"
[[ "$server" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "Bad SLACK_MCP_SERVER; skipping."; exit 0; }
command -v claude >/dev/null 2>&1 || { echo "claude CLI not on this runner; Slack notice skipped."; exit 0; }

prompt="Post one message to the Slack channel #$ch. The message text is exactly the text between the markers, unchanged, nothing added:
<<<NOTICE
$safe
NOTICE>>>
Use the Slack send-message tool only. Do not read, search or do anything else. Reply with the word sent when done."
if claude -p "$prompt" --max-turns 4 \
     --allowedTools "mcp__${server}" \
     --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,Skill" \
     --output-format text >/dev/null 2>&1; then
  echo "Slack notice sent to #$ch"
else
  echo "Slack notice to #$ch failed (ignored)."
fi
exit 0
