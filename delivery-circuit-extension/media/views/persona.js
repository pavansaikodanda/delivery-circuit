// Persona panel: one tab per persona the identity can view. State from src/views/model.ts buildPersona().
(function () {
  const { h, post } = DC;
  const me = document.currentScript && document.currentScript.src;
  if (me) document.head.append(h("link", { rel: "stylesheet", href: me.replace(/[^/]*$/, "views.css") }));

  DC.onState(render);

  const prevent = (fn) => (e) => { e.preventDefault(); fn(); };

  function render(s) {
    if (!s) return DC.empty("No data yet.");
    const head = h("div.header", [
      h("div", [
        h("h1", s.selectedLabel ? s.selectedLabel + " view" : "Persona views"),
        h("div.sub", s.login ? ["Signed in as ", h("strong", s.login), s.active ? " · acting as " + label(s.active) : " · no active persona"] : "Not signed in"),
      ]),
      h("div.row", [
        s.login ? DC.button("Switch persona", () => post({ type: "switchPersona" }), { kind: "secondary" }) : null,
        DC.button("Refresh", () => post({ type: "refresh" }), { kind: "secondary" }),
      ]),
    ]);
    if (!s.selected) return h("div", [head, DC.notice(s.notice || "Nothing to show.", "warn")]);
    return h("div", [
      head,
      s.tabs.length ? DC.tabs(s.tabs, s.selected, (id) => post({ type: "selectTab", persona: id })) : null,
      s.notice ? DC.notice(s.notice) : null,
      s.error ? h("div.dc-section", DC.notice("Some data could not be loaded: " + s.error, "warn")) : null,
      queue(s), aiActions(s), features(s), prs(s),
      h("p.muted.small.dc-section", "Updated " + new Date(s.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
    ]);
  }

  function label(p) { return { architect: "Architect", developer: "Developer", tester: "Tester" }[p] || p; }

  function section(title, count, body) {
    return h("div.dc-section", [h("h2", [title, count != null ? h("span.count", String(count)) : null]), body]);
  }

  function actionsRow(actions) {
    if (!actions || !actions.length) return null;
    const blocked = actions.filter((a) => !a.allowed);
    const reasons = [...new Set(blocked.map((a) => a.reason).filter(Boolean))];
    return h("div.row", [DC.actionButtons(actions, (a) => a.allowed), reasons.length ? h("span.dc-reason", reasons.join(" · ")) : null]);
  }

  function queue(s) {
    const title = s.canAct ? "Waiting on you" : "Waiting on the " + s.selectedLabel;
    if (!s.queue.length) return section(title, null, DC.empty("Nothing is waiting on the " + s.selectedLabel + " right now."));
    return section(title, s.queue.length, h("div.list", s.queue.map((q) => h("div.item.stack", [
      h("div.spread", [h("span.title", q.title), q.age ? h("span.muted.small", { title: q.since || null }, "waiting " + q.age) : null]),
      h("div.row", [
        q.gate ? h("span.badge.info", { title: q.gateLabel || null }, q.gateLabel || q.gate) : null,
        q.detail ? h("span.muted.small", q.detail) : null,
      ]),
      h("div.row", [
        DC.links(q.links),
        q.featureId ? h("a.small", { href: "#", onclick: prevent(() => post({ type: "openFeature", id: q.featureId })) }, "Feature " + q.featureId) : null,
      ]),
      actionsRow(q.actions),
    ]))));
  }

  function aiActions(s) {
    if (!s.aiActions.length) return null;
    return section("AI actions", null, h("div.stack", [
      h("p.muted.small", "Each starts a Claude session as the " + s.selectedLabel + ". You pick the feature, pull request or source next. AI never approves, merges or deploys."),
      h("div.row", s.aiActions.map((a) => DC.button(a.label, () => DC.action(a), { kind: "secondary", disabled: !a.allowed, title: a.allowed ? null : a.reason }))),
      s.aiActions.some((a) => !a.allowed) ? h("span.dc-reason", s.aiActions.find((a) => !a.allowed).reason || "") : null,
    ]));
  }

  function strip(key, steps) {
    return h("div.dc-strip", [
      h("span.k", key),
      h("span.steps", steps.map((st) => h("span.step." + (st.state || "todo") + (st.own === true ? ".dc-own" : st.own === false ? ".dc-other" : ""),
        { title: st.title || null }, st.label))),
    ]);
  }

  function features(s) {
    if (!s.features.length) return section("Features", null, DC.empty("No features yet. The Architect starts one with Intake."));
    return section("Features", s.features.length, h("div.stack", s.features.map((f) => h("div.card", [
      h("div.spread", [
        h("a.dc-card-title", { href: "#", onclick: prevent(() => post({ type: "openFeature", id: f.id })) }, f.slug),
        f.score != null ? h("span.badge", { title: "speckit-sf-score" }, "score " + f.score) : null,
      ]),
      h("div.muted.small", f.title),
      strip("Stage", f.stages),
      strip("Gates", f.gates),
      h("div.row.dc-meta", [
        h("span", f.openQuestions + " open question" + (f.openQuestions === 1 ? "" : "s")),
        h("span", "· " + f.stories + " stor" + (f.stories === 1 ? "y" : "ies")),
        f.next ? h("span", "· next " + f.next.id + " " + f.next.label + " (" + f.next.ownerLabel + ")") : h("span", "· all gates done"),
      ]),
      h("div.row", [DC.links(f.links)]),
    ]))));
  }

  function prs(s) {
    if (!s.prs.length) return section("Pull requests", null, DC.empty("No open pull requests for the " + s.selectedLabel + "."));
    return section("Pull requests", s.prs.length, h("div.list", s.prs.map((p) => h("div.item.stack.dc-pr", [
      h("div.head", [
        h("span", [h("span.title", "#" + p.number + " " + p.title)]),
        h("span.row", [
          p.needsYou ? DC.badge(s.canAct ? "needs you" : "needs " + s.selectedLabel, "info") : null,
          p.draft ? DC.badge("draft") : null,
          p.aiAttempt ? DC.badge("ai-attempt-" + p.aiAttempt, p.aiAttempt >= 3 ? "warn" : null) : null,
          h("span.muted.small", p.age),
        ]),
      ]),
      h("div.row.dc-meta", [h("code", p.branch), h("span", "by " + p.author), p.storyKey ? h("span", "· " + p.storyKey) : null]),
      p.labels.length ? h("div.row", p.labels.map((l) => h("span.badge", l))) : null,
      p.checks.length ? h("div.row", p.checks.map((c) => h("span.badge" + (c.cls ? "." + c.cls : ""), { title: c.name + ": " + c.state }, c.name))) : null,
      p.gates.length ? strip("Your gates", p.gates.map((g) => Object.assign({}, g, { own: undefined }))) : null,
      signals(p),
      h("div.row", [DC.links(p.links), p.featureId ? h("a.small", { href: "#", onclick: prevent(() => post({ type: "openFeature", id: p.featureId })) }, "Feature " + p.featureId) : null]),
    ]))));
  }

  function signals(p) {
    if (!p.groups.length && !p.missing.length) return null;
    const rows = [];
    p.groups.forEach((g) => {
      rows.push(h("span.src", g.label));
      rows.push(h("div", g.signals.map((x) => h("div.dc-signal", [
        DC.dot(x.cls || null), h("span", x.author), h("span.muted", x.state), x.summary ? h("span.muted", "· " + x.summary) : null, DC.links(x.links),
      ]))));
    });
    if (p.missing.length) { rows.push(h("span.src", "No signal yet")); rows.push(h("span.muted", p.missing.join(", "))); }
    return h("div.dc-signals", rows);
  }
})();
