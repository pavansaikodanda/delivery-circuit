// Repository-only data for the stdio Circuit MCP (CI, terminal): spec folders, Jira map and SF AI Tester runs.
// No GitHub, Jira or Fireflies calls, no secrets, no transcripts. No vscode import.
import { enrichFeatures } from "../project/gates";
import { loadFeatures } from "../project/parse";
import { buildQueue } from "../project/queue";
import type { CircuitData } from "./tools";
import { readTestResults } from "./testResults";

export function repoData(root: string): CircuitData {
  const features = async () => enrichFeatures(await loadFeatures(root), [], undefined, undefined);
  return {
    features,
    async feature(id) { return (await features()).find((f) => f.id === id || f.slug === id); },
    async queue(persona) { return buildQueue(persona, { features: await features(), prs: [], env: { jiraConnected: false } }); },
    async jiraMap(featureId) {
      const p = (await loadFeatures(root)).find((x) => x.feature.id === featureId || x.feature.slug === featureId);
      return { ...(p?.facts.jiraRefs ?? {}) };
    },
    testResults: (suite) => readTestResults(root, suite),
  };
}
