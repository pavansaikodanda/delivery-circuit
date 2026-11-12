// Persona view (DESIGN.md §6.2): one tab per persona the identity can view (Architect: all three, acting only as
// Architect; Developer and Tester: their own). Waiting on you, Features and Pull requests are keyed row lists;
// AI sessions are the "Start AI session" menu on the Pull requests section. v3: features are Jira epics with a
// Confluence design page; Start story, Add tests, Fix with AI and the review room arrive as queue and PR actions.
// State from src/views/model.ts buildPersona().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));

  const refresh = () => post({ type: "refresh" });

  DC.mount([DC.header({ title: "Persona view", onRefresh: refresh }), DC.skeleton({ n: 4, label: "Loading the persona view" })]);
  DC.onState(render);

  function render(s) {
    if (!s) return DC.skeleton({ n: 4 });
    const sub = s.login ? ["Signed in as " + s.login, s.repo].filter(Boolean).join(" · ") : "Not signed in";
    const head = DC.header({
      title: s.selectedLabel ? s.selectedLabel + " view" : "Persona views", sub,
      persona: s.active, personas: s.personas || [], onRefresh: refresh,
    });
    if (!s.selected) {
      return [head, DC.empty({
        icon: s.login ? "account" : "github", title: s.login ? "No persona yet" : "Not signed in", text: s.notice || "Nothing to show.",
        action: s.login ? null : { label: "Connect GitHub", kind: "primary", onClick: () => post({ type: "connectGithub" }) },
      })];
    }
    return [
      head,
      (s.tabs || []).length > 1 ? DC.tabs(s.tabs.map((t) => ({ id: t.id, label: t.label, icon: (DC.PERSONA[t.id] || {}).icon, title: t.title || null })),
        s.selected, (id) => { if (id !== s.selected) post({ type: "selectTab", persona: id }); }) : null,
      s.notice ? DC.notice(s.notice, "info", { icon: "eye" }) : null,
      s.error ? DC.notice("Some data could not be loaded: " + s.error, "warn", { action: { label: "Retry", onClick: refresh } }) : null,
      queue(s), features(s), prs(s),
      footer(s),
    ];
  }

  function queue(s) {
    const title = s.canAct ? "Waiting on you" : "Waiting on " + s.selectedLabel;
    const list = s.queue || [];
    if (!list.length) {
      return DC.section(title, { key: "sec:queue", first: true },
        DC.empty({ icon: "check", title: "Nothing waiting", text: "Nothing is waiting on the " + s.selectedLabel + " right now." }));
    }
    return DC.section(title, { key: "sec:queue", count: list.length, needs: s.canAct, first: true },
      DC.list(list.map((q) => DC.queueRow(q, { viewer: s.active, view: s.selected, canAct: s.canAct })), { label: title }));
  }

  function features(s) {
    const list = s.features || [];
    if (!list.length) {
      return DC.section("Features", { key: "sec:features" },
        DC.empty({ icon: "map", title: "No features yet", text: "A feature is a Jira epic with a design page. The Architect starts one with Intake." }));
    }
    // "G3 next, you" only when the viewer acts in this view; in a view-only tab no gate is "yours".
    const viewer = s.canAct ? s.selected : null;
    return DC.section("Features", { key: "sec:features", count: list.length },
      DC.list(list.map((f) => DC.featureRow(viewer ? f : Object.assign({}, f, { gates: (f.gates || []).map((g) => Object.assign({}, g, { own: false })) }), { viewer })),
        { label: "Features" }));
  }

  function aiMenu(s) {
    const acts = (s.aiActions || []).filter((a) => a && a.label);
    if (!acts.length) return null;
    return DC.menu(["Runs your logged-in Claude as the " + s.selectedLabel + "; you pick the target next. AI never approves, merges or deploys.", ...acts.map((a) => ({
      label: a.label, icon: "sparkle", disabled: !a.allowed, reason: a.allowed ? null : a.reason, onClick: () => DC.action(a),
    }))], { text: "Start AI session", icon: "sparkle", label: "Start AI session" });
  }

  function prs(s) {
    const list = s.prs || [];
    const act = aiMenu(s);
    if (!list.length) {
      return DC.section("Pull requests", { key: "sec:prs", action: act },
        DC.empty({ icon: "git-pull-request", title: "No open pull requests", text: "Nothing open for the " + s.selectedLabel + "." }));
    }
    return DC.section("Pull requests", { key: "sec:prs", count: list.length, action: act },
      DC.list(list.map((p) => DC.prRow(p, { viewer: s.active, view: s.selected, canAct: s.canAct, actions: p.actions || [] })), { label: "Pull requests" }));
  }

  function footer(s) {
    const t = s.updated ? new Date(s.updated) : null;
    return h("p.dc-footer", { "data-key": "footer" }, t && !isNaN(t.getTime()) ? "Updated " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);
  }
})();
