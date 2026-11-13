# Delivery Circuit extension: architecture

Modules talk only through `src/core/contracts.ts`. Logic that can be tested without VS Code lives in vscode-free files.

```
connections + identity -> project -> mcp -> sessions -> views
```

| Module | Files | Does |
|---|---|---|
| core | `contracts.ts`, `util.ts`, `webview.ts`, `claude.ts` | Types, process runner, webview shell, locating `claude` |
| connections | `catalog.ts`, `service.ts`, `identity*.ts`, `parse.ts`, `safety.ts`, `config.ts`, `github.ts` | The ~7 login rows, roles from GitHub teams, the GitHub client |
| project | `work.ts` (pure), `github.ts`, `jira.ts`, `acli.ts`, `mcpReader.ts`, `design.ts`, `sources.ts`, `pdf.ts`, `index.ts` | Reads Jira, Confluence and GitHub; next steps per role, story status, missing items, story detail; the encrypted transcript store |
| mcp | `tools.ts`, `http.ts`, `personaConfig.ts`, `index.ts` | Loopback Circuit MCP with `transcript_get` only (Architect), per-session MCP config |
| sessions | `terminal.ts`, `index.ts` | `claude --agent <role> [--mcp-config <file>] "<skill> <arg>"` in a terminal |
| views | `model.ts` (pure), `messages.ts`, `index.ts` | The sidebar (Work / Connections / Missing), the story panel, the four commands |

Webviews: `media/views/home.js`, `media/views/story.js`, `media/views/views.css` on the shared kit
`media/shared/ui.js` + `base.css` (design/DESIGN.md).

## Rules

- **No stored credentials.** GitHub uses the VS Code sign-in; Claude, `sf`, `acli` and MCP servers use the person's own
  logins. Repo setup checks read environment secret **names** only; a value is never requested.
- **Webviews are untrusted.** They send a row id; the extension looks up what the row runs (`RunSpec`) from the state it
  sent. Links in the story panel open only when they are among the panel's own links, and only `https:`.
- **AI never approves.** Buttons start skills or open GitHub/Jira pages; approvals, merges and status changes stay with
  people (docs/CIRCUIT-V4.md section 6).
- **Calm UI.** At most five next steps, one button per row, short labels, no gate numbers or jargon (unit-tested).
- **Placeholders only** in fixtures and docs.
