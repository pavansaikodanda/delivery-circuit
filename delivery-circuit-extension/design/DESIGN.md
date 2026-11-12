# Delivery Circuit — UI design v2 ("Quiet Circuit")

Reference prototype: `design/prototype.html` (open in a browser: palette swatches, then dark and light side by side
with a Developer view, a Connections list and a Testing run panel; hover reveal, expand and the overflow menu work).
Scope: `media/shared/base.css`, `media/shared/ui.js` (`window.DC`) and the seven pages. Plain CSS + the existing
`h()` renderer, no framework. v1 ("Calm Circuit") was rejected as cluttered; §0 lists what this version drops.

## 0. What changed from v1 (and why)

| v1 (rejected) | v2 |
|---|---|
| Every row showed gate chip + links row + checks row + reviews rows + 2-3 buttons | A row shows **title · one status · age · one primary action**. The rest appears on hover (action strip) or on expand. |
| Link chips with labels on every card | Links are **monochrome app logos** in the hover strip (tooltip = label); the full link list is inside the expanded row. |
| Uppercase 11 px section headings, counts in chips | Sentence-case 15 px headings, count as muted text (`Waiting on you · 3`). |
| Persona tint (purple/blue/green) across rails, chips and text | One global 3-colour palette; the persona is a small text chip in the header. |
| Cards in cards, 2 px coloured left rails, status tint backgrounds | Lists with 1 px dividers; at most one level of boxing (the sticky run panel, the chat log). Status is a 6 px dot + word. |
| 12 px body, 1.45 line height | 13 px body, 1.5 line height; three type levels only. |
| Disabled reason rendered inline next to the button | Disabled button carries the reason as tooltip (`data-tip` + `aria-describedby`); the expanded row repeats it as one muted line. |
| `null` printed by the prototype | `h()` ignores `null`/`undefined`/`false`; nothing is ever stringified without a guard. |

## 1. Principles

1. **Essentials first, everything else one gesture away.** A row answers three questions at a glance: what is it, what
   state is it in, what can I do. Links, secondary actions, checks and review detail are reached by hover/focus (action
   strip) or by expanding the row. Nothing on a page competes for attention with the primary action of the row you
   are looking at.
2. **Three colours, used for three jobs.** Primary indigo = action, selection, focus, active tab. Secondary teal =
   progress and positive highlight, and the one "attention" accent (a count that needs you). Tertiary slate = text
   hierarchy, borders, icons, neutral chips. Status (pass/warn/fail) is a 6 px dot or thin coloured text, never a
   block.
3. **Native surfaces.** Backgrounds come from the VS Code theme (`editor-background`, `sideBar-background`); the brand
   colours sit on top of them. In high contrast the brand colours map to VS Code's HC variables.
4. **Air is structure.** 16 px gutters, 12 px row padding, 32 px between sections, 1 px dividers instead of boxes.
   A row holds at most two lines of meta; anything longer goes into the expanded state.
5. **Lists, not cards.** Repeating things are rows in a list with dividers. Boxing is used once per page at most
   (a live run panel, a chat log), never nested.
6. **Icons are quiet.** Codicons for concepts, monochrome brand logos for apps; both drawn in the icon colour
   (slate), 16 px, tinting to primary only on hover of their own control.
7. **Motion is confirmation, not decoration.** Hover reveal 120 ms, expand 200 ms, a changed row highlights once,
   progress bars move. `prefers-reduced-motion` turns all of it into instant state changes.
8. **Change is local.** `DC.mount` reconciles by key: unchanged rows are untouched, scroll and focus survive, an
   expanded row stays expanded across re-renders.

## 2. Tokens

Defined on `:root` in `base.css`; VS Code adds `body.vscode-light`, `body.vscode-high-contrast`,
`body.vscode-high-contrast-light` itself (the preview harness adds the same classes). Dark values are the defaults.
Every value below was checked for contrast in §10.

### 2.1 Brand palette (exactly three)

| Token | Role | Dark | Light | High contrast (maps to) |
|---|---|---|---|---|
| `--dc-primary` | text/icon/border uses of primary: links, selected tab, active row rail, focus ring, hover tint of brand icons | `#818CF8` | `#4F46E5` | `--vscode-focusBorder` |
| `--dc-primary-strong` | primary button background (white text) | `#5B5FEA` | `#4F46E5` | `--vscode-button-background` |
| `--dc-primary-soft` | selection background, pressed state, "changed" highlight | `color-mix(in srgb, var(--dc-primary) 14%, transparent)` | 10 % | `transparent` |
| `--dc-secondary` | progress fill, done stages, positive highlight, the "needs you" count | `#2DD4BF` | `#0F766E` | `--vscode-textLink-foreground` |
| `--dc-secondary-soft` | progress track highlight, teal chip background | 14 % mix | 10 % mix | `transparent` |
| `--dc-tertiary` | the slate family (below) | — | — | — |

Slate (tertiary) is a family of neutral steps rather than one value:

| Token | Role | Dark | Light | HC |
|---|---|---|---|---|
| `--dc-fg` | titles, body text | `var(--vscode-foreground, #E2E8F0)` | `var(--vscode-foreground, #1E293B)` | `--vscode-foreground` |
| `--dc-muted` | meta text, counts, disabled labels | `#9AA4B2` | `#475569` | `--vscode-descriptionForeground` |
| `--dc-icon` | codicons, brand logos, chevrons | `#8B95A5` | `#64748B` | `--vscode-icon-foreground` |
| `--dc-border` | dividers, input borders | `#363B45` | `#E2E8F0` | `--vscode-contrastBorder` |
| `--dc-border-strong` | hovered control border, the single box | `#4A5160` | `#CBD5E1` | `--vscode-contrastActiveBorder` |
| `--dc-chip` | neutral chip background | `rgba(148,163,184,.14)` | `rgba(71,85,105,.10)` | `transparent` + border |

### 2.2 Surfaces (from the theme)

```css
--dc-surface-0: var(--vscode-editor-background, #1F1F1F);     /* page       light fallback #FFFFFF */
--dc-surface-1: var(--vscode-sideBar-background, #181818);    /* sidebar, run panel, log   light #F8F8F8 */
--dc-surface-2: var(--vscode-editorWidget-background, #202020);/* menus, toasts, tooltips   light #F3F3F3 */
--dc-hover:  rgba(255,255,255,.04);   /* light: rgba(15,23,42,.035) */
--dc-shadow: 0 4px 16px rgba(0,0,0,.40); /* menus and toasts only; light: rgba(15,23,42,.12); HC: none */
```

### 2.3 Status (dots and thin text only)

| Token | Dark | Light | HC |
|---|---|---|---|
| `--dc-ok` | `#4ADE80` | `#15803D` | `--vscode-testing-iconPassed` |
| `--dc-warn` | `#FBBF24` | `#A16207` | `--vscode-editorWarning-foreground` |
| `--dc-err` | `#F87171` | `#B91C1C` | `--vscode-testing-iconFailed` |
| `--dc-info` (running, pending, waiting) | `var(--dc-primary)` | `var(--dc-primary)` | `--vscode-focusBorder` |

Rules: a status colour may paint a 6 px dot, a 12 px icon, a 2 px progress segment or 12-13 px text. It never paints
a background larger than a chip, never a border around a row, never a rail.

### 2.4 Type scale (three levels + page title)

| Level | Size / weight / line height | Used for |
|---|---|---|
| Page title | 18 px / 600 / 1.3 | `DC.header` title |
| Title | 15 px / 600 / 1.4 | section headings, run panel heading |
| Body | 13 px (`--vscode-font-size`) / 400 / 1.5 | row titles (500), buttons, inputs, chat |
| Meta | 12 px / 400 / 1.5, `--dc-muted` | age, detail line, counts, chips, tooltips |

Mono: `--vscode-editor-font-family`, 12 px, for branches, ids, secrets, logs. No uppercase, no letter-spacing.
Row title 500 so it reads before its meta; nothing else on a row is bold.

### 2.5 Spacing and radii

`--dc-s-1: 4px · s-2: 8px · s-3: 12px · s-4: 16px · s-5: 24px · s-6: 32px · s-7: 48px`.
Page gutter 16 px (sidebar 12 px). Row: `padding: 12px 16px`, min height 44 px, 1 px divider `--dc-border`.
Section gap 32 px; heading to list 8 px. Expanded panel: `padding: 4px 16px 16px 40px` (indented under the title).
Radii: `--dc-r-1: 4px` chips, inputs · `--dc-r-2: 6px` buttons, menus, toasts · `--dc-r-3: 8px` the one box per
page · `--dc-r-pill: 999px` persona chip, segmented control.

### 2.6 Motion

| Token | Value | Use |
|---|---|---|
| `--dc-d-hover` | 120 ms ease | action strip opacity, background hover, icon tint |
| `--dc-d-expand` | 200 ms ease | expand/collapse (`grid-template-rows 0fr→1fr`), chevron rotate, tab underline slide, menu open |
| `--dc-d-progress` | 240 ms ease | progress bar width, ring offset |
| `--dc-d-flash` | 900 ms ease-out | changed row: background `--dc-primary-soft` → transparent, once |
| spin | 1 s linear ∞ | `loading` icon only |

Never animated: text colour, font size, layout width, scroll position, counts, page fade (removed). Under
`prefers-reduced-motion: reduce` (or `body.dc-reduced-motion`) every duration is 0 ms, the strip is simply shown,
the flash becomes a 1 px primary left border for 2 s, spinners keep spinning (they are status).

## 3. Icons

### 3.1 Concept icons — `@vscode/codicons`

`DC.icon(name, {size: 16|12, spin, label})` → `<i class="codicon codicon-<name>">`. Colour `--dc-icon` unless inside
a status context. The mapping table from v1 stays valid (persona, gates, stages, states, actions); the only changes:
expand chevron `chevron-right` (rotates 90° when open), overflow menu `kebab-horizontal` rendered as "…", external
link `link-external` (12 px, after a link label inside the expanded panel).

### 3.2 App logos — `simple-icons` (monochrome)

Source: npm package `simple-icons` **16.37.0** (checked 2026-11-11; package licence CC0-1.0, each icon's own brand
guidelines apply, see its `DISCLAIMER.md`). SVGs are `viewBox="0 0 24 24"`, single `<path>`, drawn with
`fill: currentColor`. We ship only the paths we use, copied verbatim; we never redraw a logo.

| App | Slug in package | Present in 16.37.0 | Rendered as |
|---|---|---|---|
| GitHub | `github` | yes | brand path |
| Jira | `jira` | yes | brand path |
| Confluence | `confluence` | yes | brand path |
| Atlassian (MCP) | `atlassian` | yes | brand path |
| Lucid | `lucid` | yes | brand path |
| CodeRabbit | `coderabbit` | yes | brand path |
| Claude | `claude` | yes | brand path (`claudecode` also present; we use `claude`) |
| Anthropic | `anthropic` | yes | brand path (AI Reviewer rows) |
| Slack | — | **missing** (removed at the brand's request) | codicon `comment` |
| Salesforce | — | **missing** (removed at the brand's request) | codicon `cloud` |
| Fireflies | — | **missing** (never added) | codicon `mic` |

Rendering rules: 16 px box, `color: var(--dc-icon)`, `opacity: .9`; a logo inside a hovered or focused control
tints to `--dc-primary` (120 ms). Never shown in brand colour, never larger than 16 px (20 px in the Connections
row), never with a background tile. Each logo has `role="img" aria-label="<App>"` when it is the only content of a
control (icon-only link), otherwise `aria-hidden`.

`DC.brand(id, {size})` where id ∈ `github | jira | confluence | atlassian | lucid | coderabbit | claude | anthropic |
slack | salesforce | fireflies`; the three fallbacks resolve to `DC.icon(...)` internally so pages never branch.
Connection ids map: `sf-dev`, `sf-qa`, `mcp-salesforce` → salesforce; `mcp-atlassian` → atlassian; `mcp-*` others →
their app; `ai-reviewer` → anthropic; `code-analyzer` → salesforce; `testing-browsers` → codicon `browser`.
`DeepLink.kind` maps 1:1 (`file` → codicon `file`, `report` → `report`, `url` → `link-external`).

Build step (`build.mjs`, new devDependency `simple-icons@16.37.0`, copy at build time, not at runtime):

```js
// build.mjs — brand logos (CC0 paths from simple-icons; see DESIGN.md §3.2)
import { siGithub, siJira, siConfluence, siAtlassian, siLucid, siCoderabbit, siClaude, siAnthropic } from "simple-icons";
const BRANDS = { github: siGithub, jira: siJira, confluence: siConfluence, atlassian: siAtlassian, lucid: siLucid,
  coderabbit: siCoderabbit, claude: siClaude, anthropic: siAnthropic };
const out = Object.fromEntries(Object.entries(BRANDS).map(([k, i]) => [k, { title: i.title, path: i.path }]));
await fs.writeFile("media/shared/brands/brands.js", `// generated by build.mjs from simple-icons ${version}; do not edit\nwindow.DC_BRANDS = ${JSON.stringify(out)};\n`);
```

`media/shared/brands/` is gitignored and listed in `.vscodeignore` exceptions; `webview.ts` adds the script before
`ui.js`. `DC.brand` builds `<svg viewBox="0 0 24 24"><path d=…></svg>` from `window.DC_BRANDS` and falls back to the
codicon when the key is absent (so a future removal from the package degrades gracefully).

## 4. Progressive disclosure

Three patterns, used everywhere; no fourth.

### 4.1 Hover / focus action strip

```
default   │ [ic] Approve AI plan: CE-13 Tier 2 routing        ● waiting on you · 1 d   [AI review plan]  ›
hover     │ [ic] Approve AI plan: CE-13 Tier 2 routing   gh jira file  …   · 1 d       [AI review plan]  ›
```

The strip (`.dc-strip`) sits in the meta slot to the left of the age; it reserves its width always and has
`opacity: 0` until the row is `:hover` or `:focus-within` (then `opacity: 1`, 120 ms). It holds: up to **three** link
logos (icon-only ghost buttons with tooltip = link label), then an overflow "…" button when there are more links or
secondary actions. The status text hides while the strip is visible so the row never changes width or height.
Touch/no-hover devices: `@media (hover: none)` shows the strip always at 70 % opacity.

### 4.2 Expand row

Clicking the row (anywhere that is not a control) or the chevron toggles `aria-expanded` on the row button and
`.is-open` on the row; the panel below animates `grid-template-rows 0fr→1fr`. The panel contains, in this order and
only when present: detail line · links list (logo + label + 12 px external icon) · checks line (dots + names) ·
reviews list (source logo, author, state word, summary) · secondary actions (ghost buttons) · one muted reason line
for disabled actions. Open state is page-local UI state keyed by row key (`ui.open[key]`), so a re-render keeps it.
Keyboard: Enter/Space toggles, Esc collapses, arrows move between rows (roving tabindex in a list).

### 4.3 Overflow menu "…"

`DC.menu(items, {label})` → `<button aria-haspopup="menu">…</button>` + popover (`--dc-surface-2`, shadow, radius 6,
`role="menu"`, items `role="menuitem"` with optional icon, disabled items keep their reason as `title`). Opens on
click, closes on Esc/outside click/item; arrows move. Used for secondary actions and links beyond the first three.

## 5. Components — anatomy, states, `DC.*` API

Shared states: default · hover (`--dc-hover` bg) · focus (`outline: 1px solid var(--dc-primary); outline-offset: -1px`
on rows, `2px` on buttons; `:focus-visible` only) · selected (`--dc-primary-soft` bg + 2 px left border primary) ·
disabled (`opacity: .5; cursor: not-allowed`, reason in tooltip) · loading (`loading` icon replaces the icon, label
stays, `aria-busy`, width locked) · busy row (`aria-busy`, controls disabled, spinner in status slot).

### 5.1 Header — `DC.header({title, sub, persona, personas, onSwitch, actions})`
```
Developer view                                            Developer ▾     ⟳
Signed in as ravi-dev · acme-org/salesDemoOrg
────────────────────────────────────────────────────────────────────────
```
Title 18/600; sub 12 muted. Persona chip: pill, `--dc-chip` bg, `--dc-fg` text 12/500, codicon of the persona at
12 px, chevron when switchable (opens a `DC.menu` listbox). Header actions: **one** ghost icon button (Refresh);
anything else (Settings, Export…) goes in a "…" menu. Sticky, `--dc-surface-0`, 1 px bottom border, no shadow.

### 5.2 Section — `DC.section(title, {count, action, key}, body)`
`<h2>` 15/600 sentence case; count appended as muted text `· 3`; when the count means "needs you" it is rendered in
`--dc-secondary` 600. Optional single ghost action at the right (`Show all`, `Check all`). No chevrons, no
uppercase, no icon.

### 5.3 Row — `DC.row({key, icon, title, status:{tone, text}, age, primary, strip:[...], menu:[...], expanded, open})`
The base of every list. Grid: `16px icon | 1fr title | auto strip | auto status | auto age | auto primary | 16px chevron`.
```
[ic]  Title in 500, truncates with ellipsis                 ● status text · 1 d   [Primary]  ›
      optional one-line detail in meta (only when `meta` is given)
```
`status.tone` ∈ ok | warn | err | info | muted. `primary` is one `DC.button` (kind primary when the row needs the
viewer, otherwise secondary); a disabled primary keeps its reason as tooltip. `strip` = up to three `{brand, label,
href}`; `menu` = further links and actions. `expanded` = a function returning the panel content (rendered only when
open). The row sets `data-key`/`data-hash` for reconcile, and its hash excludes `open`.

### 5.4 Queue row — `DC.queueRow(q, {onFeature})` (Home and Persona "Waiting on you")
Icon = gate codicon (tooltip "G3 · AI plan approved · Developer"). Status = `waiting on you` (tone info) or
`waiting on <persona>` when the viewer cannot act (tone muted); age with tooltip = ISO `since`; overdue (> 3 d) turns
the age `--dc-warn`. Primary = `q.actions[0]`; other actions and links in the menu; expanded shows detail, links,
all actions, reason line. Home sidebar uses the compact variant (`compact: true`): no strip, status under the title,
primary becomes an icon-only ghost arrow that opens the persona view.

### 5.5 Feature row — `DC.featureRow(f, {onOpen})` with `DC.stageLine(stages)`
```
[map]  001-case-escalation                                     ● Build · G3 next, you   [Open]  ›
       ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 7/10 stages
```
Stage line: 10 segments, 3 px tall, 2 px gap, radius 2; done `--dc-secondary`, active `--dc-primary`, todo
`--dc-border`, blocked `--dc-err`; `role="progressbar"` with `aria-valuetext="Build, 7 of 10 stages"`. Status text
= current stage name; when a gate waits on the viewer, `· G3 next, you` in `--dc-secondary`. Expanded: title line,
gates list (`G1 Plan signed off · Architect · done` with dot, own gates 500), `n open questions · n stories ·
score 92`, links list. No gate chips, no ring.

### 5.6 PR row — `DC.prRow(p, {onFeature, viewer})`
```
collapsed │ [pr]  #44 CE-14 Notify the account owner on escalation      ● 2 checks failing · 3 h   [Take over]  ›
expanded  │ [pr]  #44 CE-14 Notify the account owner on escalation      ● 2 checks failing · 3 h   [Take over]  ˅
          │        feature/CE-14-escalation-notify · claude[bot] · attempt 3 · needs-human
          │        Checks    ● guard  ● static  ● qa  ● design-gate  ○ gate/developer  ○ gate/tester
          │        Reviews   [cr] CodeRabbit · changes requested · SOQL inside loop in NotifyOwnerHandler
          │                  [an] AI Reviewer · block · VERDICT: BLOCK (bulk safety)
          │                  [sf] Code Analyzer · block · 2 violations
          │                  [bk] SF AI Tester · block · S03-TC-01 failed: no email sent
          │        Links     [gh] PR #44 ↗   [jira] CE-14 ↗   [cr] CodeRabbit ↗   [gh] Checks ↗
          │        [AI review]  [Approve (G5)]  — Approve needs every check green
```
Status text is computed, one phrase, in priority order: `n checks failing` (err) → `blocked by <tool>` (err) →
`waiting on you` (info) → `checks running` (info) → `review pending` (muted) → `ready` (ok) → `draft` (muted).
Labels are not shown collapsed; `ai-attempt-n ≥ 3` appears in the expanded meta line. Draft PR: muted title and
draft icon. Checks line: dots + names, pending dot pulses once per state change only. Reviews: logo (human =
codicon `person`), author, state word in its tone, summary truncated to one line, link via the whole line.

### 5.7 Connection row — `DC.connectionRow(r, {onConnect, onCheck, onDisconnect, onManage})`
```
[gh]  GitHub                                      ● Connected · demo-architect      [Reconnect]  ›
[cl]  Claude (subscription)                       ● Expires in 19 days               [Reconnect]  ›
[at]  Atlassian MCP                               ● Problem                          [Sign in]    ›
```
Brand logo 20 px. Status word from state (`Connected` ok · `Expires in n days` warn · `Problem` err · `Checking`
spinner · `Not verified` muted · `Not connected` muted) followed by `· account` when it fits in one line. Primary =
`connectLabel`; strip = Check (codicon `sync`) + Manage (logo of the vendor page) ; menu = Disconnect (danger) when
allowed. Expanded: detail line, links, scope + needed-by personas as muted text, disabled reason. Check puts the row
in busy state; the result arrives through state → hash changes → flash + `DC.announce`.
v3 stores no credentials, so there are no secret rows: the Project section shows read-only repo checks instead
(rulesets, production environment, "workflows without stored credentials").

### 5.8 Tabs — `DC.tabs(items, selected, onSelect)`
Text 13/500, selected `--dc-fg` with 2 px `--dc-primary` underline (one `.tab-ink` that slides 200 ms), others
`--dc-muted`. Count as muted text after the label. Roving tabindex, arrows, Home/End. Hidden panels not rendered.

### 5.9 Segmented — `DC.segmented(options, value, onChange, {label})`
Pill container 1 px `--dc-border`; selected option `--dc-primary-soft` bg + `--dc-primary` text 500; `role="radiogroup"`.
Used for Mode / Org on Testing and for Act-as on Connections.

### 5.10 Buttons — `DC.button(label, onClick, {kind, icon, iconOnly, loading, disabled, reason, size, tip})`
Kinds: **primary** (`--dc-primary-strong` bg, white text) · **secondary** (transparent, 1 px `--dc-border-strong`,
`--dc-fg`) · **ghost** (transparent, `--dc-fg` text or `--dc-icon` icon, hover bg) · **danger** (ghost with
`--dc-err` text; only inside menus and confirmations). Height 28 px (sm 24), padding 0 12 px, radius 6, 13/500.
Hover: primary darkens 6 % (`color-mix(... black 6%)`), others get `--dc-hover`; press: none (no scale); focus:
2 px primary ring offset 2. Disabled: opacity .5, `reason` becomes `data-tip` and `aria-describedby` → a visually
hidden element; nothing inline. `iconOnly` requires `label` (becomes `aria-label` + tooltip).
`DC.actionButtons(actions, allowed)` returns `{primary, rest}`: the first allowed action (or the first action if none
is allowed) is primary; the rest go to the menu or the expanded panel.

### 5.11 Toast — `DC.toast(text, {kind, action, timeout = 5000, id})`
Bottom-right, max 3, `--dc-surface-2`, shadow, radius 6, 6 px dot in kind colour, text 13, one action link, close.
Enters with 8 px rise + fade 200 ms; pauses on hover. `DC.announce` mirrors to the live region.

### 5.12 Skeleton — `DC.skeleton({kind: "rows", n})`
Rows of two bars (title 40 %, meta 24 %), `--dc-chip` colour, no shimmer (static; reduced-motion safe by design).

### 5.13 Empty state — `DC.empty({icon, title, text, action})`
Centred, 24 px codicon in `--dc-icon`, title 13/500, text meta, one secondary button. No dashed box.

### 5.14 Progress — `DC.progress({value, max, segments})`, `DC.ring(value, max, {size})`
Bar 4 px, track `--dc-border`, fill `--dc-secondary` (stacked segments in status colours when `segments` given),
width transition 240 ms, `role="progressbar"`. Ring 20 px, stroke 2, same colours; used only in the run panel heading.

### 5.15 Log — `DC.log(id, lines, {follow})`
`<pre role="log">`, `--dc-surface-1`, mono 12, line classes as v1, max-height 240 px, "Jump to latest" ghost link
when not following. The only box on the Testing page besides the run panel that contains it.

### 5.16 Chip — `DC.chip(text, {tone})`
18 px, 12/500, `--dc-chip` bg, `--dc-muted` text; tones `primary` (soft primary bg, primary text) and `secondary`.
No status chips: status is `DC.status(tone, text)` = dot + text.

### 5.17 Tooltip — `data-tip`
CSS tooltip `[data-tip]::after`, `--dc-surface-2`, shadow, 12 px, max 280 px, appears on hover/focus after 300 ms,
mirrored to `aria-label`/`aria-describedby`.

## 6. Per-page layouts (collapsed default state)

### 6.1 Home (sidebar, compact rows)
```
ravi-dev · Developer ▾                                  ⟳
────────────────────────────────────────────────────────
Waiting on you · 3
[G3]  Approve AI plan: CE-13 Tier 2 routing          →
      waiting on you · 1 d
[G5]  Code review: CE-12 Agent escalates a Case      →
      waiting on you · 5 h
[!]   Take over CE-14: AI stopped after 3 attempts   →
      needs a human · 3 h
Show all 7

Go to
[beaker]  Testing                      2 running
[plug]    Connections                  1 expiring
[code]    Developer view

Updated 10:42
```
Notices (setup needed, GitHub error) are one `DC.notice` line each (icon + text + one link), above the queue.

### 6.2 Persona view
```
Developer view                                     Developer ▾   ⟳
Signed in as ravi-dev · acme-org/salesDemoOrg
Developer   (Architect also sees: Architect · Developer · Tester tabs)
─────────────────────────────────────────────────────────────────────
Waiting on you · 3
[G3] Approve AI plan: CE-13 Tier 2 routing     ● waiting on you · 1 d   [AI review plan]  ›
[G5] Code review: CE-12 Agent escalates a Case ● waiting on you · 5 h   [AI review]       ›
[!]  Take over CE-14: AI stopped after 3…      ● needs a human · 3 h    [Take over]       ›

Features · 2
[map] 001-case-escalation                       ● Build · G3 next, you  [Open]  ›
      ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 7/10
[map] 002-entitlement-sla                       ● Clarify · 3 questions [Open]  ›
      ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 1/10

Pull requests · 4                                       Start AI session ▾
[pr] #44 CE-14 Notify the account owner…        ● 2 checks failing · 3 h [Take over]     ›
[pr] #42 CE-12 Agent escalates a Case…          ● waiting on you · 5 h   [Approve (G5)]  ›
[pr] #43 CE-13 Escalated Cases route to…        ● draft · 1 d            [AI review plan] ›
[pr] #41 Spec: case escalation stories…         ● ready · 1 d            [Open]          ›
```
AI actions are not a section any more: they are the "Start AI session ▾" menu on the Pull requests section (one
item per `aiActions` entry, disabled with reason when `!allowed`). When the viewer is an Architect looking at the
Developer tab, every primary action is disabled with the reason tooltip "You act as Architect; switch persona to
run Developer actions", and the status text reads `waiting on Developer`.

### 6.3 Feature detail
```
001-case-escalation                                       Developer ▾   ⟳
Case escalation with reason and queue routing · score 92 · signed off
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ Build · 7/10 stages
Next: G3 AI plan approved · Developer (you)                 [AI review plan]
─────────────────────────────────────────────────────────────────────
Gates · 6 of 9 done
● G1 Plan signed off              Architect        done
● G2 Testability confirmed        Tester           done
● G3 AI plan approved             Developer (you)  waiting      [AI review plan] ›
…
Stories · 4
[book] 00 Contract and data model        ● PR #41 merged     [Open]  ›
[book] 01 Agent escalates a Case         ● PR #42 in review  [Open]  ›
Sources · 2       Links · 4        (plain lists; links show logo + label)
```
Gate rows are rows with status words; only the gate that waits on the viewer has a primary action. Spec Kit
actions for other personas live in the gate row's menu, disabled with reason.

### 6.4 Connections
```
Connections                                   Act as [Architect|Developer|Tester]   ⟳
demo-architect · acme-org/salesDemoOrg · admin
─────────────────────────────────────────────────────────────────────
Personal · 5                                                        Check all
[gh] GitHub                      ● Connected · demo-architect    [Reconnect] ›
[cl] Claude (subscription)       ● Expires in 19 days            [Reconnect] ›
[sf] Salesforce dev org          ● Connected · demo.user@…       [Reconnect] ›
[ji] Jira                        ● Connected · dev.user@example.com[Reconnect] ›
[sl] Slack                       ● Not verified                  [Connect]   ›
Claude MCP · 3
[at] Atlassian MCP               ● Problem                       [Sign in]   ›
[gh] GitHub MCP                  ● Not verified                  [Sign in]   ›
[sf] Salesforce DX MCP           ● Deprecated                    [Open]      ›
Review tools · 3
[cr] CodeRabbit                  ● Not verified                  [Install app]›   (disabled: admin only)
Project · runner, GitHub for Jira, CodeRabbit rows, then read-only repo checks and reminders (no secrets in v3)
8 connections only other personas need are hidden · Checked 3 min ago
```

### 6.5 Testing
```
Testing                                                       Tester ▾   …   ⟳
Runs as maria-qa
─────────────────────────────────────────────────────────────────────
Suites                      │ Smoke - Account · 2 cases                  Validate
[file] Smoke - Account  ●2  │ Mode [manual|automation|both]  Org [qa|dev]   [Run all]
[file] Lead convert     ●1●1│ Cases   Results   Runs   Generate
                            │ ☐ SMOKE-ACC-001 Create a Business Account…   ● passed · 4 h  ›
                            │ ☐ SMOKE-ACC-002 The "Key Customers" list…    ● passed · 4 h  ›
                            │ ┌ Running · 1 of 2 · SMOKE-ACC-001 manual        [Cancel] ┐
                            │ │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │
                            │ │ ● SMOKE-ACC-002 passed   ◌ SMOKE-ACC-001 running         │
                            │ │ Log ˅  (collapsed; last line shown in meta)              │
                            │ └──────────────────────────────────────────────────────────┘
```
Suite list is a narrow list (not a boxed sidebar); selected suite = primary-soft bg + 2 px rail. Case rows show
one status (manual or automation, whichever ran last; the other in the expanded row). The run panel is the one box
on the page: heading, 4 px progress, per-case dots, log collapsed by default with its last line as meta and a
chevron to open. Results tab: route as status text (`● Pass · every case passed`), four counts as muted text, case
rows expandable (steps table and evidence inside).

### 6.6 Setup wizard
```
Project setup                                              B2 of 13 · Admin ▾   ⟳
Phases                 │ B2 Self-hosted runners               ● partial     [Check all]
● B0 Prerequisites     │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 2/4 steps
● B1 GitHub repo       │ [server] Runner "circuit" online ● online           [Check]   ›
◐ B2 Runners           │ [server] Runner "circuit-release" ● missing         [Copy]    ›
○ B3 Salesforce logins │ [person] Sign in the runner user ● waiting for you  [Done]    ›
```
Phase list = rows with status dot; step cards become rows (kind icon, title, status, one action; detail and
checklist inside the expanded row). The config form (`build.config.yml`) is a second tab; Save becomes primary
only when dirty.

### 6.7 AI session
```
Claude · /dev-review-plan 42                                   Developer ▾   ● running
┌──────────────────────────────────────────────────────────────────────┐
│ You      Review the plan on PR 42                                      │
│ Claude   Reading docs/plans/CE-13/PLAN.md …▍                           │
│          ↳ Read  src/… ✓   ↳ Grep  Handler ✓     (tool rows, meta)     │
└──────────────────────────────────────────────────────────────────────┘
claude-sonnet · 3 turns · $0.012                       [Send]  Stop
```
The log is the one box. Tool calls are meta rows indented under the message; a streaming message shows a 1-char
caret. Composer: textarea + primary Send (`Ctrl+Enter` hint in tooltip) + ghost Stop.

## 7. Keyed updates (`DC.mount`)

Unchanged from the v1 reconcile, with three adjustments:
1. `data-hash` of a row never includes UI-only state (`open`, checked, menu open); those live in the page's `ui`
   object keyed by `data-key`, and `DC.row` re-applies `.is-open` from `ui.open[key]` after each mount.
2. A changed row gets `.dc-changed` → background `--dc-primary-soft` fading out over 900 ms (reduced motion: 1 px
   primary left border for 2 s). New rows enter with a 160 ms fade, no translate, no stagger beyond 4 rows.
3. Expanded panels reconcile too: a review list inside an open PR row updates in place and flashes its own row.

Incremental events (log lines, streaming text, run progress) still append in place through `DC.onEvent`.

## 8. Accessibility

- Contrast (verified, §10): all text ≥ 4.5:1 on `--dc-surface-0` and `-1` in both themes; icons and dots ≥ 3:1;
  status is never colour alone (dot + word). HC maps every brand token to a VS Code HC variable and drops soft
  backgrounds and shadows.
- Rows are `role="button" aria-expanded` when expandable; controls inside stop propagation. Lists use roving
  tabindex (arrows, Home/End); Enter/Space expands; Esc collapses or closes a menu.
- The action strip is reachable by keyboard (`:focus-within` reveals it); icon-only buttons have `aria-label`
  and a tooltip; disabled buttons expose their reason via `aria-describedby`.
- `main#app` has no `aria-live`; `#dc-live` (`role="status"`, polite) receives `DC.announce` for: connection check
  results, run start/finish, gate action result, toast text, persona switch. Logs are `role="log" aria-live="off"`.
- Focus is never hidden: 1 px primary outline inset on rows, 2 px offset on buttons; `prefers-reduced-motion`
  respected everywhere (§2.6).
- Tooltips appear on focus as well as hover and never contain the only copy of an action's label.

## 9. Build notes for the implementer

- devDependencies: `@vscode/codicons` (as v1), `simple-icons@16.37.0` (build-time only; emits
  `media/shared/brands/brands.js`, see §3.2). Add `media/shared/brands/` to `.gitignore` and to `.vscodeignore`
  exceptions; `webview.ts` loads `brands.js` before `ui.js` with the same CSP nonce.
- `base.css`: replace the v1 token block with §2; delete persona tint tokens and `body[data-persona]` colour rules;
  delete uppercase section header styles, rails, card shadows and the status tint rules.
- `ui.js`: add `DC.row`, `DC.status`, `DC.strip`, `DC.menu`, `DC.brand`, `DC.stageLine`; rewrite `queueCard` →
  `queueRow`, `featureCard` → `featureRow`, `prRow`, `connectionRow` on top of `DC.row`; `actionButtons` returns
  `{primary, rest}`; `reason()` is removed (reason is a tooltip). Keep `header`, `section`, `tabs`, `segmented`,
  `button`, `toast`, `skeleton`, `empty`, `progress`, `log`, `chip`, `mount`, `announce` with the same signatures.
- Pages: remove every inline links row, chips row, reason span and second button; each list item becomes one
  `DC.*Row` call with `expanded` content. Home uses `compact: true`.
- ARCHITECTURE.md UI rule 2 ("every card/row shows `DC.links`") becomes "every row exposes its links in the hover
  strip (first three) and in its expanded panel (all)".

## 10. Contrast verification (WCAG 2.x ratios, computed)

| Token | Dark hex on `#1F1F1F` / `#181818` | Light hex on `#FFFFFF` / `#F8F8F8` |
|---|---|---|
| `--dc-primary` | `#818CF8` 5.53 / 5.95 | `#4F46E5` 6.29 / 5.92 |
| white on `--dc-primary-strong` | `#5B5FEA` 4.92 | `#4F46E5` 6.29 |
| `--dc-secondary` | `#2DD4BF` 8.85 / 9.54 | `#0F766E` 5.47 / 5.15 |
| `--dc-fg` (fallback) | `#E2E8F0` 13.37 / 14.40 | `#1E293B` 14.63 / 13.77 |
| `--dc-muted` | `#9AA4B2` 6.54 / 7.04 | `#475569` 7.58 / 7.14 |
| `--dc-icon` (graphic, needs 3:1) | `#8B95A5` 5.45 / 5.87 | `#64748B` 4.76 / 4.48 |
| `--dc-ok` | `#4ADE80` 9.46 / 10.19 | `#15803D` 5.02 / 4.72 |
| `--dc-warn` | `#FBBF24` 9.87 / 10.64 | `#A16207` 4.92 / 4.64 |
| `--dc-err` | `#F87171` 5.96 / 6.42 | `#B91C1C` 6.47 / 6.09 |

Every text use ≥ 4.5:1; `--dc-icon` in light on the sidebar surface is 4.48:1, used for icons only (≥ 3:1 required).
VS Code's own foregrounds (`#CCCCCC` dark 10.26, `#3B3B3B` light 11.20) are used when present.
