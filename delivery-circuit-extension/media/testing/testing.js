// Testing page: SF AI Tester suites, runs and results inside the circuit. State from src/testing/page.ts buildPageState().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "testing.css") }));

  // Page-local choices (kept across re-renders).
  const ui = { tab: "cases", mode: "manual", orgRole: "qa", checked: {}, gen: { requirement: "", name: "", count: 5, orgRole: "qa", explore: false } };
  const STATUS_LABEL = { passed: "Passed", failed: "Failed", blocked: "Blocked", error: "Error" };
  const ROUTE_CLASS = { pass: "ok", dev: "err", qa: "warn", infra: "warn" };

  DC.onState(render);
  DC.onEvent = (m) => {
    const s = DC.state;
    if (!s) return;
    if (m.type === "log" && s.live) {
      s.live.log = (s.live.log || []).concat([m.line]).slice(-400);
      if (m.needsUser) s.live.needsUser = m.line;
      appendLine("t-log", m.line);
    } else if (m.type === "genLog") {
      if (s.generate) s.generate.log = (s.generate.log || []).concat([m.line]);
      appendLine("t-genlog", m.line);
    }
  };

  function appendLine(id, line) {
    const el = document.getElementById(id);
    if (!el) return;
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    el.append((el.textContent ? "\n" : "") + line);
    if (stick) el.scrollTop = el.scrollHeight;
  }

  function rerender() { if (DC.state) DC.mount(render(DC.state)); }

  function render(s) {
    if (!s) return DC.empty("No data yet.");
    if (s.error) return h("div", [header(s), DC.notice(s.error, "err")]);
    if (s.denied) return h("div", [header(s), DC.notice(s.denied, "warn")]);
    const p = s.persona || {};
    const running = !!(s.live && s.live.running);
    return h("div", [
      header(s),
      s.notice ? h("div.row", { style: { marginBottom: "12px" } }, [
        h("div.notice." + (s.notice.kind || "info"), { style: { flex: "1" } }, s.notice.text),
        DC.button("Dismiss", () => post({ type: "dismiss" }), { kind: "ghost" }),
      ]) : null,
      !p.canRun && p.reason ? h("div", { style: { marginBottom: "12px" } }, DC.notice(p.reason, "info")) : null,
      h("div.t-layout", [suiteList(s), h("div", [
        DC.tabs([
          { id: "cases", label: "Cases" },
          { id: "results", label: "Results" + (s.result ? "" : " (none)") },
          { id: "runs", label: "Runs" },
          { id: "generate", label: "Generate" },
        ], ui.tab, (id) => { ui.tab = id; rerender(); }),
        ui.tab === "cases" ? casesTab(s, running) : null,
        ui.tab === "results" ? resultsTab(s) : null,
        ui.tab === "runs" ? runsTab(s) : null,
        ui.tab === "generate" ? generateTab(s) : null,
        running || (s.live && s.live.log && s.live.log.length) ? liveBox(s) : null,
      ])]),
    ]);
  }

  function header(s) {
    const p = s.persona || {};
    return h("div.header", [
      h("div", [
        h("h1", "Testing"),
        h("div.sub", p.login ? ["SF AI Tester runs as ", h("strong", p.login), p.active ? " · acting as " + p.active : ""] : "Not signed in"),
      ]),
      s.denied ? null : h("div.row", [
        DC.button("Export Excel", () => post({ type: "export", formats: ["xlsx"] }), { kind: "secondary", disabled: !!s.busy, title: s.busy ? "Busy: " + s.busy : "Excel report of every suite" }),
        DC.button("Export PDF", () => post({ type: "export", formats: ["pdf"] }), { kind: "secondary", disabled: !!s.busy }),
        DC.button("Settings", () => post({ type: "openSettings" }), { kind: "ghost" }),
        DC.button("Refresh", () => post({ type: "refresh" }), { kind: "secondary" }),
      ]),
    ]);
  }

  function counts(last, notRun) {
    const parts = ["passed", "failed", "blocked", "error"].filter((k) => last && last[k])
      .map((k) => DC.badge(last[k] + " " + STATUS_LABEL[k].toLowerCase(), DC.stateClass(k)));
    if (notRun) parts.push(DC.badge(notRun + " not run"));
    return parts.length ? h("span.t-counts", parts) : h("span.muted.small", "not run yet");
  }

  function suiteList(s) {
    if (!s.suites || !s.suites.length) {
      return h("div", [h("h2", { style: { marginTop: "0" } }, "Suites"), DC.empty("No suites in test-cases/ yet. Use Generate, or /qa-design-tests.")]);
    }
    return h("div", [
      h("h2", { style: { marginTop: "0" } }, "Suites"),
      h("div.list", s.suites.map((x) => h("div.item.t-suite", {
        "aria-current": String(x.key === s.selected), tabindex: "0",
        onclick: () => post({ type: "select", key: x.key }),
        onkeydown: (e) => { if (e.key === "Enter") post({ type: "select", key: x.key }); },
      }, [
        h("div.spread", [h("span.title", x.name), h("span.muted.small", x.cases + (x.cases === 1 ? " case" : " cases"))]),
        h("div.meta", [
          x.error ? DC.badge("invalid", "err") : counts(x.last, x.notRun),
          x.storyKey ? h("span.muted.small", x.storyKey) : null,
        ]),
        h("div.meta", [DC.links(x.links)]),
      ]))),
    ]);
  }

  function statusCell(m) {
    if (!m) return h("span.muted.small", "not run");
    return h("span", { title: (m.summary || "") + (m.at ? "\n" + new Date(m.at).toLocaleString() : "") + (m.model ? "\n" + m.model : "") }, [
      DC.badge(STATUS_LABEL[m.status] || m.status, DC.stateClass(m.status)),
      m.stale ? h("span.t-stale", " changed since") : null,
    ]);
  }

  function checkedFor(key) { return (ui.checked[key] = ui.checked[key] || {}); }

  function casesTab(s, running) {
    const d = s.detail;
    if (!d) return DC.empty("Select a suite.");
    const p = s.persona || {};
    const sel = checkedFor(d.key);
    const ids = d.cases.filter((c) => sel[c.id]).map((c) => c.id);
    const why = !p.canRun ? (p.reason || "Not available for your persona") : s.busy ? "Busy: " + s.busy : d.error ? "Fix the suite first" : null;
    const org = (s.orgs || []).find((o) => o.role === ui.orgRole) || {};
    const run = (caseIds) => post({ type: "run", key: d.key, caseIds, mode: ui.mode, orgRole: ui.orgRole });
    return h("div", [
      h("div.spread", [
        h("div", [h("h2", { style: { margin: "0" } }, d.name), d.context ? h("div.muted.small", d.context.split("\n")[0]) : null]),
        h("div.row", [DC.links(d.links), DC.button("Validate suite", () => post({ type: "validate", key: d.key }), { kind: "secondary", disabled: !!s.busy })]),
      ]),
      d.error ? h("div", { style: { marginTop: "8px" } }, DC.notice(d.error, "err")) : null,
      s.validation && s.validation.key === d.key ? h("div", { style: { marginTop: "8px" } }, [
        DC.notice((s.validation.ok ? "Validation passed" : "Validation found problems") + (s.validation.command ? " · " + s.validation.command : ""), s.validation.ok ? "ok" : "err"),
        h("pre.t-out", s.validation.output),
      ]) : null,
      h("div.t-controls", [
        h("label", ["Mode ", select(["manual", "automation", "both"], ui.mode, (v) => { ui.mode = v; })]),
        h("label", ["Org ", select((s.orgs || []).map((o) => ({ value: o.role, label: o.role + (o.alias ? " (" + o.alias + ")" : "") })), ui.orgRole, (v) => { ui.orgRole = v; rerender(); })]),
        DC.links(org.links),
        DC.button(ids.length ? "Run selected (" + ids.length + ")" : "Run selected", () => run(ids), { disabled: !!why || !ids.length, title: why || (ids.length ? null : "Tick the cases to run") }),
        DC.button("Run all", () => run(undefined), { kind: "secondary", disabled: !!why, title: why }),
        running ? DC.button("Cancel run", () => post({ type: "cancel" }), { kind: "secondary", disabled: !p.canRun, title: p.canRun ? null : p.reason }) : null,
      ]),
      d.cases.length ? h("table", [
        h("thead", h("tr", [
          h("th.t-check", h("input", { type: "checkbox", "aria-label": "Select all", checked: d.cases.length > 0 && ids.length === d.cases.length,
            onchange: (e) => { d.cases.forEach((c) => { sel[c.id] = e.target.checked; }); rerender(); } })),
          h("th", "ID"), h("th", "Title"), h("th", "Manual"), h("th", "Automation"), h("th", "Links"),
        ])),
        h("tbody", d.cases.map((c) => h("tr", [
          h("td.t-check", h("input", { type: "checkbox", "aria-label": "Select " + c.id, checked: !!sel[c.id], onchange: (e) => { sel[c.id] = e.target.checked; rerender(); } })),
          h("td.mono", c.id),
          h("td", [c.title, h("div.muted.small", [c.section, " · ", c.steps + " steps", c.target === "web" ? " · web" : ""])]),
          h("td", statusCell(c.manual)),
          h("td", statusCell(c.automation)),
          h("td", DC.links(c.links)),
        ]))),
      ]) : DC.empty("This suite has no cases."),
    ]);
  }

  function select(options, value, onChange) {
    return h("select", { onchange: (e) => onChange(e.target.value) }, options.map((o) => {
      const v = typeof o === "string" ? o : o.value;
      return h("option", { value: v, selected: v === value }, typeof o === "string" ? o : o.label);
    }));
  }

  function liveBox(s) {
    const l = s.live || {};
    const progress = l.running
      ? "Running " + (l.done || 0) + (l.total ? "/" + l.total : "") + (l.current ? " · " + l.current.caseId + " " + (l.current.mode || "") + (l.current.model ? " (" + l.current.model + ")" : "") : "")
      : l.error ? "Last run stopped: " + l.error : "Last run log";
    return h("div", { style: { marginTop: "16px" } }, [
      h("div.spread", [h("h3", { style: { margin: "0" } }, [l.running ? DC.dot("info") : null, " ", progress]),
        h("span.t-counts", (l.results || []).map((r) => DC.badge(r.caseId + " " + (r.status || ""), DC.stateClass(r.status))))]),
      l.needsUser ? h("div", { style: { marginTop: "6px" } }, DC.notice(l.needsUser, "warn")) : null,
      h("pre.t-log#t-log", (l.log || []).join("\n")),
    ]);
  }

  function resultsTab(s) {
    const r = s.result;
    if (!r) return DC.empty("No run of this suite yet.");
    const c = r.counts || {};
    return h("div", [
      h("div.spread", [
        h("div", [
          h("h2", { style: { margin: "0" } }, [r.suite, " ", h("span.muted.small", r.startedAt ? new Date(r.startedAt).toLocaleString() : r.id)]),
          h("div.row", { style: { marginTop: "4px" } }, [
            DC.badge("route " + r.route, ROUTE_CLASS[r.route]), h("span.muted.small", r.routeText || ""),
            r.org ? h("span.muted.small", "org " + r.org) : null,
          ]),
        ]),
        DC.links(r.links),
      ]),
      h("div.row", { style: { margin: "10px 0" } }, [
        h("span", ["Total ", h("strong", String(r.total))]),
        ...["passed", "failed", "blocked", "error"].map((k) => DC.badge((c[k] || 0) + " " + STATUS_LABEL[k].toLowerCase(), c[k] ? DC.stateClass(k) : null)),
      ]),
      r.analysis ? h("div.card", { style: { margin: "8px 0" } }, [
        h("h3", "AI analysis: " + r.analysis.headline),
        h("p", r.analysis.summary),
        (r.analysis.groups || []).map((g) => h("div.t-group", [
          h("div", [DC.badge(g.kind), " ", h("strong", g.title), " ", h("span.muted.small", (g.cases || []).join(", "))]),
          h("div.small", g.explanation), h("div.small", ["Next step: ", g.nextStep]),
        ])),
      ]) : null,
      r.cases.map((x) => caseResult(x)),
    ]);
  }

  function caseResult(x) {
    return h("details.t-case", { open: x.status !== "passed" }, [
      h("summary", [
        DC.badge(STATUS_LABEL[x.status] || x.status, DC.stateClass(x.status)),
        h("strong.mono", x.id), h("span", x.title),
        h("span.muted.small", [x.mode, x.model ? " · " + x.model : "", " · " + x.durationSec + "s"]),
        DC.links(x.links),
      ]),
      h("p", x.summary),
      x.attempts && x.attempts.length > 1 ? h("div.muted.small", "Attempts: " + x.attempts.map((a) => a.model + " " + a.status).join(" → ")) : null,
      x.defects && x.defects.length ? h("div", [h("h3", "Defects"), x.defects.map((d) => h("div.t-defect", [
        h("div", [DC.badge(d.severity, d.severity === "critical" || d.severity === "major" ? "err" : "warn"), " ", h("strong", d.title)]),
        h("div.small", d.details),
      ]))]) : null,
      x.steps && x.steps.length ? h("table", { style: { marginTop: "6px" } }, [
        h("thead", h("tr", [h("th", "#"), h("th", "Step"), h("th", "Status"), h("th", "Observed")])),
        h("tbody", x.steps.map((st, i) => h("tr", [h("td", String(i + 1)), h("td", st.step), h("td", DC.badge(st.status, DC.stateClass(st.status))), h("td.small", st.actual)]))),
      ]) : null,
      x.evidence && x.evidence.length ? h("div", [
        h("h3", "Evidence"),
        h("div.t-shots", x.evidence.filter((e) => e.uri).map((e) => h("a", { href: "#", title: e.name, onclick: (ev) => { ev.preventDefault(); DC.openLink(e.link); } },
          h("img", { src: e.uri, alt: e.name })))),
        DC.links(x.evidence.filter((e) => !e.uri).map((e) => e.link)),
      ]) : null,
    ]);
  }

  function runsTab(s) {
    if (!s.runs || !s.runs.length) return DC.empty("No runs yet. Results are kept in .sf-ai-tester/runs/.");
    return DC.table([
      { key: "when", label: "When", render: (r) => h("span", { title: r.startedAt || r.id }, r.startedAt ? DC.when(r.startedAt) : r.id) },
      { key: "suite", label: "Suite", render: (r) => [r.suite, r.org ? h("div.muted.small", "org " + r.org) : null] },
      { key: "counts", label: "Result", render: (r) => [h("span.small", (r.counts.passed || 0) + "/" + r.total + " passed "), DC.badge(r.route, ROUTE_CLASS[r.route])] },
      { key: "links", label: "Links", render: (r) => DC.links(r.links) },
      { key: "view", label: "", render: (r) => DC.button("View", () => { ui.tab = "results"; post({ type: "showRun", runId: r.id }); }, { kind: "ghost" }) },
    ], s.runs);
  }

  function generateTab(s) {
    const p = s.persona || {};
    const g = s.generate || {};
    const why = !p.canRun ? (p.reason || "Not available for your persona") : s.busy ? "Busy: " + s.busy : null;
    const f = ui.gen;
    return h("div.t-form", [
      h("p.muted", "Describe a requirement or user story. The AI drafts cases using the org's real fields, picklists and validation rules, then the new suite is validated and saved in test-cases/."),
      h("textarea", { placeholder: "As a sales rep I can convert a qualified Lead into an Account, Contact and Opportunity…", "aria-label": "Requirement",
        oninput: (e) => { f.requirement = e.target.value; } }, f.requirement),
      h("div.row", [
        h("input", { type: "text", placeholder: "Suite name (optional)", "aria-label": "Suite name", value: f.name, oninput: (e) => { f.name = e.target.value; } }),
        h("label.muted.small", ["Cases ", h("input", { type: "number", min: "1", max: "20", value: String(f.count), style: { width: "60px" }, oninput: (e) => { f.count = Number(e.target.value) || 5; } })]),
        h("label.muted.small", ["Org ", select(["qa", "dev"], f.orgRole, (v) => { f.orgRole = v; })]),
        h("label.muted.small", [h("input", { type: "checkbox", checked: f.explore, onchange: (e) => { f.explore = e.target.checked; } }), " Look at the org (read-only)"]),
      ]),
      h("div.row", [
        DC.button(g.busy ? "Generating…" : "Generate cases with AI", () => post({ type: "generate", requirement: f.requirement, name: f.name, count: f.count, orgRole: f.orgRole, explore: f.explore }),
          { disabled: !!why || !!g.busy, title: why }),
      ]),
      g.error ? DC.notice(g.error, "err") : null,
      g.result ? h("div", [
        DC.notice("Wrote " + g.result.count + " case(s) to " + g.result.key + " with " + g.result.model + ". " + (g.result.validation.ok ? "Validation passed." : "Validation found problems."), g.result.validation.ok ? "ok" : "warn"),
        h("div.row", { style: { marginTop: "6px" } }, [DC.links([{ kind: "file", label: g.result.key, target: g.result.key }]),
          DC.button("Open in Cases", () => { ui.tab = "cases"; post({ type: "select", key: g.result.key }); }, { kind: "ghost" })]),
        h("pre.t-out", g.result.validation.output),
      ]) : null,
      (g.log && g.log.length) || g.busy ? h("pre.t-log#t-genlog", (g.log || []).join("\n")) : null,
    ]);
  }
})();
