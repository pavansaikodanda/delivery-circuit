// Project context parsers: acli JSON (Jira), build.config.yml, stories and test cases, the design-page listing and the
// read-only Atlassian MCP reader (Confluence, and Jira without acli). Fixtures are recorded-shape outputs (placeholders only).
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  acliJson, AcliError, authSite, compareKeys, docText, keyList, normalizeIssues, parseCliJson, searchArgs, searchIssues, viewArgs, viewIssue,
  type AcliExec,
} from "../../src/project/acli";
import { normalizeDesignPages } from "../../src/project/design";
import {
  acceptanceCriteriaOf, childrenJql, confluencePage, designPageOf, epicsJql, orderStories, parseConfig, sprintJql, storiesOf, storyNumOf,
  storyTitleOf, testCasesJql, testCasesOf, yamlValue,
} from "../../src/project/jira";
import {
  allowedTools, ATLASSIAN_SERVERS, designPagesPrompt, jiraPrompt, readDesignPages, readerJson, readJiraIssues, type ClaudeExec,
} from "../../src/project/mcpReader";

const FIX = path.join(__dirname, "..", "fixtures", "project");
const raw = (p: string) => fs.readFileSync(path.join(FIX, p), "utf8");
const cfg = parseConfig(raw("repo/build.config.yml"));
const epics = normalizeIssues(JSON.parse(raw("acli/epics.json")));
const children = normalizeIssues(JSON.parse(raw("acli/children.json")));
const tests = normalizeIssues(JSON.parse(raw("acli/tests.json")));
const byKey = (k: string) => [...epics, ...children, ...tests].find((i) => i.key === k)!;

/** A fake acli: answers by the first matching args pattern, records every call. */
function fakeAcli(routes: [RegExp, { code?: number; stdout?: string; stderr?: string }][]): AcliExec & { calls: string[][] } {
  const calls: string[][] = [];
  const f = (async (args: string[]) => {
    calls.push(args);
    const hit = routes.find(([re]) => re.test(args.join(" ")));
    const r = hit?.[1] ?? { code: 1, stderr: "unexpected call" };
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }) as any;
  f.calls = calls;
  return f;
}

describe("acli (Jira through the Atlassian CLI login)", () => {
  it("builds argument arrays, never shell strings, and refuses bad keys", () => {
    expect(searchArgs("project = ABC")).toEqual(["jira", "workitem", "search", "--jql", "project = ABC", "--fields", "*all", "--paginate", "--json"]);
    expect(viewArgs("ABC-1")).toEqual(["jira", "workitem", "view", "ABC-1", "--fields", "*all", "--json"]);
    expect(() => viewArgs("ABC-1; rm -rf /")).toThrow(/Not a Jira key/);
    expect(keyList(["ABC-10", "ABC-2", "bad)", "ABC-2"])).toBe("ABC-2, ABC-10");
    expect(["ABC-10", "ABC-9", "AB-1"].sort(compareKeys)).toEqual(["AB-1", "ABC-9", "ABC-10"]);
    expect(epicsJql("ABC")).toContain("project = ABC AND issuetype = Epic");
    expect(() => epicsJql("abc) OR 1=1")).toThrow();
    expect(childrenJql(["ABC-20", "ABC-10"])).toBe("parent in (ABC-10, ABC-20) ORDER BY key ASC");
    expect(childrenJql([])).toBeUndefined();
    expect(testCasesJql("ABC")).toBe('project = ABC AND labels in ("circuit-test", "test-case") ORDER BY key ASC');
    expect(sprintJql("ABC")).toContain("sprint in openSprints()");
  });
  it("parses JSON after a notice line and accepts the REST and flattened shapes", () => {
    expect(parseCliJson("Update available: acli 1.3\n[{\"key\":\"ABC-1\"}]")).toEqual([{ key: "ABC-1" }]);
    expect(parseCliJson("")).toBeUndefined();
    expect(parseCliJson("no json here")).toBeUndefined();
    const flat = normalizeIssues([{ key: "ABC-1", summary: "S", issueType: "Story", status: "To Do", labels: "a,b", parentKey: "ABC-0" }]);
    expect(flat[0]).toMatchObject({ key: "ABC-1", summary: "S", issueType: "Story", status: "To Do", labels: ["a", "b"], parentKey: "ABC-0" });
    expect(normalizeIssues({ data: { issues: [{ key: "ABC-2", fields: { summary: "x" } }] } })[0].key).toBe("ABC-2");
    expect(normalizeIssues({ workItems: [{ key: "bad" }, { key: "ABC-3" }] }).map((i) => i.key)).toEqual(["ABC-3"]);
    expect(normalizeIssues(null)).toEqual([]);
  });
  it("normalises the recorded fixtures", () => {
    expect(epics.map((e) => e.key)).toEqual(["ABC-10", "ABC-20"]);
    const s00 = byKey("ABC-11");
    expect(s00).toMatchObject({ summary: "Story 00: Foundation", issueType: "Story", status: "In Progress", statusCategory: "indeterminate", parentKey: "ABC-10" });
    expect(s00.links.find((l) => l.key === "ABC-12")).toMatchObject({ type: "Blocks", direction: "outward", phrase: "blocks", issueType: "Story" });
    expect(byKey("ABC-13").parentKey).toBe("ABC-10"); // flattened parent string
  });
  it("turns Atlassian Document Format into text", () => {
    expect(docText(byKey("ABC-11").fields.description)).toBe("Set up the escalation fields.\n## Acceptance criteria\nAC1: Escalation fields deploy cleanly");
    expect(docText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] })).toBe("a\nb");
    expect(docText("  ")).toBeUndefined();
    expect(docText(3)).toBe("3");
  });
  it("classifies a missing CLI, a missing login and other failures", async () => {
    const missing = fakeAcli([[/./, { code: 1, stderr: "'acli' is not recognized as an internal or external command" }]]);
    await expect(searchIssues(missing, "x")).rejects.toMatchObject({ kind: "missing" });
    const auth = fakeAcli([[/./, { code: 1, stderr: "Error: unauthorized. Please run acli jira auth login" }]]);
    const e = await searchIssues(auth, "x").catch((x) => x);
    expect(e).toBeInstanceOf(AcliError);
    expect(e.kind).toBe("auth");
    expect(e.message).toContain("acli jira auth login --web");
    const bad = fakeAcli([[/./, { code: 1, stderr: "Error: JQL invalid near 'foo'" }]]);
    await expect(searchIssues(bad, "x")).rejects.toMatchObject({ kind: "failed", message: "acli jira workitem search failed: Error: JQL invalid near 'foo'" });
    const empty = fakeAcli([[/./, { code: 0, stdout: "No work items found" }]]);
    expect(await acliJson(empty, ["jira"])).toEqual([]);
  });
  it("reads one issue with view", async () => {
    const a = fakeAcli([[/workitem view ABC-99/, { stdout: raw("acli/view-ABC-99.json") }]]);
    expect(await viewIssue(a, "ABC-99")).toMatchObject({ key: "ABC-99", summary: "Loose task", status: "Done", statusCategory: "done", description: "Not under an epic" });
    expect(a.calls[0]).toEqual(["jira", "workitem", "view", "ABC-99", "--fields", "*all", "--json"]);
  });
  it("reads the site from auth status without relying on an undocumented exit code", async () => {
    const ok = fakeAcli([[/auth status/, { stdout: "Authenticated\n  Site: acme.atlassian.net\n  Email: demo.user@example.com" }]]);
    expect(await authSite(ok)).toMatchObject({ loggedIn: true, site: "https://acme.atlassian.net" });
    const out = fakeAcli([[/auth status/, { code: 0, stdout: "You are not logged in" }]]);
    expect((await authSite(out)).loggedIn).toBe(false);
    const gone = fakeAcli([[/auth status/, { code: 1, stderr: "spawn acli ENOENT" }]]);
    expect(await authSite(gone)).toMatchObject({ loggedIn: false });
  });
});

describe("build.config.yml", () => {
  it("reads the Jira project, site, space, ready status, field ids and the environment ladder", () => {
    expect(cfg).toEqual({
      site: "https://acme.atlassian.net", projectKey: "ABC", spaceKey: "SD", readyStatus: "Ready for Dev",
      fields: { designPage: "customfield_10050", acceptanceCriteria: "customfield_10053" },
      environments: [
        { branch: "sprint/*", environment: "qa" }, { branch: "dev", environment: "dev" }, { branch: "sit", environment: "sit" },
        { branch: "uat", environment: "uat" }, { branch: "main", environment: "production" },
      ],
    });
    const empty = parseConfig(undefined);
    expect(empty).toMatchObject({ fields: {}, readyStatus: "Ready for Dev" });
    expect(empty.environments.map((e) => e.branch)).toEqual(["sprint/*", "dev", "sit", "uat", "main"]);
    expect(parseConfig("jira:\n  project_key: abc; drop\n  site: <site>\n").projectKey).toBeUndefined();
    expect(parseConfig("environments:\n  - { branch: release, environment: prod }\n  - { branch: 'a b', environment: x }\n").environments)
      .toEqual([{ branch: "release", environment: "prod" }]);
    expect(yamlValue("jira:\n  site: \"x.atlassian.net\" # note\n", "jira", "site")).toBe("x.atlassian.net");
  });
});

describe("stories and test cases", () => {
  it("keeps stories (not test cases, sub-tasks or epics), Story 00 first", () => {
    expect(storiesOf(children).map((s) => s.key)).toEqual(["ABC-11", "ABC-21", "ABC-12", "ABC-13", "ABC-14", "ABC-15"]);
    expect(orderStories([byKey("ABC-15"), byKey("ABC-12"), byKey("ABC-11")]).map((s) => s.key)).toEqual(["ABC-11", "ABC-12", "ABC-15"]);
  });
  it("finds the design page link in the field, the description or any custom field", () => {
    expect(designPageOf(byKey("ABC-10"), cfg.fields)).toEqual({ id: "123456", url: "https://acme.atlassian.net/wiki/spaces/SD/pages/123456/Case+escalation" });
    expect(designPageOf(byKey("ABC-20"), {})).toMatchObject({ id: "222222" });
    expect(confluencePage("see https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=42")).toMatchObject({ id: "42" });
    expect(confluencePage("https://evil.example/pages/1")).toBeUndefined();
  });
  it("reads story numbers, titles and acceptance criteria", () => {
    expect(storyNumOf(byKey("ABC-11"))).toBe("00");
    expect(storyNumOf(byKey("ABC-15"))).toBeUndefined();
    expect(storyTitleOf("Story 01: Agent escalates a Case")).toBe("Agent escalates a Case");
    expect(acceptanceCriteriaOf(byKey("ABC-11"), cfg.fields)).toBe("AC1: Escalation fields deploy cleanly");
    expect(acceptanceCriteriaOf(byKey("ABC-12"), cfg.fields)).toContain("AC1: Agent escalates with a reason");
  });
  it("links test cases to their story", () => {
    expect(testCasesOf(byKey("ABC-11"), tests)).toEqual(["ABC-31"]);
    expect(testCasesOf(byKey("ABC-12"), tests)).toEqual(["ABC-32", "ABC-33"]);
    expect(testCasesOf(byKey("ABC-21"), tests)).toEqual([]);
  });
});

/** A fake `claude -p` recording args and prompt. */
function fakeClaude(stdout: string, code = 0): ClaudeExec & { calls: { args: string[]; prompt: string }[] } {
  const calls: { args: string[]; prompt: string }[] = [];
  const f = (async (args: string[], prompt: string) => { calls.push({ args, prompt }); return { code, stdout, stderr: "" }; }) as any;
  f.calls = calls;
  return f;
}
const wrap = (o: unknown) => JSON.stringify({ type: "result", result: JSON.stringify(o) });

describe("the read-only Atlassian MCP reader", () => {
  it("lists circuit-design pages with status, open questions, slug and the Lucid diagram", async () => {
    const c = fakeClaude(raw("confluence/listing.json"));
    const pages = await readDesignPages(c, "SD");
    expect(pages).toEqual([
      { id: "123456", title: "Design: Case escalation", url: "https://acme.atlassian.net/wiki/spaces/SD/pages/123456/Case+escalation", status: "Approved", openQuestions: 0, slug: "case-escalation", diagramUrl: "https://lucid.app/lucidchart/0000-demo/view" },
      { id: "222222", title: "Design: Order sync", url: "https://acme.atlassian.net/wiki/spaces/SD/pages/222222/Order+sync", status: "In progress", openQuestions: 2, slug: "order-sync" },
      { id: "333333", title: "Design: Returns portal", url: "https://acme.atlassian.net/wiki/spaces/SD/pages/333333/Returns+portal", status: "Approved", openQuestions: 0, slug: "returns-portal" },
    ]);
    const args = c.calls[0].args;
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed.every((t) => /^mcp__(atlassian|claude_ai_Atlassian)__(searchConfluenceUsingCql|getConfluencePage|getAccessibleAtlassianResources)$/.test(t))).toBe(true);
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(c.calls[0].prompt).toContain('label = "circuit-design"');
    expect(() => designPagesPrompt('SD" OR 1=1')).toThrow();
    expect(normalizeDesignPages({ pages: [{ id: "1", title: "x", url: "http://insecure", openQuestions: -3 }] })).toEqual([{ id: "1", title: "x", openQuestions: 0 }]);
  });
  it("reads Jira through the MCP when acli is not installed", async () => {
    const c = fakeClaude(wrap({ issues: [{ key: "ABC-12", fields: { summary: "Story 01: x", issuetype: { name: "Story" }, status: { name: "Ready for Dev", statusCategory: { key: "new" } }, labels: [], parent: { key: "ABC-10" } } }] }));
    const list = await readJiraIssues(c, "project = ABC");
    expect(list[0]).toMatchObject({ key: "ABC-12", status: "Ready for Dev", statusCategory: "new", parentKey: "ABC-10" });
    const args = c.calls[0].args;
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(allowedTools(ATLASSIAN_SERVERS, ["searchJiraIssuesUsingJql", "getJiraIssue", "getAccessibleAtlassianResources"]).join(","));
    expect(() => jiraPrompt("a\nb")).toThrow();
    await expect(readJiraIssues(fakeClaude(wrap({ issues: [], error: "not signed in" })), "x")).rejects.toThrow("Jira: not signed in");
    expect(() => readerJson({ code: 1, stdout: "", stderr: "" })).toThrow(/not installed/);
  });
});
