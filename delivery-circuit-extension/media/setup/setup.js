// Project Setup wizard: phases B0-B12 with checks, safe runs, secrets, terminals and human checkpoints.
// Posts: ready, select {phase}, check {phase}, verify {step}, run {step}, secret {step, name}, tick {step, index, value},
//        setStatus {phase, status, notes?}, saveConfig {values}, openLink {link}.
(function () {
  const { h } = DC;
  let tab = "phases";
  let form = null;           // draft of build.config.yml values
  let statusDraft = {};      // phase -> status chosen in the select

  const KIND_LABEL = { check: "Automatic check", run: "Run", secret: "Secrets", terminal: "Terminal", human: "You do this", form: "Form" };
  const KIND_DOT = { done: "ok", partial: "info", blocked: "err", todo: "" };

  function resultView(r) {
    if (!r) return null;
    return h("div.stack", { style: { marginTop: "8px" } },
      h("div.row", DC.dot(r.state), h("span", r.text), h("span.small.muted", DC.when(r.at))),
      r.lines && r.lines.length
        ? h("details", h("summary.small.muted", { style: { cursor: "pointer" } }, r.lines.length + " line(s)"),
            h("div.mono.small", { style: { whiteSpace: "pre-wrap", marginTop: "4px" } }, r.lines.join("\n")))
        : null);
  }

  function stepCard(s, st) {
    const busy = !!st.busy;
    const mine = st.busy === s.id;
    const head = h("div.spread",
      h("div.row",
        DC.badge(s.hc ? s.hc + " · " + KIND_LABEL[s.kind] : KIND_LABEL[s.kind], s.kind === "human" ? "warn" : s.kind === "check" ? null : "info"),
        h("span.title", s.title)),
      mine ? h("span.small.muted", "Working…") : null);

    const checklist = s.checklist && s.checklist.length
      ? h("div.stack", { style: { marginTop: "8px" } }, s.checklist.map((c, i) =>
          h("label.row", { style: { cursor: "pointer" } },
            h("input", { type: "checkbox", checked: c.done, onchange: (e) => DC.post({ type: "tick", step: s.id, index: i, value: e.target.checked }) }),
            h("span", c.text))))
      : null;

    const secrets = s.secrets && s.secrets.length
      ? h("div.row", { style: { marginTop: "8px" } }, s.secrets.map((x) =>
          h("span.row", { style: { gap: "4px" } },
            DC.dot(x.set === true ? "ok" : x.set === false ? "warn" : ""),
            DC.button((x.set ? "Replace " : "Set ") + x.name, () => DC.post({ type: "secret", step: s.id, name: x.name }), { kind: "secondary", disabled: busy })),
        ), s.env ? h("span.small.muted", "environment " + s.env) : null)
      : null;

    const buttons = [];
    if (s.kind === "form") buttons.push(DC.button("Open form", () => { tab = "config"; DC.mount(render(DC.state)); }, { kind: "secondary" }));
    if (s.action && s.kind !== "secret") buttons.push(DC.button(s.action, () => DC.post({ type: "run", step: s.id }), { disabled: busy }));
    if (s.verify) buttons.push(DC.button(s.kind === "human" ? "Verify" : "Check", () => DC.post({ type: "verify", step: s.id }), { kind: "secondary", disabled: busy }));

    return h("div.item", { style: { padding: "12px" } },
      head,
      h("p.muted.small", s.detail),
      s.links && s.links.length ? h("div.row.small", h("span.muted", s.kind === "human" ? "Open:" : "Links:"), DC.links(s.links)) : null,
      checklist, secrets,
      buttons.length ? h("div.row", { style: { marginTop: "8px" } }, buttons) : null,
      resultView(s.result));
  }

  function phaseDetail(p, st) {
    const statusSel = h("select", { "aria-label": "Phase status", onchange: (e) => { statusDraft[p.id] = e.target.value; } },
      ["TODO", "PARTIAL", "DONE", "BLOCKED"].concat(p.id === "B12" ? ["COMPLETE"] : []).map((x) =>
        h("option", { value: x, selected: (statusDraft[p.id] || p.status.split(" ")[0].toUpperCase()) === x }, x)));
    return h("div.stack",
      h("div.spread",
        h("div", h("h2", { style: { margin: "0" } }, p.id + " " + p.name), h("div.muted.small", p.summary)),
        h("div.row", DC.badge(p.status, KIND_DOT[p.kind]),
          DC.button("Check all", () => DC.post({ type: "check", phase: p.id }), { kind: "secondary", disabled: !!st.busy }))),
      p.verified || p.evidence || p.notes
        ? h("div.small.muted", [p.verified ? "Verified " + p.verified : null, p.evidence ? "Evidence: " + p.evidence : null, p.notes ? "Notes: " + p.notes : null].filter(Boolean).join(" · "))
        : null,
      h("div.row",
        h("span.small.muted", "build-state.md"), statusSel,
        DC.button("Save status", () => DC.post({ type: "setStatus", phase: p.id, status: statusDraft[p.id] || p.status.split(" ")[0] }), { kind: "secondary", disabled: !!st.busy }),
        p.ready && p.kind !== "done" ? DC.button("Mark " + (p.id === "B12" ? "COMPLETE" : "DONE"), () => DC.post({ type: "setStatus", phase: p.id, status: p.id === "B12" ? "COMPLETE" : "DONE" }), { disabled: !!st.busy }) : null),
      h("div.list", p.steps.map((s) => stepCard(s, st))));
  }

  function phasesTab(st) {
    const sel = st.phases.find((p) => p.id === st.selected) || st.phases[0];
    const nav = h("div.list", { role: "listbox", "aria-label": "Phases", style: { alignSelf: "start" } }, st.phases.map((p) =>
      h("div.item", {
        role: "option", "aria-selected": String(p.id === sel.id), tabindex: "0",
        style: { cursor: "pointer", borderLeft: "2px solid " + (p.id === sel.id ? "var(--dc-accent)" : "transparent") },
        onclick: () => DC.post({ type: "select", phase: p.id }),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); DC.post({ type: "select", phase: p.id }); } },
      }, h("div.spread", { style: { flexWrap: "nowrap" } },
        h("span.row", { style: { flexWrap: "nowrap", minWidth: "0" } }, DC.dot(KIND_DOT[p.kind]),
          h("span", { title: p.id + " " + p.name, style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.id + " " + p.name)),
        h("span.small.muted", { style: { whiteSpace: "nowrap" } }, p.status)))));
    return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(200px, 260px) 1fr", gap: "16px" } }, nav, phaseDetail(sel, st));
  }

  function configTab(st) {
    const c = st.config;
    if (!form) form = Object.assign({}, c.values);
    const errFor = (k) => c.errors.filter((e) => e.key === k).map((e) => e.message).join(" ");
    const field = (f) => {
      const v = form[f.key] == null ? "" : form[f.key];
      const set = (val) => { form[f.key] = val; };
      let input;
      if (f.type === "people") input = h("textarea", { rows: 3, style: { width: "100%" }, oninput: (e) => set(e.target.value), "aria-label": f.label }, v);
      else if (f.type === "select") input = h("select", { onchange: (e) => set(e.target.value), "aria-label": f.label }, f.options.map((o) => h("option", { value: o, selected: v === o }, o)));
      else if (f.type === "bool") input = h("select", { onchange: (e) => set(e.target.value), "aria-label": f.label }, ["false", "true"].map((o) => h("option", { value: o, selected: String(v) === o }, o)));
      else input = h("input", { type: f.type === "number" ? "number" : "text", value: v, style: { width: "100%" }, oninput: (e) => set(e.target.value), "aria-label": f.label });
      const e = errFor(f.key);
      return h("div.item", { style: { display: "grid", gridTemplateColumns: "200px 1fr", gap: "12px", alignItems: "start" } },
        h("div", h("div", f.label), h("div.small.muted.mono", f.key)),
        h("div.stack", input, f.hint ? h("div.small.muted", f.hint) : null, e ? h("div.small", { style: { color: "var(--dc-err)" } }, e) : null));
    };
    const general = c.errors.filter((e) => !e.key).map((e) => DC.notice(e.message, "err"));
    return h("div.stack",
      h("div.spread",
        h("div", h("h2", { style: { margin: "0" } }, "build.config.yml"), h("div.small.muted", "Read by every phase. No secrets here: they go to GitHub Actions secrets from the phase steps.")),
        DC.links([{ kind: "file", label: "Open file", target: "build.config.yml" }])),
      c.exists ? null : DC.notice("build.config.yml does not exist yet. Saving creates it from the plugin template.", "warn"),
      general,
      h("div.list", c.fields.map(field)),
      h("div.row", DC.button("Save", () => DC.post({ type: "saveConfig", values: form })),
        DC.button("Discard changes", () => { form = null; DC.mount(render(DC.state)); }, { kind: "secondary" })));
  }

  function render(st) {
    if (!st) return DC.empty("No data.");
    if (!st.admin) return h("div", h("h1", "Project Setup"), DC.notice("Project Setup is for organisation or repository admins.", "warn"));
    const done = st.phases.filter((p) => p.kind === "done").length;
    const header = h("div.header",
      h("div", h("h1", "Project Setup"),
        h("div.sub", st.repo.owner + "/" + st.repo.repo + " · " + done + " of " + st.phases.length + " phases done · signed in as " + st.login)),
      DC.links([
        st.repo.url ? { kind: "github", label: "Repository", target: st.repo.url } : null,
        st.buildState.exists ? { kind: "file", label: "build-state.md", target: st.buildState.path } : null,
        st.config.exists ? { kind: "file", label: "build.config.yml", target: "build.config.yml" } : null,
      ].filter(Boolean)));
    const notices = [
      st.buildState.exists ? null : DC.notice("build-state.md does not exist yet. It is created on the first status change (or by the installer dry run).", "info"),
      st.buildState.repaired ? DC.notice("build-state.md has phase rows outside its table. They are shown here and written back into the table on the next status change.", "warn") : null,
    ];
    return h("div", header, notices,
      DC.tabs([{ id: "phases", label: "Phases" }, { id: "config", label: "build.config.yml" }], tab, (t) => { tab = t; DC.mount(render(DC.state)); }),
      tab === "config" ? configTab(st) : phasesTab(st));
  }

  DC.onState((st) => {
    // a saved config comes back as the new baseline
    if (form && st && st.config && !st.config.errors.length && JSON.stringify(form) === JSON.stringify(st.config.values)) form = null;
    return render(st);
  });
})();
