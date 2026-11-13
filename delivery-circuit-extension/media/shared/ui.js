// Delivery Circuit UI kit, design v2 "Quiet Circuit" (design/DESIGN.md). Plain browser JS loaded before every page
// script (after media/shared/brands.js). Exposes window.DC. Pages call DC.onState(render) and build with DC.h(...) and
// the components below. Never use innerHTML with data: h() only creates text nodes, and ignores null/undefined/false.
//
// Rows show title · one status · age · one primary action; links and secondary actions live in the hover strip, the
// "…" menu and the expanded panel. Expanded state is page-local UI state (DC.ui.open[key]) so re-renders keep it.
// Event handlers: h() keeps on* handlers in el.__dcOn and DC.mount moves them onto the live nodes when it reconciles,
// so kit handlers find their elements from the event (currentTarget), never from closures over built nodes.
(function (root) {
  "use strict";

  // =====================================================================================================
  // Pure core (no DOM). Also loadable by unit tests through `module.exports`.
  // =====================================================================================================
  const ROLE = {
    architect: { label: "Architect", icon: "symbol-structure" },
    developer: { label: "Developer", icon: "code" },
    tester: { label: "QA", icon: "beaker" },
    lead: { label: "Lead", icon: "organization" },
  };
  /** Concept icons (codicons). DC.iconFor(group, value). */
  const ICONS = {
    role: { architect: "symbol-structure", developer: "code", tester: "beaker", lead: "organization" },
    notice: { info: "info", warn: "warning", err: "error", ok: "pass" },
  };

  /** Status word -> tone: ok | warn | err | info | "" (muted). */
  const TONE = {
    connected: "ok", success: "ok", passed: "ok", done: "ok", pass: "ok", approved: "ok", ok: "ok", present: "ok", merged: "ok", set: "ok", complete: "ok",
    expiring: "warn", warn: "warn", warning: "warn", partial: "warn", blocked: "warn",
    pending: "info", checking: "info", waiting: "info", active: "info", running: "info", info: "info",
    failure: "err", failed: "err", block: "err", err: "err", error: "err", "changes-requested": "err", expired: "err",
  };
  function stateClass(state) { return TONE[String(state == null ? "" : state).toLowerCase()] || ""; }
  const WORD = { "changes-requested": "changes requested", "not-started": "not started", "not-run": "not run", success: "passed", failure: "failed" };
  function word(s) { return s == null ? "" : WORD[s] || String(s); }

  /** djb2 of JSON.stringify -> short base-36 string (data-hash). */
  function hash(obj) {
    let s;
    try { s = typeof obj === "string" ? obj : JSON.stringify(obj === undefined ? null : obj); } catch { s = String(obj); }
    let x = 5381;
    for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
    return (x >>> 0).toString(36);
  }
  function iconFor(group, value) { const g = ICONS[group]; return (g && value != null && g[value]) || null; }

  /** Keyed reconcile plan. ops: keep (same hash) | update (changed: patch + flash) | patch (no hash, or open row) | enter. */
  function planKeyed(old, next, cap = 4) {
    const prev = new Map();
    for (const o of old) if (o.key != null && !prev.has(o.key)) prev.set(o.key, o);
    let n = 0;
    const seen = new Set();
    const ops = next.map((x) => {
      const o = x.key != null ? prev.get(x.key) : undefined;
      if (o && !seen.has(x.key)) {
        seen.add(x.key);
        if (o.dirty) return { key: x.key, op: "update" };
        if (o.hash == null && x.hash == null) return { key: x.key, op: "patch" };
        if (o.hash === x.hash) return { key: x.key, op: o.open ? "patch" : "keep" };
        return { key: x.key, op: "update" };
      }
      return { key: x.key, op: "enter", i: Math.min(n++, cap) };
    });
    return { ops, removed: [...prev.keys()].filter((k) => !seen.has(k)) };
  }
  function ageDays(iso, now = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN;
    return isNaN(t) ? 0 : (now - t) / 86400000;
  }
  /** "5 h", "1 d", "12 min", "now" from an ISO date; "" when missing/invalid. */
  function ago(iso, now = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN;
    if (isNaN(t)) return "";
    const s = Math.max(0, (now - t) / 1000);
    if (s < 90) return "now";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " d";
  }

  const core = { ROLE, ICONS, hash, stateClass, word, iconFor, planKeyed, ageDays, ago };
  if (typeof module === "object" && module && module.exports && typeof document === "undefined") { module.exports = core; return; }

  // =====================================================================================================
  // DOM basics
  // =====================================================================================================
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };
  const SVGNS = "http://www.w3.org/2000/svg";
  const post = (msg) => vscode.postMessage(msg);
  const reducedMotion = () => (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) || document.body.classList.contains("dc-reduced-motion");
  const isNode = (x) => typeof Node !== "undefined" && x instanceof Node;
  const str = (x) => (x == null || x === false || x === true ? "" : String(x));
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : "");
  const roleLabel = (r) => (r && ROLE[r] ? ROLE[r].label : cap(r || ""));
  let uid = 0;
  const nextId = (p) => "dc-" + p + "-" + (++uid);

  function dcDispatch(e) { const f = this.__dcOn && this.__dcOn[e.type]; if (f) return f.call(this, e); }
  function setHandler(el, type, fn) {
    if (!el.__dcOn) el.__dcOn = {};
    if (!(type in el.__dcOn)) el.addEventListener(type, dcDispatch);
    el.__dcOn[type] = fn;
  }
  /** h("div.cls#id", {onclick, class, style, ...attrs}, ...children). Children: strings, numbers, nodes, arrays;
   *  null, undefined, false and true render nothing. Text is always a text node (escaped). */
  function h(sel, props, ...children) {
    const m = String(sel).match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i) || [];
    const el = document.createElement(m[1] || "div");
    (m[2] || "").replace(/([.#])([\w-]+)/g, (_, t, v) => { if (t === ".") el.classList.add(v); else el.id = v; return ""; });
    if (props != null && (typeof props !== "object" || isNode(props) || Array.isArray(props))) { children.unshift(props); props = null; }
    applyProps(el, props);
    const add = (c) => {
      if (c == null || c === false || c === true) return;
      if (Array.isArray(c)) c.forEach(add);
      else if (isNode(c)) el.append(c);
      else if (typeof c === "object") return; // never stringify objects ("[object Object]")
      else el.append(String(c));
    };
    children.forEach(add);
    return el;
  }
  function applyProps(el, props) {
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") setHandler(el, k.slice(2).toLowerCase(), v);
      else if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (k === "style" && typeof v === "object") { // CSSOM, allowed by the webview CSP (no inline style attributes)
        for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith("--")) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv; }
      } else if (k === "style") continue;
      else if (typeof v === "object") continue;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, String(v));
    children.flat().forEach((c) => c && el.append(c));
    return el;
  }
  function hostEl(id, attrs) {
    let el = document.getElementById(id);
    if (!el) { el = h("div#" + id, attrs); document.body.append(el); }
    return el;
  }
  let announceTimer;
  /** DC.announce(text): polite screen-reader message through #dc-live. */
  function announce(text) {
    const s = str(text);
    if (!s) return;
    const el = hostEl("dc-live", { role: "status", "aria-live": "polite", class: "sr-only" });
    el.textContent = "";
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { el.textContent = s; }, 30);
  }
  /** DC.tip(el, text): tooltip via data-tip; mirrored to aria-label when the element has no text of its own. */
  function tip(el, text) {
    if (!el || !text) return el;
    el.setAttribute("data-tip", String(text));
    if (!el.getAttribute("aria-label") && !str(el.textContent).trim()) el.setAttribute("aria-label", String(text));
    return el;
  }

  // ---------- page-local UI state (open rows), kept across re-renders and webview reloads ----------
  const saved = (() => { try { return (vscode.getState && vscode.getState()) || {}; } catch { return {}; } })();
  const ui = { open: Object.assign({}, saved.dcOpen || {}) };
  function saveUi() {
    try { const s = Object.assign({}, (vscode.getState && vscode.getState()) || {}, { dcOpen: ui.open }); if (vscode.setState) vscode.setState(s); } catch { /* preview */ }
  }

  // =====================================================================================================
  // Keyed reconcile (DESIGN.md §7)
  // =====================================================================================================
  const keyOf = (n) => (n && n.nodeType === 1 ? n.getAttribute("data-key") : null);
  const isTransient = (n) => n && n.nodeType === 1 && n.hasAttribute("data-dc-transient");
  const KEEP_CLASSES = ["dc-enter", "dc-changed"];
  const KIT_PROPS = ["__dcPatch", "__dcExpand", "__dcMenu"];
  let firstMount = true;

  function syncAttributes(old, nw) {
    const tag = old.nodeName;
    const hadChecked = old.hasAttribute("checked"), hadSelected = old.hasAttribute("selected");
    const isInk = old.hasAttribute("data-dc-ink");
    for (const a of [...old.attributes]) {
      if (nw.hasAttribute(a.name)) continue;
      if (a.name === "open" && tag === "DETAILS") continue;
      if (a.name === "style" && isInk) continue;
      if (a.name === "tabindex" && old.classList.contains("dc-row")) continue;
      old.removeAttribute(a.name);
    }
    for (const a of [...nw.attributes]) {
      if (a.name === "open" && tag === "DETAILS") continue;
      if (a.name === "style") { if (!isInk && old.style.cssText !== nw.style.cssText) old.style.cssText = nw.style.cssText; continue; }
      if (a.name === "tabindex" && old.classList.contains("dc-row")) continue; // roving tabindex is live state
      if (a.name === "class") {
        const keep = KEEP_CLASSES.filter((c) => old.classList.contains(c));
        if (old.getAttribute("class") !== a.value) { old.setAttribute("class", a.value); keep.forEach((c) => old.classList.add(c)); }
        continue;
      }
      if (old.getAttribute(a.name) === a.value) continue;
      old.setAttribute(a.name, a.value);
      if (a.name === "value" && "value" in old) old.value = a.value;
    }
    if (tag === "INPUT" && nw.hasAttribute("checked") !== hadChecked) old.checked = nw.hasAttribute("checked");
    if (tag === "OPTION" && nw.hasAttribute("selected") !== hadSelected) old.selected = nw.hasAttribute("selected");
  }
  function moveHandlers(old, nw) {
    const on = nw.__dcOn;
    if (old.__dcOn) for (const t of Object.keys(old.__dcOn)) if (!on || !(t in on)) old.__dcOn[t] = null;
    if (on) for (const t of Object.keys(on)) setHandler(old, t, on[t]);
    for (const p of KIT_PROPS) if (nw[p]) old[p] = nw[p];
  }
  function transplant(old, nw) {
    if (old.nodeType !== 1 || nw.nodeType !== 1 || old.nodeName !== nw.nodeName) return;
    moveHandlers(old, nw);
    const a = [...old.children].filter((c) => !isTransient(c)), b = [...nw.children];
    for (let i = 0; i < Math.min(a.length, b.length); i++) transplant(a[i], b[i]);
  }
  function mark(el, cls, i) {
    if (cls === "dc-enter" && reducedMotion()) return;
    if (el.classList.contains(cls)) { el.classList.remove(cls); void el.offsetWidth; }
    if (i != null) el.style.setProperty("animation-delay", (i * 30) + "ms");
    el.classList.add(cls);
    const ms = cls === "dc-changed" ? (reducedMotion() ? 2000 : 1000) : 400;
    clearTimeout(el["__dcT_" + cls]);
    el["__dcT_" + cls] = setTimeout(() => { el.classList.remove(cls); if (cls === "dc-enter") el.style.removeProperty("animation-delay"); }, ms);
  }
  function patchNode(old, nw) {
    if (old.nodeType !== nw.nodeType || old.nodeName !== nw.nodeName || keyOf(old) !== keyOf(nw)) return nw;
    if (old.nodeType === 3 || old.nodeType === 8) { if (old.data !== nw.data) old.data = nw.data; return old; }
    if (old.nodeType !== 1) return nw;
    if (old.namespaceURI === SVGNS) { // small SVGs (logos, rings): attributes and children
      syncAttributes(old, nw);
      if (old.innerHTML !== nw.innerHTML) old.replaceChildren(...nw.childNodes);
      return old;
    }
    if (nw.__dcPatch && old.__dcPatch && nw.__dcPatch(old, nw)) { moveHandlers(old, nw); return old; }
    syncAttributes(old, nw);
    moveHandlers(old, nw);
    if (old.nodeName === "TEXTAREA") {
      if (old.defaultValue !== nw.defaultValue) { old.defaultValue = nw.defaultValue; old.value = nw.defaultValue; }
      return old;
    }
    patchChildren(old, [...nw.childNodes]);
    return old;
  }
  function patchChildren(parent, newKids) {
    const oldKids = [...parent.childNodes].filter((n) => !isTransient(n));
    const keyed = newKids.some((n) => keyOf(n) != null);
    const result = [];
    if (keyed) {
      const byKey = new Map();
      const unkeyed = [];
      for (const o of oldKids) { const k = keyOf(o); if (k != null && !byKey.has(k)) byKey.set(k, o); else if (k == null) unkeyed.push(o); }
      const plan = planKeyed(
        [...byKey.entries()].map(([key, o]) => ({ key, hash: o.getAttribute("data-hash"), dirty: o.hasAttribute("data-dc-optimistic"), open: o.classList.contains("is-open") })),
        newKids.map((n) => ({ key: keyOf(n), hash: n.nodeType === 1 ? n.getAttribute("data-hash") : null })));
      let u = 0;
      newKids.forEach((nk, idx) => {
        const k = keyOf(nk);
        if (k == null) {
          while (u < unkeyed.length && unkeyed[u].nodeName !== nk.nodeName) u++;
          result.push(u < unkeyed.length ? patchNode(unkeyed[u++], nk) : nk);
          return;
        }
        const op = plan.ops[idx];
        const o = byKey.get(k);
        if (op.op === "keep") { transplant(o, nk); result.push(o); return; }
        if (op.op === "patch" && o) { result.push(patchNode(o, nk)); return; }
        if (op.op === "update" && o) {
          const optimistic = o.hasAttribute("data-dc-optimistic");
          const said = o.getAttribute("data-announce");
          const live = patchNode(o, nk);
          live.removeAttribute("data-dc-optimistic");
          mark(live, "dc-changed");
          const say = nk.getAttribute("data-announce");
          const st = nk.getAttribute("data-state");
          if (say && (optimistic || say !== said) && st !== "checking" && st !== "running") announce(say);
          result.push(live);
          return;
        }
        if (!firstMount) mark(nk, "dc-enter", op.i);
        result.push(nk);
      });
    } else {
      newKids.forEach((nk, i) => result.push(i < oldKids.length ? patchNode(oldKids[i], nk) : nk));
    }
    const keep = new Set(result);
    for (const o of oldKids) if (!keep.has(o)) o.remove();
    let prev = null;
    for (const live of result) {
      let want = prev ? prev.nextSibling : parent.firstChild;
      while (want && isTransient(want)) want = want.nextSibling;
      if (want !== live) parent.insertBefore(live, want);
      prev = live;
    }
  }
  const FOCUSABLE = "button, input, select, textarea, a, [tabindex]";
  function captureFocus(app) {
    const a = document.activeElement;
    if (!a || a === document.body || !app.contains(a)) return null;
    const keyed = a.closest("[data-key]");
    const scope = keyed || app;
    return { el: a, id: a.id, key: keyed ? keyed.getAttribute("data-key") : null, tag: a.nodeName, index: [...scope.querySelectorAll(FOCUSABLE)].indexOf(a),
      sel: "selectionStart" in a ? (() => { try { return [a.selectionStart, a.selectionEnd]; } catch { return null; } })() : null };
  }
  function restoreFocus(app, f) {
    if (!f || (f.el.isConnected && document.activeElement === f.el)) return;
    let t = f.el.isConnected ? f.el : null;
    if (!t && f.id) t = document.getElementById(f.id);
    if (!t && f.key != null) {
      const scope = [...app.querySelectorAll("[data-key]")].find((e) => e.getAttribute("data-key") === f.key);
      if (scope) {
        const list = [...scope.querySelectorAll(FOCUSABLE)];
        t = list[f.index] && list[f.index].nodeName === f.tag ? list[f.index] : list.find((e) => e.nodeName === f.tag) || null;
      }
    }
    if (!t || t.disabled) t = app;
    try { t.focus({ preventScroll: true }); } catch { /* not focusable */ }
    if (f.sel && t !== app && "setSelectionRange" in t) { try { t.setSelectionRange(f.sel[0], f.sel[1]); } catch { /* no selection */ } }
  }
  function captureScroll(app) {
    const list = [[app, app.scrollTop]];
    app.querySelectorAll("[data-scroll]").forEach((el) => list.push([el.getAttribute("data-scroll") || "", el.scrollTop, el]));
    return { x: window.scrollX, y: window.scrollY, list };
  }
  function restoreScroll(app, s) {
    app.scrollTop = s.list[0][1];
    for (const [id, top, el] of s.list.slice(1)) {
      const live = el.isConnected ? el : [...app.querySelectorAll("[data-scroll]")].find((e) => (e.getAttribute("data-scroll") || "") === id);
      if (live && live.scrollTop !== top && !live.hasAttribute("data-dc-follow")) live.scrollTop = top;
    }
    if (window.scrollX !== s.x || window.scrollY !== s.y) window.scrollTo(s.x, s.y);
  }
  /** DC.mount(node | nodes): reconcile into #app by data-key/data-hash; scroll, focus and open rows survive. */
  function mount(node) {
    const app = document.getElementById("app");
    if (!app) return;
    if (!app.hasAttribute("tabindex")) app.setAttribute("tabindex", "-1");
    const nodes = node == null ? [] : (Array.isArray(node) ? node.flat(Infinity) : [node]).filter((n) => isNode(n));
    if (firstMount || !app.hasAttribute("data-dc-mounted")) {
      app.replaceChildren(...nodes);
      app.setAttribute("data-dc-mounted", "");
      firstMount = false;
      afterMount(app);
      return;
    }
    const focus = captureFocus(app);
    const scroll = captureScroll(app);
    patchChildren(app, nodes);
    restoreScroll(app, scroll);
    restoreFocus(app, focus);
    afterMount(app);
  }
  function afterMount(scope) {
    placeInks(scope, true);
    requestAnimationFrame(() => placeInks(scope, true));
    scope.querySelectorAll("pre.dc-log[data-dc-follow]").forEach((l) => { l.scrollTop = l.scrollHeight; });
    roving(scope);
  }
  /** Lists use a roving tabindex: one row per list is in the tab order (the last one focused, else the first). */
  const lastRow = new Map();
  function roving(scope) {
    (scope || document).querySelectorAll(".dc-list").forEach((list, i) => {
      const rows = [...list.querySelectorAll(":scope > .dc-item > .dc-row[data-roving]")];
      if (!rows.length) return;
      const id = list.getAttribute("data-key") || list.getAttribute("aria-label") || "list" + i;
      const want = lastRow.get(id);
      const pick = rows.find((r) => r.parentElement.getAttribute("data-key") === want) || rows[0];
      rows.forEach((r) => r.setAttribute("tabindex", r === pick ? "0" : "-1"));
    });
  }
  function rowFocus(e) {
    const row = e.currentTarget;
    const list = row.closest(".dc-list");
    if (!list) return;
    const all = [...list.querySelectorAll(":scope > .dc-item > .dc-row[data-roving]")];
    all.forEach((r) => r.setAttribute("tabindex", r === row ? "0" : "-1"));
    const id = list.getAttribute("data-key") || list.getAttribute("aria-label") || "list" + [...document.querySelectorAll(".dc-list")].indexOf(list);
    lastRow.set(id, row.parentElement.getAttribute("data-key"));
  }

  // ---------- ink (tabs) ----------
  function placeInk(container, animate) {
    const ink = container.querySelector(":scope > [data-dc-ink]");
    const sel = container.querySelector(":scope > [aria-selected='true']");
    if (!ink) return;
    if (!sel || !sel.offsetWidth) { ink.style.opacity = "0"; return; }
    const placed = ink.hasAttribute("data-placed");
    if (!placed || !animate) ink.style.transition = "none";
    ink.style.opacity = "1";
    ink.style.left = sel.offsetLeft + "px";
    ink.style.width = sel.offsetWidth + "px";
    if (!placed || !animate) { void ink.offsetWidth; ink.style.transition = ""; }
    ink.setAttribute("data-placed", "");
  }
  function placeInks(scope, animate) { (scope || document).querySelectorAll(".dc-tabs").forEach((c) => placeInk(c, animate)); }
  window.addEventListener("resize", () => placeInks(document, false), { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeInks(document, false));

  // =====================================================================================================
  // Icons and brand logos (DESIGN.md §3)
  // =====================================================================================================
  const SIZE = { 12: "sm", sm: "sm", 16: "", md: "", 20: "lg", lg: "lg", 24: "xl", xl: "xl" };
  /** DC.icon(name, {size: 16|12|20|24|"sm"|"lg", spin, label, cls, title}) -> <i class="codicon codicon-name">. */
  function icon(name, o = {}) {
    if (!name) return null;
    const spin = o.spin != null ? !!o.spin : name === "loading";
    const sz = SIZE[o.size == null ? 16 : o.size] || "";
    return h("i", {
      class: ["codicon", "codicon-" + name, "dc-ic", sz, spin ? "dc-spin" : "", o.cls || ""].filter(Boolean).join(" "),
      "aria-hidden": o.label ? null : "true", role: o.label ? "img" : null, "aria-label": o.label || null, title: o.title || null,
    });
  }
  const BRAND_LABEL = { github: "GitHub", jira: "Jira", confluence: "Confluence", atlassian: "Atlassian", lucid: "Lucid", coderabbit: "CodeRabbit",
    claude: "Claude", salesforce: "Salesforce", fireflies: "Fireflies" };
  /** Apps missing from simple-icons use neutral codicons. */
  const BRAND_FALLBACK = { salesforce: "cloud", fireflies: "mic", github: "github", jira: "issues", confluence: "book",
    atlassian: "organization", lucid: "graph", coderabbit: "hubot", claude: "sparkle" };
  /** Connection ids and DeepLink kinds -> brand id. */
  const BRAND_OF = { "sf-dev": "salesforce", "sf-qa": "salesforce" };
  const OTHER_ICON = { url: "link-external" };
  function brandId(id) { return BRAND_OF[id] || id; }
  function brandLabel(id) { const b = brandId(id); return BRAND_LABEL[b] || (id ? cap(String(id).replace(/[-_]/g, " ")) : ""); }
  /** DC.brand(id, {size: 16|12|20, label}): monochrome app logo from window.DC_BRANDS (simple-icons, CC0); Salesforce,
   *  Fireflies and any missing logo fall back to a codicon. Also takes connection ids (sf-dev, sf-qa) and DeepLink kinds. */
  function brand(id, o = {}) {
    const b = brandId(id);
    const data = root.DC_BRANDS && root.DC_BRANDS[b];
    const sz = SIZE[o.size == null ? 16 : o.size] || "";
    if (data && data.path) {
      return svg("svg", {
        class: "dc-brand" + (sz ? " " + sz : "") + (o.cls ? " " + o.cls : ""), viewBox: "0 0 24 24", focusable: "false",
        role: o.label ? "img" : null, "aria-label": o.label || null, "aria-hidden": o.label ? null : "true",
      }, svg("path", { d: data.path }));
    }
    return icon(OTHER_ICON[id] || BRAND_FALLBACK[b] || OTHER_ICON[b] || "link-external", { size: o.size, label: o.label, cls: o.cls });
  }

  // =====================================================================================================
  // Status, chips, small text (DESIGN.md §2.3, §5.16)
  // =====================================================================================================
  const toneCls = (t) => (t && t !== "muted" ? t : "");
  /** DC.dot(tone, {pulse, hollow}): 6 px status dot (ok | warn | err | info | muted). */
  function dot(tone, o = {}) {
    const t = toneCls(tone);
    return h("span", { class: ["dc-dot", "dot", t, o.pulse ? "pulse" : "", o.hollow ? "hollow" : ""].filter(Boolean).join(" "), "aria-hidden": "true" });
  }
  /** DC.status(tone, text, {age, since, late, extra, spin, pulse}): dot + word (+ "· age"); spin shows the loading icon. */
  function status(tone, text, o = {}) {
    const t = toneCls(tone);
    const spin = o.spin || tone === "running" || tone === "checking";
    return h("span.dc-status", { "data-tone": t || "muted" },
      spin ? icon("loading", { size: 12, cls: "info" }) : dot(t, { pulse: o.pulse }),
      str(text) ? h("span.dc-status-t" + (t ? "." + (tone === "running" || tone === "checking" ? "info" : t) : ""), str(text)) : null,
      o.extra ? h("span.dc-status-x", " · " + str(o.extra)) : null,
      str(o.age) ? h("span.dc-age" + (o.late ? ".late" : ""), { title: o.since || null }, "· " + str(o.age)) : null);
  }
  /** DC.chip(text, {tone: primary|secondary, icon, mono, tip, title}). Neutral by default; no status chips. */
  function chip(text, o = {}) {
    const tone = o.tone === "primary" || o.tone === "secondary" ? o.tone : "";
    const el = h("span", { class: ["dc-chip", tone, o.mono ? "mono" : "", o.cls || ""].filter(Boolean).join(" "), title: o.title || null },
      o.icon ? icon(o.icon, { size: 12 }) : null, str(text) ? h("span", str(text)) : null);
    if (o.tip) tip(el, o.tip);
    return el;
  }
  /** DC.when(iso): "5 h ago" (first-kit helper). DC.ago(iso): "5 h". */
  function when(iso) { const a = ago(iso); return !a ? "" : a === "now" ? "just now" : a + " ago"; }

  // =====================================================================================================
  // Buttons and the overflow menu (DESIGN.md §5.10, §4.3)
  // =====================================================================================================
  function guardClick(fn) {
    return function (e) {
      const b = e.currentTarget;
      if (b.getAttribute("aria-disabled") === "true" || b.getAttribute("aria-busy") === "true") { e.preventDefault(); e.stopPropagation(); return; }
      if (fn) fn.call(this, e);
    };
  }
  /** DC.button(label, onClick, {kind: primary|secondary|ghost|danger|link, icon, brand, iconOnly, loading, disabled,
   *  reason, size: "sm", tip, title, id, type, cls}). A disabled button stays focusable (aria-disabled) and carries
   *  its reason as tooltip + aria-describedby; nothing is rendered inline. */
  function button(label, onClick, opts = {}) {
    const kind = opts.kind || "primary";
    const text = str(label);
    const reason = opts.disabled ? str(opts.reason || opts.title) : "";
    const tipText = opts.disabled && reason ? (opts.iconOnly ? text + ": " + reason : reason) : opts.tip || (opts.iconOnly ? text : null);
    const rid = reason ? nextId("why") : null;
    const b = h("button", {
      class: ["btn", kind, opts.size === "sm" ? "sm" : "", opts.iconOnly ? "icon" : "", opts.cls || ""].filter(Boolean).join(" "),
      type: opts.type || "button", id: opts.id || null, onclick: guardClick(onClick), "aria-disabled": opts.disabled ? "true" : null,
      "aria-label": opts.iconOnly ? text : null, "aria-describedby": rid, "data-tip": tipText || null,
      title: !opts.disabled && opts.title && !opts.tip ? opts.title : null,
    }, opts.icon ? icon(opts.icon) : opts.brand ? brand(opts.brand) : null,
    opts.iconOnly ? null : h("span.dc-btn-t", text),
    opts.chevron ? icon("chevron-down", { size: 12 }) : null,
    rid ? h("span.sr-only", { id: rid, "aria-hidden": "true" }, reason) : null);
    if (opts.loading) setLoading(b, true);
    return b;
  }
  /** DC.setLoading(button, on): loading icon replaces the icon, label stays, width locked, aria-busy. */
  function setLoading(b, on) {
    if (!b) return;
    const cur = b.querySelector(":scope > .dc-busy");
    if (on) {
      if (cur) return;
      if (b.offsetWidth) b.style.minWidth = b.offsetWidth + "px";
      b.setAttribute("aria-busy", "true");
      const sp = icon("loading", { spin: true, cls: "dc-busy" });
      const ic = b.querySelector(":scope > .dc-ic, :scope > .dc-brand");
      if (ic) { ic.setAttribute("hidden", ""); ic.before(sp); } else b.prepend(sp);
    } else {
      if (cur) cur.remove();
      const ic = b.querySelector(":scope > [hidden]");
      if (ic) ic.removeAttribute("hidden");
      b.removeAttribute("aria-busy");
      b.style.minWidth = "";
    }
  }

  let openMenu = null;
  function closeMenu(refocus) {
    if (!openMenu) return;
    const { host, pop } = openMenu;
    openMenu = null;
    pop.remove();
    const btn = host.querySelector(":scope > button");
    if (btn) { btn.setAttribute("aria-expanded", "false"); if (refocus) btn.focus(); }
  }
  document.addEventListener("click", (e) => { if (openMenu && !openMenu.host.contains(e.target)) closeMenu(false); }, true);
  window.addEventListener("blur", () => closeMenu(false));
  function menuItems(pop) { return [...pop.querySelectorAll(".dc-menu-item")]; }
  function openMenuFor(host, focusLast) {
    if (openMenu && openMenu.host === host) { closeMenu(true); return; }
    closeMenu(false);
    const items = host.__dcMenu || [];
    const btn = host.querySelector(":scope > button");
    const pop = h("div.dc-menu", { role: "menu", "data-dc-transient": "", "aria-label": btn ? btn.getAttribute("aria-label") || str(btn.textContent) : null },
      items.filter((it) => it != null && it !== false).map((it) => {
        if (it === "-") return h("hr.dc-menu-sep", { role: "separator" });
        if (typeof it === "string") return h("div.dc-menu-label", it);
        const dis = !!it.disabled;
        const why = dis ? str(it.reason) : "";
        return h("button", {
          type: "button", class: "dc-menu-item" + (it.danger ? " danger" : ""), role: it.checked != null ? "menuitemradio" : "menuitem",
          "aria-checked": it.checked != null ? String(!!it.checked) : null, tabindex: "-1", "aria-disabled": dis ? "true" : null,
          title: why || it.title || null,
          onclick: (e) => {
            e.stopPropagation();
            if (dis) return;
            closeMenu(true);
            if (it.onClick) it.onClick(e);
            else if (it.link) DC.openLink(it.link);
          },
        }, it.checked != null ? icon(it.checked ? "check" : "blank", { size: 16, cls: "dc-menu-check" })
          : it.brand ? brand(it.brand) : it.icon ? icon(it.icon) : it.link ? brand(it.link.kind) : null,
        h("span.dc-menu-t", str(it.label)), why ? h("span.sr-only", ": " + why) : it.hint ? h("span.dc-menu-hint", str(it.hint)) : null);
      }));
    pop.addEventListener("keydown", (e) => {
      const list = menuItems(pop);
      const i = list.indexOf(document.activeElement);
      const go = (j) => { e.preventDefault(); if (list.length) list[(j + list.length) % list.length].focus(); };
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(list.length - 1);
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === "Tab") closeMenu(false);
    });
    host.append(pop);
    // open upward when there is no room below; align to the left edge when the host sits on the left half
    const r = host.getBoundingClientRect();
    if (r.bottom + pop.offsetHeight + 8 > window.innerHeight && r.top > pop.offsetHeight + 8) pop.classList.add("up");
    if (r.left + r.width / 2 < window.innerWidth / 2) pop.classList.add("start");
    if (btn) btn.setAttribute("aria-expanded", "true");
    openMenu = { host, pop };
    const list = menuItems(pop);
    const first = focusLast ? list[list.length - 1] : list.find((x) => x.getAttribute("aria-disabled") !== "true") || list[0];
    if (first) first.focus();
  }
  /** DC.menu(items, {label = "More actions", text, icon, kind, size, chevron}): "…" button + popover menu.
   *  items: {label, onClick | link, icon | brand, disabled, reason, danger, checked, hint} | "-" (separator) | "Heading".
   *  Opens on click/Enter/ArrowDown, closes on Esc, outside click or choosing an item; arrows/Home/End move. */
  function menu(items, o = {}) {
    const list = (items || []).filter((x) => x != null && x !== false);
    if (!list.some((x) => typeof x === "object")) return null;
    const label = o.label || "More actions";
    const btn = o.text
      ? button(o.text, null, { kind: o.kind || "ghost", size: o.size === "md" ? null : "sm", icon: o.icon || null, chevron: o.chevron !== false })
      : button(label, null, { kind: o.kind || "ghost", size: o.size === "md" ? null : "sm", icon: o.icon || "ellipsis", iconOnly: true, tip: label });
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    if (o.text) btn.setAttribute("aria-label", o.label || o.text);
    setHandler(btn, "click", (e) => { e.stopPropagation(); openMenuFor(e.currentTarget.parentElement, false); });
    setHandler(btn, "keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMenuFor(e.currentTarget.parentElement, e.key === "ArrowUp"); }
    });
    const host = h("span.dc-menu-host", btn);
    host.__dcMenu = list;
    return host;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (openMenu) { closeMenu(true); return; }
    const t = document.querySelector("#dc-toasts .dc-toast:focus-within");
    if (t && t.__dcClose) t.__dcClose();
  });

  // =====================================================================================================
  // Hover strip (DESIGN.md §4.2)
  // =====================================================================================================
  /** DC.strip(items): up to three icon-only ghost buttons ({brand | icon, label, onClick | link}). */
  function strip(items) {
    return (items || []).filter(Boolean).slice(0, 3).map((s) => button(s.label, s.onClick || (s.link ? () => DC.openLink(s.link) : null), {
      kind: "ghost", size: "sm", iconOnly: true, icon: s.icon || null, brand: s.icon ? null : s.brand || "url",
      disabled: s.disabled, reason: s.reason, tip: s.tip || s.label,
    }));
  }

  // =====================================================================================================
  // Row (DESIGN.md §5.3) and its panel helpers
  // =====================================================================================================
  const CONTROL = "button, a, input, select, textarea, label, summary, .dc-menu, [role=menu]";
  function toggleRow(item, force) {
    if (!item || !item.__dcExpand) return;
    const key = item.getAttribute("data-key");
    const open = force != null ? !!force : !item.classList.contains("is-open");
    if (open) ui.open[key] = true; else delete ui.open[key];
    saveUi();
    item.classList.toggle("is-open", open);
    const row = item.querySelector(":scope > .dc-row");
    if (row) row.setAttribute("aria-expanded", String(open));
    const box = item.querySelector(":scope > .dc-panel > div");
    if (open && box && !box.firstChild) box.append(h("div.dc-panel-inner", item.__dcExpand()));
  }
  function primaryNode(p) {
    if (p == null || p === false) return null;
    if (isNode(p)) return p;
    if (typeof p === "object" && p.label) return button(p.label, p.onClick, Object.assign({ size: "sm" }, p));
    return null;
  }
  /** DC.row({key, icon, title, num, mono, titleTip, status: {tone, text, extra, spin} | node, age, since, late, meta,
   *  primary: node | {label, onClick, kind, disabled, reason}, strip: [{brand|icon, label, onClick|link}], menu: [...],
   *  expanded: () => content, onClick, selected, draft, busy, compact, chev, hash, announce, state}) -> .dc-item.
   *  Grid: icon | title | strip | status · age | primary | chevron. Clicking the row (not a control) toggles the panel
   *  (or runs onClick); Enter/Space toggles, Esc collapses, arrows/Home/End move between rows of the list. */
  function row(o = {}) {
    const key = str(o.key) || "row-" + hash([o.title, o.num]);
    const expandable = typeof o.expanded === "function";
    const open = expandable && !!ui.open[key];
    const clickable = expandable || typeof o.onClick === "function";
    const st = o.status == null || o.status === false ? null
      : isNode(o.status) ? o.status
        : status(o.busy ? "running" : o.status.tone, o.status.text, { age: o.age, since: o.since, late: o.late, extra: o.status.extra, spin: o.status.spin, pulse: o.status.pulse });
    const statusNode = st || (str(o.age) ? h("span.dc-status", h("span.dc-age" + (o.late ? ".late" : ""), { title: o.since || null }, str(o.age))) : null);
    if (st && isNode(o.status) && str(o.age)) st.append(h("span.dc-age" + (o.late ? ".late" : ""), { title: o.since || null }, "· " + str(o.age)));
    const stripBtns = o.compact ? [] : strip(o.strip);
    const more = o.compact ? null : menu(o.menu, { label: "More for " + str(o.title) });
    const titleId = nextId("t");
    const r = h("div", {
      class: ["dc-row", clickable ? "click" : "", o.selected ? "selected" : "", o.draft ? "draft" : "", o.compact ? "compact" : ""].filter(Boolean).join(" "),
      role: clickable ? "button" : null, tabindex: clickable ? "-1" : null, "data-roving": clickable ? "" : null,
      "aria-expanded": expandable ? String(open) : null, "aria-busy": o.busy ? "true" : null, "aria-current": o.selected ? "true" : null,
      "aria-labelledby": clickable ? titleId : null,
      onclick: (e) => {
        if (e.target.closest(CONTROL) && e.target.closest(CONTROL) !== e.currentTarget) return;
        const item = e.currentTarget.parentElement;
        if (o.onClick) o.onClick(e); else toggleRow(item);
      },
      onkeydown: (e) => {
        const rowEl = e.currentTarget;
        if (e.target !== rowEl) return;
        const item = rowEl.parentElement;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (o.onClick) o.onClick(e); else toggleRow(item); return; }
        if (e.key === "Escape" && item.classList.contains("is-open")) { e.preventDefault(); toggleRow(item, false); return; }
        if (e.key === "ArrowRight" && item.__dcExpand && !item.classList.contains("is-open")) { e.preventDefault(); toggleRow(item, true); return; }
        if (e.key === "ArrowLeft" && item.classList.contains("is-open")) { e.preventDefault(); toggleRow(item, false); return; }
        const list = rowEl.closest(".dc-list");
        if (!list) return;
        const rows = [...list.querySelectorAll(":scope > .dc-item > .dc-row[data-roving]")];
        const i = rows.indexOf(rowEl);
        const j = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -2;
        if (j === -2) return;
        e.preventDefault();
        const t = rows[Math.max(0, Math.min(rows.length - 1, j))];
        if (t) t.focus();
      },
      onfocus: rowFocus,
    },
    h("span.dc-ic-cell", o.icon || null),
    h("span", { class: "dc-title" + (o.mono ? " mono" : ""), id: titleId, title: o.titleTip || null }, str(o.num) ? h("span.dc-num", str(o.num)) : null, str(o.title)),
    o.meta != null && o.meta !== false && o.meta !== "" ? h("span.dc-meta-line", o.meta) : null,
    stripBtns.length || more ? h("span.dc-strip", stripBtns, more) : null,
    statusNode,
    h("span.dc-primary", primaryNode(o.primary)),
    o.compact ? null : h("span.dc-chev", expandable ? icon("chevron-right") : o.onClick && o.chev !== false ? icon("arrow-right") : null));
    const item = h("div", {
      class: "dc-item" + (open ? " is-open" : ""), "data-key": key, "data-state": o.state || null, "data-announce": o.announce || null,
    }, r, expandable ? h("div.dc-panel", h("div", open ? h("div.dc-panel-inner", o.expanded()) : null)) : null);
    if (expandable) item.__dcExpand = o.expanded;
    // the hash never includes UI-only state (open, menu): data when given, else the visible row text and tooltips
    const sig = o.hash !== undefined ? o.hash
      : [r.textContent, [...r.querySelectorAll("[data-tip]")].map((x) => x.getAttribute("data-tip")), !!o.selected, !!o.busy];
    item.setAttribute("data-hash", hash(sig));
    return item;
  }
  /** DC.list(rows, {label, key}): the divider list rows live in (one row per item, roving tabindex). */
  function list(rows, o = {}) {
    return h("div.dc-list", { "aria-label": o.label || null, "data-key": o.key || null }, rows);
  }
  /** DC.kv(pairs): expanded-panel grid of [label, content] pairs; empty content is skipped. */
  function kv(pairs) {
    const cells = [];
    (pairs || []).forEach((p) => {
      if (!p) return;
      const [k, v] = p;
      if (v == null || v === false || v === "" || (Array.isArray(v) && !v.filter(Boolean).length)) return;
      cells.push(h("span.dc-k", str(k)), h("div.dc-v", v));
    });
    return cells.length ? h("div.dc-kv", cells) : null;
  }


  // =====================================================================================================
  // Page structure (DESIGN.md §5.1, §5.2, §5.8, §5.9)
  // =====================================================================================================
  /** DC.roleChip(role, {roles, onSwitch}): pill; a menu of roles when there is a choice. Posts {type:"switchRole", role}. */
  function roleChip(role, o = {}) {
    if (!role) return null;
    const choices = (o.roles || []).filter((r) => ROLE[r]);
    const inner = [icon(ROLE[role] ? ROLE[role].icon : "account", { size: 12 }), h("span", roleLabel(role))];
    if (choices.length <= 1) return h("span.dc-persona", { title: "Working as " + roleLabel(role) }, inner);
    const onSwitch = o.onSwitch || ((r) => post({ type: "switchRole", role: r }));
    const host = menu(choices.map((r) => ({ label: roleLabel(r), checked: r === role, onClick: () => { if (r !== role) { announce("Working as " + roleLabel(r)); onSwitch(r); } } })),
      { label: "Switch role" });
    const btn = h("button.dc-persona", { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Working as " + roleLabel(role) + ". Switch role",
      onclick: (e) => { e.stopPropagation(); openMenuFor(e.currentTarget.parentElement, false); },
      onkeydown: (e) => { if (e.key === "ArrowDown") { e.preventDefault(); openMenuFor(e.currentTarget.parentElement, false); } },
    }, inner, icon("chevron-down", { size: 12 }));
    host.replaceChildren(btn);
    return host;
  }
  /** DC.header({title, sub, role, roles, onSwitch, onRefresh, menu, actions, icon}): sticky page header.
   *  Right side: role chip, then extra nodes, then one Refresh ghost icon button and an optional "…" menu. */
  function header(o = {}) {
    const refresh = o.onRefresh || (o.refresh === true ? () => post({ type: "refresh" }) : null);
    return h("header.dc-header",
      h("div.dc-header-main", h("h1", o.icon ? [icon(o.icon), " "] : null, str(o.title)), str(o.sub) || isNode(o.sub) ? h("div.dc-sub", o.sub) : null),
      h("div.dc-header-right",
        roleChip(o.role, o),
        o.actions || null,
        o.menu ? menu(o.menu, { label: "More", size: "md" }) : null,
        refresh ? button("Refresh", refresh, { kind: "ghost", icon: "refresh", iconOnly: true }) : null));
  }
  /** DC.section(title, {count, needs, action, actions, key, first}, ...body): sentence-case h2 with "· n" count
   *  (teal when it needs the viewer) and one optional ghost action on the right. */
  function section(title, opts, ...body) {
    if (opts != null && (typeof opts !== "object" || isNode(opts) || Array.isArray(opts))) { body.unshift(opts); opts = {}; }
    const o = opts || {};
    const key = o.key || "sec:" + String(title).toLowerCase().replace(/\W+/g, "-");
    const act = o.action || o.actions || null;
    return h("section", { class: "dc-sec" + (o.first ? " first" : ""), "data-key": key, "aria-label": str(title) || null },
      h("div.dc-sec-h", h("h2", str(title), o.count != null && o.count !== "" ? h("span", { class: "dc-count" + (o.needs ? " needs" : "") }, " · " + str(o.count)) : null),
        act ? h("span.dc-sec-a", act) : null),
      body);
  }
  /** DC.tabs(items: [{id, label, count, icon, disabled, title}], selected, onSelect): underline tabs with a sliding ink,
   *  roving tabindex, arrows/Home/End. */
  function tabs(items, selected, onSelect) {
    return h("div.dc-tabs", {
      role: "tablist",
      onkeydown: (e) => {
        const all = [...e.currentTarget.querySelectorAll(":scope > .dc-tab:not(:disabled)")];
        const i = all.indexOf(document.activeElement);
        if (i < 0) return;
        const j = e.key === "ArrowRight" ? (i + 1) % all.length : e.key === "ArrowLeft" ? (i - 1 + all.length) % all.length
          : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
        if (j >= 0) { e.preventDefault(); all[j].focus(); all[j].click(); }
      },
    }, (items || []).filter(Boolean).map((t) => {
      const sel = t.id === selected;
      const b = h("button.dc-tab.tab", {
        type: "button", role: "tab", "aria-selected": String(sel), tabindex: sel ? "0" : "-1", "data-id": str(t.id),
        disabled: !!t.disabled, title: t.title || null,
        onclick: (e) => {
          const btn = e.currentTarget;
          const wrap = btn.parentElement;
          if (btn.getAttribute("aria-selected") !== "true") {
            wrap.querySelectorAll(":scope > .dc-tab").forEach((x) => { x.setAttribute("aria-selected", String(x === btn)); x.setAttribute("tabindex", x === btn ? "0" : "-1"); });
            placeInk(wrap, true);
          }
          if (onSelect) onSelect(t.id);
        },
      }, t.icon ? icon(t.icon) : null, h("span", str(t.label)), t.count != null && t.count !== "" ? h("span.dc-tab-n", "· " + str(t.count)) : null);
      return b;
    }), h("span.dc-tab-ink", { "data-dc-ink": "", "aria-hidden": "true" }));
  }

  // =====================================================================================================
  // Feedback and data display (DESIGN.md §5.11-§5.15)
  // =====================================================================================================
  /** DC.toast(text, {kind: info|ok|warn|err, action: {label, onClick}, timeout = 5000 (0 = sticky), id}) -> {close}.
   *  Bottom-right, at most 3, pauses on hover/focus; mirrored to the live region. */
  function toast(text, o = {}) {
    const box = hostEl("dc-toasts", { role: "region", "aria-label": "Notifications" });
    const kind = o.kind || "info";
    const timeout = o.timeout == null ? 5000 : o.timeout;
    if (o.id) { const old = [...box.children].find((t) => t.getAttribute("data-id") === String(o.id)); if (old) old.remove(); }
    const acts = [...(o.actions || []), ...(o.action ? [o.action] : [])].filter((a) => a && a.label);
    let timer = null, left = timeout, started = 0, closed = false;
    const close = () => {
      if (closed) return; closed = true; clearTimeout(timer);
      if (reducedMotion()) { t.remove(); return; }
      t.classList.add("out");
      setTimeout(() => t.remove(), 200);
    };
    const start = () => { if (!timeout || closed) return; started = Date.now(); timer = setTimeout(close, left); };
    const pause = () => { if (!timeout || !timer) return; clearTimeout(timer); timer = null; left -= Date.now() - started; };
    const t = h("div.dc-toast", { "data-id": o.id || null, "data-kind": kind, onmouseenter: pause, onmouseleave: start, onfocusin: pause, onfocusout: start },
      dot(kind), h("span.dc-toast-t", str(text)),
      acts.map((a) => h("a.dc-toast-a", { href: "#", onclick: (e) => { e.preventDefault(); if (a.onClick) a.onClick(); close(); } }, str(a.label))),
      button("Dismiss", close, { kind: "ghost", size: "sm", iconOnly: true, icon: "close", cls: "tip-up" }));
    t.__dcClose = close;
    while (box.children.length >= 3) box.firstElementChild.remove();
    box.append(t);
    announce(text);
    start();
    return { close, el: t };
  }
  /** DC.skeleton({kind: "rows", n = 3, label}): static placeholder rows (title 40 %, meta 24 %); no shimmer. */
  function skeleton(o = {}) {
    const n = o.n || 3;
    return h("div.dc-skeleton", { "aria-busy": "true", role: "status", "aria-label": o.label || "Loading" },
      Array.from({ length: n }, (_, i) => h("div.dc-sk-row", h("span.dc-sk.ic"),
        h("span.dc-sk", { style: { width: (40 + ((i * 11) % 18)) + "%" } }), h("span.dc-sk", { style: { width: (24 + ((i * 7) % 10)) + "%", height: "8px" } }))));
  }
  /** DC.empty({icon, title, text, action: {label, onClick, icon}}) or DC.empty(text): centred, quiet, no box. */
  function empty(o) {
    if (o == null || typeof o !== "object" || isNode(o)) return h("div.dc-empty.plain.empty", isNode(o) ? o : str(o));
    return h("div.dc-empty", icon(o.icon || "inbox", { size: 24 }), str(o.title) ? h("div.dc-empty-t", str(o.title)) : null,
      str(o.text) || isNode(o.text) ? h("div.dc-empty-x", o.text) : null,
      o.action && o.action.label ? h("div.dc-empty-a", button(o.action.label, o.action.onClick, { kind: o.action.kind || "secondary", icon: o.action.icon })) : null);
  }
  /** DC.notice(text | node, kind: info|warn|err|ok, {icon, action: {label, onClick}}): one quiet line (icon + text + link). */
  function notice(text, kind, o = {}) {
    const k = kind || "info";
    return h("div.dc-notice.notice" + (kind ? "." + kind : ""), { role: k === "err" ? "alert" : null },
      icon(o.icon || ICONS.notice[k] || "info"), h("div.dc-notice-t", isNode(text) || Array.isArray(text) ? text : str(text)),
      o.action && o.action.label ? h("a.dc-notice-a", { href: "#", onclick: (e) => { e.preventDefault(); if (o.action.onClick) o.action.onClick(); } }, str(o.action.label)) : null);
  }


  // =====================================================================================================
  const DC = {
    vscode, h, svg, post, core, ui,
    /** Register the page renderer; called with each {type:"state"} payload. Posts "ready" once. */
    onState(render) {
      window.addEventListener("message", (e) => {
        const m = e.data || {};
        if (m.type === "state") { DC.state = m.data; DC.mount(render(m.data)); }
        else if (DC.onEvent) DC.onEvent(m);
      });
      post({ type: "ready" });
    },
    mount,
    /** Re-place tab inks after a page changes layout outside mount. */
    layout: () => placeInks(document, false),
    openLink(link) { if (link) post({ type: "openLink", link }); },
    /** Expand or collapse a row by key (true/false/undefined = toggle). */
    toggle(key, open) {
      const item = [...document.querySelectorAll(".dc-item[data-key]")].find((x) => x.getAttribute("data-key") === String(key));
      if (item) toggleRow(item, open); else { if (open === false) delete ui.open[key]; else ui.open[key] = true; saveUi(); }
    },
    // helpers
    hash, stateClass, toneOf: stateClass, word, iconFor, when, ago, announce, tip, setLoading, roleLabel, brandLabel, ROLE, ICONS,
    // primitives
    icon, brand, dot, status, chip, button, menu, strip,
    // structure
    header, roleChip, section, tabs, row, list, kv,
    // feedback
    toast, skeleton, empty, notice,
  };
  root.DC = DC;
})(typeof window !== "undefined" ? window : this);
