#!/usr/bin/env bash
# One-time workstation setup for a circuit persona (v3: logins only, no tokens).
#   ./scripts/setup-persona.sh architect|developer|tester
# Checks tools and logins (gh, claude, sf, acli), logs in to the persona's orgs (never the production org), adds the
# cc-arch / cc-dev / cc-qa shell alias, and prints the first-run MCP sign-in steps. Stores no credentials.
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
if command -v acli >/dev/null 2>&1; then
  printf '  %-7s %s\n' acli "$(acli --version 2>/dev/null | head -1)"
  echo "          (each acli release is supported for 6 months: keep it updated)"
else
  echo "  acli    MISSING  Atlassian CLI (Jira). Install: https://developer.atlassian.com/cloud/acli/guides/install-acli/"
  echo "          macOS: brew tap atlassian/homebrew-acli && brew install acli"
  echo "          Windows: download acli.exe from https://acli.atlassian.com/windows/latest/acli_windows_amd64/acli.exe onto PATH"
  echo "          Linux: apt/yum repo or https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli"
  missing=1
fi
if [ "$P" = architect ]; then command -v specify >/dev/null 2>&1 && echo "  specify $(specify --version 2>/dev/null | head -1)" || echo "  specify MISSING (uv tool install specify-cli): local Spec Kit drafting"; fi
if [ "$P" = tester ]; then command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || { echo "  python MISSING"; missing=1; }; fi
[ "$missing" = 0 ] || { echo "Install the missing tools, then re-run."; exit 1; }

echo "== 2. Logins (each opens a browser or prompts in YOUR terminal; nothing is stored in the repo)"
if gh auth status >/dev/null 2>&1; then echo "  GitHub: signed in"; else echo "  GitHub: run 'gh auth login --web'"; missing=1; fi
if claude auth status >/dev/null 2>&1; then echo "  Claude: signed in"; else echo "  Claude: run 'claude' once and /login with your own Claude seat"; missing=1; fi
if acli jira auth status >/dev/null 2>&1; then
  echo "  Atlassian CLI: signed in"
else
  echo "  Atlassian CLI: signing in with the browser (accept, then pick the project's site in this terminal)"
  acli jira auth login --web || { echo "  acli login did not finish; re-run 'acli jira auth login --web' later"; missing=1; }
fi

echo "== 3. Salesforce logins (browser opens). The org the project names as production is never logged in here."
cfg() { grep -E "^\s*$1:" build.config.yml 2>/dev/null | head -1 | awk '{print $2}' || true; }
DEV_URL="$(cfg dev_url)"; DEV_URL="${DEV_URL:-$(cfg dev_sandbox_url)}"
QA_URL="$(cfg qa_url)";   QA_URL="${QA_URL:-$(cfg qa_sandbox_url)}"
# Any org type may be DEV or QA (sandbox, scratch, Developer Edition, SDO/demo); the URL decides the login host.
sf org display --target-org dev >/dev/null 2>&1 || sf org login web --alias dev --instance-url "${DEV_URL:-https://login.salesforce.com}"
if [ "$P" = tester ]; then
  sf org display --target-org qa >/dev/null 2>&1 || sf org login web --alias qa --instance-url "${QA_URL:-https://login.salesforce.com}"
  echo "   SF AI Tester (https://github.com/pavansaikodanda/sf-ai-tester):"
  echo "   - VS Code: install the VSIX from its releases/ folder, or build it from source (npm ci && npm run package)."
  echo "   - CLI: SF_AI_TESTER_REF=<sha> bash scripts/ci/install-sf-ai-tester.sh ~/.sf-ai-tester-cli"
  echo "          then: SF_ALIAS=qa node ~/.sf-ai-tester-cli/dist/cli.js run test-cases/<KEY>.sf-tests.yaml --mode manual"
fi

echo "== 4. Shell alias $ALIAS"
LINE="alias $ALIAS='cd \"$REPO\" && CIRCUIT_PERSONA=$P claude --agent $P --mcp-config .claude/personas/$P.mcp.json --strict-mcp-config'"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q "alias $ALIAS=" "$rc" && sed -i.bak "/alias $ALIAS=/d" "$rc"
  echo "$LINE" >> "$rc"; echo "  added to $rc"
done
cat <<EOF
  PowerShell users: add this to your \$PROFILE instead:
    function $ALIAS { Set-Location "$REPO"; \$env:CIRCUIT_PERSONA='$P'; claude --agent $P --mcp-config .claude/personas/$P.mcp.json --strict-mcp-config @args }
  The Delivery Circuit extension starts the same session with its Circuit MCP added; prefer it when you use VS Code.

== 5. First run: MCP sign-ins (browser OAuth, once per machine; Claude Code keeps and refreshes the tokens)
  Open a new terminal and run: $ALIAS
  Inside Claude Code run /mcp and choose Authenticate for each server:
EOF
grep -oE '"(atlassian|lucid|fireflies|slack)"' ".claude/personas/$P.mcp.json" | tr -d '"' | sed 's/^/    - /'
cat <<EOF
  Notes:
    - Salesforce is used through the sf CLI (no Salesforce MCP server; @salesforce/mcp is retired).
    - Slack: a workspace admin must allow the Slack MCP client. If /mcp cannot sign in to "slack", use the claude.ai
      Slack connector instead and start Claude without --strict-mcp-config.
    - claude -p and CI runs cannot do OAuth: sign in here, interactively, first.

== 6. Acceptance test: as $P, run the first command of your persona
    architect -> /circuit-intake <source id from the extension's Sources page>
    developer -> /dev-review-stories <epic key, e.g. ACME-10>
    tester    -> /qa-design-tests <story key, e.g. ACME-12>
EOF
[ "$missing" = 0 ] || echo "Some logins are still missing (see above). Finish them, then re-run this script."
