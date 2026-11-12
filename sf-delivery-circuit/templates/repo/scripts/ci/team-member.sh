#!/usr/bin/env bash
# team-member.sh <team> <github-login>: exit 0 when <login> is an active member of org team <team>.
# Reads the org through the self-hosted runner's own 'gh' sign-in (needs read:org); the job's GITHUB_TOKEN cannot
# read team membership. No stored token: GH_TOKEN / GITHUB_TOKEN are removed for this one call.
#   ORG defaults to GITHUB_REPOSITORY_OWNER.
set -uo pipefail
team="${1:-}"; login="${2:-}"; org="${ORG:-${GITHUB_REPOSITORY_OWNER:-}}"
[[ "$team" =~ ^(architects|developers|testers)$ ]] || { echo "team-member: team must be architects, developers or testers" >&2; exit 2; }
[[ "$login" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "team-member: '$login' is not a GitHub user login" >&2; exit 1; }
[[ "$org" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "team-member: set ORG" >&2; exit 2; }
state=$(env -u GH_TOKEN -u GITHUB_TOKEN gh api "orgs/$org/teams/$team/memberships/$login" --jq .state 2>/dev/null || true)
[ "$state" = active ]
