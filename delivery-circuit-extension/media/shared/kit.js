// UI kit gallery (preview only, not packaged): every DC.* component in its states, with fixture data in the
// contract shapes (preview/fixtures/shared.kit.default.json). Open http://127.0.0.1:5178/page/shared/kit?theme=dark
(function () {
  "use strict";
  const { h } = DC;
  const local = { tab: "components", seg: "manual", org: "qa", data: null, running: true };
  DC.ui.open["q-d-g3-43"] = DC.ui.open["q-d-g3-43"] ?? true;
  DC.ui.open["pr-44"] = DC.ui.open["pr-44"] ?? true;

  // gallery-only layout helpers (the preview has no CSP; pages never do this)
  try {
    const css = new CSSStyleSheet();
    css.replaceSync(`.kit-line{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:8px 0 12px}
      .kit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px;align-items:start;margin:8px 0}
      .kit-sidebar{max-width:340px;background:var(--dc-surface-1);padding:0 12px}
      .kit-stage{display:flex;align-items:center;gap:12px;flex:1;min-width:200px;margin:0}
      .kit-cases{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;margin-top:8px}.kit-cases>span{display:inline-flex;align-items:center;gap:6px}
      .kit-brands{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px 16px}
      .kit-brand{display:flex;align-items:center;gap:8px}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, css];
  } catch { /* older engines: gallery still renders, less tidy */ }
  const say = (text, kind) => DC.toast(text, { kind: kind || "info" });
  const onAction = (a) => { DC.action(a); say(a.label + " started", "info"); };
  const rerender = () => { if (local.data) DC.mount(render(local.data)); };

  function brands() {
    const ids = ["github", "jira", "confluence", "atlassian", "lucid", "coderabbit", "claude", "anthropic", "slack", "salesforce", "fireflies", "file", "report", "url"];
    return h("div.kit-brands", ids.map((id) => h("span.kit-brand", DC.brand(id), h("span.meta", id), DC.brand(id, { size: 12 }), DC.brand(id, { size: 20 }))));
  }

  function runPanel(live) {
    if (!live) return null;
    const results = Object.fromEntries((live.results || []).map((r) => [r.caseId, r.status]));
    if (live.current && !results[live.current.caseId]) results[live.current.caseId] = "running";
    const done = local.running ? live.done || 0 : live.total;
    const heading = local.running
      ? "Running · " + done + " of " + live.total + (live.current ? " · " + live.current.caseId + " " + live.current.mode : "")
      : "Finished · " + live.total + " of " + live.total + " passed · route pass";
    const lines = (live.log || []).concat(local.running ? [] : ["[W1] PASSED SMOKE-ACC-001 (manual) in 82s", "Run finished: 2 passed, 0 failed, 0 blocked -> route pass"]);
    return DC.box({
      key: "run", busy: local.running, title: heading,
      status: local.running ? DC.icon("loading", { cls: "info" }) : DC.dot("ok"),
      actions: local.running
        ? DC.button("Cancel run", () => { local.running = false; rerender(); DC.toast("Smoke - Account finished: 2/2 passed · route pass", { kind: "ok", action: { label: "Open report", onClick: () => {} } }); }, { kind: "ghost", size: "sm", icon: "debug-stop" })
        : DC.button("Open report", () => {}, { kind: "ghost", size: "sm", icon: "report" }),
    },
    DC.progress({ value: done, max: live.total }),
    h("div.kit-cases", Object.entries(results).map(([id, s]) => h("span", local.running && s === "running" ? DC.icon("loading", { size: 12, cls: "info" }) : DC.dot(DC.stateClass(local.running ? s : "passed")),
      h("span.mono", id), h("span.muted", local.running ? s : "passed")))),
    DC.log("kit-run", lines));
  }

  function render(d) {
    local.data = d;
    const viewer = d.viewer;
    const queueNeeds = d.queue.length;
    const aiMenu = DC.menu(d.aiActions.map((a) => ({ label: a.label, icon: "sparkle", disabled: a.allowed === false, reason: a.reason, onClick: () => onAction(a) })),
      { text: "Start AI session", icon: "sparkle", label: "Start AI session" });
    const conns = d.connections.map((r) => DC.connectionRow(r, {
      onCheck: (id) => setTimeout(() => {
        const row = local.data.connections.find((x) => x.id === id);
        if (row) { row.state = row.state === "connected" ? "expiring" : "connected"; row.expiresAt = row.state === "expiring" ? new Date(Date.now() + 19 * 864e5).toISOString() : row.expiresAt; }
        rerender();
      }, 1500),
      onConnect: (id) => say("Connect " + id),
      onDisconnect: (id) => say(id + " disconnected", "warn"),
      onManage: (id) => say("Opens the vendor page for " + id),
    }));
    return [
      DC.header({
        title: "UI kit", sub: "Quiet Circuit · every component in its states · signed in as " + d.login + " · " + d.repo,
        persona: viewer, personas: ["architect", "developer", "tester"], onSwitch: (p) => { local.data.viewer = p; rerender(); },
        onRefresh: () => say("Refreshed", "ok"),
        menu: [{ label: "Export Excel", icon: "export" }, { label: "Export PDF", icon: "export" }, "-", { label: "Settings", icon: "settings-gear" }],
      }),
      DC.tabs([{ id: "components", label: "Components" }, { id: "rows", label: "Rows", count: 4 }, { id: "legacy", label: "First-kit names" }, { id: "disabled", label: "Disabled", disabled: true, title: "Example of a disabled tab" }],
        local.tab, (id) => { local.tab = id; rerender(); }),

      local.tab !== "legacy" ? [
        DC.section("Waiting on you", { count: queueNeeds, needs: true, first: true },
          DC.list(d.queue.map((q) => DC.queueRow(q, { viewer, onAction, onFeature: (id) => say("Opens feature " + id) })), { label: "Waiting on you" })),
        DC.section("Architect viewing the Developer tab", { count: d.queueAsArchitect.length },
          DC.list(d.queueAsArchitect.map((q) => DC.queueRow(q, { viewer: "architect", view: "developer", canAct: false, onAction })), { label: "Developer queue, view only" })),
        DC.section("Home sidebar (compact)", {},
          h("div.kit-sidebar", DC.list(d.queue.map((q) => DC.queueRow(q, { compact: true, onOpen: () => say("Opens the Developer view") })), { label: "Compact queue" }))),
        DC.section("Features", { count: d.features.length },
          DC.list(d.features.map((f) => DC.featureRow(f, { viewer, onOpen: (id) => say("Opens feature " + id) })), { label: "Features" })),
        DC.section("Pull requests", { count: d.prs.length, action: aiMenu },
          DC.list(d.prs.map((p) => DC.prRow(p, { viewer, onAction, onFeature: (id) => say("Opens feature " + id) })), { label: "Pull requests" })),
        DC.section("Connections", { count: d.connections.length, action: DC.button("Check all", () => say("Checking " + d.connections.length + " connections"), { kind: "ghost", size: "sm", icon: "sync" }) },
          DC.list(conns, { label: "Connections" })),
        DC.section("Project secrets", { count: d.secrets.length },
          DC.list(d.secrets.map((s, i) => DC.secretRow(s, { canSet: i !== 2, reason: "Needs repo admin" })), { label: "Secrets" })),
      ] : null,

      local.tab === "components" ? [
        DC.section("Buttons", {},
          h("div.kit-line", DC.button("Primary", () => say("Primary")), DC.button("Secondary", null, { kind: "secondary" }), DC.button("Ghost", null, { kind: "ghost", icon: "sparkle" }),
            DC.button("Danger", null, { kind: "danger", icon: "debug-disconnect" }), DC.button("Loading", null, { kind: "secondary", icon: "sync", loading: true }),
            DC.button("Approve (G5)", null, { disabled: true, reason: "Approve after the AI review and CodeRabbit's open nitpick are resolved" }),
            DC.button("Refresh", null, { kind: "ghost", icon: "refresh", iconOnly: true }), DC.button("GitHub", null, { kind: "ghost", brand: "github", iconOnly: true })),
          h("div.kit-line", DC.button("Small primary", null, { size: "sm" }), DC.button("Small secondary", null, { size: "sm", kind: "secondary" }),
            DC.button("Small ghost", null, { size: "sm", kind: "ghost", icon: "arrow-right" }), DC.button("Disabled", null, { size: "sm", kind: "secondary", disabled: true, reason: "Tick the cases to run" }),
            DC.menu([{ label: "AI review", icon: "sparkle" }, { label: "Approve (G5)", icon: "check", disabled: true, reason: "Needs every check green" }, "-",
              { label: "CodeRabbit review", brand: "coderabbit" }, { label: "Disconnect", icon: "debug-disconnect", danger: true }]),
            DC.button("Link button", null, { kind: "link" }))),
        DC.section("Status, chips, tooltips", {},
          h("div.kit-line", DC.status("ok", "passed", { age: "4 h" }), DC.status("warn", "Expires in 19 days"), DC.status("err", "2 checks failing", { age: "3 h" }),
            DC.status("info", "waiting on you", { age: "6 d", late: true, since: "2026-11-05T10:00:00Z" }), DC.status("muted", "draft"), DC.status("running", "Checking"),
            DC.status("info", "Build", { extra: "G3 next, you" })),
          h("div.kit-line", DC.chip("Developer"), DC.chip("primary", { tone: "primary" }), DC.chip("secondary", { tone: "secondary" }), DC.chip("feature/CE-14", { mono: true, icon: "git-branch" }),
            DC.tip(h("span.muted", "Hover me"), "Tooltips use data-tip, appear after 300 ms and on focus"), DC.kbd("Ctrl+Enter"))),
        DC.section("Segmented and progress", {},
          h("div.kit-line", h("span.meta", "Mode"), DC.segmented(["manual", "automation", "both"], local.seg, (v) => { local.seg = v; rerender(); }, { label: "Mode" }),
            h("span.meta", "Org"), DC.segmented([{ value: "qa", label: "qa" }, { value: "dev", label: "dev" }, { value: "prod", label: "prod", disabled: true, reason: "Tests never run against production" }], local.org, (v) => { local.org = v; }, { label: "Org" })),
          h("div.kit-grid", DC.progress({ value: 3, max: 5 }), DC.progress({ segments: { passed: 6, failed: 2, blocked: 1, error: 0 } }),
            h("div.kit-line", DC.ring(6, 9, { label: "6 of 9 gates done" }), DC.ring(2, 2, { tone: "ok" }), DC.ring(null, null), h("span.dc-meta-line.kit-stage", DC.stageLine(d.features[0].stages))))),
        DC.section("Run panel (the one box)", {}, runPanel(d.live)),
        DC.section("Feedback", {},
          h("div.kit-line", DC.button("Info toast", () => DC.toast("Claude session started: AI review plan"), { kind: "secondary", size: "sm" }),
            DC.button("Success toast", () => DC.toast("Smoke - Account finished: 2/2 passed", { kind: "ok", action: { label: "Open report", onClick: () => {} } }), { kind: "secondary", size: "sm" }),
            DC.button("Warning toast", () => DC.toast("Claude subscription expires in 19 days", { kind: "warn" }), { kind: "secondary", size: "sm" }),
            DC.button("Error toast", () => DC.toast("GitHub: 401 Bad credentials", { kind: "err", timeout: 0 }), { kind: "secondary", size: "sm" })),
          DC.notice("Setup is not finished: 3 of 13 phases done.", "warn", { action: { label: "Open setup", onClick: () => say("Opens setup") } }),
          DC.notice("GitHub could not be reached; showing data from 10:42.", "err"),
          DC.notice("View only: you act as Architect.", "info"),
          h("div.kit-grid", DC.skeleton({ n: 3 }), DC.empty({ icon: "git-pull-request", title: "No pull requests", text: "Pull requests for this repo appear here once Claude or a person opens one.", action: { label: "Start AI session", icon: "sparkle", onClick: () => {} } }))),
        DC.section("App logos", {}, brands()),
      ] : null,

      local.tab === "legacy" ? DC.section("First-kit names (quiet style)", { first: true },
        h("div.stack",
          h("div.row", DC.dot("ok"), DC.dot("warn"), DC.dot("err"), DC.dot("info"), DC.dot(""), DC.badge("2 passed", "passed"), DC.badge("1 failed", "failed"), DC.badge("not run")),
          DC.links(d.features[0].links),
          DC.steps([{ label: "G1", state: "done" }, { label: "G2", state: "done" }, { label: "G3", state: "waiting" }, { label: "G4", state: "blocked" }, { label: "G5", state: "todo" }]),
          DC.actionButtons(d.queue[1].actions, (a) => a.allowed),
          DC.actionButtons(d.queueAsArchitect[0].actions, (a) => a.allowed, { viewer: "architect" }),
          DC.notice("A first-kit notice line", "ok"),
          DC.empty("Nothing here yet."),
          DC.table([{ key: "id", label: "Case" }, { key: "title", label: "Title" }, { key: "status", label: "Status", render: (r) => DC.badge(r.status, DC.stateClass(r.status)) }, { key: "when", label: "When", render: (r) => DC.when(r.at) }],
            [{ id: "SMOKE-ACC-001", title: "Create a Business Account", status: "passed", at: new Date(Date.now() - 4 * 36e5).toISOString() },
              { id: "SMOKE-ACC-002", title: "GFS Customers list view", status: "failed", at: null }]))) : null,

      h("div.dc-footer", "Updated " + new Date().toTimeString().slice(0, 5)),
    ];
  }
  DC.onState(render);
})();
