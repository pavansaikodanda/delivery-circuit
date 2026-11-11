// Connections page. State comes from src/connections/panelState.ts (PanelState). Posts: connect, check, disconnect,
// manage, switchPersona, setSecret, refresh, openLink.
(function () {
  const { h, post } = DC;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  const STATE_TEXT = { connected: "Connected", disconnected: "Not connected", expiring: "Expiring", error: "Problem", checking: "Checking", unknown: "Not verified" };

  function header(s) {
    const id = s.identity;
    const left = h("div",
      h("h1", "Connections"),
      id ? h("div.sub.row",
        h("span", id.login),
        id.owner ? h("span.muted", "·") : null,
        id.owner ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); DC.openLink({ kind: "github", label: "Repo", target: `https://github.com/${id.owner}/${id.repo}` }); } }, `${id.owner}/${id.repo}`) : null,
        id.isAdmin ? DC.badge("admin") : null,
        (id.personas || []).map((p) => DC.badge(cap(p), p === id.active ? "info" : null)))
        : h("div.sub", "Not signed in to GitHub"));
    const right = h("div.row",
      id && id.personas && id.personas.length > 1 ? h("label.row.small.muted", "Act as",
        h("select", { "aria-label": "Act as persona", onchange: (e) => post({ type: "switchPersona", persona: e.target.value }) },
          id.personas.map((p) => h("option", { value: p, selected: p === id.active }, cap(p))))) : null,
      DC.button("Check all", () => post({ type: "refresh" }), { kind: "secondary" }));
    return h("div.header", left, right);
  }

  function row(r) {
    const dis = !r.actionable;
    const busy = r.state === "checking";
    const meta = [r.account && r.account !== r.detail ? h("span.mono.small", r.account) : null,
      r.expiryText ? DC.badge(r.expiryText, r.state === "expiring" ? "warn" : r.state === "error" ? "err" : null) : null];
    return h("div.item", { "data-id": r.id },
      h("div.spread",
        h("div.row", { style: { flexWrap: "nowrap", alignItems: "flex-start", minWidth: "0" } },
          h("span", { style: { paddingTop: "6px" }, title: STATE_TEXT[r.state] || r.state }, DC.dot(DC.stateClass(r.state))),
          h("div", { style: { minWidth: "0" } },
            h("div.row", h("span.title", r.label), h("span.muted.small", STATE_TEXT[r.state] || r.state), meta),
            r.detail ? h("div.muted.small", r.detail) : null,
            h("div", DC.links(r.links)))),
        h("div.row", { style: { flex: "none" } },
          DC.button(r.connectLabel, () => post({ type: "connect", id: r.id }), { disabled: dis || busy, title: dis ? r.reason : null,
            kind: r.state === "connected" ? "secondary" : null }),
          DC.button("Check", () => post({ type: "check", id: r.id }), { kind: "secondary", disabled: busy }),
          r.manageUrl ? DC.button("Manage", () => post({ type: "manage", id: r.id }), { kind: "ghost" }) : null,
          r.canDisconnect ? DC.button("Disconnect", () => post({ type: "disconnect", id: r.id }), { kind: "ghost" }) : null)));
  }

  function secretRow(x, admin, repoUrl) {
    const state = x.unknown ? "" : !x.present ? "err" : x.expiring ? "warn" : "ok";
    return h("div.item",
      h("div.spread",
        h("div.row", DC.dot(state), h("span.mono", x.name), x.env ? DC.badge(`env ${x.env}`) : null,
          h("span.muted.small", x.unknown ? "not visible to you" : x.present ? "set" : "missing"),
          x.expiryText ? DC.badge(x.expiryText, x.expiring ? "warn" : null) : null),
        h("div.row",
          repoUrl ? DC.links([{ kind: "github", label: "Secrets", target: x.env ? `${repoUrl}/settings/environments` : `${repoUrl}/settings/secrets/actions` }]) : null,
          DC.button(x.present || x.unknown ? "Replace" : "Set", () => post({ type: "setSecret", name: x.name, env: x.env }),
            { kind: x.present || x.unknown ? "secondary" : null, disabled: !admin, title: admin ? null : "Only repo or org admins can set project secrets." }))));
  }

  function projectSection(s) {
    const p = s.project;
    const admin = !!(s.identity && s.identity.isAdmin);
    const out = [h("h2", "Project (admin)")];
    if (!admin) out.push(h("p.muted.small", "Read-only. A repo or org admin sets these up."));
    if (!p) { out.push(h("p.muted", "Loading…")); return out; }
    if (p.error) out.push(DC.notice(p.error, "warn"));
    const block = (title, list, empty) => [h("h3", title),
      list.length ? h("div.list", list.map((x) => secretRow(x, admin, p.repoUrl))) : DC.empty(empty)];
    out.push(...block("Slack webhooks", p.webhooks, "No workflow posts to Slack."));
    out.push(...block("CI secrets", p.secrets, "No .github/workflows in this repo yet."));
    if (p.reminders && p.reminders.length) {
      out.push(h("h3", "Reminders (build-state.md)"),
        h("div.list", p.reminders.map((r) => h("div.item.row",
          DC.dot(r.state === "expiring" ? "warn" : r.state === "expired" ? "err" : "ok"), h("span", r.label),
          h("span.muted.small", r.text || r.date),
          DC.links([{ kind: "file", label: "build-state.md", target: "build-state.md" }])))));
    }
    return out;
  }

  function render(s) {
    if (!s) return DC.empty("No data.");
    const parts = [header(s)];
    if (s.notice) parts.push(DC.notice(s.notice, s.signedIn ? "warn" : null));
    if (!s.signedIn) {
      parts.push(h("div.row", { style: { margin: "12px 0" } }, DC.button("Sign in to GitHub", () => post({ type: "connect", id: "github" }))));
    }
    for (const g of s.groups || []) {
      parts.push(h("h2", g.title), h("div.list", g.rows.map(row)));
    }
    parts.push(...projectSection(s));
    parts.push(h("hr"), h("p.muted.small",
      s.hiddenCount ? `${s.hiddenCount} connection${s.hiddenCount === 1 ? "" : "s"} only other personas need ${s.hiddenCount === 1 ? "is" : "are"} hidden. ` : "",
      s.checkedAt ? `Checked ${DC.when(s.checkedAt)}.` : ""));
    return h("div.stack", parts);
  }

  DC.onState(render);
})();
