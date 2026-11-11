# Delivery Circuit — UI design (v2 "Calm Circuit")

Reference prototype: `design/prototype.html` (open in a browser; dark and light side by side; motion live).
Scope: `media/shared/base.css`, `media/shared/ui.js` (window.DC) and the seven pages. Everything below is buildable
with plain CSS + the existing `h()` renderer. No framework.

## 1. Principles

1. **Native first.** Every colour comes from a `--vscode-*` variable; the page must look like a VS Code view
   (Settings, Testing, SCM), not a web dashboard. One accent (`--vscode-focusBorder`/textLink) plus a *persona* tint.
2. **Hierarchy before decoration.** Three surfaces, two border strengths, a 6-step type scale. Titles 600,
   body 400, meta 12 px muted. Status is carried by icon + colour + word, never colour alone.
3. **Reactive means "the UI answers you".** Hover lifts, press settles, a changed row flashes once, a running thing
   visibly runs, a result lands with a toast. Each reaction is ≤ 240 ms, single-property where possible, and happens
   only on the element you touched or the data that changed. Nothing idles except one pulse (current stage) and
   spinners for work in flight.
4. **Change is local.** Re-rendering never moves scroll, never steals focus, never re-animates unchanged rows.
   `DC.mount` reconciles by key; only changed rows flash, only new rows enter.
5. **Icons carry meaning.** Codicons for personas, gates, stages, links, statuses and actions, so a row can be read
   at a glance and in high contrast.
6. **Calm by default.** No gradients, glow, neon, confetti, parallax, bounce. `prefers-reduced-motion` turns the
   system into instant state changes with the same information.

## 2. Tokens (`base.css` `:root`, overridden under `body.vscode-light`, `body.vscode-high-contrast`, `body.vscode-high-contrast-light`)

VS Code adds the body class itself in webviews. The preview harness must add `vscode-dark`/`vscode-light` to `<body>`
(one-line change in `preview/serve.mjs`). Defaults below are dark-safe; light and HC override only what differs.

```css
:root {
  /* surfaces (elevation 0-3) */
  --dc-surface-0: var(--vscode-editor-background, #1f1f1f);          /* page */
  --dc-surface-1: var(--vscode-sideBar-background, #181818);          /* cards, lists, logs */
  --dc-surface-2: var(--vscode-editorWidget-background, #202020);     /* raised: hover state, popovers, skeleton base */
  --dc-surface-3: var(--vscode-editorHoverWidget-background, #202020);/* tooltips, toasts */
  --dc-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,.12));
  --dc-selected: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.2));
  --dc-selected-fg: var(--vscode-list-activeSelectionForeground, var(--dc-fg));
  --dc-shadow-1: 0 1px 2px rgba(0,0,0,.35);                           /* hover lift */
  --dc-shadow-2: 0 4px 16px rgba(0,0,0,.45);                          /* toast, popover (= widget shadow) */
  /* text */
  --dc-fg: var(--vscode-foreground, #cccccc);
  --dc-muted: var(--vscode-descriptionForeground, #9d9d9d);
  --dc-faint: color-mix(in srgb, var(--dc-muted) 60%, transparent);   /* placeholders, dividers in text */
  /* borders */
  --dc-border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
  --dc-border-strong: color-mix(in srgb, var(--dc-fg) 28%, transparent);
  --dc-focus: var(--vscode-focusBorder, #0078d4);
  /* accents */
  --dc-accent: var(--vscode-textLink-foreground, #4daafc);
  --dc-persona-architect: var(--vscode-charts-purple, #b180d7);
  --dc-persona-developer: var(--vscode-charts-blue, #3794ff);
  --dc-persona-tester:    var(--vscode-charts-green, #89d185);
  --dc-persona: var(--dc-accent);               /* set by body[data-persona=...] */
  --dc-persona-tint: color-mix(in srgb, var(--dc-persona) 14%, transparent);
  /* status */
  --dc-ok:   var(--vscode-testing-iconPassed, #73c991);
  --dc-warn: var(--vscode-editorWarning-foreground, #cca700);
  --dc-err:  var(--vscode-testing-iconFailed, var(--vscode-errorForeground, #f14c4c));
  --dc-info: var(--vscode-charts-blue, #3794ff);
  --dc-tint-strength: 16%;                      /* status/row tints: color-mix(status, this, transparent) */
  /* radii */
  --dc-r-1: 3px;  /* chips, kbd */
  --dc-r-2: 6px;  /* cards, buttons, inputs, list */
  --dc-r-3: 10px; /* toasts, empty states */
  --dc-r-pill: 999px;
  /* spacing scale */
  --dc-s-1: 4px; --dc-s-2: 8px; --dc-s-3: 12px; --dc-s-4: 16px; --dc-s-5: 24px; --dc-s-6: 32px;
  /* type scale (base = VS Code font size, 13px) */
  --dc-font: var(--vscode-font-family, system-ui, sans-serif);
  --dc-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
  --dc-t-xs: 11px; --dc-t-sm: 12px; --dc-t-base: var(--vscode-font-size, 13px); --dc-t-md: 14px; --dc-t-lg: 16px; --dc-t-xl: 20px;
  --dc-lh: 1.45; --dc-lh-tight: 1.25;
  /* motion */
  --dc-d-press: 80ms; --dc-d-hover: 120ms; --dc-d-enter: 180ms; --dc-d-expand: 240ms; --dc-d-flash: 900ms;
  --dc-ease: cubic-bezier(.4,0,.2,1); --dc-ease-out: cubic-bezier(.16,1,.3,1);
}
body[data-persona="architect"] { --dc-persona: var(--dc-persona-architect); }
body[data-persona="developer"] { --dc-persona: var(--dc-persona-developer); }
body[data-persona="tester"]    { --dc-persona: var(--dc-persona-tester); }

body.vscode-light {
  --dc-surface-1: var(--vscode-sideBar-background, #f8f8f8);
  --dc-surface-2: var(--vscode-editorWidget-background, #f3f3f3);
  --dc-shadow-1: 0 1px 2px rgba(0,0,0,.08); --dc-shadow-2: 0 4px 16px rgba(0,0,0,.14);
  --dc-persona-architect: var(--vscode-charts-purple, #652d90);
  --dc-persona-developer: var(--vscode-charts-blue, #005fb8);
  --dc-persona-tester:    var(--vscode-charts-green, #388a34);
  --dc-ok: var(--vscode-testing-iconPassed, #388a34); --dc-warn: var(--vscode-editorWarning-foreground, #bf8803);
  --dc-err: var(--vscode-testing-iconFailed, #e51400); --dc-info: var(--vscode-charts-blue, #005fb8);
  --dc-tint-strength: 12%;
}
body.vscode-high-contrast, body.vscode-high-contrast-light {
  --dc-surface-1: var(--dc-surface-0); --dc-surface-2: var(--dc-surface-0); --dc-surface-3: var(--dc-surface-0);
  --dc-border: var(--vscode-contrastBorder, #6fc3df); --dc-border-strong: var(--vscode-contrastActiveBorder, var(--dc-border));
  --dc-shadow-1: none; --dc-shadow-2: none; --dc-tint-strength: 0%;   /* colour only on text, icons, borders */
  --dc-hover: transparent; --dc-persona-tint: transparent;
}
```

Rules: tints are always `color-mix(in srgb, <status> var(--dc-tint-strength), transparent)` so HC collapses them to
nothing. Persona colour is used for icon, 2 px rail, chip border and 600-weight text ≥ 12 px — never for body text.
Focus ring: `outline: 1px solid var(--dc-focus); outline-offset: 1px` (VS Code's own); cards/rows use `-1px` offset.

## 3. Iconography — `@vscode/codicons` (new devDependency, copied to `media/shared/codicons/` by `build.mjs`)

Load `codicon.css` from `base.css` via `@import url("codicons/codicon.css")` (CSP: style + font from `cspSource`,
both already allowed). `DC.icon("name")` → `<i class="codicon codicon-<name>" aria-hidden="true">`; `{spin:true}` adds
`codicon-modifier-spin`; `{label}` adds `role="img" aria-label`.

| Concept | Codicon |
|---|---|
| Persona Architect / Developer / Tester | `symbol-structure` / `code` / `beaker` |
| Switch persona · act-as | `arrow-swap` |
| Gates G1 Plan signed off · G2 Testability · G3 AI plan approved · G4 AI test plan approved · G5 Code review · G6 QA on sandbox · G7 Schema/design review · G8 Merge · G9 Production approval | `checklist` · `beaker` · `sparkle` · `tasklist` · `code-review` · `verified` · `type-hierarchy` · `git-merge` · `rocket` |
| Gate state done / waiting / blocked / not-started | `pass-filled` / `clock` / `error` / `circle-outline` |
| Stages intake · clarify · plan · signoff · stories · tests · jira · build · qa · release | `inbox` · `comment-discussion` · `map` · `verified` · `book` · `beaker` · `issues` · `tools` · `bug` · `rocket` |
| Stage state done / active / todo / blocked | `check` / `play-circle` / `circle-outline` / `error` |
| Connections github · claude · sf-dev, sf-qa · jira · confluence · slack · fireflies · lucid · testing-browsers · coderabbit · code-analyzer · ai-reviewer · mcp-* | `github` · `sparkle` · `cloud` · `issues` · `book` · `comment` · `mic` · `graph` · `browser` · `hubot` · `shield` · `sparkle` · `plug` |
| Connection state connected / disconnected / expiring / error / checking / unknown | `pass-filled` / `circle-outline` / `clock` / `error` / `loading` (spin) / `question` |
| Scope personal / project · admin · secret | `account` / `repo` · `shield` · `key` |
| Review source human / coderabbit / ai-reviewer / code-analyzer / sf-ai-tester | `person` / `hubot` / `sparkle` / `shield` / `beaker` |
| Review state approved / changes-requested / commented / pass / block | `check` / `request-changes` / `comment` / `pass` / `circle-slash` |
| PR · draft PR · merged · branch · label · check success / failure / pending / missing | `git-pull-request` · `git-pull-request-draft` · `git-merge` · `git-branch` · `tag` · `pass` / `error` / `clock` / `circle-outline` |
| Test status passed / failed / blocked / error / running / not run | `testing-passed-icon` / `testing-failed-icon` / `circle-slash` / `warning` / `loading` (spin) / `circle-outline` |
| Route pass / dev / qa / infra | `pass` / `code` / `beaker` / `server` |
| Links github · jira · salesforce · slack · confluence · lucid · fireflies · coderabbit · file · report · url | `github` · `issues` · `cloud` · `comment` · `book` · `graph` · `mic` · `hubot` · `file` · `report` · `link-external` |
| Actions refresh · run · run all · cancel/stop · export · settings · connect · disconnect · check · manage · validate · generate (AI) · send · dismiss · copy · open feature · sign in · terminal · human step · form · verify · save · search · filter · more | `refresh` · `play` · `run-all` · `debug-stop` · `export` · `settings-gear` · `plug` · `debug-disconnect` · `sync` · `link-external` · `checklist` · `sparkle` · `send` · `close` · `copy` · `arrow-right` · `sign-in` · `terminal` · `person` · `edit` · `verified` · `save` · `search` · `filter` · `kebab-vertical` |
| Notice info / warn / err / ok · empty state · loading | `info` / `warning` / `error` / `pass` · `inbox`, `search`, `beaker` (context) · `loading` |
| Keyboard hint | `keyboard` |

## 4. Motion system

| Token | Value | Used for |
|---|---|---|
| `--dc-d-press` 80 ms | ease | button press: `transform: scale(.98)` (ghost: background only) |
| `--dc-d-hover` 120 ms | ease | hover: background, border-colour, `translateY(-1px)` + `--dc-shadow-1` on cards; link underline |
| `--dc-d-enter` 180 ms | ease-out | list/card enter: `opacity 0→1, translateY(4px)→0`; stagger `calc(var(--i) * 20ms)`, `--i` capped at 8 (≤160 ms) |
| `--dc-d-expand` 240 ms | ease | tab indicator slide (`transform`/`width`), progress bar width, details expand (grid-template-rows 0fr→1fr), toast in/out |
| `--dc-d-flash` 900 ms | ease | changed row: background `color-mix(status 22%)` → transparent, plus 2 px left rail in status colour that stays |
| pulse 2 s | ease-in-out ∞ | **only** the current stage segment: `box-shadow: 0 0 0 0 → 0 0 0 5px transparent` of `--dc-persona-tint` |
| spin 1 s | linear ∞ | `codicon-modifier-spin` for checking/running |
| shimmer 1.4 s | linear ∞ | skeleton: moving 40 %-wide highlight of `--dc-surface-2` → `--dc-hover` |
| toast life 5 s | linear | thin bottom progress line on auto-dismiss toasts; pauses on hover/focus |

Never animates: text colour of body copy, font size, layout columns/widths, table cells, scroll position
(no smooth scroll on data updates), counts (no number tween), page-level fade (**remove** the current whole-`#app`
`.fade`), unchanged rows on re-render, anything on hidden tabs.

`@media (prefers-reduced-motion: reduce)` (and `body.dc-reduced-motion` for testing): all transitions → 0 ms,
no transforms, no stagger, no shimmer (static skeleton), no pulse (current stage keeps its ring), toast appears/
disappears instantly, changed-row flash becomes the 2 px rail only (kept 2 s). Spinners stay (they are status).

## 5. Components (anatomy · states · DC API)

Shared states: **default** · **hover** (`--dc-hover` bg, border-strong) · **focus** (focus ring; never removed) ·
**active/press** · **disabled** (opacity .55, `cursor:not-allowed`, keeps colour meaning, reason inline) ·
**loading** (spinner replaces icon, label dimmed, `aria-busy`) · **selected** (`--dc-selected` + 2 px accent rail).

### 5.1 App header — `DC.header({title, sub, persona, personas, onSwitch, actions, icon})`
```
┌ [icon] Title                                        [persona chip ▾]  [⟳ Refresh] [⚙] ┐
│        sub line: login · owner/repo · Updated 10:42                                     │
└──────────────────────────────────────────── border ────────────────────────────────────┘
```
Title `--dc-t-xl` 600, sub `--dc-t-sm` muted. Persona chip: codicon + name, border 1 px `--dc-persona`, bg
`--dc-persona-tint`, text `--dc-persona` 600. If `personas.length > 1` the chip is a `<button aria-haspopup="listbox">`
that opens a small popover (`--dc-surface-3`, shadow-2, enter 120 ms) listing personas with icon, check on active,
arrow keys + Enter/Esc. Switching posts `switchPersona` and sets `body[data-persona]` immediately (optimistic tint).
Header is `position: sticky; top: 0` with `--dc-surface-0` and bottom border; no shadow until scrolled
(`.is-scrolled` toggled by a passive scroll listener → `--dc-shadow-1`).

### 5.2 Sidebar section — `DC.section(title, {count, icon, actions, collapsible, key}, body)`
Uppercase 11 px 600 tracking .04 em title (like VS Code's view headers), count chip right, optional chevron that
collapses (`details`-like, 240 ms grid expand, state in `localStorage`-free `vscode.setState`). Section bodies carry
`data-key` for reconcile.

### 5.3 Queue card — `DC.queueCard(q, {allowed, onFeature, compact})`
```
┃ [G3 ▸ sparkle]  Approve AI plan: CE-13 Tier 2 routing                 1 d ·
┃  docs/plans/CE-13/PLAN.md on draft PR
┃  [gh PR #43] [jira CE-13] [file PLAN.md] [→ Feature 001]
┃  [AI review plan] [Add plan-approved]   ⓘ Not available as Tester
```
Anatomy: 2 px left rail in persona colour of the gate owner (own gate = `--dc-persona`, else `--dc-border`); gate chip
(gate codicon + id, `title` = gate label); title 500; age right, muted, `title` = ISO; links row (icon + label chips,
hover bg); actions row: first action primary, rest secondary; a disabled action shows its reason **inline** in
`--dc-muted` with `info` icon (not only `title`). Hover: card lifts (-1 px, shadow-1, border-strong). Enter: stagger.
Changed (age/state/actions hash) → flash. Overdue (`since` > 3 d) → age chip `warn`.

### 5.4 Feature card — `DC.featureCard(f, {onOpen})`, uses `DC.stageBar`, `DC.gateStrip`, `DC.gateRing`
```
┌ 001-case-escalation                                  (◔ 6/9) score 92 ┐
│ Case escalation with reason and queue routing                        │
│ ▰▰▰▰▰▰▰◉▱▱   Build (current)                                         │
│ G1✓ G2✓ G3◷ G4◷ G5◷ G6◷ G7○ G8○ G9○      next G3 · Developer (you)   │
│ 0 open questions · 4 stories · [gh] [jira] [confluence] [file spec]  │
└──────────────────────────────────────────────────────────────────────┘
```
- `DC.stageBar(stages, {label})`: 10 equal segments, 6 px tall, gap 2 px, radius 2 px. done = `--dc-ok`, active =
  `--dc-persona` + **pulse** (only element that pulses), todo = `--dc-border`, blocked = `--dc-err`. `title` per
  segment; current stage name text right. Progress animates width only when a segment flips (reconcile flash).
- `DC.gateStrip(gates, {viewer})`: chips `G1`…`G9` with state icon; own gates 600 + persona border; others opacity .7;
  `blocked` err. Hover shows gate label + owner tooltip.
- `DC.gateRing(done, total, {size:20})`: SVG ring, stroke `--dc-ok` over `--dc-border`, `stroke-dashoffset`
  transition 240 ms; `aria-label="6 of 9 gates done"`.

### 5.5 PR row — `DC.prRow(p, {onFeature})`
```
┃ [git-pull-request] #42 Agent escalates a Case         [needs you] [ai-attempt-2]   5 h
┃  feature/CE-12-escalation · by dev-bot · CE-12
┃  checks: [✓ guard] [✓ static] [◷ qa] [○ spec-gate]        gates: G5◷ G6○
┃  reviews: [person alice · approved] [hubot CodeRabbit · 1 nit] [sparkle AI reviewer · PASS]
┃           [shield Code Analyzer · no signal yet]
```
Check chips: icon by state, name; pending spins; failure chip err with hover tooltip of state. Review-signal chips:
source icon + author + state word, coloured border by state, link icon opens url. "No signal yet" chips muted dashed
border. `needs you` chip uses `--dc-persona`. Draft PR uses the draft icon and muted title.

### 5.6 Connection row — `DC.connectionRow(r, {onConnect, onCheck, onDisconnect, onManage})`
```
┃ [github]  GitHub                 ● Connected · pavansaikodanda      [Reconnect] [Check] [Manage]
┃           Signed in · acme-org/salesDemoOrg · admin   [gh Repo]
```
State pill: icon + word (`connected` ok, `expiring` warn + expiry chip, `error` err, `checking` spinner,
`unknown` muted question, `disconnected` outline). **Check** sets the row `data-state="checking"` optimistically
(spinner, buttons disabled, `aria-busy`); the result arrives via state → row hash changes → flash in the new state's
colour, `DC.announce("GitHub: Connected")`. "Check all" runs the same per row, staggered visually by arrival order.
Secret rows reuse the row with `key` icon, mono name, env chip.

### 5.7 Counters — `DC.counter(label, value, {state, icon, onClick})`
Inline stat `value` `--dc-t-lg` 600 + label `--dc-t-xs` muted uppercase; optional colour; clickable → ghost-button
hover. Used for test totals (passed/failed/blocked/error) and header counts. Value changes do not tween; the counter
flashes via reconcile when its hash changes.

### 5.8 Tabs — `DC.tabs(items, selected, onSelect)` (same signature)
Adds a single `.tab-ink` element positioned under the selected tab (`left`/`width` set from `offsetLeft/offsetWidth`
after mount, `transition: left,width 240ms`). Tabs: icon optional, count chip optional (`{count}`), disabled keeps
label for screen readers. Keyboard: arrow keys move, Home/End, roving tabindex. Hidden tab panels are not rendered.

### 5.9 Segmented control — `DC.segmented(options, value, onChange, {label, size})`
`role="radiogroup"`, pill container `--dc-surface-2` border, selected option `--dc-surface-0` + shadow-1 + 600; the
selected background slides (same ink technique). Replaces the `<select>`s for Mode / Org on Testing and Act-as.

### 5.10 Buttons — `DC.button(label, onclick, {kind, icon, loading, disabled, reason, size, title})`
Kinds: **primary** (`button-background`), **secondary** (`button-secondaryBackground`), **ghost** (transparent,
accent text, hover bg), **danger** (transparent, `--dc-err` text + border on hover; used for Disconnect, Cancel run,
Discard). Height 26 px (sm 22), padding 0 10 px, radius `--dc-r-2`, icon 16 px left. Hover: brightness(1.08)
(primary) / bg (others), 120 ms; press scale(.98) 80 ms; focus ring; disabled opacity .55 + inline `reason` rendered
as sibling `.dc-reason` by `actionButtons` (icon `info`); loading: spinner replaces icon, label stays, `aria-busy`,
width locked (`min-width` from measured width) so layout doesn't jump.
`DC.actionButtons(actions, allowed, {reason: (a) => a.reason})` renders one reason line for all blocked actions.

### 5.11 Toasts — `DC.toast(text, {kind, icon, actions:[{label,onClick}], timeout=5000, id})`
Bottom-right stack (`#dc-toasts`, `role="region" aria-label="Notifications"`), max 3, `--dc-surface-3`, shadow-2,
radius `--dc-r-3`, 2 px left rail in kind colour, icon, text, optional action link, close `×`, bottom life line.
Enter: translateY(8px)+fade 240 ms; exit: fade 180 ms. Pauses on hover/focus. `DC.announce` mirrors text to the
live region. Pages emit toasts on: gate action accepted, run finished (route), connection result, config saved.

### 5.12 Skeletons — `DC.skeleton({kind:"rows"|"cards"|"table"|"lines", n})`
Blocks of `--dc-surface-2` with shimmer, radius `--dc-r-1`, `aria-hidden`, `aria-busy` on the container. Shown by
pages for `mode:"loading"` and by Testing/Connections before first state; replaced by content with enter stagger.

### 5.13 Empty states — `DC.empty({icon, title, text, action:{label,onClick}})` (string overload keeps old behaviour)
Centered, dashed border `--dc-r-3`, 32 px codicon in `--dc-faint`, title 500, text muted, one secondary/ghost CTA.

### 5.14 Progress — `DC.progressBar({value, max, segments:{passed,failed,blocked,error}})`, `DC.ring(value, max, {size, label})`
Bar: 6 px, stacked segments in status colours, widths transition 240 ms, `role="progressbar"` with `aria-valuenow`.
Ring: SVG, same stroke rules as gate ring; 28 px in run header, 20 px inline; indeterminate = `codicon loading` spin.

### 5.15 Live run log — `DC.log(id, lines, {follow:true})`
`<pre role="log" aria-live="off">` in `--dc-surface-1`, mono 12 px, line classes: `[W1]` worker prefix muted,
`===` case headers 600, `->` tool calls faint, lines containing `error`/`failed` err. New lines append in place
(no rerender), auto-follow while scrolled to bottom, "Jump to latest" ghost button appears when not following.

### 5.16 Keyboard hints & tooltips — `DC.kbd("Ctrl+Enter")`, `data-tip` attribute
`kbd`: mono 11 px, 1 px border, radius 3, `--dc-surface-2`. Tooltips: CSS-only `[data-tip]::after` (instant, 120 ms
fade, `--dc-surface-3`, shadow-2, max 280 px), plus the same text in `aria-label`/`title` for AT. Use for icon-only
buttons, gate chips, check chips, segments.

### 5.17 Status chip — `DC.chip(text, {state, icon, tone:"solid"|"outline", title})` (`DC.badge` stays as alias)
Height 18 px, 11 px 500, icon 12 px, outline tone by default (border = colour, text = colour), solid tone =
`color-mix(colour var(--dc-tint-strength))` bg. `DC.dot` stays for dense rows.

## 6. Per-page layouts

### 6.1 Home (sidebar)
```
● pavansaikodanda  [beaker Tester ▾]           ⟳
──────────────────────────────────────────────
WAITING ON YOU                              (3)
┃ [G4] Approve AI test plan: CE-13       1 d
┃  … links … [Approve] [AI review]
┃ [G6] QA on sandbox: PR #42              5 h
Show all 7 →
GO TO
  [beaker] Testing             2 running ⟳
  [plug]   Connections         1 expiring
  [symbol-structure] Persona view
Updated 10:42 · Refresh
```
Changes: identity line becomes the persona chip + switcher; sections get uppercase headers and counts; queue items
become `queueCard` compact (rail + gate chip + icon links); nav rows get icons and status chips; loading mode shows
skeleton rows; `github-error` notices use the notice component with icon. Reactive: row hover, flash on new/changed
queue items, "Refresh" button spins while a refresh is in flight (`DC.state.refreshing`), toast on gate action.

### 6.2 Persona view
```
[symbol-structure] Architect view         [chip Architect ▾] [⟳]
Signed in as pavan · acting as Architect
▔Architect▔  Developer  Tester                (ink slides)
WAITING ON YOU (2)      AI ACTIONS            FEATURES (3)          PULL REQUESTS (4)
queue cards…            [sparkle Intake]…     feature cards (grid)  pr rows (list)
```
Changes: tabs with ink + per-tab count; AI actions as ghost buttons with `sparkle`; features in `.grid` cards with
stage bar/gate ring; PRs as `prRow`. Reactive: cards lift, PR check chips spin while pending, flash on review-signal
change, counts in section headers update with flash.

### 6.3 Feature detail
```
[map] 001-case-escalation                             links… [⟳]
Case escalation … · score 92 · 0 open questions · plan signed off
▰▰▰▰▰▰▰◉▱▱  Build                     (◔ 6/9 gates)   Next: G3 AI plan approved — Developer (you)
GATES ─ table: icon+id · label · owner chip · state chip (own rows 600, persona rail)
OPEN QUESTIONS · STORIES (table: # · story · jira chip · tests (ui/unit/manual counters) · PR chip · file)
SOURCES CITED · FILES (chips) · SPEC KIT ACTIONS (grouped by persona chip; inline reason)
```
Reactive: gate row flash when a gate state changes; stage bar current pulse; story PR chip spins when checks pending.

### 6.4 Connections
```
[plug] Connections        pavan · owner/repo [admin] [personas…]   Act as [seg Architect|Developer|Tester] [⟳ Check all]
PERSONAL (4)   connection rows …
CLAUDE MCP (6) connection rows …
PROJECT (admin) — Slack webhooks / CI secrets / Reminders: secret rows
footer: 2 connections only other personas need are hidden · Checked 3 min ago
```
Reactive: Check → spinner → flash in result colour + announce; Check all → header button loading, rows update as
they arrive; expiring rows show a warn chip; signed-out state is an empty state with `sign-in` CTA.

### 6.5 Testing
```
[beaker] Testing      runs as pavan · acting as tester        [export xlsx] [export pdf] [⚙] [⟳]
┌ SUITES ─────────┐ ┌ ▔Cases▔ Results(1) Runs Generate ──────────────────────────────┐
│ ▸ Smoke-Account │ │ Smoke - Account  [validate]                                      │
│   2 cases ●2    │ │ Mode [manual|automation|both]  Org [dev|qa]  [▶ Run selected (2)] [Run all] │
│   Lead convert  │ │ table: ☐ · ID · title · manual chip · automation chip · links     │
└─────────────────┘ │ ┌ RUN  ◔ 1/2  SMOKE-ACC-001 manual (haiku)   ▰▰▰▰▰▱▱▱  [■ Cancel]┐ │
                    │ │ [✓ ACC-002] [⟳ ACC-001]  live log …                             │ │
```
Reactive: selected suite rail + bg; run box has ring + stacked bar + per-case chips that flip with flash as events
arrive; log streams; results tab counters; `details` expands 240 ms; Generate button loading with log streaming.

### 6.6 Setup wizard
```
[tools] Project Setup   owner/repo · 4 of 13 phases done   [gh] [file] [file]
▔Phases▔  build.config.yml
┌ B0 ✓ Prereqs      ┐ ┌ B3 Secrets                       [chip PARTIAL] [Check all] ┐
│ B1 ✓ …            │ │ progress bar of steps · status select → segmented · Save      │
│ ▸ B3 ◐ Secrets    │ │ step cards: kind chip (icon) · title · detail · links         │
│ B4 ○ …            │ │  checklist (custom checkbox) · secret chips · [Run] [Check]   │
└───────────────────┘ │  result line flashes ok/err                                   │
```
Reactive: phase list selected rail; step "Working…" becomes button loading; result row flashes; phase status chip
flashes on save; config form fields show inline error state (err border) and the Save button becomes primary only
when dirty.

### 6.7 Session chat
```
[sparkle] Claude · /dev-review-plan 42                        [chip Developer] ● running
notice (mcp issues) …
┌ log (scroll) ───────────────────────────────────────────────┐
│ You ▸ text                                                   │
│ Claude ▸ text (streaming caret)                              │
│   [tool] Read  src/…  ✓      ← tool rows compact, nested indent│
└──────────────────────────────────────────────────────────────┘
model · 3 turns · $0.0123                           [Send ⌘↵] [■ Stop]
```
Reactive: streaming message shows a 1-character blinking caret (CSS steps); tool rows enter with stagger and their
dot flips with a flash on completion; "Jump to latest" when not following; composer keeps focus/caret via reconcile.

## 7. Data updates — keyed reconcile in `DC.mount`

Pages keep calling `DC.mount(render(state))`. New behaviour:

1. **Keys.** Any repeating element sets `data-key` (stable id: queue id, PR number, connection id, suite key, case id,
   gate id, phase id, message index) and `data-hash` = `DC.hash(sourceObject)` (djb2 of `JSON.stringify`, with
   volatile fields such as `age` included on purpose — age changes are visible changes). Helper:
   `DC.keyed(key, obj, node)` sets both attributes.
2. **Capture** before patch: `document.activeElement` (its `id` or nearest `data-key` + selection range),
   `scrollTop` of `#app` and every `[data-scroll]` element.
3. **Patch** `reconcile(oldEl, newEl)`:
   - different tag or `data-key` → replace.
   - copy attributes (add/remove/update) except `class` modifiers `dc-enter`/`dc-changed`.
   - if `newEl` children have `data-key`: map old children by key; walk new children in order: known key with equal
     hash → **reuse old node untouched**, move into place if needed; known key with different hash → recurse (so
     nested keyed children get their own treatment) and add `.dc-changed` (flash; `--dc-flash` colour from
     `data-state`); unknown key → insert new node with `.dc-enter` and `style="--i:n"` (n counts new nodes, capped 8);
     old keys missing → remove (no leave animation, instant).
   - no keys: if both have only text → update text if different; else recurse pairwise by index, replacing extras.
4. **Restore** scroll positions and focus (+selection); if the focused element vanished, focus the nearest sibling
   with the same `data-key` or `#app` without scrolling.
5. **Class cleanup**: `animationend` removes `dc-enter`/`dc-changed`; reduced motion removes them immediately.
6. First mount: whole page gets stagger enter (max 8 items), no flash.
7. Incremental events (log lines, streaming text) still append in place via `DC.onEvent`; they never call `mount`.

Hashes must not include DOM-only state (checked boxes, open details); page-local UI state stays in the page module,
as today.

## 8. Accessibility

- Contrast: all text ≥ 4.5:1 in both themes (persona colours listed are ≥ 4.9:1 on their surfaces; checked for
  VS Code Dark Modern / Light Modern); chips never rely on colour alone (icon + word); HC drops tints and shadows and
  uses `contrastBorder`.
- Focus order: header → persona chip → actions → tabs → sections in reading order; cards are not focusable unless
  they are the only control (nav rows, suite rows: `role="button"`/`option`, Enter/Space). Focus ring never removed;
  `:focus-visible` only.
- `main#app` loses `aria-live` (today every re-render is announced). A single `#dc-live` `role="status"
  aria-live="polite"` region receives `DC.announce(text)` for: connection results, run start/finish, gate action
  result, toast text, persona switch. Logs are `role="log" aria-live="off"`.
- Reduced motion as in §4; tooltips readable by AT via `aria-label`; spinners carry `aria-label="…in progress"`;
  progress bars expose `aria-valuenow/max/text`.
- Keyboard: tabs arrows, segmented arrows, popover listbox, `Ctrl+Enter` send, `Esc` closes popover/toast, `/`
  focuses search when present. Hints shown with `DC.kbd` next to the control.

## 9. Build notes for the implementer

- New devDependency: `@vscode/codicons` (copy `dist/codicon.css` + `codicon.ttf` to `media/shared/codicons/` in
  `build.mjs`; add the folder to `.vscodeignore` exceptions).
- `src/core/webview.ts`: remove `aria-live` from `main`, add `<div id="dc-live" role="status" aria-live="polite" class="sr-only">`
  and `<div id="dc-toasts">`; pages set `document.body.dataset.persona` from state.
- `preview/serve.mjs`: add `vscode-dark`/`vscode-light` body class; define `--vscode-charts-*`,
  `--vscode-editorWidget-background`, `--vscode-testing-icon*`, `--vscode-list-activeSelection*` in `THEMES`.
- ARCHITECTURE.md UI rules update: "animation beyond the built-in fade" → "motion only from the §4 system".
