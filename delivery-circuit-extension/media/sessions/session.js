// Claude session panel (Agent SDK), DESIGN.md §6.7. State: { persona, title, items[], running, model, costUsd, turns,
// mcpIssues[], meta }. The conversation log is the page's one box; tool calls are quiet meta rows under the message
// they belong to (long runs of them fold behind "Show n earlier"). Model text is only ever rendered as text.
// Posts: ready, send {text}, stop, openLink {link}.
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "session.css") }));

  const FOLD = 4;            // tool runs longer than this show only the last FOLD - 1 until unfolded
  const unfolded = {};       // block key -> true (page-local)
  let stick = true;          // follow the newest message
  let seen = 0;              // items rendered while following (drives "Jump to latest")

  const PERSONA_LABEL = { architect: "Architect", developer: "Developer", tester: "Tester" };
  const personaLabel = (p) => PERSONA_LABEL[p] || (p ? String(p) : "");

  // ---------------------------------------------------------------- grouping
  /** Consecutive tool calls attach to the message before them; a run without one gets its own Claude block. */
  function blocks(items) {
    const out = [];
    for (const i of items || []) {
      if (!i || typeof i !== "object") continue;
      if (i.kind === "tool") {
        const last = out[out.length - 1];
        if (last && (last.lead == null || last.lead.kind === "assistant" || last.lead.kind === "user")) last.tools.push(i);
        else out.push({ key: "tools-" + i.id, lead: null, tools: [i] });
      } else out.push({ key: "m-" + i.id, lead: i, tools: [] });
    }
    return out;
  }

  // ---------------------------------------------------------------- pieces
  function toolRow(i) {
    const st = i.status === "error" ? DC.icon("error", { size: 12, cls: "err", label: "Failed" })
      : i.status === "ok" ? DC.icon("check", { size: 12, cls: "ok", label: "Done" })
        : DC.icon("loading", { size: 12, spin: true, cls: "info", label: "Running" });
    const link = i.link && i.link.target ? i.link : null;
    return h("div.ss-tool" + (i.nested ? ".nested" : ""), { "data-key": "t-" + i.id },
      DC.icon(i.nested ? "type-hierarchy-sub" : "arrow-small-right", { size: 12, cls: "ss-tool-ic" }),
      h("span.ss-tool-n.mono", i.tool || "tool"),
      h("span.ss-tool-x.mono", { title: i.text || null }, i.text || ""),
      st,
      link ? h("a.ss-tool-a", { href: "#", title: link.target, onclick: (e) => { e.preventDefault(); DC.openLink(link); } }, link.label || "Open") : null);
  }
  function toolList(b) {
    if (!b.tools.length) return null;
    const open = !!unfolded[b.key];
    const hidden = !open && b.tools.length > FOLD ? b.tools.length - (FOLD - 1) : 0;
    const shown = hidden ? b.tools.slice(hidden) : b.tools;
    const failed = b.tools.filter((t) => t.status === "error").length;
    return h("div.ss-tools", { "data-key": "tools:" + b.key },
      hidden ? h("button.ss-more", {
        type: "button", "aria-expanded": "false",
        onclick: () => { unfolded[b.key] = true; if (DC.state) DC.mount(render(DC.state)); },
      }, DC.icon("chevron-right", { size: 12 }), "Show " + hidden + " earlier tool call" + (hidden === 1 ? "" : "s"),
      failed && b.tools.slice(0, hidden).some((t) => t.status === "error") ? h("span.err", " · includes a failure") : null) : null,
      shown.map(toolRow));
  }
  function text(i) {
    // plain text with preserved line breaks; no HTML from the model is ever rendered
    return h("div.ss-text", i.text || "", i.streaming ? h("span.ss-caret", { "aria-hidden": "true" }) : null);
  }
  function block(b) {
    const i = b.lead;
    let who = "", body;
    if (!i) { who = "Claude"; body = null; }
    else if (i.kind === "user") { who = "You"; body = text(i); }
    else if (i.kind === "assistant") { who = "Claude"; body = text(i); }
    else if (i.kind === "error") body = DC.notice(i.text || "Something went wrong.", "err");
    else body = h("div.ss-system", DC.icon("info", { size: 12 }), h("span", i.text || ""));
    return h("div", { class: "ss-msg" + (i ? " " + i.kind : ""), "data-key": b.key },
      h("div.ss-who", who, i && i.streaming ? h("span.sr-only", " (writing)") : null),
      h("div.ss-body", body, toolList(b)));
  }

  // ---------------------------------------------------------------- composer
  function submit() {
    const ta = document.getElementById("ss-msg");
    const value = ta ? String(ta.value || "").trim() : "";
    if (!value) { if (ta) ta.focus(); DC.announce("Type a message first"); return; }
    ta.value = "";
    stick = true;
    post({ type: "send", text: value });
  }
  function composer(s) {
    const ta = h("textarea#ss-msg", {
      rows: 3, "aria-label": "Message to Claude",
      placeholder: s.running ? "Claude is working. A message sent now is queued for the next turn." : "Message Claude, or a skill command such as /dev-review-plan 42",
      onkeydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } },
    });
    return h("div.ss-composer", { "data-key": "composer" }, ta,
      h("div.ss-bar",
        h("span.meta.ss-meta", s.meta || ""),
        h("span.dc-acts",
          s.running ? DC.button("Stop", () => post({ type: "stop" }), { kind: "ghost", size: "sm", icon: "debug-stop", tip: "Stop this turn" }) : null,
          DC.button("Send", submit, { size: "sm", icon: "send", tip: "Send (Ctrl+Enter)" }))));
  }

  // ---------------------------------------------------------------- page
  function follow() {
    const el = document.getElementById("ss-log");
    if (!el) return;
    if (stick) el.scrollTop = el.scrollHeight;
    const jump = document.getElementById("ss-jump");
    if (jump) jump.hidden = stick || (DC.state && (DC.state.items || []).length <= seen);
    if (stick && DC.state) seen = (DC.state.items || []).length;
  }
  function render(s) {
    if (!s) return DC.skeleton({ n: 3, label: "Starting the session" });
    const issues = (s.mcpIssues || []).filter((m) => m && m.name);
    const bs = blocks(s.items);
    const log = h("div.dc-box.ss-log#ss-log", {
      role: "log", "aria-live": "off", "aria-label": "Conversation", tabindex: "0", "data-key": "log", "data-scroll": "ss-log",
      onscroll: (e) => {
        const el = e.currentTarget;
        stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        if (stick) { seen = (DC.state && DC.state.items || []).length; const j = document.getElementById("ss-jump"); if (j) j.hidden = true; }
      },
    }, bs.length ? bs.map(block)
      : DC.empty({ icon: "comment-discussion", title: "No messages yet", text: "Type a prompt or a skill command such as /dev-review-plan 42." }));
    const jump = DC.button("Jump to latest", () => { stick = true; follow(); }, { kind: "secondary", size: "sm", icon: "arrow-down", id: "ss-jump", cls: "ss-jump" });
    jump.hidden = true;
    requestAnimationFrame(follow);
    return h("div.ss-page", { "data-key": "page" },
      DC.header({
        title: s.title || "Claude",
        sub: "Runs in this repository as the " + personaLabel(s.persona) + " agent, with its skills, settings and the circuit guard.",
        persona: s.persona || null,
        actions: s.running ? DC.status("running", "running") : DC.status("muted", "idle"),
      }),
      issues.length ? DC.notice("Not connected: " + issues.map((m) => m.name + (m.status ? " (" + m.status + ")" : "")).join(", ") +
        ". Sign in once with /mcp in a terminal session (the panel cannot run the OAuth sign-in).", "warn") : null,
      h("div.ss-logwrap", { "data-key": "logwrap" }, log, jump),
      composer(s));
  }

  DC.mount(render(null));
  DC.onState((s) => {
    const r = render(s);
    // a new message from you always brings the log back to the bottom
    const items = (s && s.items) || [];
    if (items.length && items[items.length - 1].kind === "user") stick = true;
    return r;
  });
})();
