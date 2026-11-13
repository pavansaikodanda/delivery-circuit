// Story panel (docs/CIRCUIT-V4.md section 7): one story, its five-step line (Design → Stories → Build → QA → Release),
// the PR status (scan, CodeRabbit, human approval) and its links. State comes from src/views/model.ts buildStory().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));

  const open = (target) => post({ type: "openLink", target });
  const STEP_TONE = { done: "ok", active: "info", todo: "" };
  const SCAN = { success: "ok", failure: "err", pending: "checking", missing: "" };
  const RABBIT = { approved: "ok", changes: "err", pending: "" };
  const STATUS_TONE = { design: "", ready: "", building: "info", "in-pr": "info", qa: "info", done: "ok" };

  DC.mount(DC.skeleton({ n: 3, label: "Loading the story" }));
  DC.onState(render);

  function render(s) {
    if (!s || s.loading) return DC.skeleton({ n: 3, label: "Loading the story" });
    if (s.error || !s.story) return [DC.header({ title: "Story", onRefresh: () => post({ type: "refresh" }) }), DC.empty({ icon: "search", title: s.error || "Story not found" })];
    const st = s.story;
    return [
      DC.header({ title: st.key + "  " + st.title, sub: DC.status(STATUS_TONE[st.status], st.statusLabel), onRefresh: () => post({ type: "refresh" }) }),
      h("ol.dc-flow", { "aria-label": "Progress", "data-key": "flow" }, st.steps.map((x) =>
        h("li", { class: "dc-flow-step " + x.state, "aria-current": x.state === "active" ? "step" : null },
          x.state === "done" ? DC.icon("pass-filled", { size: 16, cls: "ok" }) : DC.dot(STEP_TONE[x.state], { hollow: x.state === "todo" }),
          h("span", x.label)))),
      st.pr ? DC.section("Pull request", { key: "sec:pr" }, pr(st.pr)) : DC.section("Pull request", { key: "sec:pr" }, DC.empty("No pull request yet.")),
      DC.section("Links", { key: "sec:links" }, links(st.links)),
    ];
  }

  function pr(p) {
    return DC.list([
      DC.row({ key: "pr-scan", compact: true, icon: DC.icon("shield"), title: "Scan", status: { tone: SCAN[p.scan], text: p.scanText },
        primary: p.scanUrl ? { label: "Logs", kind: "ghost", onClick: () => open(p.scanUrl) } : null, hash: [p.scan, p.scanUrl] }),
      DC.row({ key: "pr-rabbit", compact: true, icon: DC.brand("coderabbit"), title: "CodeRabbit", status: { tone: RABBIT[p.coderabbit], text: p.coderabbitText }, hash: p.coderabbit }),
      DC.row({ key: "pr-human", compact: true, icon: DC.icon("person"), title: "Human approval",
        status: { tone: p.approvedBy.length ? "ok" : p.state === "open" ? "info" : "", text: p.approvalText }, hash: p.approvalText }),
    ], { label: "PR #" + p.number });
  }

  function links(list) {
    if (!list || !list.length) return DC.empty("No links yet.");
    return h("div.dc-links", list.map((l) => h("a", { href: "#", title: l.target, onclick: (e) => { e.preventDefault(); open(l.target); } },
      DC.brand(l.kind, { size: 16 }), h("span", l.label), DC.icon("link-external", { size: 12, cls: "dc-ext" }))));
  }
})();
