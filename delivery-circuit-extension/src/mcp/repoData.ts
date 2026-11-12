// Repository-scope data for the stdio Circuit MCP (CI, terminal): Jira through the machine's own `acli` login (the
// self-hosted runner logs in with `acli jira auth login --web` once) and SF AI Tester runs from the repository.
// No GitHub or Confluence calls, no secrets, no transcripts. No vscode import.
import { promises as fs } from "fs";
import * as path from "path";
import { run } from "../core/util";
import { searchIssues, viewIssue, type AcliExec } from "../project/acli";
import { storyDetail } from "../project/details";
import { buildFeatures } from "../project/gates";
import { childrenJql, epicsJql, groupFeatures, parseConfig, testCasesJql } from "../project/jira";
import type { CircuitConfig, FeatureInfo } from "../project/model";
import { buildQueue } from "../project/queue";
import type { CircuitData } from "./tools";
import { readTestResults } from "./testResults";

export function repoData(root: string, acli: AcliExec = (args) => run(process.env.CIRCUIT_ACLI || "acli", args, { cwd: root, shell: false, timeoutMs: 90_000 })): CircuitData {
  let cache: { at: number; features: FeatureInfo[]; error?: string } | undefined;
  async function config(): Promise<CircuitConfig> {
    try { return parseConfig(await fs.readFile(path.join(root, "build.config.yml"), "utf8")); } catch { return parseConfig(undefined); }
  }
  async function load(): Promise<{ at: number; features: FeatureInfo[]; error?: string }> {
    if (cache && Date.now() - cache.at < 60_000) return cache;
    const cfg = await config();
    const browse = (k: string) => (cfg.site ? `${cfg.site}/browse/${k}` : undefined);
    if (!cfg.projectKey) return (cache = { at: Date.now(), features: [], error: "jira.project_key is not set in build.config.yml" });
    try {
      const epics = await searchIssues(acli, epicsJql(cfg.projectKey));
      const jql = childrenJql(epics.map((e) => e.key));
      const children = jql ? await searchIssues(acli, jql) : [];
      const tests = await searchIssues(acli, testCasesJql(cfg.projectKey));
      // Design pages are not read here (no Confluence login in this scope): G1 shows as not read.
      const features = buildFeatures(groupFeatures(epics, children, tests, cfg.fields), [], undefined, cfg, { jiraBrowseUrl: browse });
      return (cache = { at: Date.now(), features });
    } catch (e: any) {
      return (cache = { at: Date.now(), features: [], error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  const features = async () => (await load()).features;
  return {
    features,
    async feature(id) { return (await features()).find((f) => f.id === id || f.slug === id); },
    async queue(persona) {
      const l = await load();
      return buildQueue(persona, { features: l.features, prs: [], env: l.error ? { jiraError: l.error } : {} });
    },
    async story(key) {
      for (const f of await features()) {
        const s = f.stories.find((x) => x.jiraKey === key);
        if (s) return storyDetail(f, s, []);
      }
      const i = await viewIssue(acli, key);
      if (!i) throw new Error(`Jira issue ${key} not found`);
      return { key: i.key, summary: i.summary, issueType: i.issueType, status: i.status, labels: i.labels, parent: i.parentKey ?? null, description: i.description ?? null };
    },
    testResults: (suite) => readTestResults(root, suite),
  };
}
