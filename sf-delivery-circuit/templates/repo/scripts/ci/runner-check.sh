#!/usr/bin/env bash
# runner-check.sh: prove the self-hosted runner has the logins a job needs, without printing any of them.
# Replaces the v2 sf-login.sh: the circuit stores no credentials. The runner's service user signs in once
# (gh auth login, sf org login web/device, acli jira auth login --web, claude) and every job reuses those logins.
#
#   bash scripts/ci/runner-check.sh [--gh] [--acli] [--claude] [--sf <alias>]... [--not-sf <alias>]...
#                                   [--tools a,b,c] [--sf-plugin <name>]...
#
#   --gh            gh is signed in as the runner's own account (GH_TOKEN / GITHUB_TOKEN ignored for this check)
#   --acli          Atlassian CLI is signed in to Jira (acli jira auth status)            VERIFY output/exit code
#   --claude        the claude CLI is installed for the runner's service user (sign-in itself is checked by use)
#   --sf <alias>    the sf CLI has a working login for <alias>
#   --not-sf <a>    the runner holds NO login for <a> (the org the project names as production, on the circuit runner)
#   --tools a,b     each command is on PATH
#   --sf-plugin p   an sf plugin whose name contains p is installed (code-analyzer, sfdx-git-delta)
# Exit 0 when every check passes; 1 otherwise, with one line per problem and the command that fixes it.
set -uo pipefail

fail=0
ok()  { echo "ok    $*"; }
bad() { echo "FAIL  $*"; fail=1; }
alias_ok() { [[ "$1" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; }

SF=(); NOT_SF=(); TOOLS=(); PLUGINS=(); GH=0; ACLI=0; CLAUDE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --gh) GH=1 ;;
    --acli) ACLI=1 ;;
    --claude) CLAUDE=1 ;;
    --sf) SF+=("${2:-}"); shift ;;
    --not-sf) NOT_SF+=("${2:-}"); shift ;;
    --tools) IFS=, read -r -a more <<<"${2:-}"; TOOLS+=("${more[@]}"); shift ;;
    --sf-plugin) PLUGINS+=("${2:-}"); shift ;;
    *) echo "runner-check: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

for t in "${TOOLS[@]}"; do
  [[ "$t" =~ ^[A-Za-z0-9_.-]+$ ]] || { bad "bad tool name '$t'"; continue; }
  if command -v "$t" >/dev/null 2>&1; then ok "tool $t"; else bad "tool $t is not on PATH for the runner's service user"; fi
done

if [ "$GH" = 1 ]; then
  if ! command -v gh >/dev/null 2>&1; then bad "gh is not installed"
  elif env -u GH_TOKEN -u GITHUB_TOKEN gh auth status >/dev/null 2>&1; then ok "gh signed in (runner account)"
  else bad "gh is not signed in: run 'gh auth login' as the runner's service user (scopes: repo, read:org)"; fi
fi

if [ "$ACLI" = 1 ]; then
  if ! command -v acli >/dev/null 2>&1; then bad "acli is not installed (developer.atlassian.com/cloud/acli/guides/install-acli/)"
  else
    # The docs give neither the output nor the exit code of 'auth status' when signed out: accept only exit 0
    # without a signed-out phrase. VERIFY on the runner after install.
    out=$(acli jira auth status 2>&1); rc=$?
    if [ "$rc" -eq 0 ] && ! grep -qiE 'not (logged|signed|authenticated)|no (active )?account|unauthenticated|log ?in first' <<<"$out"; then
      ok "acli signed in to Jira"
    else bad "acli is not signed in: run 'acli jira auth login --web' as the runner's service user"; fi
  fi
fi

if [ "$CLAUDE" = 1 ]; then
  if command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1; then ok "claude CLI present (uses the runner's own Claude sign-in)"
  else bad "claude CLI is missing: install Claude Code and run 'claude' once as the runner's service user to sign in"; fi
fi

if [ "${#SF[@]}" -gt 0 ] || [ "${#NOT_SF[@]}" -gt 0 ] || [ "${#PLUGINS[@]}" -gt 0 ]; then
  command -v sf >/dev/null 2>&1 || { bad "sf CLI is not installed"; echo "runner-check: failed"; exit 1; }
  command -v jq >/dev/null 2>&1 || { bad "jq is not installed"; echo "runner-check: failed"; exit 1; }
fi

for a in "${SF[@]}"; do
  alias_ok "$a" || { bad "bad org alias '$a'"; continue; }
  for n in "${NOT_SF[@]}"; do [ "$a" = "$n" ] && bad "alias '$a' is both required and forbidden on this runner"; done
  st=$(sf org display --target-org "$a" --json 2>/dev/null | jq -r 'if .status == 0 then (.result.connectedStatus // "Connected") else "error" end' 2>/dev/null)
  case "$st" in
    Connected|Unknown) ok "sf org '$a' ($st)" ;;
    *) bad "sf org '$a' is not usable (${st:-no login}): run 'sf org login web --alias $a' (or 'sf org login device --alias $a' on a headless runner)" ;;
  esac
done

for a in "${NOT_SF[@]}"; do
  alias_ok "$a" || { bad "bad org alias '$a'"; continue; }
  if sf org display --target-org "$a" --json >/dev/null 2>&1; then
    bad "this runner holds a login for '$a', the org the project names as production; log it out here ('sf org logout --target-org $a') and keep it on the circuit-release runner only"
  else ok "no login for production alias '$a'"; fi
done

for p in "${PLUGINS[@]}"; do
  [[ "$p" =~ ^[@A-Za-z0-9/_.-]+$ ]] || { bad "bad plugin name '$p'"; continue; }
  if sf plugins --json 2>/dev/null | jq -e --arg p "$p" 'any(.[]?; (.name // "") | contains($p))' >/dev/null 2>&1; then ok "sf plugin $p"
  else bad "sf plugin $p is not installed for the runner's service user (sf plugins install ...)"; fi
done

if [ "$fail" -ne 0 ]; then echo "runner-check: failed (fix the runner, then re-run the job)"; exit 1; fi
echo "runner-check: ok"
