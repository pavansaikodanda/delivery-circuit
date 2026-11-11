// Connections page (DESIGN.md §6.4). State comes from src/connections/panelState.ts (PanelState).
// Posts: connect, check, disconnect, manage, switchPersona, setSecret, refresh, openLink.
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
      DC.list(rows.map((r) => DC.connectionRow(r)), { label: g.title, key: "list:" + g.id }));
  }

  // ---------- project secrets ----------
  const KIND = {
    "slack-webhook": "Slack webhook for a workflow", claude: "Claude token for the AI Reviewer", jira: "Jira access for CI",
    salesforce: "Salesforce JWT login for CI", "github-app": "GitHub App for CI",
  };
  function secretStatus(x) {
    if (x.unknown) return { tone: "", text: "not visible to you" };
    if (!x.present) return { tone: "err", text: "missing" };
    if (x.expiring) return { tone: "warn", text: str(x.expiryText) || "expiring" };
    return { tone: "ok", text: "set" };
  }
  function secretRow(x, admin, repoUrl) {
    const where = repoUrl
      ? { kind: "github", label: x.env ? "Environment secrets on GitHub" : "Actions secrets on GitHub",
        target: x.env ? repoUrl + "/settings/environments" : repoUrl + "/settings/secrets/actions" }
      : null;
    const reason = admin ? null : "Only repo or org admins can set project secrets.";
    const has = x.present || x.unknown;
    return DC.row({
      key: "s-" + (x.env ? x.env + "/" : "") + x.name, icon: DC.icon("key"), title: x.name, mono: true,
      status: secretStatus(x),
      primary: DC.button(has ? "Replace" : "Set", () => post({ type: "setSecret", name: x.name, env: x.env }),
        { kind: has || !admin ? "secondary" : "primary", size: "sm", disabled: !admin, reason }),
      strip: where ? [{ brand: "github", label: where.label, link: where }] : [],
      expanded: () => [
        DC.kv([["Used for", KIND[x.kind] || str(x.kind)], ["Environment", str(x.env)],
          ["Expires", x.present ? str(x.expiryText) : ""], ["Links", where ? DC.links([where]) : null]]),
        reason ? DC.reasonLine((has ? "Replace" : "Set") + ": " + reason) : null,
      ],
      hash: [x, admin, repoUrl],
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
    if (!p) {
      return DC.section("Project (admin)", { key: "grp:project" }, DC.skeleton({ n: 3, label: "Loading project secrets" }));
    }
    const webhooks = (p.webhooks || []).filter(Boolean);
    const secrets = (p.secrets || []).filter(Boolean);
    const reminders = (p.reminders || []).filter(Boolean);
    const missing = admin ? [...webhooks, ...secrets].filter((x) => !x.unknown && !x.present).length : 0;
    const block = (title, key, list, emptyText, mk) => [
      h("h3", title, list.length ? h("span.muted", " · " + list.length) : null),
      list.length ? DC.list(list.map(mk), { label: title, key: "list:" + key }) : h("p.muted.small", emptyText),
    ];
    const all = [...webhooks, ...secrets];
    const hidden = all.length > 0 && all.every((x) => x.unknown);
    // one quiet line instead of the info notice and the read error both saying "admins only"
    const note = p.error ? DC.notice(p.error, admin ? "warn" : "info", { icon: admin ? null : "lock" })
      : admin ? null : DC.notice("Read-only. A repo or org admin sets these up.", "info", { icon: "lock" });
    return DC.section("Project (admin)", { key: "grp:project", count: missing ? plural(missing, "missing", "missing") : null, needs: missing > 0 },
      note,
      // presence unknown for every secret (not an admin): one summary row instead of a wall of identical rows
      hidden ? DC.list([hiddenSecretsRow(webhooks, secrets, p.repoUrl)], { label: "Workflow secrets", key: "list:hidden" }) : [
        block("Slack webhooks", "webhooks", webhooks, "No workflow posts to Slack.", (x) => secretRow(x, admin, p.repoUrl)),
        block("CI secrets", "secrets", secrets, "No .github/workflows in this repo yet.", (x) => secretRow(x, admin, p.repoUrl)),
      ],
      reminders.length ? block("Reminders", "reminders", reminders, "", reminderRow) : null);
  }
  function hiddenSecretsRow(webhooks, secrets, repoUrl) {
    const n = webhooks.length + secrets.length;
    const where = repoUrl ? { kind: "github", label: "Actions secrets on GitHub", target: repoUrl + "/settings/secrets/actions" } : null;
    const names = (list) => (list.length ? h("span.mono", list.map((x) => x.name + (x.env ? " (" + x.env + ")" : "")).join(", ")) : null);
    return DC.row({
      key: "s-hidden", icon: DC.icon("key"), title: plural(n, "secret the workflows need", "secrets the workflows need"),
      status: { tone: "", text: "not visible to you" },
      strip: where ? [{ brand: "github", label: where.label, link: where }] : [],
      expanded: () => [
        DC.kv([["Slack webhooks", names(webhooks)], ["CI secrets", names(secrets)], ["Links", where ? DC.links([where]) : null]]),
        DC.reasonLine("Set / Replace: Only repo or org admins can see and set project secrets."),
      ],
      hash: [webhooks, secrets, repoUrl],
    });
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
    return [
      header(s),
      // one line: the identity notice, with the sign-in link when signed out
      s.notice || !s.signedIn ? DC.notice(str(s.notice) || "Sign in to GitHub to see your personas and the project's secrets.", s.signedIn ? "warn" : "info",
        s.signedIn ? {} : { icon: "github", action: { label: "Sign in to GitHub", onClick: () => post({ type: "connect", id: "github" }) } }) : null,
      groups.length
        ? groups.map((g, i) => groupSection(g, i, s))
        : DC.empty({ icon: "plug", title: "No connections to show", text: "Nothing this persona needs. Check again after switching persona.", action: { label: "Check all", icon: "sync", onClick: () => post({ type: "refresh" }) } }),
      s.signedIn ? projectSection(s) : null,
      footer(s),
    ];
  }

  DC.onState(render);
})();
