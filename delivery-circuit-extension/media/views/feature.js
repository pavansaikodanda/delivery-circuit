// Feature detail panel (one per feature). State from src/views/model.ts buildFeature().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));

  DC.onState(render);

  function section(title, body, count) {
    return h("div.dc-section", [h("h2", [title, count != null ? h("span.count", String(count)) : null]), body]);
  }

  function render(s) {
    if (!s) return DC.empty("No data yet.");
    const refresh = DC.button("Refresh", () => post({ type: "refresh" }), { kind: "secondary" });
    if (!s.found || !s.feature) {
      return h("div", [
        h("div.header", [h("h1", "Feature " + s.featureId), refresh]),
        s.error ? DC.notice("Could not load: " + s.error, "warn") : null,
        DC.empty("Feature " + s.featureId + " was not found under .specify/specs/."),
      ]);
    }
    const f = s.feature;
    return h("div", [
      h("div.header", [
        h("div", [
          h("h1", f.slug),
          h("div.sub", [f.title,
            f.score != null ? " · score " + f.score : "",
            " · " + f.openQuestions + " open question" + (f.openQuestions === 1 ? "" : "s"),
            f.signedOff ? " · plan signed off" : " · plan not signed off"]),
        ]),
        h("div.row", [DC.links(f.links), refresh]),
      ]),
      s.error ? DC.notice("Some data could not be loaded: " + s.error, "warn") : null,
      section("Stage", h("span.steps", s.stages.map((st) => h("span.step." + st.state, { title: st.title || null }, st.label)))),
      gates(s),
      questions(s),
      stories(s),
      sources(s),
      section("Files", s.files.length ? DC.links(s.files) : h("span.muted", "No spec files found in " + f.dir + ".")),
      actions(s),
    ]);
  }

  function gates(s) {
    const rows = s.gates;
    const next = s.next
      ? h("p.small", ["Next: ", h("strong", s.next.id + " " + s.next.label), " — " + s.next.ownerLabel + (s.viewer && s.next.owner === s.viewer ? " (you)" : "")])
      : h("p.small", "Every gate is done.");
    const table = h("table", [
      h("thead", h("tr", [h("th", "Gate"), h("th", "What"), h("th", "Owner"), h("th", "State")])),
      h("tbody", rows.map((g) => h("tr" + (g.own ? ".dc-own" : ""), [
        h("td", g.id), h("td", g.label), h("td", g.ownerLabel + (g.own ? " (you)" : "")),
        h("td", [DC.dot(g.cls || null), g.state]),
      ]))),
    ]);
    return section("Gates", h("div", [next, table]));
  }

  function questions(s) {
    const n = s.feature.openQuestions;
    const spec = s.files.find((l) => /spec\.md$/.test(l.target));
    return section("Open questions", h("div.row", [
      h("span" + (n ? "" : ".muted"), n ? n + " open in the clarification report" : "None open"),
      spec ? DC.links([{ kind: "file", label: "spec.md", target: spec.target }]) : null,
    ]), n || null);
  }

  function stories(s) {
    if (!s.stories.length) return section("Stories", DC.empty("No stories yet (task_story_NN.md)."));
    return section("Stories", DC.table([
      { key: "num", label: "#" },
      { key: "title", label: "Story" },
      { key: "jira", label: "Jira", render: (r) => r.jiraKey ? DC.links(r.links.filter((l) => l.kind === "jira")) : h("span.muted", "not pushed") },
      { key: "tests", label: "Test cases", render: (r) => r.total
          ? h("span.row", [h("span", String(r.total)), h("span.muted.small", "ui " + r.counts.ui + " · unit " + r.counts.unit + " · manual " + r.counts.manual)])
          : h("span.muted", "none") },
      { key: "pr", label: "PR", render: (r) => r.prNumber ? DC.links(r.links.filter((l) => l.kind === "github")) : h("span.muted", "—") },
      { key: "file", label: "", render: (r) => DC.links(r.links.filter((l) => l.kind === "file")) },
    ], s.stories), s.stories.length);
  }

  function sources(s) {
    if (s.sources === null) return null; // Architect only
    if (!s.sources.length) return section("Sources cited", h("span.muted", "The spec cites no call or upload."));
    return section("Sources cited", h("div.list", s.sources.map((src) => h("div.item.spread", [
      h("span", [h("span.title", src.title), h("span.muted.small", " · " + (src.kind === "fireflies" ? "Fireflies" : "Upload") + (src.date ? " · " + src.date : ""))]),
      h("span.row", [
        DC.links(src.links),
        src.canOpen ? h("a.small", { href: "#", onclick: (e) => { e.preventDefault(); post({ type: "openSource", id: src.id }); } }, "Transcript") : null,
      ]),
    ]))), s.sources.length);
  }

  function actions(s) {
    if (!s.actions.length) return null;
    const by = {};
    s.actions.forEach((a) => { (by[a.persona] = by[a.persona] || []).push(a); });
    const name = { architect: "Architect", developer: "Developer", tester: "Tester" };
    return section("Spec Kit actions", h("div.stack", Object.keys(by).map((p) => {
      const list = by[p];
      const reason = (list.find((a) => !a.allowed) || {}).reason;
      return h("div.row", [
        h("span.muted.small", { style: { minWidth: "80px" } }, name[p] || p),
        h("span.row", list.map((a) => DC.button(a.label, () => DC.action(a), { kind: "secondary", disabled: !a.allowed, title: a.allowed ? null : a.reason }))),
        reason ? h("span.dc-reason", reason) : null,
      ]);
    })));
  }
})();
