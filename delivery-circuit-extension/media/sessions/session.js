// Claude session panel (Agent SDK). State: { persona, title, items[], running, model, costUsd, turns, mcpIssues[] }.
// Posts: ready, send {text}, stop, openLink {link}.
(function () {
  const { h } = DC;
  let draft = "";
  let stickToBottom = true;

  function toolRow(i) {
    const state = i.status === "error" ? "err" : i.status === "ok" ? "ok" : "info";
    return h("div.item", { style: { padding: "4px 12px", marginLeft: i.nested ? "16px" : "0" } },
      h("div.row", { style: { flexWrap: "nowrap" } },
        DC.dot(state),
        h("span.mono.small", { style: { flex: "none" } }, i.tool || "tool"),
        h("span.mono.small.muted", { title: i.text, style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0", flex: "1" } }, i.text || ""),
        i.link ? DC.links([i.link]) : null));
  }

  function textBlock(i) {
    // Plain text with preserved line breaks; no HTML from the model is ever rendered.
    return h("div", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }, i.text);
  }

  function message(i) {
    if (i.kind === "tool") return toolRow(i);
    if (i.kind === "user") {
      return h("div.item", h("div.small.muted", "You"), textBlock(i));
    }
    if (i.kind === "assistant") {
      return h("div.item", h("div.small.muted", "Claude" + (i.streaming ? " · writing" : "")), textBlock(i));
    }
    if (i.kind === "error") return h("div.item", DC.notice(i.text, "err"));
    return h("div.item.small.muted", i.text);
  }

  function footer(s) {
    const parts = [];
    if (s.model) parts.push(s.model);
    parts.push(s.turns + (s.turns === 1 ? " turn" : " turns"));
    parts.push("$" + Number(s.costUsd || 0).toFixed(4));
    return h("div.spread.small.muted", { style: { marginTop: "8px" } },
      h("span", parts.join(" · ")),
      h("span", s.running ? "Running" : "Idle"));
  }

  function composer(s) {
    const ta = h("textarea#msg", {
      rows: 3, placeholder: s.running ? "Claude is working. A message sent now is queued for the next turn." : "Message Claude (Ctrl+Enter to send)",
      "aria-label": "Message", style: { width: "100%", resize: "vertical" },
      oninput: (e) => { draft = e.target.value; },
      onkeydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } },
    });
    ta.value = draft;
    function submit() {
      const text = (draft || "").trim();
      if (!text) return;
      draft = ""; stickToBottom = true;
      DC.post({ type: "send", text });
    }
    return h("div.stack", { style: { marginTop: "12px" } }, ta,
      h("div.row",
        DC.button("Send", submit),
        s.running ? DC.button("Stop", () => DC.post({ type: "stop" }), { kind: "secondary" }) : null));
  }

  function render(s) {
    const active = document.activeElement;
    const hadFocus = !!active && active.id === "msg";
    const caret = hadFocus ? active.selectionStart : 0;
    const header = h("div.header",
      h("div", h("h1", s.title || "Claude"), h("div.sub", "Runs in this repository with the " + s.persona + " agent, its skills, settings and the circuit guard.")),
      h("span.row", DC.dot(s.running ? "info" : ""), DC.badge(s.persona, "info")));

    const issues = (s.mcpIssues || []).length
      ? DC.notice("Not connected: " + s.mcpIssues.map((m) => m.name + " (" + m.status + ")").join(", ") +
          ". Sign in once with /mcp in a terminal session or `claude mcp login <name>`.", "warn")
      : null;

    const list = (s.items || []).length
      ? h("div.list#log", { style: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }, s.items.map(message))
      : DC.empty("No messages yet. Type a prompt or a skill command such as /dev-review-plan 42.");

    const view = h("div", header, issues, list, footer(s), composer(s));
    setTimeout(() => {
      const el = document.getElementById("log");
      if (el && stickToBottom) el.scrollTop = el.scrollHeight;
      const ta = document.getElementById("msg");
      if (ta && hadFocus) { ta.focus(); ta.setSelectionRange(caret, caret); }
      if (el) el.onscroll = () => { stickToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24; };
    }, 0);
    return view;
  }

  DC.onState(render);
})();
