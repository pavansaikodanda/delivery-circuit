// Sidebar "Circuit" (docs/CIRCUIT-V4.md section 7): header (user · role chip · refresh) and three tabs: Work,
// Connections, Missing. One button per row; the row id goes back to the extension, which knows what it runs.
// State comes from src/views/model.ts buildHome().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));
  document.body.classList.add("sidebar");

  const TABS = ["work", "connections", "missing"];
  const saved = (() => { try { return DC.vscode.getState() || {}; } catch { return {}; } })();
  const fromHash = /tab=(\w+)/.exec(location.hash || "");
  let tab = TABS.includes(fromHash && fromHash[1]) ? fromHash[1] : TABS.includes(saved.tab) ? saved.tab : "work";
  const setTab = (t) => {
    tab = t;
    try { DC.vscode.setState(Object.assign({}, DC.vscode.getState() || {}, { tab })); } catch { /* preview */ }
    if (DC.state) DC.mount(render(DC.state));
  };

  const refresh = () => post({ type: "refresh" });
  const run = (id) => post({ type: "run", id });
  const STEP_ICON = { intake: "mic", design: "edit", stories: "list-tree", build: "tools", fix: "wrench", review: "code-review",
    qa: "beaker", tests: "checklist", promote: "git-pull-request", prod: "rocket" };
  const STATUS_TONE = { design: "", ready: "", building: "info", "in-pr": "info", qa: "info", done: "ok" };
  const CONN = { connected: ["ok", "Connected"], disconnected: ["", "Not connected"], error: ["err", "Problem"], checking: ["checking", "Checking"], unknown: ["", "Not checked"] };
  const GROUPS = [["connections", "Connections"], ["repo", "Repo setup"], ["stories", "Stories"]];

  DC.mount(DC.skeleton({ n: 3, label: "Loading" }));
  DC.onState(render);

  function render(s) {
    if (!s) return DC.skeleton({ n: 3 });
    if (s.mode === "signin") {
      return [DC.header({ title: "Delivery Circuit", onRefresh: refresh }),
        DC.empty({ icon: "github", title: "Sign in to GitHub", text: "Your role comes from your GitHub teams.",
          action: { label: "Sign in", kind: "primary", onClick: () => post({ type: "connectGithub" }) } })];
    }
    const u = s.user;
    const head = DC.header({ title: u.login, sub: s.repo || "No GitHub remote", role: u.role, roles: u.roles.map((r) => r.id), onRefresh: refresh });
    const tabs = DC.tabs([
      { id: "work", label: "Work" },
      { id: "connections", label: "Connections" },
      { id: "missing", label: "Missing", count: s.missingCount || null },
    ], tab, setTab);
    const body = tab === "connections" ? connections(s) : tab === "missing" ? missing(s) : work(s);
    return [head, tabs, s.notice ? DC.notice(s.notice, "info") : null, ...body];
  }

  // ---------- Work ----------
  function work(s) {
    if (s.mode === "no-remote") {
      return [DC.empty({ icon: "repo", title: "No GitHub remote", text: "Open a Salesforce DX repo whose origin is on GitHub." })];
    }
    const w = s.work;
    if (!w) return [DC.skeleton({ n: 4, label: "Reading Jira and GitHub" })];
    const out = [];
    (w.errors || []).forEach((e) => out.push(DC.notice(e, "warn", { action: { label: "Retry", onClick: refresh } })));
    out.push(DC.section("Next steps", { key: "sec:next", first: true },
      w.next.length
        ? DC.list(w.next.map((r) => DC.row({
          key: "n-" + r.id, compact: true, icon: DC.icon(STEP_ICON[r.id.split(":")[0]] || "arrow-right"), title: r.title, meta: r.detail || null,
          primary: { label: r.button, onClick: () => run(r.id), kind: "secondary" }, hash: r,
        })), { label: "Next steps" })
        : DC.empty({ icon: "check", title: "Nothing to do", text: "Nothing waits on you right now." })));
    const sp = w.sprint;
    out.push(DC.section("Sprint", { key: "sec:sprint", count: sp.stories.length || null, action: sp.name ? h("span.dc-mono-muted", sp.name) : null },
      sp.stories.length
        ? DC.list(sp.stories.map((x) => DC.row({
          key: "s-" + x.key, compact: true, num: x.key, title: x.title, onClick: () => post({ type: "openStory", key: x.key }),
          primary: DC.status(STATUS_TONE[x.status], x.statusLabel), hash: x,
        })), { label: "Sprint stories" })
        : DC.empty("No stories in the sprint yet.")));
    out.push(footer(s, w.updatedAt));
    return out;
  }

  // ---------- Connections ----------
  function connections(s) {
    return [DC.list(s.connections.map((c) => {
      const st = CONN[c.state] || ["", c.state];
      const busy = c.state === "checking";
      const msg = c.button === "Check" ? "check" : "connect";
      return DC.row({
        key: "c-" + c.id, compact: true, icon: DC.brand(c.id, { size: 16 }), title: c.label, busy,
        status: { tone: st[0], text: c.state === "connected" && c.account ? c.account : st[1] },
        meta: c.detail || null,
        primary: { label: busy ? "Check" : c.button, kind: c.button === "Fix" ? "primary" : c.button === "Check" ? "ghost" : "secondary",
          disabled: busy, reason: busy ? "Checking" : null, onClick: () => post({ type: msg, id: c.id }) },
        hash: c, state: c.state,
      });
    }), { label: "Connections" })];
  }

  // ---------- Missing ----------
  function missing(s) {
    if (!s.missing) return [DC.skeleton({ n: 3, label: "Checking what is missing" })];
    if (!s.missing.length) return [DC.empty({ icon: "pass", title: "Nothing missing", text: "Everything the flow needs is in place." })];
    return GROUPS.map(([g, title]) => {
      const items = s.missing.filter((m) => m.group === g);
      if (!items.length) return null;
      return DC.section(title, { key: "sec:m-" + g, count: items.length },
        DC.list(items.map((m) => DC.row({
          key: "m-" + m.id, compact: true, icon: DC.icon(m.id === "repo:bootstrap" ? "tools" : "circle-outline"), title: m.title, meta: m.detail || null,
          primary: { label: m.button, onClick: () => run(m.id), kind: m.id === "repo:bootstrap" ? "primary" : "secondary" }, hash: m,
        })), { label: title }));
    });
  }

  function footer(s, at) {
    const t = at ? new Date(at) : null;
    return h("p.dc-footer", { "data-key": "footer" }, t && !isNaN(t.getTime()) ? "Updated " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  }
})();
