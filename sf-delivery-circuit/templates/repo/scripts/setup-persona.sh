#!/usr/bin/env bash
# One-time workstation setup for a circuit persona.
#   ./scripts/setup-persona.sh architect|developer|tester
# Checks tools, logs in to the persona's sandboxes (never production), adds the cc-arch / cc-dev / cc-qa
# shell alias, and prints the first-run sign-in steps for the remote MCP servers.
set -euo pipefail

P="${1:-}"
case "$P" in
  architect) ALIAS=cc-arch ;;
  developer) ALIAS=cc-dev ;;
  tester)    ALIAS=cc-qa ;;
  *) echo "Usage: $0 architect|developer|tester"; exit 2 ;;
esac
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

echo "== 1. Tools"
missing=0
for t in git gh node npm sf claude jq; do
  if command -v "$t" >/dev/null 2>&1; then printf '  %-7s %s\n' "$t" "$("$t" --version 2>/dev/null | head -1)"; else echo "  $t MISSING"; missing=1; fi
done
command -v specify >/dev/null 2>&1 && echo "  specify $(specify --version 2>/dev/null | head -1)" || echo "  specify MISSING (uv tool install specify-cli)"
if [ "$P" = tester ]; then command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || { echo "  python MISSING"; missing=1; }; fi
[ "$missing" = 0 ] || { echo "Install the missing tools, then re-run."; exit 1; }
claude auth status >/dev/null 2>&1 || echo "  Note: run 'claude' once and /login with your own Claude subscription account."

echo "== 2. Salesforce sandbox logins (browser opens). Production is never logged in here."
DEV_URL=$(grep -E '^\s*dev_sandbox_url:' build.config.yml 2>/dev/null | awk '{print $2}' || true)
QA_URL=$(grep -E '^\s*qa_sandbox_url:' build.config.yml 2>/dev/null | awk '{print $2}' || true)
sf org display --target-org dev >/dev/null 2>&1 || sf org login web --alias dev --instance-url "${DEV_URL:-https://test.salesforce.com}"
if [ "$P" = tester ]; then
  sf org display --target-org qa >/dev/null 2>&1 || sf org login web --alias qa --instance-url "${QA_URL:-https://test.salesforce.com}"
fi

echo "== 3. Shell alias $ALIAS"
LINE="alias $ALIAS='cd \"$REPO\" && CIRCUIT_PERSONA=$P claude --agent $P --mcp-config .claude/personas/$P.mcp.json --strict-mcp-config'"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q "alias $ALIAS=" "$rc" && sed -i.bak "/alias $ALIAS=/d" "$rc"
  echo "$LINE" >> "$rc"; echo "  added to $rc"
done
cat <<EOF
  PowerShell users: add this to your \$PROFILE instead:
    function $ALIAS { Set-Location "$REPO"; \$env:CIRCUIT_PERSONA='$P'; claude --agent $P --mcp-config .claude/personas/$P.mcp.json --strict-mcp-config @args }

== 4. First run
  Open a new terminal and run: $ALIAS
  Inside Claude Code run /mcp and sign in to each remote server (browser OAuth):
EOF
grep -oE '"(github|atlassian|lucid|fireflies|playwright)"' ".claude/personas/$P.mcp.json" | tr -d '"' | sed 's/^/    - /'
cat <<EOF
  Jira writes from skills (arch-jira-push / qa-push-tests) also need, in your own terminal only:
    export JIRA_BASE_URL=https://<site>.atlassian.net JIRA_EMAIL=<you> JIRA_API_TOKEN=<your token>

  Acceptance test: as $P, run the first command of your persona:
    architect -> /circuit-intake inputs/transcripts/<file>     developer -> /dev-review-stories <NNN-slug>
    tester    -> /qa-design-tests <NNN-slug>
EOF
