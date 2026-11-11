// Setup wizard step handlers: automatic checks (CLI + GitHub/Jira/Confluence APIs), safe runs (always confirmed),
// secrets (password box or picked file, never logged), terminals for interactive tools, and Verify for human
// checkpoints. Production logins and approvals are never automated.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { CircuitServices, ConnectionId } from "../core/contracts";
import { gitBranch, parseJson, run } from "../core/util";
import { resolveClaude } from "../sessions/terminal";
import { parseBuildState, statusKind } from "./buildState";
import { FILE_SECRETS, installCommand, LABELS, parseInstallOutput, rulesetWithTeam, secretNameOk, TOOLS, variablesFor, versionOf } from "./commands";
import { readConfig, type BuildConfig } from "./config";
import { fillMcpUrls, type PhaseCtx, type StepDef } from "./phases";

export type ResultState = "ok" | "warn" | "err";
export interface StepResult { state: ResultState; text: string; at: string; lines?: string[] }

const TEAMS_DEFAULT = { architect: "architects", developer: "developers", tester: "testers" } as const;
const SPEC_KIT_SF_URL = "https://github.com/Evernorth/spec-kit-sf/archive/refs/tags/v2.0.1.zip";

const ok = (text: string, lines?: string[]): Omit<StepResult, "at"> => ({ state: "ok", text, lines });
const warn = (text: string, lines?: string[]): Omit<StepResult, "at"> => ({ state: "warn", text, lines });
const err = (text: string, lines?: string[]): Omit<StepResult, "at"> => ({ state: "err", text, lines });

export class SetupSteps {
  constructor(private s: CircuitServices, private log: (m: string) => void) {}

  // ---------- context ----------
  private get id() {
    const id = this.s.identity.get();
    if (!id) throw new Error("Sign in to GitHub first (Connections).");
    return id;
  }
  private get repoP() { return `/repos/${encodeURIComponent(this.id.owner)}/${encodeURIComponent(this.id.repo)}`; }
  file(rel: string) { return path.join(this.s.root, rel); }
  exists(rel: string) { return fs.existsSync(this.file(rel)); }

  config(): BuildConfig | undefined {
    const f = this.file("build.config.yml");
    if (!fs.existsSync(f)) return undefined;
    try { return readConfig(fs.readFileSync(f, "utf8")); } catch { return undefined; }
  }
  org(): string {
    const c = this.config();
    return c?.org && !/[<>]/.test(c.org) ? c.org : this.id.owner;
  }
  teams(): Record<"architect" | "developer" | "tester", string> {
    const t = vscode.workspace.getConfiguration("deliveryCircuit").get<Record<string, string>>("githubTeams") ?? {};
    return { architect: t.architect || TEAMS_DEFAULT.architect, developer: t.developer || TEAMS_DEFAULT.developer, tester: t.tester || TEAMS_DEFAULT.tester };
  }
  phaseCtx(): PhaseCtx {
    const id = this.s.identity.get();
    const c = this.config();
    return {
      owner: id?.owner ?? "", repo: id?.repo ?? "", org: c?.org && !/[<>]/.test(c.org) ? c.org : id?.owner ?? "",
      devUrl: c?.devUrl ?? "", qaUrl: c?.qaUrl ?? "", jiraSite: c?.jiraSite ?? "", jiraKey: c?.jiraKey ?? "", spaceKey: c?.spaceKey ?? "",
    };
  }

  // ---------- API helpers ----------
  private gh<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", p: string, body?: unknown): Promise<T> {
    return this.s.connections.githubRequest<T>(method, p, body);
  }
  private async tryGh<T = any>(p: string): Promise<{ data?: T; error?: string }> {
    try { return { data: await this.gh<T>("GET", p) }; } catch (e: any) { return { error: e?.message ?? String(e) }; }
  }
  private async secretNames(env?: string): Promise<string[]> {
    if (!env) return this.s.connections.repoSecretNames();
    const r = await this.tryGh<any>(`${this.repoP}/environments/${encodeURIComponent(env)}/secrets?per_page=100`);
    return (r.data?.secrets ?? []).map((x: any) => String(x.name));
  }
  private async variables(): Promise<Record<string, string>> {
    const r = await this.gh<any>("GET", `${this.repoP}/actions/variables?per_page=100`);
    return Object.fromEntries((r?.variables ?? []).map((v: any) => [String(v.name), String(v.value)]));
  }
  private async setVariable(name: string, value: string): Promise<void> {
    try { await this.gh("POST", `${this.repoP}/actions/variables`, { name, value }); }
    catch { await this.gh("PATCH", `${this.repoP}/actions/variables/${encodeURIComponent(name)}`, { name, value }); }
  }
  private async installations(): Promise<{ slugs: string[]; error?: string }> {
    const r = await this.tryGh<any>(`/orgs/${encodeURIComponent(this.org())}/installations?per_page=100`);
    return { slugs: (r.data?.installations ?? []).map((i: any) => String(i.app_slug)), error: r.error };
  }
  private async jiraFetch(p: string): Promise<any> {
    const j = await this.s.connections.jira();
    if (!j) throw new Error("Connect Jira on the Connections page first");
    const res = await fetch(j.site.replace(/\/$/, "") + p, {
      headers: { Authorization: "Basic " + Buffer.from(`${j.email}:${j.token}`).toString("base64"), Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${p}`);
    return res.json();
  }
  private async confirm(text: string, button: string, detail?: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(text, { modal: true, detail }, button)) === button;
  }
  private async secretsResult(names: readonly string[], env?: string): Promise<Omit<StepResult, "at">> {
    const have = new Set(await this.secretNames(env));
    const missing = names.filter((n) => !have.has(n));
    const where = env ? `environment ${env}` : "repository";
    return missing.length ? warn(`Missing ${where} secrets: ${missing.join(", ")}`) : ok(`All set on the ${where}: ${names.join(", ")}`);
  }

  // ---------- verify (automatic checks) ----------
  async verify(step: StepDef, ticks: boolean[]): Promise<Omit<StepResult, "at">> {
    const r = await this.verifyStep(step);
    if (step.kind === "human" && step.checklist?.length) {
      const done = step.checklist.filter((_, i) => ticks[i]).length;
      if (done < step.checklist.length && r.state === "ok") return warn(`${r.text}. Checklist ${done}/${step.checklist.length} ticked.`, r.lines);
    }
    return r;
  }

  private async verifyStep(step: StepDef): Promise<Omit<StepResult, "at">> {
    const id = this.id;
    const org = this.org();
    switch (step.id) {
      case "b0.tools": {
        const found: string[] = [];
        const missing: string[] = [];
        await Promise.all(TOOLS.map(async (t) => {
          const r = await run(t.cmd, t.args, { cwd: this.s.root, timeoutMs: 30_000 });
          const v = r.code === 0 ? versionOf(r.stdout + " " + r.stderr) : undefined;
          if (v) found.push(`${t.name} ${v}`); else if (t.required) missing.push(t.name); else found.push(`${t.name} missing (optional)`);
        }));
        const plugins = await run("sf", ["plugins"], { cwd: this.s.root, timeoutMs: 60_000, shell: false });
        const ca = plugins.stdout.match(/code-analyzer\s+(\d[\w.]*)/);
        const order = (x: string) => TOOLS.findIndex((t) => x.startsWith(t.name + " "));
        found.sort((a, b) => order(a) - order(b));
        const list = found.map((f) => (f.startsWith("sf ") && ca ? `${f} (code-analyzer ${ca[1]})` : f));
        if (!ca) missing.push("sf plugin code-analyzer");
        return missing.length ? err(`Missing: ${missing.join(", ")}`, list) : ok(list.join(", "), list);
      }
      case "b0.gh": {
        const r = await run("gh", ["auth", "status"], { timeoutMs: 30_000 });
        const out = r.stdout + "\n" + r.stderr;
        const scopes = (out.match(/Token scopes:\s*(.+)/)?.[1] ?? "").replace(/'/g, "").split(/\s*,\s*/).filter(Boolean);
        const need = ["repo", "admin:org", "workflow"].filter((x) => !scopes.includes(x));
        const lines = [`gh: ${r.code === 0 ? "signed in" : "not signed in"}; scopes ${scopes.join(", ") || "unknown"}`, `You: ${id.login}, ${id.isAdmin ? "admin" : "not an admin"} of ${id.owner}/${id.repo}`];
        if (r.code !== 0) return err("gh is not signed in: run gh auth login", lines);
        if (need.length) return warn(`gh token lacks ${need.join(", ")}: run gh auth refresh -s admin:org,workflow`, lines);
        return id.isAdmin ? ok("gh scopes and admin access OK", lines) : warn("You are not an admin of this repository", lines);
      }
      case "b0.config": {
        const c = this.config();
        if (!c) return err("build.config.yml does not exist yet (the installer dry run creates it, or save the form)");
        const gaps: string[] = [];
        if (!c.org || /[<>]/.test(c.org)) gaps.push("github.org");
        if (!c.repo) gaps.push("github.repo");
        for (const k of ["architects", "developers", "testers"] as const) if (!c.people[k].length) gaps.push(`people.${k}`);
        if (!c.jiraSite || /[<>]/.test(c.jiraSite)) gaps.push("jira.site");
        return gaps.length ? warn(`Still empty: ${gaps.join(", ")}`) : ok("Filled");
      }
      case "b0.hc1": {
        const want: ConnectionId[] = ["github", "jira", "confluence", "sf-dev", "sf-qa", "slack"];
        const list = await this.s.connections.list().catch(() => []);
        const lines = want.map((w) => { const c = list.find((x) => x.id === w); return `${c?.label ?? w}: ${c?.state ?? "unknown"}${c?.detail ? " (" + c.detail + ")" : ""}`; });
        const gh = list.find((x) => x.id === "github");
        return gh?.state === "connected" ? ok("GitHub connected", lines) : warn("Connect GitHub on the Connections page", lines);
      }
      case "b1.teams": {
        const c = this.config();
        const t = this.teams();
        const lines: string[] = [];
        const members: Record<string, string[]> = {};
        let bad = false;
        for (const [persona, slug] of Object.entries(t)) {
          const team = await this.tryGh(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`);
          if (!team.data) { lines.push(`${slug}: missing`); bad = true; continue; }
          const m = await this.tryGh<any[]>(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members?per_page=100`);
          members[slug] = (m.data ?? []).map((x: any) => String(x.login).toLowerCase());
          const want = (c?.people[`${persona}s` as "architects"] ?? []).map((p) => p.gh.toLowerCase());
          const absent = want.filter((w) => !members[slug].includes(w));
          const perm = await this.tryGh(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/repos/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}`);
          lines.push(`${slug}: ${members[slug].length} member(s)${absent.length ? `, not yet in team: ${absent.join(", ")}` : ""}${perm.data ? ", has repo access" : ", no repo access"}`);
          if (absent.length || !perm.data) bad = true;
        }
        const all = Object.entries(members).flatMap(([slug, ms]) => ms.map((m) => [m, slug]));
        const dup = all.filter(([m], i) => all.findIndex(([x]) => x === m) !== i).map(([m]) => m);
        if (dup.length) return err(`Teams are not disjoint: ${[...new Set(dup)].join(", ")}`, lines);
        return bad ? warn("Teams incomplete", lines) : ok("Teams, members and repo access OK", lines);
      }
      case "b1.labels": {
        const have = new Set(((await this.gh<any[]>("GET", `${this.repoP}/labels?per_page=100`)) ?? []).map((l: any) => String(l.name)));
        const missing = LABELS.filter((l) => !have.has(l.name)).map((l) => l.name);
        return missing.length ? warn(`Missing labels: ${missing.join(", ")}`) : ok(`All ${LABELS.length} labels exist`);
      }
      case "b1.hc2": {
        const sec = await this.secretsResult(["APP_ID", "APP_PRIVATE_KEY"]);
        const inst = await this.installations();
        const lines = [inst.error ? `Installed apps: not readable (${inst.error})` : `Installed apps: ${inst.slugs.join(", ") || "none"}`];
        return { ...sec, lines };
      }
      case "b1.app": return this.secretsResult(["APP_ID", "APP_PRIVATE_KEY"]);
      case "b1.hc3": {
        const names = await this.secretNames();
        if (names.includes("ANTHROPIC_API_KEY")) return err("ANTHROPIC_API_KEY is set as a repository secret. Delete it: the circuit uses subscription auth only.");
        return names.includes("CLAUDE_CODE_OAUTH_TOKEN") ? ok("CLAUDE_CODE_OAUTH_TOKEN set; no ANTHROPIC_API_KEY") : warn("CLAUDE_CODE_OAUTH_TOKEN is not set");
      }
      case "b1.vars": {
        const c = this.config();
        if (!c) return err("build.config.yml is missing");
        const have = await this.variables();
        const want = variablesFor(c);
        const diff = want.filter((w) => have[w.name] !== w.value);
        const lines = want.map((w) => `${w.name} = ${have[w.name] ?? "(not set)"}${have[w.name] !== w.value ? `  (expected ${w.value})` : ""}`);
        return diff.length ? warn(`${diff.length} variable(s) differ`, lines) : ok("All variables set", lines);
      }
      case "b1.env": {
        const r = await this.tryGh(`${this.repoP}/environments/production`);
        return r.data ? ok("Environment production exists") : warn("Environment production does not exist");
      }
      case "b2.orgs": {
        const lines: string[] = [];
        let bad = false;
        for (const role of ["dev", "qa"] as const) {
          const alias = this.s.connections.sfAlias(role);
          const r = await run("sf", ["org", "display", "--target-org", alias, "--json"], { cwd: this.s.root, timeoutMs: 60_000, shell: false });
          const j = parseJson<any>(r.stdout)?.result;
          if (r.code === 0 && j) lines.push(`${role} (${alias}): ${j.username ?? "?"} at ${j.instanceUrl ?? "?"}, ${j.connectedStatus ?? "unknown"}`);
          else { lines.push(`${role} (${alias}): not available`); bad = true; }
        }
        return bad ? warn("An org alias is not connected", lines) : ok("dev and qa connected", lines);
      }
      case "b2.hc4": {
        const lines: string[] = [];
        let good = 0;
        for (const alias of ["ci-dev-test", "ci-qa-test"]) {
          const r = await run("sf", ["org", "display", "--target-org", alias, "--json"], { cwd: this.s.root, timeoutMs: 60_000, shell: false });
          const j = parseJson<any>(r.stdout)?.result;
          if (r.code === 0 && j) { good++; lines.push(`${alias}: ${j.username} (JWT login works)`); } else lines.push(`${alias}: no JWT test login yet`);
        }
        return good === 2 ? ok("JWT logins work for DEV and QA", lines)
          : warn("Test with: sf org login jwt --client-id <key> --username <user> --jwt-key-file ~/.sfkeys/dev.key --instance-url <login url> --alias ci-dev-test (same for qa)", lines);
      }
      case "b2.secrets": return this.secretsResult(step.secrets ?? []);
      case "b2.hc5": {
        const envNames = await this.secretNames("production");
        const repoNames = await this.secretNames();
        const want = step.secrets ?? [];
        const missing = want.filter((n) => !envNames.includes(n));
        const leaked = want.filter((n) => repoNames.includes(n));
        const lines = [`docs/prod-access-steps.md: ${this.exists("docs/prod-access-steps.md") ? "present" : "missing"}`];
        if (leaked.length) return err(`Production secrets must not be repository secrets: ${leaked.join(", ")}`, lines);
        return missing.length ? warn(`Missing on environment production: ${missing.join(", ")}`, lines) : ok("Production secrets are on the production environment only", lines);
      }
      case "b3.branch": return this.branchResult("pipeline/foundation");
      case "b3.install": {
        const want = ["CLAUDE.md", ".claude/hooks/circuit-guard.mjs", ".claude/agents/architect.md", ".claude/agents/developer.md", ".claude/agents/tester.md",
          ".claude/personas/architect.mcp.json", ".github/CODEOWNERS", ".coderabbit.yaml", "scripts/ci", ".specify/extensions/sf/sf-config.yml"];
        const missing = want.filter((w) => !this.exists(w));
        const lines = want.map((w) => `${this.exists(w) ? "present" : "missing"}  ${w}`);
        return missing.length ? warn(`${missing.length} file(s) missing`, lines) : ok("Circuit files present", lines);
      }
      case "b3.mcp": {
        const dir = this.file(".claude/personas");
        if (!fs.existsSync(dir)) return err(".claude/personas does not exist (run the installer)");
        const lines: string[] = [];
        for (const f of fs.readdirSync(dir).filter((x) => /\.mcp\.json$/.test(x) && !/\.local\./.test(x))) {
          const t = fs.readFileSync(path.join(dir, f), "utf8");
          const n = (t.match(/"VERIFY/g) ?? []).length;
          lines.push(`${f}: ${n ? `${n} VERIFY placeholder(s)` : "OK"}`);
        }
        return lines.some((l) => /VERIFY/.test(l)) ? warn("VERIFY placeholders remain", lines) : ok("All persona MCP URLs filled", lines);
      }
      case "b3.pr": return this.prResult("pipeline/foundation");
      case "b4.skills": {
        const left = ["deploy", "hotfix", "pr"].filter((x) => this.exists(`.claude/skills/speckit-sf-${x}`));
        return left.length ? warn(`Still present: ${left.map((x) => "speckit-sf-" + x).join(", ")}`) : ok("Deploy, hotfix and PR skills removed");
      }
      case "b4.check": {
        const lines: string[] = [];
        const has = this.exists(".specify");
        lines.push(`.specify/: ${has ? "present" : "missing"}`);
        const ext = this.exists(".specify/extensions/sf/extension.yml") ? fs.readFileSync(this.file(".specify/extensions/sf/extension.yml"), "utf8").match(/version:\s*"?([\d.]+)"?/)?.[1] : undefined;
        lines.push(`spec-kit-sf: ${ext ?? "not installed"}`);
        const cfg = this.exists(".specify/extensions/sf/sf-config.yml") ? fs.readFileSync(this.file(".specify/extensions/sf/sf-config.yml"), "utf8") : "";
        const prodNone = /prod:\s*"?none"?/.test(cfg);
        lines.push(`sf-config prod: ${prodNone ? "none" : cfg ? "NOT none" : "file missing"}`);
        lines.push(`constitution: ${this.exists(".specify/memory/constitution.md") ? "present" : "missing"}`);
        if (!has || !ext) return err("Spec Kit or spec-kit-sf is not installed", lines);
        if (!prodNone) return err("sf-config.yml must have prod: \"none\"", lines);
        return ext === "2.0.1" ? ok(`spec-kit-sf ${ext}`, lines) : warn(`spec-kit-sf ${ext} (the circuit was verified with 2.0.1)`, lines);
      }
      case "b4.constitution": {
        const f = ".specify/memory/constitution.md";
        if (!this.exists(f)) return warn("No constitution yet");
        const t = fs.readFileSync(this.file(f), "utf8");
        return /Article\s+X\b/i.test(t) ? ok("Constitution with Article X") : warn("Constitution has no Article X (house rules) yet");
      }
      case "b5.hc6": return this.secretsResult(step.secrets ?? []);
      case "b5.setup": {
        const c = this.config();
        if (!c?.jiraKey) return err("Set jira.project_key in build.config.yml");
        const project = await this.jiraFetch(`/rest/api/3/project/${encodeURIComponent(c.jiraKey)}`);
        const statuses = await this.jiraFetch(`/rest/api/3/project/${encodeURIComponent(c.jiraKey)}/statuses`);
        const names = new Set<string>((statuses ?? []).flatMap((t: any) => (t.statuses ?? []).map((s: any) => String(s.name).toLowerCase())));
        const wantS = ["Backlog", "Design Review", "Design Approved", "Ready for Dev", "Plan Review", "In Build", "Code Review", "QA", "Ready to Merge", "Done"];
        const fields = await this.jiraFetch("/rest/api/3/field");
        const fnames = new Set<string>((fields ?? []).map((f: any) => String(f.name).toLowerCase()));
        const wantF = ["Spec file", "Feature", "Story type", "Schema change", "Persona", "Test level", "AC id", "Testability confirmed", "Acceptance criteria"];
        const ms = wantS.filter((x) => !names.has(x.toLowerCase()));
        const mf = wantF.filter((x) => !fnames.has(x.toLowerCase()));
        const lines = [`Project ${project?.key} (${project?.name}), ${project?.style ?? ""}`.trim(), `Missing statuses: ${ms.join(", ") || "none"}`, `Missing fields: ${mf.join(", ") || "none"}`,
          "Transition restrictions cannot be read by API: try moving a test issue as a non-tester."];
        return ms.length || mf.length ? warn("Jira project incomplete", lines) : ok("Statuses and fields exist", lines);
      }
      case "b5.hc7": {
        const r = await this.tryGh<any>(`${this.repoP}/actions/runs?event=repository_dispatch&per_page=5`);
        if (r.error) return warn(`Could not read workflow runs: ${r.error}`);
        const n = r.data?.total_count ?? 0;
        return n ? ok(`${n} repository_dispatch run(s): Rule A reaches GitHub`) : warn("No repository_dispatch run yet. Trigger Rule A once (temporary echo workflow) and check its audit log shows 204.");
      }
      case "b5.app": {
        const inst = await this.installations();
        if (inst.error) return warn(`Installed apps not readable: ${inst.error}`);
        return inst.slugs.some((s) => /jira/.test(s)) ? ok("GitHub for Jira installed") : warn("GitHub for Jira is not installed on the org");
      }
      case "b6.space": {
        const c = this.config();
        if (!c?.spaceKey) return err("Set confluence.space_key in build.config.yml");
        const r = await this.jiraFetch(`/wiki/api/v2/spaces?keys=${encodeURIComponent(c.spaceKey)}`);
        const sp = r?.results?.[0];
        return sp ? ok(`Space ${sp.key}: ${sp.name}`) : warn(`Space ${c.spaceKey} not found`);
      }
      case "b6.hc": {
        const ids: ConnectionId[] = ["confluence", "lucid", "fireflies", "mcp-lucid", "mcp-fireflies", "mcp-atlassian"];
        const lines: string[] = [];
        for (const cid of ids) {
          const st = await this.s.connections.check(cid).catch(() => undefined);
          lines.push(`${st?.label ?? cid}: ${st?.state ?? "unknown"}${st?.detail ? " (" + st.detail + ")" : ""}`);
        }
        return lines.some((l) => /: (disconnected|error)/.test(l)) ? warn("Some connections are missing (these are checked for you; the Architect checks their own)", lines) : ok("Connected", lines);
      }
      case "b7.hc": return this.secretsResult(step.secrets ?? []);
      case "b8.branch": {
        const wf = await this.tryGh<any>(`${this.repoP}/actions/workflows`);
        if ((wf.data?.total_count ?? 0) >= 8) return ok(`${wf.data.total_count} workflows already on GitHub`);
        return this.branchResult("pipeline/workflows");
      }
      case "b8.lint": {
        const dir = this.file(".github/workflows");
        if (!fs.existsSync(dir)) return err(".github/workflows does not exist");
        const files = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
        if (!files.length) return err("No workflow files");
        const r = await run("actionlint", files, { cwd: this.s.root, timeoutMs: 120_000 });
        const out = (r.stdout + r.stderr).trim().split(/\r?\n/).filter(Boolean);
        if (r.code === 0) return ok(`actionlint clean (${files.length} files)`);
        return /not recognized|not found|ENOENT/i.test(out.join(" ")) ? err("actionlint is not installed") : err(`${out.length} actionlint finding(s)`, out.slice(0, 30));
      }
      case "b8.coderabbit": {
        const inst = await this.installations();
        if (inst.error) return warn(`Installed apps not readable: ${inst.error}`);
        return inst.slugs.includes("coderabbitai") ? ok("CodeRabbit installed") : warn("CodeRabbit is not installed");
      }
      case "b8.pr": {
        const wf = await this.tryGh<any>(`${this.repoP}/actions/workflows`);
        const names = (wf.data?.workflows ?? []).map((w: any) => String(w.name));
        return names.length >= 8 ? ok(`${names.length} workflows active`, names) : warn(`${names.length} workflow(s) on GitHub; 8 expected after the PR is merged`, names);
      }
      case "b9.rulesets": {
        const rs = await this.tryGh<any[]>(`${this.repoP}/rulesets?per_page=100`);
        if (rs.error) return warn(`Rulesets not readable: ${rs.error}`);
        const names = (rs.data ?? []).map((r: any) => String(r.name));
        const missing = ["circuit-main-gates", "circuit-merge-architects-only"].filter((n) => !names.includes(n));
        return missing.length ? warn(`Missing rulesets: ${missing.join(", ")}`, names) : ok("Both rulesets active", names);
      }
      case "b9.env": {
        const e = await this.tryGh<any>(`${this.repoP}/environments/production`);
        if (!e.data) return warn("Environment production does not exist");
        const rr = (e.data.protection_rules ?? []).find((p: any) => p.type === "required_reviewers");
        const teams = (rr?.reviewers ?? []).filter((r: any) => r.type === "Team").map((r: any) => String(r.reviewer?.slug));
        const lines = [`Reviewers: ${teams.join(", ") || "none"}`, `Prevent self-review: ${rr?.prevent_self_review ? "yes" : "no"}`,
          `Branch policy: ${e.data.deployment_branch_policy ? (e.data.deployment_branch_policy.custom_branch_policies ? "selected branches" : "protected branches") : "any branch"}`];
        return teams.includes(this.teams().architect) && rr?.prevent_self_review && e.data.deployment_branch_policy ? ok("Production needs an architect's approval", lines) : warn("Production is not fully protected", lines);
      }
      case "b9.tag": {
        const rs = await this.tryGh<any[]>(`${this.repoP}/rulesets?per_page=100`);
        const tag = (rs.data ?? []).filter((r: any) => r.target === "tag");
        return tag.length ? ok(`Tag ruleset: ${tag.map((t: any) => t.name).join(", ")}`) : warn("No tag ruleset yet");
      }
      case "b10.people": {
        const t = this.teams();
        const lines: string[] = [];
        for (const slug of Object.values(t)) {
          const m = await this.tryGh<any[]>(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members?per_page=100`);
          lines.push(`${slug}: ${(m.data ?? []).map((x: any) => x.login).join(", ") || "no members"}`);
        }
        const mine = await this.s.connections.list().catch(() => []);
        const off = mine.filter((c) => c.state !== "connected" && c.neededBy.some((p) => id.personas.includes(p)));
        lines.push(`Your connections not connected: ${off.map((c) => c.label).join(", ") || "none"}`);
        return ok("Each person confirms on their own Connections page", lines);
      }
      case "b11.vars": {
        const v = await this.variables();
        const env = await this.tryGh(`${this.repoP}/environments/production-dryrun`);
        const lines = [`DEPLOY_ENVIRONMENT = ${v.DEPLOY_ENVIRONMENT ?? "(not set)"}`, `AI_LOOP_DRY_RUN = ${v.AI_LOOP_DRY_RUN ?? "(not set)"}`, `environment production-dryrun: ${env.data ? "exists" : "missing"}`];
        return v.DEPLOY_ENVIRONMENT === "production-dryrun" && v.AI_LOOP_DRY_RUN === "false" && env.data ? ok("Dry-run settings active", lines) : warn("Dry-run settings not active", lines);
      }
      case "b11.hc9": return this.prResult("intake/sample");
      case "b11.cleanup": {
        const v = await this.variables();
        return v.DEPLOY_ENVIRONMENT === "production-dryrun" ? warn("DEPLOY_ENVIRONMENT still points at production-dryrun") : ok("Deploys target production again");
      }
      case "b12.live": {
        const f = this.file("build-state.md");
        const st = fs.existsSync(f) ? parseBuildState(fs.readFileSync(f, "utf8")) : undefined;
        const open = (st?.rows ?? []).filter((r) => r.id !== "B12" && statusKind(r.status) !== "done").map((r) => r.id);
        return open.length ? warn(`Not DONE yet: ${open.join(", ")}`) : ok("B0-B11 are DONE");
      }
      default:
        return warn("No automatic check for this step");
    }
  }

  private async branchResult(branch: string): Promise<Omit<StepResult, "at">> {
    const cur = await gitBranch(this.s.root);
    if (cur === branch) return ok(`On ${branch}`);
    const pr = await this.prResult(branch);
    return pr.state === "ok" ? pr : warn(`On ${cur || "unknown"}, not ${branch}`);
  }

  private async prResult(branch: string): Promise<Omit<StepResult, "at">> {
    const id = this.id;
    const prs = await this.tryGh<any[]>(`${this.repoP}/pulls?state=all&head=${encodeURIComponent(`${id.owner}:${branch}`)}&per_page=10`);
    if (prs.error) return warn(`Pull requests not readable: ${prs.error}`);
    const pr = (prs.data ?? [])[0];
    if (!pr) return warn(`No PR from ${branch} yet`);
    const lines = [`#${pr.number} ${pr.title}`, pr.html_url];
    if (pr.merged_at) return ok(`PR #${pr.number} merged`, lines);
    return warn(`PR #${pr.number} is ${pr.state}${pr.draft ? " (draft)" : ""}, not merged`, lines);
  }

  // ---------- runs (safe automatic steps, always confirmed) ----------
  async run(step: StepDef): Promise<Omit<StepResult, "at"> | undefined> {
    const id = this.id;
    const org = this.org();
    switch (step.id) {
      case "b0.tools": return undefined; // recording is handled by the panel (needs the last result)
      case "b0.dryrun": return this.install(true);
      case "b3.install": {
        const dry = await this.install(true);
        if (dry.state === "err") return dry;
        const p = parseInstallOutput((dry.lines ?? []).join("\n"));
        const branch = await gitBranch(this.s.root);
        const detail = `Add ${p.add.length}, update/merge ${p.update.length}, skip ${p.skip.length} existing file(s).${p.warn.length ? "\n" + p.warn.join("\n") : ""}\nBranch: ${branch}`;
        if (/^(main|master)$/.test(branch)) return err("Switch to pipeline/foundation first: the installer never writes on main");
        if (!(await this.confirm(`Install the delivery circuit into ${id.owner}/${id.repo}?`, "Install", detail))) return undefined;
        return this.install(false);
      }
      case "b1.teams": {
        const c = this.config();
        if (!c) return err("build.config.yml is missing");
        const t = this.teams();
        const plan = (Object.entries(t) as ["architect" | "developer" | "tester", string][]).map(([p, slug]) => ({ slug, people: c.people[`${p}s` as "architects"].map((x) => x.gh) }));
        const all = plan.flatMap((x) => x.people.map((u) => u.toLowerCase()));
        const dup = all.filter((u, i) => all.indexOf(u) !== i);
        if (dup.length) return err(`Fix build.config.yml first: ${[...new Set(dup)].join(", ")} in more than one team`);
        const detail = plan.map((x) => `${x.slug}: ${x.people.join(", ") || "(nobody yet)"}; push on ${id.owner}/${id.repo}`).join("\n");
        if (!(await this.confirm(`Create the persona teams in ${org} and add members as ${id.login}?`, "Create", detail))) return undefined;
        const lines: string[] = [];
        for (const x of plan) {
          const exists = await this.tryGh(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(x.slug)}`);
          if (!exists.data) { await this.gh("POST", `/orgs/${encodeURIComponent(org)}/teams`, { name: x.slug, privacy: "closed" }); lines.push(`created team ${x.slug}`); }
          for (const user of x.people) {
            await this.gh("PUT", `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(x.slug)}/memberships/${encodeURIComponent(user)}`, { role: "member" });
            lines.push(`${user} -> ${x.slug}`);
          }
          await this.gh("PUT", `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(x.slug)}/repos/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}`, { permission: "push" });
          lines.push(`${x.slug}: push on ${id.repo}`);
        }
        return ok("Teams ready (invitations may need accepting)", lines);
      }
      case "b1.labels": {
        const have = new Set(((await this.gh<any[]>("GET", `${this.repoP}/labels?per_page=100`)) ?? []).map((l: any) => String(l.name)));
        const missing = LABELS.filter((l) => !have.has(l.name));
        if (!missing.length) return ok("All labels already exist");
        if (!(await this.confirm(`Create ${missing.length} label(s) in ${id.owner}/${id.repo}?`, "Create", missing.map((l) => l.name).join(", ")))) return undefined;
        for (const l of missing) await this.gh("POST", `${this.repoP}/labels`, l);
        return ok(`Created ${missing.map((l) => l.name).join(", ")}`);
      }
      case "b1.vars": {
        const c = this.config();
        if (!c) return err("build.config.yml is missing");
        const vars = variablesFor(c);
        if (!(await this.confirm(`Set ${vars.length} repository variables on ${id.owner}/${id.repo}?`, "Set", vars.map((v) => `${v.name} = ${v.value}`).join("\n")))) return undefined;
        for (const v of vars) await this.setVariable(v.name, v.value);
        return ok("Variables set", vars.map((v) => `${v.name} = ${v.value}`));
      }
      case "b1.env": {
        if (!(await this.confirm(`Create the environment production on ${id.owner}/${id.repo}?`, "Create"))) return undefined;
        await this.gh("PUT", `${this.repoP}/environments/production`, {});
        return ok("Environment production exists");
      }
      case "b2.keys": {
        const dir = path.join(os.homedir(), ".sfkeys");
        const todo = ["dev", "qa"].filter((r) => !fs.existsSync(path.join(dir, `${r}.key`)));
        if (!todo.length) return ok("dev.key and qa.key already exist in ~/.sfkeys");
        if (!(await this.confirm(`Create ${todo.map((r) => r + ".key/.crt").join(" and ")} in ${dir}?`, "Create", "RSA 2048, self-signed, 730 days. The .key files stay on this machine; delete them after the secrets are stored."))) return undefined;
        fs.mkdirSync(dir, { recursive: true });
        const lines: string[] = [];
        for (const r of todo) {
          const res = await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${r}.key`, "-out", `${r}.crt`, "-days", "730", "-subj", `/CN=delivery-${r}`], { cwd: dir, timeoutMs: 60_000 });
          if (res.code !== 0) return err(`openssl failed for ${r}`, res.stderr.trim().split(/\r?\n/).slice(-3));
          lines.push(`${dir}${path.sep}${r}.crt (upload to the ${r.toUpperCase()} External Client App)`);
        }
        return ok("Key pairs created", lines);
      }
      case "b3.branch": return this.switchBranch("pipeline/foundation");
      case "b8.branch": return this.switchBranch("pipeline/workflows");
      case "b3.mcp": {
        const dir = this.file(".claude/personas");
        if (!fs.existsSync(dir)) return err(".claude/personas does not exist (run the installer)");
        const files = fs.readdirSync(dir).filter((x) => /\.mcp\.json$/.test(x) && !/\.local\./.test(x));
        const changes = files.map((f) => ({ f, r: fillMcpUrls(fs.readFileSync(path.join(dir, f), "utf8")) })).filter((x) => x.r.changed.length || x.r.unknown.length);
        if (!changes.some((x) => x.r.changed.length)) return changes.length ? warn(`Unknown placeholders: ${changes.flatMap((x) => x.r.unknown).join(", ")}`) : ok("Nothing to fill");
        const detail = changes.map((x) => `${x.f}: ${x.r.changed.join(", ")}`).join("\n");
        if (!(await this.confirm("Fill the verified MCP URLs in the persona configs?", "Fill", detail))) return undefined;
        for (const x of changes) if (x.r.changed.length) fs.writeFileSync(path.join(dir, x.f), x.r.text, "utf8");
        const unknown = changes.flatMap((x) => x.r.unknown);
        return unknown.length ? warn(`Filled; still to check by hand: ${unknown.join(", ")}`, detail.split("\n")) : ok("Persona MCP URLs filled", detail.split("\n"));
      }
      case "b4.skills": {
        const left = ["deploy", "hotfix", "pr"].map((x) => `.claude/skills/speckit-sf-${x}`).filter((x) => this.exists(x));
        if (!left.length) return ok("Already removed");
        if (!(await this.confirm("Delete these skill folders?", "Delete", left.join("\n")))) return undefined;
        for (const x of left) fs.rmSync(this.file(x), { recursive: true, force: true });
        return ok(`Removed ${left.join(", ")}`);
      }
      case "b9.rulesets": {
        const archSlug = this.teams().architect;
        const team = await this.gh<any>("GET", `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(archSlug)}`);
        const dir = path.join(this.s.pluginRoot, "templates", "github");
        const payloads = ["ruleset-main.json", "ruleset-merge-architects.json"].map((f) => rulesetWithTeam(fs.readFileSync(path.join(dir, f), "utf8"), Number(team.id)));
        const existing = new Set(((await this.tryGh<any[]>(`${this.repoP}/rulesets?per_page=100`)).data ?? []).map((r: any) => String(r.name)));
        const todo = payloads.filter((p) => !existing.has(p.name));
        if (!todo.length) return ok("Both rulesets already exist");
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(todo, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: true });
        if (!(await this.confirm(`HC-8: create ${todo.map((p) => p.name).join(" and ")} on ${id.owner}/${id.repo}?`, "Create rulesets", "The payloads are open in the editor. After this, only architects can merge into main, through a PR with every gate green."))) return undefined;
        for (const p of todo) await this.gh("POST", `${this.repoP}/rulesets`, p);
        return ok(`Created ${todo.map((p) => p.name).join(", ")}`);
      }
      case "b9.env": {
        const slug = this.teams().architect;
        const team = await this.gh<any>("GET", `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`);
        if (!(await this.confirm(`Protect environment production on ${id.owner}/${id.repo}?`, "Protect", `Required reviewers: team ${slug}; prevent self-review; deployments from main only.`))) return undefined;
        await this.gh("PUT", `${this.repoP}/environments/production`, {
          reviewers: [{ type: "Team", id: Number(team.id) }], prevent_self_review: true,
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        });
        try { await this.gh("POST", `${this.repoP}/environments/production/deployment-branch-policies`, { name: "main", type: "branch" }); }
        catch (e: any) { if (!/exist|already/i.test(e?.message ?? "")) throw e; }
        return ok("Production requires an architect's approval from main");
      }
      case "b11.vars": {
        if (!(await this.confirm("Switch deploys to the dry-run environment?", "Set", "DEPLOY_ENVIRONMENT = production-dryrun\nAI_LOOP_DRY_RUN = false\nCreates environment production-dryrun if missing (store QA secrets under the PROD names there)."))) return undefined;
        await this.gh("PUT", `${this.repoP}/environments/production-dryrun`, {});
        await this.setVariable("DEPLOY_ENVIRONMENT", "production-dryrun");
        await this.setVariable("AI_LOOP_DRY_RUN", "false");
        return ok("Dry-run settings active");
      }
      case "b11.cleanup": {
        if (!(await this.confirm("Remove DEPLOY_ENVIRONMENT so deploys target production again?", "Reset"))) return undefined;
        try { await this.gh("DELETE", `${this.repoP}/actions/variables/DEPLOY_ENVIRONMENT`); } catch (e: any) { if (!/not found|404/i.test(e?.message ?? "")) throw e; }
        return ok("DEPLOY_ENVIRONMENT removed");
      }
      default:
        return warn("Nothing to run for this step");
    }
  }

  private async install(dryRun: boolean): Promise<Omit<StepResult, "at">> {
    const org = this.org();
    const c = installCommand({ pluginRoot: this.s.pluginRoot, root: this.s.root, org, dryRun, platform: process.platform });
    if (!fs.existsSync(c.script)) return err(`Installer not found in the bundled plugin: ${c.script}`);
    if (!fs.existsSync(this.file(".git"))) return err("The workspace is not a git repository");
    this.log(`setup: installer ${dryRun ? "dry run" : "run"} for org ${org}`);
    const r = await run(c.cmd, c.args, { cwd: c.cwd, timeoutMs: 180_000 });
    const lines = (r.stdout + "\n" + r.stderr).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (r.code !== 0) return err(`Installer exited with ${r.code}`, lines);
    const p = parseInstallOutput(r.stdout);
    return ok(`${dryRun ? "Dry run: " : ""}add ${p.add.length}, update ${p.update.length}, skip ${p.skip.length}${p.warn.length ? `, ${p.warn.length} warning(s)` : ""}`, lines);
  }

  private async switchBranch(branch: string): Promise<Omit<StepResult, "at"> | undefined> {
    const cur = await gitBranch(this.s.root);
    if (cur === branch) return ok(`Already on ${branch}`);
    const exists = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.s.root, shell: false })).code === 0;
    if (!(await this.confirm(`${exists ? "Switch to" : "Create and switch to"} ${branch}?`, "Switch", `Current branch: ${cur}. Uncommitted changes move with you.`))) return undefined;
    const r = await run("git", exists ? ["switch", branch] : ["switch", "-c", branch], { cwd: this.s.root, timeoutMs: 60_000, shell: false });
    return r.code === 0 ? ok(`On ${branch}`) : err(`git switch failed`, r.stderr.trim().split(/\r?\n/).slice(-3));
  }

  // ---------- secrets ----------
  async setSecret(step: StepDef, name: string): Promise<Omit<StepResult, "at"> | undefined> {
    if (!(step.secrets ?? []).includes(name) || !secretNameOk(name)) throw new Error(`${name} is not a secret of this step`);
    const env = step.env;
    const where = env ? `environment ${env}` : `${this.id.owner}/${this.id.repo}`;
    let value: string | undefined;
    let file: string | undefined;
    if (FILE_SECRETS.has(name)) {
      const pick = await vscode.window.showOpenDialog({ title: `${name}: pick the private key file`, canSelectMany: false, openLabel: "Use this file",
        defaultUri: vscode.Uri.file(path.join(os.homedir(), name.startsWith("SF_") ? ".sfkeys" : "Downloads")), filters: { "Private key": ["pem", "key"], "All files": ["*"] } });
      if (!pick?.[0]) return undefined;
      file = pick[0].fsPath;
      value = fs.readFileSync(file, "utf8");
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) throw new Error("That file is not a PEM private key");
    } else {
      value = await vscode.window.showInputBox({ title: `${name} for ${where}`, prompt: "The value goes straight to GitHub (encrypted with the repository key). It is not shown, stored or logged here.",
        password: true, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? null : "Required") });
      if (value === undefined) return undefined;
      value = value.trim();
    }
    await this.s.connections.setRepoSecret(name, value, env);
    value = undefined;
    this.log(`setup: secret ${name} set on ${where} by ${this.id.login}`);
    if (file) {
      const del = await vscode.window.showWarningMessage(`${name} stored. Delete ${path.basename(file)} from this machine now?`, { modal: true, detail: file }, "Delete file", "Keep");
      if (del === "Delete file") { fs.rmSync(file, { force: true }); this.log(`setup: deleted the key file used for ${name}`); }
    }
    return ok(`${name} stored on ${where}`);
  }

  // ---------- terminals (interactive tools; fixed programs, array arguments) ----------
  async terminal(step: StepDef): Promise<void> {
    const root = this.s.root;
    const open = (name: string, shellPath: string, shellArgs: string[], env?: Record<string, string | null>) => {
      const t = vscode.window.createTerminal({ name, cwd: root, shellPath, shellArgs, env });
      t.show();
      this.log(`setup: terminal ${name}`);
    };
    switch (step.id) {
      case "b1.hc3": {
        const exe = resolveClaude(process.env.PATH ?? process.env.Path ?? "", process.platform, {
          exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }, read: (p) => fs.readFileSync(p, "utf8"),
        });
        if (exe.viaCmdShim) return open("claude setup-token", "cmd.exe", ["/d", "/c", exe.shellPath, "setup-token"], { ANTHROPIC_API_KEY: null });
        return open("claude setup-token", exe.shellPath, [...exe.prefixArgs, "setup-token"], { ANTHROPIC_API_KEY: null });
      }
      case "b4.init": return open("specify init", "specify", ["init", "--here", "--integration", "claude", "--integration-options=--no-model-invocation"]);
      case "b4.ext": return open("specify extension add", "specify", ["extension", "add", "sf", "--from", SPEC_KIT_SF_URL]);
      case "b5.discover": {
        const c = this.config();
        const j = await this.s.connections.jira();
        if (!j) throw new Error("Connect Jira on the Connections page first");
        if (!c?.jiraKey || !/^[A-Z][A-Z0-9_]+$/.test(c.jiraKey)) throw new Error("Set a valid jira.project_key in build.config.yml");
        const script = path.join(this.s.pluginRoot, "skills", "arch-jira-push", "scripts", "jira-sync.mjs");
        return open("jira-sync discover", "node", [script, "discover", "--project", c.jiraKey, "--out", ".specify/extensions/jira/jira-config.json"],
          { JIRA_BASE_URL: j.site, JIRA_EMAIL: j.email, JIRA_API_TOKEN: j.token });
      }
      case "b4.constitution":
        await this.s.sessions.start("architect", "/speckit-sf-constitution", { title: "Constitution" });
        return;
      default:
        throw new Error("No terminal for this step");
    }
  }
}
