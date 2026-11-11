# Delivery Circuit extension: architecture and build rules

One VS Code extension for the AI + Human Salesforce delivery circuit (see `../sf-delivery-circuit/` and
`../README.md`). It works on a client Salesforce DX repo that the bootstrap set up (`.specify/`, `.claude/`,
`test-cases/`, `tests/`, `scripts/ci/`). Reference repo with real data: `../salesDemoOrg/` (local only).

## Modules and ownership

| Module | Folder(s) | Provides (factory in `index.ts`) | Owner |
|---|---|---|---|
| core | `src/core/`, `media/shared/`, `preview/serve.mjs`, `src/extension.ts`, `package.json`, `build.mjs` | contracts, helpers, UI kit, wiring | integrator only |
| connections | `src/connections/`, `media/connections/` | `createIdentityAndConnections`, `registerConnectionsUI` | A |
| project + mcp | `src/project/`, `src/mcp/` | `createProject`, `createMcp`, `dist/circuit-mcp.js` | B |
| views | `src/views/`, `media/views/` | `registerViews` (sidebar + persona panels) | C |
| testing | `src/testing/`, `media/testing/` | `createTesting`, `registerTestingUI` | D |
| actions, sessions, setup | `src/actions/`, `src/sessions/`, `src/setup/`, `media/setup/`, `media/sessions/` | `createActions`, `createSessions`, `registerSetupUI` | E |

Rules:
1. Code only against `src/core/contracts.ts` and `src/core/util.ts` / `webview.ts`. Never import another module's
   files. If you need something a contract lacks, write it in your result's `contract_requests` and code
   against a local adapter; the integrator merges it.
2. Edit only your folders, plus `test/unit/<module>*.test.ts`, `preview/fixtures/<module>.*.json`,
   `test/fixtures/<module>/`. Do not edit `package.json`, `extension.ts`, `contracts.ts` or the UI kit. Do not run
   `npm install`; list new dependencies in your result.
3. Put logic that doesn't need VS Code in files that don't import `vscode` (for example `parse.ts`, `queue.ts`),
   and unit-test it with vitest (`npx vitest run test/unit/<module>`). `vscode` is mocked for tests
   (`test/unit/vscode-mock.ts`).
4. Typecheck with `npx tsc --noEmit`. Errors in other modules' folders are their work in progress: ignore them,
   but leave yours at zero.
5. Do not commit. Do not push. The integrator commits in the user's name.

## Persona rules (from the contracts)
- Persona comes from GitHub team membership (`deliveryCircuit.githubTeams`); `personaOverride` only for repos owned
  by a personal account.
- **Architect sees all three persona views but acts only as Architect** (`canView` / `canAct`). Developer and Tester
  see only their own view plus Connections. Buttons the identity can't use are shown disabled with a reason.
- Human gate actions (labels, approvals, merges, sign-off commits) use the person's **own** GitHub token and always
  confirm first ("Add label plan-approved to PR #42 as <login>"). AI actions start a Claude session as that
  persona. AI never approves, merges or deploys to production; the guard hook and GitHub rules still enforce it.

## Security rules
- Secrets: VS Code `SecretStorage` only. Never log, render or write them to files. Project secrets go straight to
  GitHub Actions secrets (libsodium sealed box with the repo public key).
- Spawn processes with `run()` (no shell injection: arguments are an array; never interpolate user input into a
  command string). Pass tokens through env, never args.
- Webviews: strict CSP from `pageHtml`; render with `DC.h()` (escapes text). Only `https:` links open externally.
- Transcripts never enter git. Uploads are stored encrypted in the extension's global storage; the repo keeps only
  `.circuit/sources.json` (ids, titles, dates). The Circuit MCP gives transcript text only to the Architect persona.

## UI rules (subtle, not exotic)
- Use `media/shared/base.css` + `media/shared/ui.js` (`window.DC`). VS Code theme colours only; one accent; thin
  borders; no gradients, glow, big shadows, emoji, or animation beyond the built-in fade.
- Every card/row that refers to something outside the extension shows `DC.links([...])` to it (GitHub, Jira,
  Salesforce, Slack, Confluence, Lucid, Fireflies, CodeRabbit, file).
- Each page: `media/<module>/<page>.js`, data only via `{type:"state", data}`; page posts `ready`, `openLink`,
  `action` and its own messages. Provide at least one fixture per page in `preview/fixtures/<module>.<page>.<name>.json`
  so it renders in `npm run preview` (http://127.0.0.1:5178).

## Review tools are connections too
CodeRabbit (GitHub App on the repo; findings are `coderabbitai[bot]` reviews), Salesforce Code Analyzer (`sf` plugin
locally; CI artifact), the AI Reviewer (CI comment ending `VERDICT: PASS|BLOCK`) and SF AI Tester verdicts all
appear as `ReviewSignal`s on each PR and as entries on the Connections page.
