// Feature detail (DESIGN.md §6.3): one feature's stage line, the next gate, gates, stories, sources and links.
// Only the gate that waits on the viewer has a primary action; other personas' Spec Kit actions sit in that gate
// row's menu, disabled with their reason. State from src/views/model.ts buildFeature().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));

  const refresh = () => post({ type: "refresh" });
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  DC.mount([DC.header({ title: "Feature", onRefresh: refresh }), DC.skeleton({ n: 5, label: "Loading the feature" })]);
  DC.onState(render);

  function render(s) {
    if (!s) return DC.skeleton({ n: 5 });
    if (!s.found || !s.feature) {
      return [
        DC.header({ title: "Feature " + s.featureId, persona: s.viewer, personas: s.personas || [], onRefresh: refresh }),
        s.error ? DC.notice("Could not load: " + s.error, "warn", { action: { label: "Retry", onClick: refresh } }) : null,
        DC.empty({ icon: "search", title: "Feature not found", text: "Feature " + s.featureId + " was not found under .specify/specs/.",
          action: { label: "Refresh", icon: "refresh", onClick: refresh } }),
      ];
    }
    const f = s.feature;
    const sub = [f.title, f.score != null ? "score " + f.score : null, f.signedOff ? "signed off" : "not signed off",
      f.openQuestions ? plural(f.openQuestions, "open question", "open questions") : null].filter(Boolean).join(" · ");
    return [
      DC.header({ title: f.slug, sub, persona: s.viewer, personas: s.personas || [], onRefresh: refresh, menu: headerMenu(s) }),
      s.error ? DC.notice("Some data could not be loaded: " + s.error, "warn", { action: { label: "Retry", onClick: refresh } }) : null,
      summary(s),
      gates(s), stories(s), sources(s), linksSection(s),
    ];
  }

  // Spec Kit actions that belong to no gate (none today) stay reachable from the header menu.
  function headerMenu(s) {
    const gated = new Set();
    (s.gates || []).forEach((g) => (g.actions || []).forEach((a) => gated.add(a.id + "|" + a.persona)));
    const rest = (s.actions || []).filter((a) => !gated.has(a.id + "|" + a.persona));
    if (!rest.length) return null;
    return rest.map((a) => ({ label: a.label + " (" + DC.personaLabel(a.persona) + ")", icon: "sparkle", disabled: !a.allowed, reason: a.allowed ? null : a.reason, onClick: () => DC.action(a) }));
  }

  function actionBtn(a, kind) {
    return DC.button(a.label, () => DC.action(a), { kind: a.allowed ? kind : "secondary", size: "sm", disabled: !a.allowed, reason: a.allowed ? null : a.reason });
  }

  // Stage line, then "Next: G3 AI plan approved · Developer (you)" with its one action when the gate is yours.
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
      menu: rest.map((a) => ({ label: a.label, icon: "sparkle", disabled: !a.allowed, reason: a.allowed ? null : a.reason, onClick: () => DC.action(a) })),
      expanded: acts.length ? () => [
        DC.kv([["Owner", g.ownerLabel + (g.own ? " (you)" : "")], ["State", stateWord],
          ["Spec Kit", h("div.dc-acts", acts.map((a) => DC.button(a.label, () => DC.action(a), { kind: "ghost", size: "sm", icon: "sparkle", disabled: !a.allowed, reason: a.allowed ? null : a.reason })))]]),
        DC.reasonLine(acts.map((a) => (a.allowed ? a : Object.assign({}, a, { reason: a.label + ": " + a.reason })))),
      ] : undefined,
      hash: [g, s.viewer],
    });
  }

  const PR_STATUS = {
    merged: { tone: "ok", text: "merged" }, open: { tone: "info", text: "in review" }, draft: { tone: "muted", text: "draft" }, closed: { tone: "muted", text: "closed" },
  };
  function storyStatus(r) {
    if (!r.prNumber) return { tone: "muted", text: r.jiraKey ? "in Jira, no PR yet" : "not pushed" };
    const st = PR_STATUS[r.prState] || { tone: "muted", text: "PR" };
    return { tone: st.tone, text: "PR #" + r.prNumber + (r.prState ? " " + st.text : "") };
  }

  function stories(s) {
    const list = s.stories || [];
    if (!list.length) {
      return DC.section("Stories", { key: "sec:stories" },
        DC.empty({ icon: "book", title: "No stories yet", text: "Stories appear here once the spec has task_story_NN.md files." }));
    }
    return DC.section("Stories", { key: "sec:stories", count: list.length },
      DC.list(list.map((r) => {
        const file = (r.links || []).find((l) => l.kind === "file");
        const c = r.counts || {};
        const tests = r.total ? plural(r.total, "test case", "test cases") + " · ui " + (c.ui || 0) + " · unit " + (c.unit || 0) + " · manual " + (c.manual || 0) : "none yet";
        return DC.row({
          key: "st-" + r.num, icon: DC.icon("book"), num: r.num, title: r.title,
          status: storyStatus(r),
          primary: file ? DC.button("Open", () => DC.openLink(file), { kind: "secondary", size: "sm" }) : null,
          strip: DC.linkStrip((r.links || []).filter((l) => l.kind !== "file")), menu: DC.linkMenu((r.links || []).filter((l) => l.kind !== "file"), 3),
          expanded: () => DC.kv([["Jira", r.jiraKey || "not pushed"], ["Tests", tests], ["Links", DC.links(r.links)]]),
          hash: r,
        });
      }), { label: "Stories" }));
  }

  function sources(s) {
    if (s.sources === null || s.sources === undefined) return null; // Architect only
    const list = s.sources;
    if (!list.length) return DC.section("Sources", { key: "sec:sources" }, DC.notice("The spec cites no call or upload.", "info"));
    return DC.section("Sources", { key: "sec:sources", count: list.length },
      DC.list(list.map((src) => DC.row({
        key: "src-" + src.id, icon: src.kind === "fireflies" ? DC.brand("fireflies") : DC.icon("cloud-upload"), title: src.title,
        status: { tone: "muted", text: (src.kind === "fireflies" ? "Fireflies" : "Upload") + (src.date ? " · " + src.date : "") },
        primary: src.canOpen ? DC.button("Transcript", () => post({ type: "openSource", id: src.id }), { kind: "secondary", size: "sm" }) : null,
        strip: DC.linkStrip(src.links), hash: src,
      })), { label: "Sources" }));
  }

  function linksSection(s) {
    const all = [...(s.files || []), ...((s.feature && s.feature.links) || []).filter((l) => !(s.files || []).some((x) => x.target === l.target))];
    if (!all.length) return DC.section("Links", { key: "sec:links" }, DC.notice("No spec files found in " + s.feature.dir + ".", "info"));
    return DC.section("Links", { key: "sec:links", count: all.length }, h("div.dc-linkbox", DC.links(all)));
  }
})();
