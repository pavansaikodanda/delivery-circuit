// Project Setup wizard (DESIGN.md §6.6), v3: phases B0-B13 as a narrow list, the selected phase's steps as rows with
// one status and one action each; detail, commands to copy (runner registration, logins), checklist, links and the last
// result live in the expanded row. v3 stores no credentials, so there are no secret fields.
// State: SetupView from src/setup/view.ts (each step carries status + actions, each phase progress).
// Posts: ready, select {phase}, check {phase}, verify {step}, run {step}, tick {step, index, value},
//        setStatus {phase, status, notes?}, saveConfig {values}, openLink {link}.
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "setup.css") }));

  const saved = (() => { try { return (DC.vscode.getState && DC.vscode.getState()) || {}; } catch { return {}; } })();
  let tab = saved.setupTab === "config" ? "config" : "phases";
  let form = null; // draft of build.config.yml values (null = no edits)

  const KIND = {
    check: { icon: "checklist", label: "Automatic check" }, run: { icon: "play", label: "Run" },
    terminal: { icon: "terminal", label: "Terminal" }, human: { icon: "person", label: "You do this" }, form: { icon: "edit", label: "Form" },
  };
  const PHASE_TONE = { done: "ok", partial: "info", blocked: "err", todo: "" };
  const STATUSES = ["TODO", "PARTIAL", "DONE", "BLOCKED"];
  const GROUPS = { github: "GitHub", people: "People", runners: "Self-hosted runners", jira: "Jira", confluence: "Confluence", salesforce: "Salesforce", slack: "Slack", ai: "AI" };

  const rerender = () => { if (DC.state) DC.mount(render(DC.state)); };
  function setTab(t) {
    tab = t;
    try { DC.vscode.setState(Object.assign({}, DC.vscode.getState() || {}, { setupTab: t })); } catch { /* preview */ }
    rerender();
  }
  const phaseWord = (p) => String(p.status || "TODO").toLowerCase().replace(/^todo\b/, "to do");
  const statusCode = (p) => String(p.status || "TODO").split(/\s/)[0].toUpperCase();
  const busyReason = (st) => (st.busy ? "Wait for the running step to finish" : null);

  // ---------------------------------------------------------------- step rows
  function runAction(s, a) {
    if (a.do === "form") { setTab("config"); return; }
    post({ type: a.do, step: s.id });
  }
  function resultBlock(r) {
    if (!r) return null;
    return h("div.su-result",
      h("div.su-result-t", DC.status(r.state, r.text), r.at ? h("span.dc-age", { title: r.at }, "· " + DC.when(r.at)) : null),
      r.lines && r.lines.length ? h("pre.su-lines", r.lines.join("\n")) : null);
  }
  function checklist(s, disabled) {
    if (!s.checklist || !s.checklist.length) return null;
    return h("div.su-check", s.checklist.map((c, i) => h("label",
      h("input", { type: "checkbox", checked: !!c.done, disabled, onchange: (e) => post({ type: "tick", step: s.id, index: i, value: e.currentTarget.checked }) }),
      h("span", c.text))));
  }
  // Commands the person runs elsewhere (runner machine, a terminal); copied as one block. They never hold a credential.
  function commandBlock(s) {
    if (!s.commands || !s.commands.length) return null;
    const text = s.commands.join("\n");
    const copy = () => {
      try { navigator.clipboard.writeText(text).then(() => DC.toast && DC.toast("Commands copied"), () => {}); } catch { /* preview */ }
    };
    return h("div.su-cmds",
      h("pre.su-lines.su-cmd", text),
      h("div.dc-acts", DC.button("Copy", copy, { kind: "ghost", size: "sm", icon: "copy", tip: "Copy the commands" })),
      (s.notes || []).map((n) => h("div.meta", n)));
  }
  // isNext: the first open step with an action; only it gets the primary (filled) button, the rest stay secondary
  function stepRow(s, st, isNext) {
    const kind = KIND[s.kind] || KIND.check;
    const why = busyReason(st);
    const acts = (s.actions || []).filter((a) => a && a.label);
    const [first, ...rest] = acts;
    const actOpts = (a, kindName) => ({ kind: kindName, size: "sm", disabled: !!why && a.do !== "form", reason: a.do === "form" ? null : why });
    const status = s.status || { tone: "muted", text: "" };
    const busy = !!status.busy;
    const primary = first ? DC.button(first.label, () => runAction(s, first), Object.assign(actOpts(first, !s.done && isNext ? "primary" : "secondary"), { loading: busy })) : null;
    const menu = rest.map((a) => ({ label: a.label, icon: a.do === "verify" ? "sync" : a.do === "form" ? "edit" : "play",
      disabled: !!why && a.do !== "form", reason: a.do === "form" ? null : why, onClick: () => runAction(s, a) }));
    const panelActs = rest;
    const more = DC.linkMenu(s.links, 3);
    if (more.length) { if (menu.length) menu.push("-"); menu.push(...more); }
    return DC.row({
      key: "step-" + s.id, icon: DC.icon(kind.icon, { label: kind.label }), num: s.hc || null, title: s.title,
      titleTip: kind.label + (s.hc ? " · " + s.hc : ""),
      status: { tone: status.tone, text: status.text, spin: busy }, busy,
      age: s.result && s.result.at ? DC.ago(s.result.at) : null, since: s.result ? s.result.at : null,
      primary, strip: DC.linkStrip(s.links), menu,
      expanded: () => [
        s.detail ? h("p.su-detail", s.detail) : null,
        DC.kv([
          ["Result", resultBlock(s.result)],
          ["Commands", commandBlock(s)],
          ["Checklist", checklist(s, busy)],
          ["Links", DC.links(s.links)],
          ["Actions", panelActs.length ? h("div.dc-acts", panelActs.map((a) => DC.button(a.label, () => runAction(s, a), actOpts(a, "ghost")))) : null],
        ]),
        why && acts.some((a) => a.do !== "form") ? DC.reasonLine(why) : null,
      ],
      hash: [s, !!st.busy], state: busy ? "running" : null,
      announce: s.title + ": " + status.text,
    });
  }

  // ---------------------------------------------------------------- phases tab
  function phaseRow(p, sel) {
    const word = phaseWord(p);
    const prog = p.progress || { done: 0, total: (p.steps || []).length };
    return DC.row({
      key: "ph-" + p.id, icon: h("span.su-ph-dot", { role: "img", "aria-label": word }, DC.dot(PHASE_TONE[p.kind] || "", { hollow: p.kind === "todo" })),
      num: p.id, title: p.name, titleTip: p.id + " " + p.name + " · " + p.status,
      status: h("span.dc-status", h("span.dc-age", { title: prog.done + " of " + prog.total + " steps passed" }, prog.done + "/" + prog.total)),
      selected: p.id === sel.id, chev: false,
      onClick: () => { if (p.id !== sel.id) post({ type: "select", phase: p.id }); },
      hash: [p.id, p.name, p.status, p.kind, prog, p.id === sel.id],
    });
  }
  function phasePicker(st, sel) {
    return h("div.su-picker", DC.menu(st.phases.map((p) => ({
      label: p.id + " " + p.name, hint: phaseWord(p), checked: p.id === sel.id,
      onClick: () => { if (p.id !== sel.id) post({ type: "select", phase: p.id }); },
    })), { text: sel.id + " " + sel.name, label: "Choose a phase", kind: "secondary", size: "md" }));
  }
  function phaseDetail(p, st) {
    const why = busyReason(st);
    const checking = st.busy === p.id;
    const code = statusCode(p);
    const last = (st.phases || []).length ? st.phases[st.phases.length - 1].id : "B13";
    const doneCode = p.id === last ? "COMPLETE" : "DONE";
    const isDone = p.kind === "done";
    const prog = p.progress || { done: 0, total: p.steps.length };
    const statusItems = ["Set status in build-state.md", ...STATUSES.concat(p.id === last ? ["COMPLETE"] : []).map((x) => ({
      label: x.charAt(0) + x.slice(1).toLowerCase(), checked: code === x, disabled: !!why, reason: why,
      hint: (x === "DONE" || x === "COMPLETE") && !p.ready ? "asks first" : null,
      onClick: () => { if (code !== x) post({ type: "setStatus", phase: p.id, status: x }); },
    }))];
    const record = [p.verified ? "Verified " + p.verified : null, p.evidence ? "Evidence: " + p.evidence : null, p.notes ? "Notes: " + p.notes : null].filter(Boolean).join(" · ");
    const hasChecks = p.steps.some((s) => s.verify);
    return h("div.su-detail-pane", { "data-key": "detail-" + p.id },
      h("div.su-phase-h",
        h("div.su-phase-t", h("h2", h("span.su-pid", p.id), " ", p.name), DC.status(PHASE_TONE[p.kind] || "muted", phaseWord(p))),
        h("div.dc-acts",
          p.ready && !isDone ? DC.button("Mark " + doneCode.toLowerCase(), () => post({ type: "setStatus", phase: p.id, status: doneCode }), { size: "sm", disabled: !!why, reason: why }) : null,
          hasChecks ? DC.button("Check all", () => post({ type: "check", phase: p.id }), { kind: p.ready || isDone ? "ghost" : "secondary", size: "sm", icon: "sync", loading: checking, disabled: !!why && !checking, reason: checking ? null : why }) : null,
          DC.menu(statusItems, { label: "Phase status" }))),
      p.summary ? h("p.su-summary", p.summary) : null,
      h("div.su-prog", DC.progress({ value: prog.done, max: prog.total, label: prog.done + " of " + prog.total + " steps passed" }), h("span.meta", prog.done + "/" + prog.total + " steps")),
      record ? h("div.su-record", { title: record }, DC.icon("file", { size: 12 }), h("span", "build-state.md · " + record)) : null,
      p.steps.length ? DC.list(p.steps.map((s) => stepRow(s, st, s === p.steps.find((x) => !x.done && (x.actions || []).some((a) => a && a.label)))), { label: "Steps of " + p.id, key: "steps-" + p.id })
        : DC.empty({ icon: "checklist", title: "No steps", text: "This phase has nothing to run from here." }));
  }
  function phasesTab(st) {
    if (!st.phases || !st.phases.length) return DC.empty({ icon: "checklist", title: "No phases", text: "The bootstrap phases could not be read." });
    const sel = st.phases.find((p) => p.id === st.selected) || st.phases[0];
    return h("div.su-layout", { "data-key": "phases" },
      h("nav.su-nav", { "aria-label": "Phases" }, DC.list(st.phases.map((p) => phaseRow(p, sel)), { label: "Phases", key: "phases" })),
      h("div.su-main", phasePicker(st, sel), phaseDetail(sel, st)));
  }

  // ---------------------------------------------------------------- build.config.yml tab
  const dirty = (c) => !!form && JSON.stringify(form) !== JSON.stringify(c.values || {});
  function saveBar(st) {
    const c = st.config;
    const d = dirty(c);
    return h("div.su-savebar#su-savebar",
      h("span.meta", d ? "Unsaved changes" : c.exists ? "No changes" : "Not saved yet"),
      h("span.dc-acts",
        d ? DC.button("Discard", () => { form = null; rerender(); }, { kind: "ghost", size: "sm" }) : null,
        DC.button(c.exists ? "Save" : "Create file", () => post({ type: "saveConfig", values: form || Object.assign({}, c.values) }),
          { kind: d || !c.exists ? "primary" : "secondary", size: "sm", disabled: !d && c.exists, reason: !d && c.exists ? "Nothing changed yet" : null, tip: "Writes build.config.yml" })));
  }
  function refreshBar() {
    const bar = document.getElementById("su-savebar");
    if (bar && DC.state) bar.replaceWith(saveBar(DC.state));
  }
  function field(f, c) {
    const id = "cfg-" + f.key.replace(/\W/g, "-");
    const v = form && form[f.key] != null ? form[f.key] : c.values && c.values[f.key] != null ? c.values[f.key] : "";
    const set = (val) => { if (!form) form = Object.assign({}, c.values || {}); form[f.key] = val; refreshBar(); };
    const errs = (c.errors || []).filter((e) => e && e.key === f.key).map((e) => e.message).join(" ");
    const hintId = f.hint ? id + "-hint" : null, errId = errs ? id + "-err" : null;
    const common = { id, "aria-describedby": [hintId, errId].filter(Boolean).join(" ") || null, "aria-invalid": errs ? "true" : null };
    let input;
    if (f.type === "people") {
      input = h("textarea", Object.assign({ rows: 3, oninput: (e) => set(e.currentTarget.value), placeholder: "login, email, @slack" }, common));
      input.defaultValue = String(v);
    } else if (f.type === "select" || f.type === "bool") {
      const opts = f.type === "bool" ? ["false", "true"] : f.options || [];
      input = h("select", Object.assign({ onchange: (e) => set(e.currentTarget.value) }, common),
        opts.map((o) => h("option", { value: o, selected: String(v) === o }, f.type === "bool" ? (o === "true" ? "Yes" : "No") : o)));
    } else {
      input = h("input", Object.assign({ type: f.type === "number" ? "number" : f.type === "url" ? "url" : "text", value: String(v), spellcheck: "false",
        oninput: (e) => set(e.currentTarget.value) }, common));
    }
    return h("div.su-field", { "data-key": "f-" + f.key },
      h("div.su-field-l", h("label", { for: id }, f.label), h("div.mono.meta", f.key)),
      h("div.su-field-v", input, f.hint ? h("div.meta#" + hintId, f.hint) : null, errs ? h("div.su-err#" + errId, DC.icon("error", { size: 12 }), h("span", errs)) : null));
  }
  function configTab(st) {
    const c = st.config || { exists: false, fields: [], values: {}, errors: [] };
    const general = (c.errors || []).filter((e) => e && !e.key);
    const groups = [];
    (c.fields || []).forEach((f) => {
      const g = f.key.split(".")[0];
      let grp = groups.find((x) => x.id === g);
      if (!grp) { grp = { id: g, title: GROUPS[g] || g, fields: [] }; groups.push(grp); }
      grp.fields.push(f);
    });
    return h("div.su-config", { "data-key": "config" },
      h("p.su-summary", "Read by every phase. No secrets anywhere: every connection is a login (gh, sf, acli, claude, MCP sign-in), and the runners hold their own."),
      c.exists ? null : DC.notice("build.config.yml does not exist yet. Saving creates it from the plugin template.", "info"),
      general.map((e) => DC.notice(e.message, "err")),
      groups.length ? groups.map((g, i) => DC.section(g.title, { key: "cfg-" + g.id, first: i === 0 }, h("div.su-fields", g.fields.map((f) => field(f, c)))))
        : DC.empty({ icon: "settings-gear", title: "No fields", text: "The form fields could not be loaded." }),
      saveBar(st));
  }

  // ---------------------------------------------------------------- page
  function render(st) {
    if (!st) return DC.skeleton({ n: 6, label: "Loading project setup" });
    const repo = st.repo && st.repo.owner ? st.repo.owner + "/" + st.repo.repo : "";
    if (!st.admin) {
      return [DC.header({ title: "Project setup", sub: repo || null }),
        DC.empty({ icon: "lock", title: "Project setup is for admins", text: "Ask an organisation or repository admin" + (repo ? " of " + repo : "") + " to run it." })];
    }
    const phases = st.phases || [];
    const done = phases.filter((p) => p.kind === "done").length;
    const links = [
      st.repo && st.repo.url ? { label: "Repository", link: { kind: "github", label: "Repository", target: st.repo.url }, brand: "github" } : null,
      st.buildState && st.buildState.exists ? { label: "build-state.md", link: { kind: "file", label: "build-state.md", target: st.buildState.path }, icon: "file" } : null,
      st.config && st.config.exists ? { label: "build.config.yml", link: { kind: "file", label: "build.config.yml", target: "build.config.yml" }, icon: "file" } : null,
    ].filter(Boolean);
    const errCount = ((st.config && st.config.errors) || []).length;
    return [
      DC.header({
        title: "Project setup",
        sub: [repo, done + " of " + phases.length + " phases done", st.login ? "signed in as " + st.login : null].filter(Boolean).join(" · "),
        actions: DC.chip("Admin", { icon: "shield", title: "Signed in as a repository admin" }),
        menu: links.length ? ["Open", ...links] : null,
        onRefresh: () => post({ type: "ready" }),
      }),
      st.buildState && !st.buildState.exists ? DC.notice("build-state.md does not exist yet. It is created on the first status change (or by the installer dry run).", "info") : null,
      st.buildState && st.buildState.repaired ? DC.notice("build-state.md has phase rows outside its table. They are shown here and written back into the table on the next status change.", "warn") : null,
      DC.tabs([{ id: "phases", label: "Phases", count: done + "/" + phases.length }, { id: "config", label: "build.config.yml", count: errCount ? errCount + (errCount === 1 ? " error" : " errors") : null }], tab, setTab),
      tab === "config" ? configTab(st) : phasesTab(st),
    ];
  }

  DC.mount(render(null));
  DC.onState((st) => {
    // a saved config comes back as the new baseline
    if (form && st && st.config && !(st.config.errors || []).length && JSON.stringify(form) === JSON.stringify(st.config.values)) form = null;
    return render(st);
  });
})();
