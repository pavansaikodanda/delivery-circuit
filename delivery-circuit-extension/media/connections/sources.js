// Sources page (Architect; docs/CIRCUIT-V3.md step 1). State from src/connections/sourcesCore.ts buildSourcesState().
// Posts: addText {text, title, origin}, attach {origin}, firefliesLoad, firefliesAdd {id}, wisprImport, watchChoose,
// watchStop, excerpt {id}, action (Start intake), openConnections, refresh, openLink.
// Events: {kind: "added" | "info" | "error", text}, {kind: "cleared"}, {kind: "excerpt", id, text}.
// Transcript text is never in the state; an excerpt is fetched on demand and kept only in this page's memory.
(function () {
  "use strict";
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "sources.css") }));
  const str = (x) => (x == null || x === false || x === true ? "" : String(x));
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

  // page-local UI state (draft text survives re-renders; never posted until "Add source")
  const ui = { text: "", title: "", dictated: false, excerpts: {} };
  const rerender = () => { if (DC.state) DC.mount(render(DC.state)); };
  const isBusy = (s, k) => (s.busy || []).includes(k);

  const ORIGIN_ICON = { paste: ["icon", "edit"], file: ["icon", "file"], fireflies: ["brand", "fireflies"], "fireflies-export": ["brand", "fireflies"],
    "wispr-flow": ["icon", "mic"], "watch-folder": ["icon", "folder"] };
  const originIcon = (o) => { const m = ORIGIN_ICON[o] || ["icon", "file"]; return m[0] === "brand" ? DC.brand(m[1]) : DC.icon(m[1]); };
  const day = (iso) => str(iso).slice(0, 10);

  // ---------- header ----------
  function header(s) {
    return DC.header({
      title: "Sources",
      sub: "Call transcripts and notes for intake. Stored encrypted on this machine; the repo keeps only the index (.circuit/sources.json).",
      persona: "architect",
      onRefresh: () => post({ type: "refresh" }),
    });
  }

  // ---------- add: paste or dictate, attach ----------
  function addSection(s) {
    const why = s.canAct ? null : str(s.reason) || "Only the Architect adds sources.";
    const busy = isBusy(s, "paste");
    const add = () => {
      if (!ui.text.trim()) { DC.toast("Paste or dictate some text first.", { kind: "warn", id: "add" }); return; }
      post({ type: "addText", text: ui.text, title: ui.title, origin: ui.dictated ? "wispr-flow" : "paste" });
    };
    return DC.section("Add a source", { key: "sec:add", first: true,
      action: DC.button(isBusy(s, "attach") ? "Attaching" : "Attach file", () => post({ type: "attach", origin: "file" }),
        { kind: "ghost", size: "sm", icon: "file-add", loading: isBusy(s, "attach"), disabled: !!why || isBusy(s, "attach"), reason: why || "Attaching…" }) },
    h("div.src-compose",
      h("textarea", { rows: "6", "aria-label": "Transcript or notes", disabled: why ? true : null,
        placeholder: "Paste a transcript or notes, or dictate here (Wispr Flow types into this box)…",
        oninput: (e) => { ui.text = e.currentTarget.value; },
        onkeydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } } }, ui.text),
      h("div.src-row",
        h("input.src-title", { type: "text", "aria-label": "Source title", placeholder: "Title (optional), e.g. Acme Shipping kick-off", value: ui.title,
          disabled: why ? true : null, oninput: (e) => { ui.title = e.currentTarget.value; } }),
        h("label.src-check", h("input", { type: "checkbox", checked: ui.dictated, disabled: why ? true : null, onchange: (e) => { ui.dictated = e.currentTarget.checked; } }),
          h("span", "Dictated with Wispr Flow")),
        DC.button(busy ? "Adding" : "Add source", add, { icon: "add", loading: busy, disabled: !!why || busy, reason: why || "Adding…", tip: "Ctrl+Enter" })),
      h("p.src-hint", "Files: " + (s.extensions || []).map((x) => "." + x).join(", ") + ". Nothing is committed to git.")));
  }

  // ---------- Fireflies ----------
  function meetingRow(m, s) {
    const busy = isBusy(s, "ff:" + m.id);
    const meta = [day(m.date), m.durationMin ? m.durationMin + " min" : "", m.participants ? plural(m.participants, "person", "people") : ""].filter(Boolean).join(" · ");
    return DC.row({
      key: "ff-" + m.id, icon: DC.brand("fireflies"), title: m.title, meta,
      status: m.indexed ? { tone: "ok", text: "In sources" } : null,
      primary: m.indexed ? null : DC.button(busy ? "Adding" : "Add", () => post({ type: "firefliesAdd", id: m.id }),
        { kind: "secondary", size: "sm", loading: busy, disabled: !s.canAct || busy, reason: !s.canAct ? str(s.reason) : "Adding…" }),
      strip: [{ brand: "fireflies", label: "Open in Fireflies", link: m.link }],
      hash: [m, busy, s.canAct],
    });
  }
  function firefliesSection(s) {
    const f = s.fireflies || { mcp: {}, meetings: [] };
    const loading = f.status === "loading" || isBusy(s, "fireflies");
    const mcpOk = f.mcp && (f.mcp.state === "connected" || f.mcp.state === "unknown" || f.mcp.state === "checking");
    const why = !s.canAct ? str(s.reason) : null;
    const load = DC.button(loading ? "Loading" : f.status === "ready" ? "Reload" : "Load meetings", () => post({ type: "firefliesLoad" }),
      { kind: "ghost", size: "sm", icon: "sync", loading, disabled: !!why || loading, reason: why || "Loading…" });
    const meetings = (f.meetings || []).filter(Boolean);
    const exportLink = h("p.src-hint.src-more", "No Fireflies MCP? ",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); if (s.canAct) post({ type: "attach", origin: "fireflies-export" }); } }, "Attach a Fireflies export"), " (.txt, .docx, .pdf).");
    return DC.section("Fireflies", { key: "sec:ff", count: meetings.length || null, action: load },
      !mcpOk ? DC.notice("Fireflies MCP: " + (str(f.mcp && f.mcp.detail) || "not signed in") + ". Meetings are listed through your own Claude and Fireflies sign-in.", "warn",
        { icon: "plug", action: { label: "Open Connections", onClick: () => post({ type: "openConnections" }) } }) : null,
      f.status === "error" ? DC.notice(str(f.error) || "Could not list meetings.", "err") : null,
      loading && !meetings.length ? DC.skeleton({ n: 3, label: "Asking Claude for your Fireflies meetings" })
        : meetings.length ? DC.list(meetings.map((m) => meetingRow(m, s)), { label: "Fireflies meetings", key: "list:ff" })
          : f.status === "idle" ? h("p.src-hint", "Load your recent meetings. Claude reads only titles and dates; transcripts stay in Fireflies until intake.")
            : f.status === "ready" ? h("p.src-hint", "No meetings found.") : null,
      f.loadedAt ? h("p.src-hint.src-more", "Listed " + DC.when(f.loadedAt)) : null,
      exportLink);
  }

  // ---------- Wispr Flow ----------
  function wisprSection(s) {
    const w = s.wispr || {};
    const busy = isBusy(s, "wispr");
    const why = !s.canAct ? str(s.reason) : !w.supported ? "Wispr Flow has no app for this platform." : !w.found ? "Wispr Flow's history was not found on this machine." : null;
    const rows = [
      DC.row({
        key: "wf-history", icon: DC.icon("history"), title: "Import from Wispr Flow history",
        meta: w.found ? "Read-only · " + w.found : w.supported ? "Not found" : "Not available on this platform",
        primary: DC.button(busy ? "Reading" : "Import…", () => post({ type: "wisprImport" }),
          { kind: "secondary", size: "sm", loading: busy, disabled: !!why || busy, reason: why || "Reading…" }),
        expanded: () => [
          DC.kv([["How", "You confirm first. The circuit reads a copy of Wispr Flow's local history (never writes to it), you pick the dictations, and they are stored encrypted as one source."],
            ["Looks in", (w.candidates || []).length ? h("span.mono", (w.candidates || []).join("\n")) : "No known location on this platform"]]),
          why && s.canAct ? DC.reasonLine("Import: " + why) : null,
        ],
        hash: [w, busy, s.canAct],
      }),
      DC.row({
        key: "wf-file", icon: DC.icon("file-add"), title: "Attach a Wispr Flow export",
        meta: "Exported dictations (.txt, .md or .docx)",
        primary: DC.button("Attach…", () => post({ type: "attach", origin: "wispr-flow" }),
          { kind: "secondary", size: "sm", disabled: !s.canAct || isBusy(s, "attach"), reason: !s.canAct ? str(s.reason) : "Attaching…" }),
        hash: [s.canAct, isBusy(s, "attach")],
      }),
    ];
    return DC.section("Wispr Flow", { key: "sec:wispr" },
      DC.list(rows, { label: "Wispr Flow", key: "list:wispr" }),
      h("p.src-hint.src-more", "Or dictate straight into the text box above and tick “Dictated with Wispr Flow”."));
  }

  // ---------- watch folder ----------
  function watchSection(s) {
    const w = s.watch || {};
    const busy = isBusy(s, "watch");
    const why = !s.canAct ? str(s.reason) : null;
    const row = DC.row({
      key: "watch", icon: DC.icon(w.active ? "folder-active" : "folder"), title: w.folder ? w.folder : "Watch a folder", mono: !!w.folder,
      meta: w.last ? "Last added " + w.last.title + " · " + DC.when(w.last.at) : w.active ? "New .txt .md .docx .vtt .srt .pdf files become sources" : "Off. The folder must be outside the repo.",
      status: w.active ? { tone: "ok", text: "Watching" } : w.folder ? { tone: "warn", text: "Stopped" } : null,
      primary: w.active
        ? DC.button("Stop", () => post({ type: "watchStop" }), { kind: "secondary", size: "sm" })
        : DC.button(busy ? "Choosing" : "Choose folder", () => post({ type: "watchChoose" }), { kind: "secondary", size: "sm", loading: busy, disabled: !!why || busy, reason: why || "Choosing…" }),
      hash: [w, busy, s.canAct],
    });
    return DC.section("Watch folder", { key: "sec:watch" },
      w.error ? DC.notice(w.error, "warn") : null,
      DC.list([row], { label: "Watch folder", key: "list:watch" }));
  }

  // ---------- the index ----------
  function sourceRow(x, s) {
    const intake = { id: "ai:/circuit-intake", label: "Start intake", persona: "architect", kind: "ai", args: { command: "/circuit-intake", argKind: "source", arg: x.id } };
    const used = (x.usedBy || []).filter(Boolean);
    const ex = ui.excerpts[x.id];
    return DC.row({
      key: "src-" + x.id, icon: originIcon(x.origin || (x.kind === "fireflies" ? "fireflies" : "file")), title: x.title,
      meta: [str(x.originLabel), day(x.date), used.length ? "used by " + used.join(", ") : ""].filter(Boolean).join(" · "),
      primary: used.length ? null : DC.button("Start intake", () => DC.action(intake), { kind: "secondary", size: "sm", icon: "sparkle", disabled: !s.canAct, reason: str(s.reason) }),
      strip: DC.linkStrip(x.links, 1),
      expanded: () => [
        DC.kv([["Id", h("span.mono", x.id)], ["Origin", str(x.originLabel)], ["Added", day(x.date)], ["Used by", used.join(", ")], ["Links", DC.links(x.links)]]),
        ex != null ? h("pre.src-excerpt", ex)
          : s.canAct ? DC.button("Show excerpt", () => post({ type: "excerpt", id: x.id }), { kind: "ghost", size: "sm", icon: "eye" }) : null,
      ],
      hash: [x, s.canAct, ex],
    });
  }
  function sourcesSection(s) {
    const list = (s.sources || []).filter(Boolean);
    return DC.section("Sources", { key: "sec:sources", count: list.length },
      s.sourcesError ? DC.notice(s.sourcesError, "err") : null,
      list.length ? DC.list(list.map((x) => sourceRow(x, s)), { label: "Sources", key: "list:sources" })
        : DC.empty({ icon: "inbox", title: "No sources yet", text: "Add a transcript or notes above; intake starts from a source." }));
  }

  // ---------- page ----------
  function render(s) {
    if (!s || typeof s !== "object") return [DC.header({ title: "Sources" }), DC.skeleton({ n: 4, label: "Loading sources" })];
    const architect = !!(s.identity && (s.identity.personas || []).includes("architect"));
    if (!architect) {
      return [header(s), DC.empty({ icon: "lock", title: "Sources are the Architect's", text: str(s.reason) || "Only the architects team adds and reads transcripts." })];
    }
    return [
      header(s),
      !s.canAct ? DC.notice(str(s.reason), "info", { icon: "lock" }) : null,
      addSection(s),
      firefliesSection(s),
      wisprSection(s),
      watchSection(s),
      sourcesSection(s),
    ];
  }

  DC.onEvent = (m) => {
    if (!m || m.type !== "event") return;
    if (m.kind === "cleared") { ui.text = ""; ui.title = ""; ui.dictated = false; rerender(); return; }
    if (m.kind === "excerpt" && typeof m.id === "string") { ui.excerpts[m.id] = str(m.text); rerender(); return; }
    if (m.kind === "added") { DC.toast(str(m.text), { kind: "ok" }); return; }
    if (m.kind === "info") { DC.toast(str(m.text), { kind: "info" }); return; }
    if (m.kind === "error") { DC.toast(str(m.text), { kind: "err", timeout: 8000 }); }
  };

  DC.onState(render);
})();
