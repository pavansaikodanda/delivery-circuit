// Preview fixtures for the Project Setup page are generated from the real view builder, so they never drift.
//   UPDATE_FIXTURES=1 npx vitest run test/unit/setup.fixtures   (rewrite preview/fixtures/setup.setup.*.json)
//   npx vitest run test/unit/setup.fixtures                     (check they are current)
// Placeholder data only (acme-org, ACME, demo.user@example.com).
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseBuildState } from "../../src/setup/buildState";
import { readConfig, readForm } from "../../src/setup/config";
import { phases, type PhaseCtx } from "../../src/setup/phases";
import { buildView } from "../../src/setup/view";

const FX = path.join(__dirname, "..", "fixtures", "setup");
const CONFIG = fs.readFileSync(path.join(FX, "build.config.yml"), "utf8");
const dir = path.resolve(__dirname, "../../preview/fixtures");
const AT = "2026-11-11T15:00:00Z";

const cfg = readConfig(CONFIG);
const CTX: PhaseCtx = {
  owner: "acme-org", repo: "acme-salesforce", org: "acme-org", jiraSite: cfg.jiraSite, jiraKey: cfg.jiraKey, spaceKey: cfg.spaceKey,
  devAlias: cfg.devAlias, qaAlias: cfg.qaAlias, prodAlias: cfg.prodAlias, runners: cfg.runners, platform: "linux",
};
const STATE = parseBuildState(`# Build state

| Phase | Status | Verified | Evidence | Notes |
|---|---|---|---|---|
| B0 Preflight | DONE | 2026-11-10 | tools ok; gh scopes ok | |
| B1 GitHub repo, teams, labels | DONE | 2026-11-10 | teams disjoint; 13 labels; no secrets | |
| B2 Self-hosted runners | PARTIAL | | | circuit runner online; release runner not registered yet |
`);

const results = {
  "b2.circuit": { state: "ok" as const, text: "[self-hosted, circuit]: circuit-1 online", at: AT, lines: ["[self-hosted, circuit]: circuit-1 online", "circuit-1: online; labels self-hosted, Linux, circuit"] },
  "b2.logins": { state: "warn" as const, text: "[self-hosted, circuit]: circuit-1 online. Checklist 3/5 ticked.", at: AT },
  "b2.release": { state: "warn" as const, text: "[self-hosted, circuit-release]: no runner registered with these labels", at: AT },
};

const view = (over: Partial<Parameters<typeof buildView>[0]> = {}) => buildView({
  login: "maya-arch", admin: true, owner: CTX.owner, repo: CTX.repo, defs: phases(CTX), state: STATE, buildStateExists: true,
  results, ticks: { "b2.logins": [true, true, true, false, false] }, selected: "B2", busy: null,
  config: { exists: true, values: readForm(CONFIG), errors: [] }, ...over,
});

const FIXTURES: Record<string, unknown> = {
  "setup.setup.default": view(),
  "setup.setup.busy": view({ busy: "b2.release" }),
  "setup.setup.notadmin": { ...view({ login: "ravi-dev", admin: false }), phases: [], config: { exists: true, fields: [], values: {}, errors: [] } },
};

describe("setup preview fixtures", () => {
  for (const [name, data] of Object.entries(FIXTURES)) {
    it(`${name} is current`, () => {
      const file = path.join(dir, `${name}.json`);
      const text = JSON.stringify(data, null, 2) + "\n";
      if (process.env.UPDATE_FIXTURES) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text); }
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    });
  }
  it("never carries a credential", () => {
    const all = JSON.stringify(FIXTURES);
    expect(all).not.toMatch(/gh[pousr]_[A-Za-z0-9]{10}|github_pat_|sk-ant-|xox[abpr]-|BEGIN [A-Z ]*PRIVATE KEY|hooks\.slack\.com/);
  });
});
