// Preview fixtures for the views pages are generated from the real view-model builders, so they never drift.
//   UPDATE_FIXTURES=1 npx vitest run test/unit/views     (rewrite preview/fixtures/views.*.json)
//   npx vitest run test/unit/views                       (check they are current)
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { Identity, QueueItem } from "../../src/core/contracts";
import * as M from "../../src/views/model";
import {
  ARCHITECT, CONNECTIONS, DEVELOPER, FEATURES, NOW, OWNER, PRS, QUEUE, REPO, SOURCES, TEAMS, TESTER, allowedFor, jiraUrl,
} from "../fixtures/views/sample";

const dir = path.resolve(__dirname, "../../preview/fixtures");

function home(id: Identity | null, over: Partial<M.HomeInput> = {}) {
  return M.buildHome({
    hasRemote: true, identity: id, githubConnected: !!id, circuitInstalled: true, connections: CONNECTIONS,
    queue: id?.active ? QUEUE.filter((q) => q.persona === id.active) : [], allowed: allowedFor(id), teams: TEAMS, now: NOW, ...over,
  });
}
const persona = (id: Identity, requested?: Identity["active"]) => M.buildPersona({
  identity: id, requested, queue: QUEUE, features: FEATURES, prs: PRS, allowed: allowedFor(id), jiraUrl, now: NOW,
});
const feature = (id: Identity, n: number) => M.buildFeature({
  feature: FEATURES[n], featureId: FEATURES[n].id, identity: id, sources: SOURCES, prs: PRS, owner: OWNER, repo: REPO,
  jiraUrl, allowed: allowedFor(id), now: NOW,
});

/** The item buildQueue adds when GitHub can't be read: a notice with a way to fix it, not waiting work. */
const GITHUB_ERROR: QueueItem = {
  id: "developer:connect:github", persona: "developer", kind: "connect", title: "Connect GitHub to see pull requests and gates",
  detail: "API rate limit exceeded", links: [{ kind: "github", label: `${OWNER}/${REPO}`, target: `https://github.com/${OWNER}/${REPO}/pulls` }],
  actions: [{ id: "nav:connections", label: "Open Connections", persona: "developer", kind: "nav" }],
};

const FIXTURES: Record<string, unknown> = {
  "views.home.architect": home(ARCHITECT),
  "views.home.developer": home(DEVELOPER),
  "views.home.tester": home(TESTER),
  "views.home.github-error": home(DEVELOPER, { queue: [GITHUB_ERROR, ...QUEUE.filter((q) => q.persona === "developer")] }),
  "views.home.onboarding": home(null, { githubConnected: false }),
  "views.home.no-remote": home(null, { hasRemote: false }),
  "views.home.no-persona": home({ ...DEVELOPER, personas: [], active: null }, { circuitInstalled: false }),
  "views.persona.architect": persona(ARCHITECT, "developer"),
  "views.persona.developer": persona(DEVELOPER),
  "views.persona.tester": persona(TESTER),
  "views.feature.default": feature(ARCHITECT, 0),
  "views.feature.developer": feature(DEVELOPER, 0),
  "views.feature.tester": feature(TESTER, 0),
  "views.feature.clarify": feature(ARCHITECT, 1),
  "views.feature.changed": feature(DEVELOPER, 2),
  "views.feature.missing": M.buildFeature({
    feature: undefined, featureId: "ACME-99", identity: DEVELOPER, sources: [], prs: [], owner: OWNER, repo: REPO,
    jiraUrl, allowed: allowedFor(DEVELOPER), now: NOW,
  }),
};

describe("views preview fixtures", () => {
  for (const [name, data] of Object.entries(FIXTURES)) {
    it(`${name} is current`, () => {
      const file = path.join(dir, `${name}.json`);
      const text = JSON.stringify(data, null, 2) + "\n";
      if (process.env.UPDATE_FIXTURES) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text); }
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    });
  }
});
