// Testing page (DESIGN.md §6.5): suites on the left, the selected suite on the right with Mode/Org, Run, four tabs and
// the run panel (the one box on the page). State from src/testing/page.ts buildPageState(); incremental events:
// {type:"log"} (run log line), {type:"genLog"} (generate log line), {type:"toast"} (run finished, export, ...).
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "testing.css") }));

  const saved = (() => { try { return (DC.vscode.getState && DC.vscode.getState()) || {}; } catch { return {}; } })();
  // Page-local choices (kept across re-renders; the tab and run choices also across reloads).
  const ui = Object.assign({ tab: "cases", mode: "manual", orgRole: "qa", logOpen: false, outOpen: false },
    saved.testing || {}, { checked: {}, gen: { requirement: "", name: "", count: 5, orgRole: "qa", explore: false } });
  function remember() {
    try {
      const s = Object.assign({}, (DC.vscode.getState && DC.vscode.getState()) || {}, { testing: { tab: ui.tab, mode: ui.mode, orgRole: ui.orgRole, logOpen: ui.logOpen } });
      if (DC.vscode.setState) DC.vscode.setState(s);
    } catch { /* preview */ }
  }

  const TONE = { passed: "ok", failed: "err", blocked: "warn", error: "err", running: "info" };
  const ROUTE = { pass: ["ok", "Pass", "every case passed"], dev: ["err", "Developer", "a case failed (defect)"],
    qa: ["warn", "QA", "a case was blocked (suite, data or permission)"], infra: ["warn", "Infra", "nothing ran or the agent errored"] };
  const toneOf = (s) => TONE[s] || DC.stateClass(s) || "";
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const dur = (sec) => { const n = Number(sec) || 0; return n < 60 ? n + " s" : Math.floor(n / 60) + " m" + (n % 60 ? " " + (n % 60) + " s" : ""); };
  const sep = (parts) => parts.filter((p) => p != null && p !== false && p !== "").flatMap((p, i) => (i ? [" · ", p] : [p]));

  DC.mount(DC.skeleton({ n: 4, label: "Loading tests" }));
  DC.onState(render);
  DC.onEvent = (m) => {
    const s = DC.state;
    if (!m) return;
    if (m.type === "toast") {
      DC.toast(String(m.text || ""), { kind: m.kind || "info", id: "testing", action: m.link ? { label: m.link.label || "Open", onClick: () => DC.openLink(m.link) } : null });
      return;
    }
    if (!s) return;
    if (m.type === "log" && s.live) {
      const line = m.line == null ? "" : String(m.line);
      s.live.log = (s.live.log || []).concat([line]).slice(-400);
      if (m.needsUser) { s.live.needsUser = line; rerender(); return; }
      const last = document.querySelector("#t-run .dc-log-row[aria-expanded='false'] .dc-last");
      if (last) last.textContent = line;
      DC.logAppend("run", [line]);
    } else if (m.type === "genLog") {
      const line = m.line == null ? "" : String(m.line);
      if (s.generate) s.generate.log = (s.generate.log || []).concat([line]);
      if (!DC.logAppend("gen", [line])) rerender();
    }
  };

  function rerender() { if (DC.state) DC.mount(render(DC.state)); }
  function setTab(id) { ui.tab = id; remember(); rerender(); }

  // ------------------------------------------------------------------------------------------- page
  function render(s) {
    if (!s) return [header({}), DC.skeleton({ n: 4, label: "Loading tests" })];
    if (s.error) return [header(s), h("div.t-page", DC.notice(s.error, "err", { action: { label: "Retry", onClick: () => post({ type: "refresh" }) } }))];
    if (s.denied) return [header(s), DC.empty({ icon: "lock", title: "Testing is not available to you", text: s.denied })];
    return [
      header(s),
      s.notice && s.notice.text ? h("div.t-notice", { "data-key": "notice" },
        DC.notice(s.notice.text, s.notice.kind || "info", { action: { label: "Dismiss", onClick: () => post({ type: "dismiss" }) } })) : null,
      h("div.t-layout", suites(s), main(s)),
    ];
  }

  function header(s) {
    const p = s.persona || {};
    const why = s.busy ? "Busy: " + s.busy : null;
    return DC.header({
      title: "Testing",
      sub: p.login ? sep(["SF AI Tester runs as " + p.login, p.canSee && !p.canRun ? "view only" : null]) : "Not signed in",
      persona: p.active || null,
      refresh: true,
      menu: s.denied || !s.persona ? null : [
        { label: "Export Excel", icon: "export", onClick: () => post({ type: "export", formats: ["xlsx"] }), disabled: !!why, reason: why },
        { label: "Export PDF", icon: "export", onClick: () => post({ type: "export", formats: ["pdf"] }), disabled: !!why, reason: why },
        "-",
        { label: "Settings", icon: "settings-gear", onClick: () => post({ type: "openSettings" }) },
      ],
    });
  }

  // ------------------------------------------------------------------------------------------- suites (left)
  function countsLine(last, notRun) {
    const parts = ["passed", "failed", "blocked", "error"].filter((k) => last && last[k])
      .map((k) => h("span." + (k === "passed" ? "ok" : k === "blocked" ? "warn" : "err"), last[k] + " " + k));
    if (notRun) parts.push(h("span", notRun + " not run"));
    return parts.length ? sep(parts) : "not run yet";
  }

  function suites(s) {
    const list = s.suites || [];
    return h("nav.t-suites", { "aria-label": "Suites" },
      DC.section("Suites", { count: list.length || null, first: true },
        list.length
          ? DC.list(list.map((x) => DC.row({
            key: "suite:" + x.key,
            icon: DC.icon(x.error ? "warning" : "file", { cls: x.error ? "err" : "" }),
            title: x.name,
            titleTip: x.key,
            meta: x.error ? h("span.err", "Invalid suite file") : countsLine(x.last, x.notRun),
            selected: x.key === s.selected,
            onClick: () => { if (x.key !== s.selected) post({ type: "select", key: x.key }); },
            chev: false,
          })), { label: "Suites", key: "suites" })
          : DC.empty({ icon: "beaker", title: "No suites yet", text: "Add one to test-cases/, or describe a requirement and let the AI draft it.",
            action: { label: "Generate cases", icon: "sparkle", onClick: () => setTab("generate") } })));
  }

  // ------------------------------------------------------------------------------------------- main (right)
  function runBlock(s) {
    const p = s.persona || {};
    const d = s.detail;
    if (!p.canRun) return p.reason || "Not available for your persona";
    if (s.live && s.live.running) return "A run is in progress";
    if (s.busy) return "Busy: " + s.busy;
    if (d && d.error) return "Fix the suite file first";
    return null;
  }

  function main(s) {
    const d = s.detail;
    const p = s.persona || {};
    const runs = s.runs || [];
    const tabsBar = DC.tabs([
      { id: "cases", label: "Cases", count: d ? d.cases.length : null },
      { id: "results", label: "Results" },
      { id: "runs", label: "Runs", count: runs.length || null },
      { id: "generate", label: "Generate" },
    ], ui.tab, setTab);
    const panel = ui.tab === "results" ? resultsTab(s) : ui.tab === "runs" ? runsTab(s) : ui.tab === "generate" ? generateTab(s) : casesTab(s);
    const run = s.run && (ui.tab === "cases" || s.run.state === "running") ? runPanel(s) : null;
    return h("div.t-main",
      d ? suiteHead(s, d) : null,
      d ? controls(s, d) : null,
      d && !p.canRun && p.reason ? DC.reasonLine(p.reason) : null,
      tabsBar,
      h("div.t-tab", { role: "tabpanel", "data-key": "tab:" + ui.tab }, panel),
      run);
  }

  function suiteHead(s, d) {
    const firstLine = d.context ? String(d.context).split("\n")[0] : "";
    const v = s.validation && s.validation.key === d.key ? s.validation : null;
    return h("div.t-head", { "data-key": "head:" + d.key },
      h("div.dc-sec-h",
        h("h2", { title: firstLine || null }, d.name, h("span.dc-count", " · " + plural(d.cases.length, "case"))),
        h("span.dc-sec-a",
          DC.strip(DC.linkStrip(d.links)),
          DC.button("Validate", () => post({ type: "validate", key: d.key }), { kind: "ghost", size: "sm", icon: "checklist",
            disabled: !!s.busy, reason: s.busy ? "Busy: " + s.busy : null, tip: "Check the suite file against the schema" }))),
      d.error ? DC.notice(d.error, "err") : null,
      v ? h("div.t-validation",
        DC.notice((v.ok ? "Validation passed" : "Validation found problems") + (v.command ? " · " + v.command : ""), v.ok ? "ok" : "err",
          v.output ? { action: { label: ui.outOpen ? "Hide output" : "Show output", onClick: () => { ui.outOpen = !ui.outOpen; rerender(); } } } : {}),
        ui.outOpen && v.output ? DC.log("validation", String(v.output).split("\n"), { follow: false, maxHeight: "200px" }) : null) : null);
  }

  function checkedFor(key) { return (ui.checked[key] = ui.checked[key] || {}); }
  function selectedIds(d) { const sel = checkedFor(d.key); return d.cases.filter((c) => sel[c.id]).map((c) => c.id); }
  function runCases(d, caseIds) { post({ type: "run", key: d.key, caseIds, mode: ui.mode, orgRole: ui.orgRole }); }

  function controls(s, d) {
    const why = runBlock(s);
    const ids = selectedIds(d);
    const orgs = s.orgs || [];
    const org = orgs.find((o) => o.role === ui.orgRole) || {};
    return h("div.t-controls",
      h("span.t-lbl", { "aria-hidden": "true" }, "Mode"),
      DC.segmented(["manual", "automation", "both"], ui.mode, (v) => { ui.mode = v; remember(); }, { label: "Mode" }),
      h("span.t-lbl", { "aria-hidden": "true" }, "Org"),
      DC.segmented((orgs.length ? orgs : [{ role: "qa" }, { role: "dev" }]).map((o) => ({ value: o.role, label: o.role, tip: o.alias ? "sf alias " + o.alias : "No sf alias set" })),
        ui.orgRole, (v) => { ui.orgRole = v; remember(); rerender(); }, { label: "Org" }),
      DC.strip((org.links || []).slice(0, 1).map((l) => ({ brand: l.kind, label: "Open the " + ui.orgRole + " org", link: l }))),
      h("span.t-spacer"),
      DC.button(ids.length ? "Run selected · " + ids.length : "Run selected", () => runCases(d, ids),
        { kind: "secondary", size: "sm", cls: "tip-left", disabled: !!why || !ids.length, reason: why || "Tick the cases to run" }),
      DC.button("Run all", () => runCases(d, undefined), { kind: "primary", size: "sm", icon: "play", cls: "tip-left", disabled: !!why, reason: why }));
  }

  // ------------------------------------------------------------------------------------------- cases tab
  function modeLine(m) {
    if (!m) return h("span", DC.dot(""), " not run");
    const more = sep([m.at ? DC.when(m.at) : null, m.model, m.stale ? "case changed since" : null]);
    return h("span", DC.dot(toneOf(m.status)), " ", DC.word(m.status),
      more.length ? h("span.muted", " · ", more) : null,
      m.summary ? h("div.muted.t-sum", m.summary) : null);
  }

  function casesTab(s) {
    const d = s.detail;
    if (!d) return DC.empty({ icon: "list-unordered", title: "No suite selected", text: (s.suites || []).length ? "Pick a suite on the left." : "Generate a suite to get started." });
    if (!d.cases.length) return DC.empty({ icon: "list-unordered", title: "This suite has no cases", text: "Add cases to " + d.key + ", or generate them." });
    const sel = checkedFor(d.key);
    const ids = selectedIds(d);
    const why = runBlock(s);
    const all = ids.length === d.cases.length;
    return h("div",
      h("label.t-all", h("input", { type: "checkbox", checked: all, "aria-label": "Select all cases",
        onchange: (e) => {
          const on = e.target.checked;
          d.cases.forEach((c) => { sel[c.id] = on; });
          document.querySelectorAll("input[data-case]").forEach((cb) => { cb.checked = on; });
          rerender();
        } }), h("span", ids.length ? ids.length + " of " + d.cases.length + " selected" : "Select all")),
      DC.list(d.cases.map((c) => {
        const last = c.latest;
        const other = last ? (last.mode === "manual" ? ["Automation", c.automation] : ["Manual", c.manual]) : null;
        return DC.row({
          key: "case:" + c.id,
          icon: h("input", { type: "checkbox", "data-case": c.id, checked: !!sel[c.id], "aria-label": "Select " + c.id,
            onchange: (e) => { sel[c.id] = e.target.checked; rerender(); } }),
          num: c.id,
          title: c.title,
          status: last ? { tone: toneOf(last.status), text: DC.word(last.status) } : { tone: "", text: "not run" },
          age: last && last.at ? DC.ago(last.at) : null,
          since: last && last.at ? last.at : null,
          strip: DC.linkStrip(c.links),
          menu: [
            { label: "Run this case", icon: "play", onClick: () => runCases(d, [c.id]), disabled: !!why, reason: why },
            ...DC.linkMenu(c.links),
          ],
          hash: [c, why],
          expanded: () => [
            DC.kv([
              last ? [last.mode === "manual" ? "Manual" : "Automation", modeLine(last)] : ["Last run", "not run yet"],
              other ? [other[0], modeLine(other[1])] : null,
              ["Case", sep([c.section, plural(c.steps || 0, "step"), c.target === "web" ? "web" : null])],
              ["Links", DC.links(c.links)],
            ]),
            DC.reasonLine(why ? "Run this case: " + why : ""),
          ],
        });
      }), { label: "Cases", key: "cases:" + d.key }));
  }

  // ------------------------------------------------------------------------------------------- run panel
  function runPanel(s) {
    const r = s.run;
    const l = s.live || {};
    const p = s.persona || {};
    const running = r.state === "running";
    const lines = l.log || [];
    const lastLine = lines.length ? lines[lines.length - 1] : "";
    const statusIcon = running ? (r.total ? DC.ring(r.done, r.total, { label: r.done + " of " + r.total + " done" }) : DC.ring(null, null)) : DC.dot(r.tone);
    const actions = running
      ? DC.button(l.cancelled ? "Cancelling" : "Cancel run", () => post({ type: "cancel" }), { kind: "ghost", size: "sm", icon: "debug-stop", cls: "tip-left",
        disabled: !p.canRun || !!l.cancelled, reason: !p.canRun ? p.reason || "Not available for your persona" : "Cancel already requested", loading: !!l.cancelled })
      : r.report ? DC.button("Open report", () => DC.openLink(r.report), { kind: "ghost", size: "sm", icon: "report" }) : null;
    const toggleLog = () => { ui.logOpen = !ui.logOpen; remember(); rerender(); };
    const bar = running
      ? DC.progress({ value: r.done, max: r.total || Math.max(r.done + 1, 1), label: r.done + (r.total ? " of " + r.total : "") + " cases done" })
      : r.cases.length ? DC.progress({ segments: r.counts }) : null;
    return h("div#t-run", { "data-key": "run" },
      DC.box({ key: "run-box", busy: running, title: r.title, status: statusIcon, actions },
        bar,
        r.cases.length ? h("div.t-dots", r.cases.map((c) => h("span", { title: c.mode || null },
          c.status === "running" ? DC.icon("loading", { size: 12, cls: "info" }) : DC.dot(toneOf(c.status)),
          h("span.mono", c.caseId), h("span.muted", DC.word(c.status))))) : null,
        l.needsUser ? DC.notice(l.needsUser, "warn", { icon: "person" }) : null,
        lines.length ? h("div.dc-log-row", { role: "button", tabindex: "0", "aria-expanded": String(!!ui.logOpen), "aria-controls": "dc-log-run",
          onclick: toggleLog, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleLog(); } } },
        DC.icon("chevron-right", { size: 12 }), h("span", "Log"), ui.logOpen ? h("span.dc-last") : h("span.dc-last", lastLine)) : null,
        lines.length && ui.logOpen ? DC.log("run", lines) : null));
  }

  // ------------------------------------------------------------------------------------------- results tab
  function resultsTab(s) {
    const r = s.result;
    if (!r) return DC.empty({ icon: "history", title: "No run of this suite yet", text: "Run the suite and the result appears here." });
    const c = r.counts || {};
    const route = ROUTE[r.route] || ["", r.route, r.routeText || ""];
    const links = r.links || [];
    const report = links.find((l) => l.kind === "report");
    const rest = links.filter((l) => l !== report);
    return h("div",
      h("div.t-result-h", { "data-key": "result:" + r.id },
        h("div.t-result-main",
          h("div", DC.status(route[0], route[1]), route[2] ? h("span.meta", " · " + route[2]) : null),
          h("div.meta", sep([r.startedAt ? h("span", { title: r.startedAt }, DC.when(r.startedAt)) : r.id, r.org ? "org " + r.org : null,
            plural(r.total || 0, "case"), (c.passed || 0) + " passed", (c.failed || 0) + " failed", (c.blocked || 0) + " blocked", (c.error || 0) + " error"]))),
        h("span.dc-sec-a", DC.strip(DC.linkStrip(rest)),
          report ? DC.button("Open report", () => DC.openLink(report), { kind: "secondary", size: "sm", icon: "report" }) : null)),
      r.analysis ? analysis(r.analysis) : null,
      DC.section("Cases", { count: (r.cases || []).length },
        DC.list((r.cases || []).map((x) => caseResult(r, x)), { label: "Case results", key: "results:" + r.id })));
  }

  function analysis(a) {
    return DC.section("AI analysis", { key: "analysis" },
      h("div.t-analysis", h("div.t-headline", DC.icon("sparkle", { size: 16 }), h("span", a.headline)), a.summary ? h("p.meta", a.summary) : null),
      (a.groups || []).length ? DC.list(a.groups.map((g, i) => DC.row({
        key: "group:" + i + ":" + (g.title || ""),
        icon: DC.icon("lightbulb"),
        title: g.title,
        status: { tone: g.kind === "defect" ? "err" : g.kind === "flaky" || g.kind === "suite" ? "warn" : "", text: g.kind },
        meta: (g.cases || []).join(", "),
        expanded: () => DC.kv([["Why", g.explanation], ["Next step", g.nextStep], ["Cases", (g.cases || []).join(", ")]]),
      })), { label: "Analysis groups", key: "groups" }) : null);
  }

  function caseResult(r, x) {
    const images = (x.evidence || []).filter((e) => e.uri);
    const files = (x.evidence || []).filter((e) => !e.uri).map((e) => e.link);
    const allLinks = [...(x.links || []), ...images.map((e) => e.link), ...files];
    return DC.row({
      key: "res:" + r.id + ":" + x.id + ":" + (x.mode || ""),
      icon: DC.icon(x.mode === "automation" ? "symbol-event" : "person", { title: x.mode || null }),
      num: x.id,
      title: x.title,
      status: { tone: toneOf(x.status), text: DC.word(x.status) },
      age: x.durationSec != null ? dur(x.durationSec) : null,
      strip: DC.linkStrip(allLinks),
      menu: DC.linkMenu(allLinks),
      expanded: () => [
        x.summary ? h("div.t-sum-full", x.summary) : null,
        DC.kv([
          ["Run", sep([x.mode, x.model, x.costUsd ? "$" + Number(x.costUsd).toFixed(2) : null, x.durationSec != null ? dur(x.durationSec) : null])],
          (x.attempts || []).length > 1 ? ["Attempts", x.attempts.map((a) => a.model + " " + DC.word(a.status)).join(" → ")] : null,
          (x.defects || []).length ? ["Defects", h("div.t-defects", x.defects.map((df) => h("div",
            DC.dot(df.severity === "critical" || df.severity === "major" ? "err" : "warn"), " ", h("strong", df.title), h("span.muted", " · " + (df.severity || "")),
            df.details ? h("div.muted", df.details) : null)))] : null,
          (x.steps || []).length ? ["Steps", h("ol.t-steps", x.steps.map((st) => h("li",
            DC.dot(toneOf(st.status)), h("span", st.step), st.actual ? h("div.muted", st.actual) : null)))] : null,
          images.length ? ["Evidence", h("div.t-shots", images.map((e) => h("a", { href: "#", "data-tip": e.name, "aria-label": "Open " + e.name,
            onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); DC.openLink(e.link); } }, h("img", { src: e.uri, alt: e.name }))))] : null,
          ["Links", DC.links([...(x.links || []), ...files])],
        ]),
      ],
    });
  }

  // ------------------------------------------------------------------------------------------- runs tab
  function runsTab(s) {
    const runs = s.runs || [];
    if (!runs.length) return DC.empty({ icon: "history", title: "No runs yet", text: "Results are kept in .sf-ai-tester/runs/." });
    const shown = s.result && s.result.id;
    return DC.list(runs.map((r) => {
      const route = ROUTE[r.route] || ["", r.route];
      const c = r.counts || {};
      return DC.row({
        key: "run:" + r.id,
        icon: DC.icon("history"),
        title: r.suite,
        titleTip: r.startedAt || r.id,
        meta: sep([r.org ? "org " + r.org : null, "route " + route[1].toLowerCase()]),
        status: { tone: route[0], text: (c.passed || 0) + "/" + (r.total || 0) + " passed" },
        age: r.startedAt ? DC.ago(r.startedAt) : null,
        since: r.startedAt || null,
        selected: r.id === shown,
        strip: DC.linkStrip(r.links),
        menu: DC.linkMenu(r.links),
        primary: { label: "View", kind: "ghost", onClick: () => { ui.tab = "results"; remember(); post({ type: "showRun", runId: r.id }); } },
      });
    }), { label: "Runs", key: "runs" });
  }

  // ------------------------------------------------------------------------------------------- generate tab
  function generateTab(s) {
    const p = s.persona || {};
    const g = s.generate || {};
    const f = ui.gen;
    const why = !p.canRun ? p.reason || "Not available for your persona" : s.busy && !g.busy ? "Busy: " + s.busy : null;
    const res = g.result;
    return h("div.t-form",
      h("p.meta", "Describe a requirement or user story. The AI drafts cases with the org's real fields, picklists and validation rules; the new suite is validated and saved in test-cases/."),
      h("textarea", { placeholder: "As a sales rep I can convert a qualified Lead into an Account, Contact and Opportunity…", "aria-label": "Requirement", rows: "5",
        disabled: why ? true : null, oninput: (e) => { f.requirement = e.target.value; } }, f.requirement),
      h("div.t-form-row",
        h("input.t-name", { type: "text", placeholder: "Suite name (optional)", "aria-label": "Suite name", value: f.name, disabled: why ? true : null,
          oninput: (e) => { f.name = e.target.value; } }),
        h("label.t-field", h("span", "Cases"), h("input.t-count", { type: "number", min: "1", max: "20", value: String(f.count), disabled: why ? true : null,
          oninput: (e) => { f.count = Math.max(1, Math.min(20, Number(e.target.value) || 5)); } })),
        h("span.t-lbl", { "aria-hidden": "true" }, "Org"),
        DC.segmented(["qa", "dev"], f.orgRole, (v) => { f.orgRole = v; }, { label: "Org for generation" }),
        h("label.t-field", h("input", { type: "checkbox", checked: !!f.explore, disabled: why ? true : null, onchange: (e) => { f.explore = e.target.checked; } }),
          h("span", "Look at the org (read-only)"))),
      h("div.t-form-row",
        DC.button(g.busy ? "Generating" : "Generate cases", () => {
          if (!String(f.requirement || "").trim()) { DC.toast("Describe the requirement first.", { kind: "warn", id: "gen" }); return; }
          post({ type: "generate", requirement: f.requirement, name: f.name, count: f.count, orgRole: f.orgRole, explore: f.explore });
        }, { icon: "sparkle", loading: !!g.busy, disabled: !!why || !!g.busy, reason: why || "Generating…" })),
      why && p.canRun ? DC.reasonLine(why) : null,
      g.error ? DC.notice(g.error, "err") : null,
      res ? h("div.t-gen-result", { "data-key": "gen-result:" + res.key },
        DC.notice("Wrote " + plural(res.count, "case") + " to " + res.key + " with " + res.model + ". " + (res.validation && res.validation.ok ? "Validation passed." : "Validation found problems."),
          res.validation && res.validation.ok ? "ok" : "warn", { action: { label: "Open in Cases", onClick: () => { ui.tab = "cases"; remember(); post({ type: "select", key: res.key }); } } }),
        res.validation && !res.validation.ok && res.validation.output ? DC.log("gen-validation", String(res.validation.output).split("\n"), { follow: false, maxHeight: "200px" }) : null) : null,
      (g.log && g.log.length) || g.busy ? DC.log("gen", g.log || []) : null);
  }
})();
