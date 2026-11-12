#!/usr/bin/env bash
# resolve-story.sh: name the files of one Jira story on its PR, and optionally fetch the story from Jira.
#
#   bash scripts/ci/resolve-story.sh <KEY>                       e.g. ACME-12
#   bash scripts/ci/resolve-story.sh --branch <head ref>         feature/ACME-12-slug -> ACME-12; other branches -> no output
#   ... [--jira [--out <dir>]]                                   also fetch the story with the runner's acli login
#
# Prints shell assignments for eval (validated values only, never Jira free text):
#   KEY=ACME-12  TC_INDEX=tests/ACME-12.tc.json  SUITE=test-cases/ACME-12.sf-tests.yaml  PLAN_DIR=docs/plans/ACME-12
#   with --jira: STORY_JSON=<out>/ACME-12.json  EPIC=<parent key or empty>
# v3: the story, its acceptance criteria and the design link live in Jira; the repo holds only the runnable tests
# and the plan on the story PR. No jira-map.json, no .specify/specs on main.
set -euo pipefail

KEY_RE='^[A-Z][A-Z0-9_]+-[0-9]+$'
key=""; branch=""; jira=0; out=".ai/story"
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) branch="${2:-}"; shift ;;
    --jira) jira=1 ;;
    --out) out="${2:-}"; shift ;;
    -*) echo "resolve-story: unknown option $1" >&2; exit 2 ;;
    *) key="$1" ;;
  esac
  shift
done

if [ -n "$branch" ]; then
  key=$(printf '%s' "$branch" | grep -oE '^feature/[A-Z][A-Z0-9_]+-[0-9]+(-|$)' | sed -E 's#^feature/##; s#-$##' || true)
  [ -n "$key" ] || exit 0          # not a story branch: print nothing
fi
[[ "$key" =~ $KEY_RE ]] || { echo "resolve-story: bad Jira key '$key'" >&2; exit 1; }

echo "KEY=$key"
echo "TC_INDEX=tests/$key.tc.json"
echo "SUITE=test-cases/$key.sf-tests.yaml"
echo "PLAN_DIR=docs/plans/$key"

if [ "$jira" = 1 ]; then
  if [[ ! "$out" =~ ^[A-Za-z0-9_./-]+$ ]] || [[ "$out" == *..* ]]; then echo "resolve-story: bad --out" >&2; exit 2; fi
  mkdir -p "$out"
  bash "$(dirname "$0")/jira.sh" get "$key" > "$out/$key.json"
  epic=$(jq -r '(.fields.parent.key // .parent.key // .fields.parent // empty) | strings' "$out/$key.json" 2>/dev/null || true)
  [[ "$epic" =~ $KEY_RE ]] || epic=""
  echo "STORY_JSON=$out/$key.json"
  echo "EPIC=$epic"
fi
