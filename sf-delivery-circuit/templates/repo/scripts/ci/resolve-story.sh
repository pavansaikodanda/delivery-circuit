#!/usr/bin/env bash
# Usage: resolve-story.sh <JIRA-KEY>
# Finds the story for a Jira key through .specify/specs/*/jira-map.json (written only by jira-sync.mjs)
# and prints shell assignments: FEATURE=..., STORY=NN, STORY_FILE=..., TC_INDEX=..., SUITE=...
set -euo pipefail
key="$1"
[[ "$key" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]] || { echo "bad key" >&2; exit 1; }
for map in .specify/specs/*/jira-map.json; do
  [ -f "$map" ] || continue
  ref=$(jq -r --arg k "$key" '.refs | to_entries[] | select(.value==$k) | .key' "$map" | head -1)
  if [ -n "$ref" ]; then
    [[ "$ref" =~ ^[0-9]{2}$ ]] || { echo "$key maps to ref '$ref', which is not a story" >&2; exit 1; }
    dir=$(dirname "$map"); feature=$(basename "$dir")
    file="$dir/task_story_${ref}.md"
    [ -f "$file" ] || { echo "missing $file" >&2; exit 1; }
    echo "FEATURE=$feature"; echo "STORY=$ref"; echo "STORY_FILE=$file"
    echo "TC_INDEX=$dir/tests/story_${ref}.tc.json"; echo "SUITE=test-cases/${feature}-story-${ref}.sf-tests.yaml"
    exit 0
  fi
done
echo "$key is not in any .specify/specs/*/jira-map.json (run arch-jira-push and merge it first)" >&2
exit 1
