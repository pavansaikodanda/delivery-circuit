// Sidebar "Circuit" (DESIGN.md §6.1): who you are, what waits on you, where to go. Compact rows, one notice line per
// problem, nothing else. State comes from src/views/model.ts buildHome().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));
  document.body.classList.add("sidebar");

  const go = (target) => post({ type: "nav", target });
  const refresh = () => post({ type: "refresh" });
  const NAV_ICON = { testing: "beaker", connections: "plug", setup: "tools" };

  DC.mount(DC.skeleton({ n: 3, label: "Loading the circuit" }));
  DC.onState(render);

  function render(s) {
    if (!s) return DC.skeleton({ n: 3 });
    return [head(s), ...body(s), footer(s)];
  }

  function head(s) {
    const id = s.identity;
    if (!id) return DC.header({ title: "Delivery Circuit", sub: s.mode === "no-remote" ? "No GitHub remote" : "Not signed in", onRefresh: refresh });
    return DC.header({
      title: id.login, persona: id.active, personas: id.personas, onRefresh: refresh,
    });
  }

  function body(s) {
    if (s.mode === "no-remote") {
      return [DC.empty({
        icon: "repo", title: "No GitHub remote",
        text: h("span", "The circuit works on a Salesforce DX repo on GitHub. Add a remote named origin, then refresh:",
          h("pre.dc-cmd", "git remote add origin https://github.com/<owner>/<repo>.git")),
        action: { label: "Refresh", icon: "refresh", onClick: refresh },
      })];
    }
    if (s.mode === "signin") {
      return [DC.empty({
        icon: "github", title: "Sign in to GitHub",
        text: "Your persona comes from your GitHub team membership. Gate actions use your own GitHub account.",
        action: { label: "Connect GitHub", kind: "primary", onClick: () => post({ type: "connectGithub" }) },
      })];
    }
    if (s.mode === "loading") return [DC.notice("Reading your GitHub teams…", "info", { icon: "loading" }), DC.skeleton({ n: 3, label: "Reading your GitHub teams" })];
    if (s.mode === "no-persona") return [...noPersona(s), nav(s)];
    return [...notices(s), waiting(s), nav(s)];
  }

  function noPersona(s) {
    const id = s.identity || {};
    const t = s.teams || {};
    const out = [];
    if (id.orgOwned) {
      out.push(DC.section("No persona yet", { first: true },
        h("p.muted.small", "You are signed in, but not in a persona team of " + (id.owner || "this organisation") + ". Ask an organisation admin to add you to one of these GitHub teams:"),
        DC.list(["architect", "developer", "tester"].map((p) => DC.row({
          key: "team-" + p, icon: DC.icon((DC.PERSONA[p] || {}).icon || "account"), title: DC.personaLabel(p), compact: true,
          status: h("span.dc-status", h("span.mono.muted", "team " + (t[p] || p + "s"))),
        })), { label: "Persona teams" }),
        DC.notice("Team names come from a setting.", "info", { action: { label: "Open setting", onClick: () => post({ type: "openSettings", setting: "deliveryCircuit.githubTeams" }) } })));
    } else {
      out.push(DC.section("No persona yet", { first: true },
        DC.notice("This repo belongs to a personal account, so there are no GitHub teams to read your persona from. Choose it in deliveryCircuit.personaOverride.", "info",
          { action: { label: "Open setting", onClick: () => post({ type: "openSettings", setting: "deliveryCircuit.personaOverride" }) } })));
    }
    out.push(...notices(s));
    return out;
  }

  // One quiet line per problem (icon + text + one link), above the queue.
  function notices(s) {
    const out = [];
    if (s.notice) out.push(DC.notice(s.notice, "info"));
    if (s.error) out.push(DC.notice("Some data could not be loaded: " + s.error, "warn", { action: { label: "Retry", onClick: refresh } }));
    if (s.setupNeeded) {
      const admin = s.identity && s.identity.isAdmin;
      out.push(DC.notice(admin ? "This repo is not set up with the circuit yet." : "This repo is not set up with the circuit yet. Ask a repo admin to run Project setup.", "warn",
        admin ? { action: { label: "Project setup", onClick: () => go("setup") } } : {}));
    }
    (s.notices || []).forEach((q) => {
      const act = (q.actions || []).find((a) => a.allowed);
      const link = (q.links || [])[0];
      const action = act ? { label: act.label, onClick: () => DC.action(act) } : link ? { label: link.label || "Open", onClick: () => DC.openLink(link) } : null;
      out.push(DC.notice(q.title + (q.detail ? ": " + q.detail : ""), "warn", action ? { action } : {}));
    });
    return out.length ? [h("div.dc-notices", { "data-key": "notices" }, out)] : [];
  }

  function waiting(s) {
    const id = s.identity || {};
    const total = s.waitingTotal || 0;
    const items = s.waiting || [];
    const view = id.active ? "persona:" + id.active : null;
    const more = total > items.length && view ? DC.button("Show all " + total, () => go(view), { kind: "link", size: "sm" }) : null;
    if (!items.length) {
      return DC.section("Waiting on you", { key: "sec:waiting", first: true },
        DC.empty({ icon: "check", title: "Nothing waiting", text: "Nothing is waiting on you as " + (id.activeLabel || "your persona") + "." }));
    }
    return DC.section("Waiting on you", { key: "sec:waiting", count: total, needs: total > 0, first: true },
      DC.list(items.map((q) => DC.queueRow(q, {
        compact: true, viewer: id.active, view: id.active,
        onOpen: view ? () => go(view) : q.featureId ? () => post({ type: "openFeature", id: q.featureId }) : null,
      })), { label: "Waiting on you" }),
      more ? h("div.dc-more", more) : null);
  }

  function navIcon(n) {
    if (n.target.startsWith("persona:")) { const p = n.target.slice(8); return (DC.PERSONA[p] || {}).icon || "account"; }
    return NAV_ICON[n.target] || "arrow-right";
  }

  function nav(s) {
    const list = s.nav || [];
    if (!list.length) return null;
    return DC.section("Go to", { key: "sec:nav" },
      DC.list(list.map((n) => DC.row({
        key: "nav-" + n.target, icon: DC.icon(navIcon(n)), title: n.label, compact: true,
        status: n.count ? { tone: n.cls || "warn", text: n.detail || String(n.count) } : n.detail === "view only" ? { tone: "muted", text: "view only" } : null,
        titleTip: n.detail && !n.count && n.detail !== "view only" ? n.detail : null,
        onClick: () => go(n.target),
        primary: DC.button("Open " + n.label, () => go(n.target), { kind: "ghost", size: "sm", icon: "arrow-right", iconOnly: true }),
        hash: n,
      })), { label: "Go to" }));
  }

  function footer(s) {
    const t = s.updated ? new Date(s.updated) : null;
    const ok = t && !isNaN(t.getTime());
    const id = s.identity;
    const repo = id && id.owner && id.repo ? id.owner + "/" + id.repo : "";
    const when = ok ? "Updated " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return h("p.dc-footer", { "data-key": "footer" }, [repo, when].filter(Boolean).join(" · "));
  }
})();
