// Sidebar "Circuit": who you are, what waits on you, where to go. State comes from src/views/model.ts buildHome().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));
  document.body.classList.add("sidebar");

  DC.onState(render);

  function render(s) {
    if (!s) return DC.empty("No data yet.");
    return h("div", [
      identityLine(s),
      s.error ? h("div.dc-section", DC.notice("Some data could not be loaded: " + s.error, "warn")) : null,
      body(s),
      footer(s),
    ]);
  }

  function identityLine(s) {
    const id = s.identity;
    if (!id) return h("div.dc-id", h("span.muted", "Not signed in"));
    return h("div.dc-id", [
      DC.dot(s.mode === "ready" ? "ok" : "warn"),
      h("span.who", id.login),
      h("span.muted", "·"),
      h("span", id.activeLabel),
      id.canSwitch ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); post({ type: "switchPersona" }); } }, "switch") : null,
    ]);
  }

  function body(s) {
    if (s.mode === "no-remote") {
      return h("div.dc-section.stack", [
        DC.notice("This workspace has no GitHub remote named origin.", "warn"),
        h("p.muted.small", "The circuit works on a Salesforce DX repo hosted on GitHub. Add the remote, then refresh:"),
        h("p", h("code", "git remote add origin https://github.com/<owner>/<repo>.git")),
        DC.button("Refresh", () => post({ type: "refresh" }), { kind: "secondary" }),
      ]);
    }
    if (s.mode === "signin") {
      return h("div.dc-section.stack", [
        h("p", "Sign in to GitHub to see what is waiting on you."),
        h("p.muted.small", "Your persona comes from your GitHub team membership. Gate actions use your own GitHub account."),
        DC.button("Connect GitHub", () => post({ type: "connectGithub" })),
      ]);
    }
    if (s.mode === "loading") {
      return h("div.dc-section.stack", [
        h("p.muted", "Reading your GitHub teams…"),
        DC.button("Refresh", () => post({ type: "refresh" }), { kind: "secondary" }),
      ]);
    }
    if (s.mode === "no-persona") return noPersona(s);
    return h("div", [s.notice ? h("div.dc-section", DC.notice(s.notice, "info")) : null, setupNotice(s), waiting(s), nav(s)]);
  }

  function noPersona(s) {
    const id = s.identity || {};
    const t = s.teams || {};
    const teamList = h("ul.small", [
      h("li", [h("code", t.architect || "architects"), " Architect"]),
      h("li", [h("code", t.developer || "developers"), " Developer"]),
      h("li", [h("code", t.tester || "testers"), " Tester"]),
    ]);
    const parts = id.orgOwned
      ? [
          DC.notice("You are signed in, but you are not in a persona team of " + (id.owner || "this organisation") + ".", "warn"),
          h("p.small", "Ask an organisation admin to add you to one of these GitHub teams:"),
          teamList,
          h("p.muted.small", ["Team names come from the setting ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); post({ type: "openSettings", setting: "deliveryCircuit.githubTeams" }); } }, "deliveryCircuit.githubTeams"), "."]),
        ]
      : [
          DC.notice("This repo belongs to a personal account, so there are no GitHub teams to read your persona from.", "info"),
          h("p.small", "Choose your persona in the setting deliveryCircuit.personaOverride (personal repos only)."),
          DC.button("Open setting", () => post({ type: "openSettings", setting: "deliveryCircuit.personaOverride" })),
        ];
    if (s.notice) parts.push(h("p.muted.small", s.notice));
    return h("div", [h("div.dc-section.stack", parts), setupNotice(s), nav(s)]);
  }

  function setupNotice(s) {
    if (!s.setupNeeded) return null;
    const admin = s.identity && s.identity.isAdmin;
    return h("div.dc-section.stack", [
      DC.notice("This repo is not set up with the circuit yet (no .specify folder or circuit guard hook).", "warn"),
      admin
        ? DC.button("Open Project setup", () => post({ type: "nav", target: "setup" }))
        : h("p.muted.small", "Ask a repo admin to run Project setup from this sidebar."),
    ]);
  }

  function waiting(s) {
    const total = s.waitingTotal || 0;
    const shown = (s.waiting || []).length;
    const head = h("h2", ["Waiting on you", total ? h("span.count", total > shown ? shown + " of " + total : String(total)) : null]);
    if (!shown) return h("div.dc-section", [head, DC.empty("Nothing is waiting on you as " + ((s.identity && s.identity.activeLabel) || "your persona") + ".")]);
    return h("div.dc-section", [
      head,
      h("div.list", s.waiting.map(queueItem)),
      total > shown && s.identity && s.identity.active
        ? h("p.small", h("a", { href: "#", onclick: (e) => { e.preventDefault(); post({ type: "nav", target: "persona:" + s.identity.active }); } }, "Show all " + total))
        : null,
    ]);
  }

  function queueItem(q) {
    const primary = (q.actions || []).slice(0, 1);
    const blocked = primary.find((a) => !a.allowed);
    return h("div.item.stack", [
      h("div.spread", [h("span.title", q.title), q.age ? h("span.muted.small", { title: q.since || null }, q.age) : null]),
      h("div.row", [
        q.gate ? h("span.badge.info", { title: q.gateLabel || null }, q.gate) : null,
        q.detail ? h("span.muted.small", q.detail) : null,
      ]),
      h("div.row", [
        DC.links(q.links),
        q.featureId ? h("a.small", { href: "#", onclick: (e) => { e.preventDefault(); post({ type: "openFeature", id: q.featureId }); } }, "Feature") : null,
      ]),
      primary.length ? h("div.row", [
        DC.actionButtons(primary, (a) => a.allowed),
        blocked ? h("span.dc-reason", blocked.reason || "") : null,
      ]) : null,
    ]);
  }

  function nav(s) {
    if (!s.nav || !s.nav.length) return null;
    return h("div.dc-section", [
      h("h2", "Go to"),
      h("div.list.dc-nav", s.nav.map((n) => {
        const go = () => post({ type: "nav", target: n.target });
        return h("div.item", {
          role: "button", tabindex: "0", onclick: go,
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } },
        }, [
          h("span", [h("span", n.label), n.detail ? h("span.muted.small", " · " + n.detail) : null]),
          n.count ? DC.badge(String(n.count), n.cls || null) : null,
        ]);
      })),
    ]);
  }

  function footer(s) {
    const t = s.updated ? new Date(s.updated) : null;
    return h("p.muted.small.dc-section", [
      t ? "Updated " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " : "",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); post({ type: "refresh" }); } }, "Refresh"),
    ]);
  }
})();
