// Delivery Circuit UI kit (plain browser JS, loaded before every page script). Exposes window.DC.
// Pages call DC.onState(render) and render with DC.h(...). Never use innerHTML with data: h() escapes text.
(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };

  /** h("div.card", {onclick}, child, ...) — tag with optional .classes and #id; children: strings, nodes, arrays, null. */
  function h(sel, props, ...children) {
    const m = String(sel).match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i) || [];
    const el = document.createElement(m[1] || "div");
    (m[2] || "").replace(/([.#])([\w-]+)/g, (_, t, v) => { if (t === ".") el.classList.add(v); else el.id = v; return ""; });
    if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : String(c)); };
    children.forEach(add);
    return el;
  }

  const post = (msg) => vscode.postMessage(msg);
  const LINK_LABEL = { github: "GitHub", jira: "Jira", salesforce: "Salesforce", slack: "Slack", confluence: "Confluence", lucid: "Lucid",
    fireflies: "Fireflies", coderabbit: "CodeRabbit", file: "File", report: "Report", url: "Open" };

  const DC = {
    vscode, h, post,
    /** Register the page renderer; called with each {type:"state"} payload. Sends "ready" once. */
    onState(render) {
      window.addEventListener("message", (e) => {
        const m = e.data || {};
        if (m.type === "state") { DC.state = m.data; DC.mount(render(m.data)); }
        else if (DC.onEvent) DC.onEvent(m);
      });
      post({ type: "ready" });
    },
    mount(node) { const app = document.getElementById("app"); app.replaceChildren(node); app.classList.add("fade"); },
    openLink(link) { post({ type: "openLink", link }); },
    action(action) { post({ type: "action", action }); },

    // ---- components ----
    dot(state) { // ok | warn | err | info | (muted)
      return h("span.dot" + (state ? "." + state : ""), { "aria-hidden": "true" });
    },
    badge(text, state) { return h("span.badge" + (state ? "." + state : ""), text); },
    links(list) {
      if (!list || !list.length) return null;
      return h("span.links", list.map((l) => h("a", { href: "#", title: l.target, onclick: (e) => { e.preventDefault(); DC.openLink(l); } },
        l.label || LINK_LABEL[l.kind] || l.kind)));
    },
    button(label, onclick, opts = {}) {
      return h("button.btn" + (opts.kind ? "." + opts.kind : ""), { onclick, disabled: !!opts.disabled, title: opts.title || null }, label);
    },
    actionButtons(actions, allowed = () => true) {
      if (!actions || !actions.length) return null;
      return h("span.row", actions.map((a, i) => DC.button(a.label, () => DC.action(a),
        { kind: i === 0 ? null : "secondary", disabled: !allowed(a), title: allowed(a) ? null : "Not available for your persona" })));
    },
    steps(entries) { // [{label, state}] state: done|active|waiting|blocked|todo|not-started
      return h("span.steps", entries.map((e) => h("span.step." + (e.state || "todo"), { title: e.title || null }, e.label)));
    },
    empty(text) { return h("div.empty", text); },
    notice(text, kind) { return h("div.notice" + (kind ? "." + kind : ""), text); },
    tabs(items, selected, onSelect) { // items: [{id,label,disabled}]
      return h("div.tabs", { role: "tablist" }, items.map((t) => h("button.tab", {
        role: "tab", "aria-selected": String(t.id === selected), disabled: !!t.disabled, title: t.title || null,
        "aria-label": t.title ? `${t.label} (${t.title})` : null,
        onclick: () => onSelect(t.id) }, t.label)));
    },
    table(columns, rows) { // columns: [{key,label,render?}]
      return h("table", h("thead", h("tr", columns.map((c) => h("th", c.label)))),
        h("tbody", rows.map((r) => h("tr", columns.map((c) => h("td", c.render ? c.render(r) : String(r[c.key] ?? "")))))));
    },
    when(iso) {
      if (!iso) return "";
      const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
      if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago";
      if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago";
    },
    stateClass(state) { // map connection/check states to dot classes
      return ({ connected: "ok", success: "ok", passed: "ok", done: "ok", pass: "ok", approved: "ok",
        expiring: "warn", pending: "info", checking: "info", waiting: "info", active: "info", blocked: "warn",
        error: "err", failure: "err", failed: "err", "changes-requested": "err", block: "err" })[state] || "";
    },
  };
  window.DC = DC;
})();
