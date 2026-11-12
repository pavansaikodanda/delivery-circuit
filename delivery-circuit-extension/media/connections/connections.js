// Connections page (DESIGN.md §6.4). State comes from src/connections/panelState.ts (PanelState).
// Posts: connect, check, disconnect, manage, switchPersona, refresh, openLink, openSources.
// v3: every connection is a login (no token prompts, no CI-secrets section). The Project section holds the
// self-hosted runner, the GitHub for Jira and CodeRabbit apps, and the repo settings the circuit relies on.
// Each row shows logo · name · one status · one primary action; links, Check, Manage and Disconnect sit in the hover
// strip / "…" menu, detail and needed-by personas in the expanded row.
(function () {
  "use strict";
  const { h, post } = DC;
  const str = (x) => (x == null || x === false || x === true ? "" : String(x));
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  // ---------- header ----------
  function header(s) {
    const id = s.identity;
    const personas = (id && id.personas) || [];
    const sub = id
      ? [str(id.login), id.owner && id.repo ? id.owner + "/" + id.repo : "", id.isAdmin ? "admin" : ""].filter(Boolean).join(" · ")
      : "Not signed in to GitHub";
    const actAs = personas.length > 1
      ? DC.segmented(personas.map((p) => ({ value: p, label: DC.personaLabel(p) })), id.active,
        (p) => { DC.announce("Acting as " + DC.personaLabel(p)); post({ type: "switchPersona", persona: p }); },
        { label: "Act as", showLabel: true })
      : null;
    return DC.header({
      title: "Connections", sub,
      // one persona: a plain chip; several: the Act-as segmented control instead of the chip menu
      persona: personas.length === 1 ? personas[0] : null,
      actions: actAs,
      menu: s.isArchitect ? [{ label: "Open Sources", icon: "inbox", onClick: () => post({ type: "openSources" }) }] : null,
      onRefresh: () => post({ type: "refresh" }),
    });
  }

  // ---------- connections ----------
  function checkAll(s) {
    return DC.button(s.refreshing ? "Checking…" : "Check all", () => post({ type: "refresh" }),
      { kind: "ghost", size: "sm", icon: "sync", loading: !!s.refreshing, disabled: !!s.refreshing, reason: s.refreshing ? "A full check is running" : null });
  }

  function groupSection(g, i, s) {
    const rows = (g.rows || []).filter(Boolean);
    return DC.section(g.title, { count: rows.length, key: "grp:" + g.id, first: i === 0, action: i === 0 ? checkAll(s) : null },
      DC.list(rows.map(connRow), { label: g.title, key: "list:" + g.id }));
  }

  // acli, runner and github-jira logos come from the shared kit (DC.brand maps them).
  const connRow = (r) => DC.connectionRow(r);

  // ---------- project ----------
  const SETTING_ICON = { rulesets: "shield", environment: "rocket", workflows: "github-action" };
  function settingRow(x) {
    const st = DC.connStatus({ state: x.state });
    return DC.row({
      key: "set-" + x.key, icon: DC.icon(SETTING_ICON[x.key] || "settings-gear"), title: x.title,
      status: { tone: st.tone, text: x.state === "connected" ? "OK" : x.state === "disconnected" ? "Missing" : x.state === "error" ? "Needs a fix" : st.text },
      strip: DC.linkStrip(x.links, 2),
      expanded: () => [DC.kv([["Detail", str(x.detail)], ["Links", DC.links(x.links)]])],
      hash: x, state: x.state,
    });
  }
  function reminderRow(r) {
    const tone = r.state === "expired" ? "err" : r.state === "expiring" ? "warn" : r.state === "ok" ? "ok" : "";
    const file = { kind: "file", label: "build-state.md", target: "build-state.md" };
    return DC.row({
      key: "r-" + r.label, icon: DC.icon("calendar"), title: r.label,
      status: { tone, text: str(r.text) || str(r.date) || "no date" },
      strip: [{ brand: "file", label: "Open build-state.md", link: file }],
      hash: r,
    });
  }
  function projectSection(s) {
    const p = s.project;
    const admin = !!(s.identity && s.identity.isAdmin);
    const rows = (s.projectRows || []).filter(Boolean);
    const settings = ((p && p.settings) || []).filter(Boolean);
    const reminders = ((p && p.reminders) || []).filter(Boolean);
    const attention = [...rows, ...settings].filter((x) => x.state === "error" || x.state === "disconnected").length;
    const block = (title, key, list, mk) => list.length ? [h("h3", title, h("span.muted", " · " + list.length)), DC.list(list.map(mk), { label: title, key: "list:" + key })] : null;
    // one quiet line instead of the info notice and the read error both saying "admins only"
    const note = p && p.error ? DC.notice(p.error, admin ? "warn" : "info", { icon: admin ? null : "lock" })
      : admin ? null : DC.notice("Read-only. A repo or org admin sets these up.", "info", { icon: "lock" });
    return DC.section("Project", { key: "grp:project", count: attention ? plural(attention, "needs attention", "need attention") : null, needs: attention > 0 },
      note,
      rows.length ? DC.list(rows.map(connRow), { label: "Project connections", key: "list:project" }) : null,
      p ? block("Repo settings", "settings", settings, settingRow) : DC.skeleton({ n: 3, label: "Loading repo settings" }),
      p ? block("Reminders", "reminders", reminders, reminderRow) : null);
  }

  // ---------- page ----------
  function footer(s) {
    const parts = [];
    if (s.hiddenCount) parts.push(plural(s.hiddenCount, "connection", "connections") + " only other personas need " + (s.hiddenCount === 1 ? "is" : "are") + " hidden");
    if (s.checkedAt) parts.push("Checked " + DC.when(s.checkedAt));
    return parts.length ? h("p.dc-footer", { "data-key": "footer" }, parts.join(" · ")) : null;
  }

  function render(s) {
    if (!s || typeof s !== "object") return [DC.header({ title: "Connections" }), DC.skeleton({ n: 6, label: "Loading connections" })];
    const groups = (s.groups || []).filter((g) => g && (g.rows || []).length);
    const hasProject = (s.projectRows || []).length > 0 || !!s.project;
    return [
      header(s),
      // one line: the identity notice, with the sign-in link when signed out
      s.notice || !s.signedIn ? DC.notice(str(s.notice) || "Sign in to GitHub to see your personas and the project's connections.", s.signedIn ? "warn" : "info",
        s.signedIn ? {} : { icon: "github", action: { label: "Sign in to GitHub", onClick: () => post({ type: "connect", id: "github" }) } }) : null,
      groups.length
        ? groups.map((g, i) => groupSection(g, i, s))
        : DC.empty({ icon: "plug", title: "No connections to show", text: "Nothing this persona needs. Check again after switching persona.", action: { label: "Check all", icon: "sync", onClick: () => post({ type: "refresh" }) } }),
      s.signedIn && hasProject ? projectSection(s) : null,
      footer(s),
    ];
  }

  DC.onState(render);
})();
