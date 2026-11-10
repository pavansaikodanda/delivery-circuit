#!/usr/bin/env bash
# Install the SF AI Tester CLI from source (https://github.com/pavansaikodanda/sf-ai-tester) at a pinned ref.
# Used by pr-checks (Linux runner) and by Tester laptops on macOS/Linux. On Windows, install the VSIX from the repo's
# releases/ folder instead; it includes the CLI at <extension dir>/dist/cli.js.
#
#   bash scripts/ci/install-sf-ai-tester.sh [<dir>]      # prints the tool dir on the last line
#   env: SF_AI_TESTER_REPO (default pavansaikodanda/sf-ai-tester), SF_AI_TESTER_REF (commit SHA or tag; required),
#        SF_AI_TESTER_WITH_DEPS=1 to install the browsers' system packages (CI runners)
# Run it as:  node "<dir>/dist/cli.js" run <suite.yaml> --mode manual --login headless   (from the repo root)
set -euo pipefail

DIR="${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sf-ai-tester}"
REPO="${SF_AI_TESTER_REPO:-pavansaikodanda/sf-ai-tester}"
REF="${SF_AI_TESTER_REF:-}"

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "SF_AI_TESTER_REPO must be owner/name" >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || { echo "Set SF_AI_TESTER_REF to a commit SHA or tag (repo variable)" >&2; exit 1; }

if [ ! -f "$DIR/dist/cli.js" ] || [ "$(cat "$DIR/.installed-ref" 2>/dev/null)" != "$REF" ]; then
  rm -rf "$DIR"
  git init -q "$DIR"
  git -C "$DIR" remote add origin "https://github.com/$REPO.git"
  # The repo keeps the prebuilt VSIX in Git LFS; it isn't needed to build the CLI.
  GIT_LFS_SKIP_SMUDGE=1 git -C "$DIR" fetch -q --depth 1 origin "$REF"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$DIR" checkout -q FETCH_HEAD
  (cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
  printf '%s' "$REF" > "$DIR/.installed-ref"
fi

# Browsers: Chromium for generated Playwright specs, Chrome for Testing for the Playwright MCP the agent drives.
if [ "${SF_AI_TESTER_WITH_DEPS:-0}" = "1" ]; then
  (cd "$DIR" && npx --no-install playwright install --with-deps chromium)
else
  (cd "$DIR" && npx --no-install playwright install chromium)
fi
(cd "$DIR" && node node_modules/@playwright/mcp/cli.js install-browser chrome-for-testing)

echo "$DIR"
