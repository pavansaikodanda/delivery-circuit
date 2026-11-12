// Feature detail (DESIGN.md §6.3), v3: one Jira epic with its Confluence design page. Stage line and the next gate,
// the design page (status, version, approved version), gates, stories with Start story / Add tests, sources and links.
// Only the action that waits on the viewer is a primary button; other personas' actions stay disabled with their
// reason. No spec-file links: the spec lives in Confluence. State from src/views/model.ts buildFeature().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));

  const refresh = () => post({ type: "refresh" });
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
  const aiIcon = (a) => (a && a.kind === "gate" ? "verified" : "sparkle");

  DC.mount([DC.header({ title: "Feature", onRefresh: refresh }), DC.skeleton({ n: 5, label: "Loading the feature" })]);
  DC.onState(render);

  function render(s) {
    if (!s) return DC.skeleton({ n: 5 });
    if (!s.found || !s.feature) {
      return [
        DC.header({ title: "Feature " + s.featureId, persona: s.viewer, personas: s.personas || [], onRefresh: refresh }),
        s.error ? DC.notice("Could not load: " + s.error, "warn", { action: { label: "Retry", onClick: refresh } }) : null,
        DC.empty({ icon: "search", title: "Feature not found", text: "No Jira epic or feature " + s.featureId + " was found. It may have been moved or renamed.",
          action: { label: "Refresh", icon: "refresh", onClick: refresh } }),
      ];
    }
    const f = s.feature;
    const sub = [f.title, s.design ? s.design.text : null,
      f.openQuestions ? plural(f.openQuestions, "open question", "open questions") : null].filter(Boolean).join(" · ");
    return [
      DC.header({ title: f.slug, sub, persona: s.viewer, personas: s.personas || [], onRefresh: refresh, menu: headerMenu(s) }),
      s.error ? DC.notice("Some data could not be loaded: " + s.error, "warn", { action: { label: "Retry", onClick: refresh } }) : null,
      summary(s),
      design(s), gates(s), stories(s), sources(s), linksSection(s),
    ];
  }

  // Actions that sit neither on the design row nor on a gate row stay reachable from the header menu.
  function headerMenu(s) {
    const placed = new Set();
    (s.gates || []).forEach((g) => (g.actions || []).forEach((a) => placed.add(a.id + "|" + a.persona)));
    (s.designActions || []).forEach((a) => placed.add(a.id + "|" + a.persona));
    const rest = (s.actions || []).filter((a) => !placed.has(a.id + "|" + a.persona));
    if (!rest.length) return null;
    return rest.map((a) => ({ label: a.label + " (" + DC.personaLabel(a.persona) + ")", icon: aiIcon(a), disabled: !a.allowed, reason: a.allowed ? null : a.reason, onClick: () => DC.action(a) }));
  }

  function actionBtn(a, kind) {
    return DC.button(a.label, () => DC.action(a), { kind: a.allowed ? kind : "secondary", size: "sm", disabled: !a.allowed, reason: a.allowed ? null : a.reason });
  }
  const menuItem = (a) => ({ label: a.label, icon: aiIcon(a), disabled: !a.allowed, reason: a.allowed ? null : a.reason, onClick: () => DC.action(a) });
  const ghosts = (acts) => (acts.length ? h("div.dc-acts", acts.map((a) => DC.button(a.label, () => DC.action(a), { kind: "ghost", size: "sm", icon: aiIcon(a), disabled: !a.allowed, reason: a.allowed ? null : a.reason }))) : null);
  const reasons = (acts) => DC.reasonLine(acts.map((a) => (a.allowed ? a : Object.assign({}, a, { reason: a.label + ": " + a.reason }))));

  // Stage line, then "Next: G1 Design approved · Architect (you)" with its one action when the gate is yours.
  function summary(s) {
    const n = s.next;
    const gate = n ? (s.gates || []).find((g) => g.id === n.id) : null;
    const act = gate && gate.waitsOnViewer ? (gate.actions || []).find((a) => a.allowed) : null;
    return h("div.dc-fsum", { "data-key": "summary" },
      h("div.dc-fsum-line", stageSummary(s.stages)),
      h("div.dc-fsum-next",
        n ? h("span", h("span.muted", "Next: "), h("span.dc-strong", n.id + " " + n.label), h("span.muted", " · " + n.ownerLabel + (s.viewer && n.owner === s.viewer ? " (you)" : "")))
          : h("span", DC.status("ok", "Every gate is done")),
        act ? actionBtn(act, "primary") : null));
  }

  // The stage line with "Build · 7/10 stages" after it (current stage, then the count).
  function stageSummary(stages) {
    const list = stages || [];
    if (!list.length) return null;
    const line = DC.stageLine(list, { label: false });
    const done = list.filter((x) => x.state === "done").length;
    const cur = list.find((x) => x.state === "active") || list.find((x) => x.state === "blocked");
    const label = cur ? cur.label + (cur.state === "blocked" ? " blocked" : "") : done === list.length ? "Done" : "Not started";
    return [line, h("span.dc-stage-n", label + " · " + done + "/" + list.length + " stages")];
  }

  // The Confluence design page as one row: status phrase, and Approve design as the primary only while the page
  // waits for an architect's approval (G1). The approval itself happens in Confluence.
  function design(s) {
    const d = s.design;
    if (!d) return null;
    const acts = s.designActions || [];
    const link = d.url ? { kind: "confluence", label: "Design page", target: d.url } : null;
    const approve = acts.find((a) => a.id === "arch:approve-design");
    const designAct = acts.find((a) => a.args && a.args.command === "/arch-design");
    const lead = d.state === "missing" ? designAct : d.state !== "approved" ? approve : null;
    const primary = lead && lead.allowed ? actionBtn(lead, "primary")
      : link ? DC.button("Open", () => DC.openLink(link), { kind: "secondary", size: "sm" }) : null;
    const rest = acts.filter((a) => !(lead && lead.allowed && a === lead));
    // the design page, its Org snapshot child page (C4) and the Lucid diagram
    const links = [link, ...((s.feature && s.feature.links) || []).filter((l) => l.kind === "lucid" || (l.kind === "confluence" && /snapshot/i.test(l.label || "")))].filter(Boolean);
    const menu = rest.map(menuItem);
    const more = DC.linkMenu(links, 3);
    if (more.length) { if (menu.length) menu.push("-"); menu.push(...more); }
    const approved = d.approvedVersion != null
      ? "v" + d.approvedVersion + (d.approvedBy ? " by " + d.approvedBy : "") + (d.approvedAt ? " · " + DC.when(d.approvedAt) : "") : "not yet";
    return DC.section("Design", { key: "sec:design" },
      DC.list([DC.row({
        key: "design", icon: DC.brand("confluence"), title: "Design page", titleTip: "Spec, decisions, plan, data model and org snapshot in Confluence",
        status: { tone: d.tone, text: d.text },
        primary, strip: DC.linkStrip(links), menu,
        expanded: () => [
          DC.kv([
            ["Status", d.status || (d.state === "missing" ? "no page yet" : "Draft")],
            ["Version", d.version != null ? "v" + d.version : null],
            ["Approved", approved],
            ["G1", "An architect sets the page status to Approved in Confluence; the stories record that version. A later change fails design-gate until it is approved again."],
            ["Links", DC.links(links)],
            ["Actions", ghosts(acts)],
          ]),
          reasons(acts),
        ],
        hash: [d, acts, s.viewer],
      })], { label: "Design" }));
  }

  function gates(s) {
    const list = s.gates || [];
    if (!list.length) return null;
    const done = list.filter((g) => g.state === "done").length;
    return DC.section("Gates", { key: "sec:gates", count: done + " of " + list.length + " done" },
      DC.list(list.map((g) => gateRow(g, s)), { label: "Gates" }));
  }

  function gateRow(g, s) {
    const acts = g.actions || [];
    const primary = g.waitsOnViewer ? acts.find((a) => a.allowed) : null;
    const rest = acts.filter((a) => a !== primary);
    const stateWord = g.state === "not-started" ? "not started" : DC.word(g.state);
    const tone = g.state === "done" ? "ok" : g.state === "blocked" ? "err" : g.waitsOnViewer ? "info" : "muted";
    return DC.row({
      key: "g-" + g.id, icon: DC.icon((DC.GATES[g.id] || {}).icon || "circle-outline", { label: g.id }),
      num: g.id, title: g.label, titleTip: g.id + " · " + g.label + " · " + g.ownerLabel,
      status: { tone, text: (g.own ? g.ownerLabel + " (you)" : g.ownerLabel) + " · " + stateWord },
      primary: primary ? actionBtn(primary, "primary") : null,
      menu: rest.map(menuItem),
      expanded: acts.length ? () => [
        DC.kv([["Owner", g.ownerLabel + (g.own ? " (you)" : "")], ["State", stateWord], ["Actions", ghosts(acts)]]),
        reasons(acts),
      ] : undefined,
      hash: [g, s.viewer],
    });
  }

  // One row per Jira story: key · title · one status · the one action that fits now (Start story, Add tests).
  function stories(s) {
    const list = s.stories || [];
    if (!list.length) {
      return DC.section("Stories", { key: "sec:stories" },
        DC.empty({ icon: "book", title: "No stories yet", text: "Stories appear here once the Architect pushes them to Jira, after the design is approved." }));
    }
    return DC.section("Stories", { key: "sec:stories", count: list.length },
      DC.list(list.map((r) => {
        const acts = r.actions || [];
        const lead = acts.find((a) => a.allowed);
        const jira = (r.links || []).find((l) => l.kind === "jira");
        const c = r.counts || {};
        const tests = r.total ? plural(r.total, "test case", "test cases") + " · ui " + (c.ui || 0) + " · unit " + (c.unit || 0) + " · manual " + (c.manual || 0) : "none in Jira yet";
        const primary = lead ? actionBtn(lead, "primary")
          : acts.length ? actionBtn(acts[0], "secondary")
          : jira ? DC.button("Open", () => DC.openLink(jira), { kind: "secondary", size: "sm" }) : null;
        const rest = acts.filter((a) => a !== lead && a !== (lead ? null : acts[0]));
        const menu = rest.map(menuItem);
        const more = DC.linkMenu(r.links || [], 3);
        if (more.length) { if (menu.length) menu.push("-"); menu.push(...more); }
        return DC.row({
          key: "st-" + (r.jiraKey || r.num), icon: DC.icon("book"), num: r.jiraKey || r.num, title: r.title,
          status: r.status || { tone: "muted", text: "" },
          primary, strip: DC.linkStrip(r.links || []), menu,
          expanded: () => [
            DC.kv([
              ["Jira", r.jiraKey ? r.jiraKey + (r.jiraStatus ? " · " + r.jiraStatus : "") : "not pushed"],
              ["Ready", r.aiReady ? "ai-ready (G2 done)" : "waits for the Tester (G2)"],
              ["Design", r.designVersion != null ? "planned on v" + r.designVersion + (r.designChanged ? ": the design changed since, re-plan or re-approve" : "") : null],
              ["Tests", tests],
              ["Links", DC.links(r.links)],
              ["Actions", ghosts(acts)],
            ]),
            reasons(acts),
          ],
          hash: r,
        });
      }), { label: "Stories" }));
  }

  function sources(s) {
    if (s.sources === null || s.sources === undefined) return null; // Architect only
    const list = s.sources;
    if (!list.length) return DC.section("Sources", { key: "sec:sources" }, DC.notice("No call, transcript or note is linked to this feature.", "info"));
    return DC.section("Sources", { key: "sec:sources", count: list.length },
      DC.list(list.map((src) => DC.row({
        key: "src-" + src.id, icon: src.kind === "fireflies" ? DC.brand("fireflies") : DC.icon("cloud-upload"), title: src.title,
        status: { tone: "muted", text: (src.kind === "fireflies" ? "Fireflies" : "Local, encrypted") + (src.date ? " · " + src.date : "") },
        primary: src.canOpen ? DC.button("Transcript", () => post({ type: "openSource", id: src.id }), { kind: "secondary", size: "sm" }) : null,
        strip: DC.linkStrip(src.links), hash: src,
      })), { label: "Sources" }));
  }

  function linksSection(s) {
    const all = (s.feature && s.feature.links) || [];
    if (!all.length) return null;
    return DC.section("Links", { key: "sec:links", count: all.length }, h("div.dc-linkbox", DC.links(all)));
  }
})();
