// WorkData built from the recorded-shape fixtures (placeholders only), shared by the work, view-model and preview
// fixture tests. Not a test file itself.
import * as fs from "fs";
import * as path from "path";
import { normalizeIssues } from "../../src/project/acli";
import { normalizeDesignPages } from "../../src/project/design";
import { mapDeployRuns, mapWorkResponse } from "../../src/project/github";
import { designPageOf, parseConfig, storiesOf } from "../../src/project/jira";
import { readerJson } from "../../src/project/mcpReader";
import type { Feature, WorkData } from "../../src/project/model";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const raw = (p: string) => fs.readFileSync(path.join(FIX, p), "utf8");

/** 2026-11-13 12:00 UTC: PR #41 has waited three days, #43 and #44 a few hours. */
export const NOW = Date.parse("2026-11-13T12:00:00Z");

export function workData(): WorkData {
  const cfg = parseConfig(raw("repo/build.config.yml"));
  const epics = normalizeIssues(JSON.parse(raw("acli/epics.json")));
  const children = normalizeIssues(JSON.parse(raw("acli/children.json")));
  const tests = normalizeIssues(JSON.parse(raw("acli/tests.json")));
  const pages = normalizeDesignPages(readerJson({ code: 0, stdout: raw("confluence/listing.json"), stderr: "" }));
  const gh = mapWorkResponse(JSON.parse(raw("github-work.json")), ["dev", "sit", "uat", "main"]);
  const features: Feature[] = epics.map((epic) => {
    const page = pages.find((p) => p.id === designPageOf(epic, cfg.fields)?.id);
    return { id: epic.key, title: epic.summary, epic, ...(page ? { page } : {}) };
  });
  for (const p of pages) if (!features.some((f) => f.page?.id === p.id)) features.push({ id: `page-${p.id}`, title: p.title.replace(/^Design:\s*/, ""), page: p, slug: p.slug });
  return {
    repo: { owner: "acme-org", repo: "acme-salesforce" }, readyStatus: cfg.readyStatus, features,
    stories: storiesOf(children).filter((s) => s.parentKey === "ABC-10"), tests, prs: gh.prs,
    deploys: mapDeployRuns(JSON.parse(raw("deploy-runs.json"))), sprint: gh.sprints[0], sprintAhead: 3,
    setup: {
      branches: gh.branches, sprintBranch: gh.sprints[0], autoMerge: gh.autoMerge,
      environments: { qa: { exists: true, authUrl: true }, dev: { exists: true, authUrl: true }, sit: { exists: true, authUrl: false }, uat: { exists: false }, production: { exists: true } },
      rulesets: { "sprint/2026-11": true, dev: true, sit: true, uat: true, main: true },
    },
    fields: cfg.fields, site: cfg.site, designsRead: true, errors: [],
  };
}

export const ENVIRONMENTS = parseConfig(raw("repo/build.config.yml")).environments;
