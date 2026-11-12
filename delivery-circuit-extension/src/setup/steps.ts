// Setup wizard step handlers (v3): automatic checks (CLI + GitHub API), safe runs (always confirmed), terminals for
// interactive logins, and Verify for human checkpoints. No secrets anywhere: every connection is a login, the
// self-hosted runners hold their own service-user logins, and production logins and approvals are never automated.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { CircuitServices, ConnectionId, Persona } from "../core/contracts";
import { gitBranch, parseJson, run } from "../core/util";
import { parseBuildState, statusKind } from "./buildState";
import {
  acliStatus, installCommand, LABELS, leftoverCredentials, parseInstallOutput, parseRunners, prodAliases, rulesetWithTeam, runnerReady,
  secretNameOk, shellArg, TOOLS, V2_WORKFLOWS, V3_WORKFLOWS, variablesFor, versionOf,
} from "./commands";
import { readConfig, type BuildConfig } from "./config";
import { fillMcpUrls, type PhaseCtx, type StepDef } from "./phases";

export type ResultState = "ok" | "warn" | "err";
export interface StepResult { state: ResultState; text: string; at: string; lines?: string[] }

const TEAMS_DEFAULT = { architect: "architects", developer: "developers", tester: "testers" } as const;
const SPEC_KIT_SF_URL = "https://github.com/Evernorth/spec-kit-sf/archive/refs/tags/v2.0.1.zip";
/** A workflow or CI script must not read a stored credential (same rule as the installer). */
const STORED_CREDENTIAL_REF = /\b(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|SF_JWT_[A-Z_]*|JIRA_API_TOKEN|FIREFLIES_API_KEY|APP_PRIVATE_KEY|SLACK_WEBHOOK[A-Z_]*)\b/;
const ALIAS = /^[\w.-]{1,60}$/;

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
  private aliases() {
    const c = this.config();
    const safe = (v: string | undefined, d: string) => (v && ALIAS.test(v) ? v : d);
    return { dev: safe(c?.devAlias, this.s.connections.sfAlias("dev") || "dev"), qa: safe(c?.qaAlias, this.s.connections.sfAlias("qa") || "qa"), prod: safe(c?.prodAlias, "prod") };
  }
  phaseCtx(): PhaseCtx {
    const id = this.s.identity.get();
    const c = this.config();
    const a = this.aliases();
    return {
      owner: id?.owner ?? "", repo: id?.repo ?? "", org: c?.org && !/[<>]/.test(c.org) ? c.org : id?.owner ?? "",
      jiraSite: c?.jiraSite ?? "", jiraKey: c?.jiraKey ?? "", spaceKey: c?.spaceKey ?? "",
      devAlias: a.dev, qaAlias: a.qa, prodAlias: a.prod,
      runners: c?.runners ?? { circuit: { name: "", os: "linux", labels: ["circuit"] }, release: { name: "", os: "linux", labels: ["circuit-release"] } },
      platform: process.platform, arch: process.arch,
    };
  }

  // ---------- API helpers ----------
  private gh<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", p: string, body?: unknown): Promise<T> {
    return this.s.connections.githubRequest<T>(method, p, body);
  }
  /** sf org display for an alias. sf is a .cmd shim on Windows, so it runs through run()'s shell default with the
   *  alias quoted by shellArg (which refuses characters cmd.exe would expand). */
  private async sfOrgDisplay(alias: string) {
    let arg: string;
    try { arg = shellArg(alias, process.platform); } catch (e) { return { code: 1, stdout: "", stderr: (e as Error).message }; }
    return run("sf", ["org", "display", "--target-org", arg, "--json"], { cwd: this.s.root, timeoutMs: 60_000 });
  }
  private async tryGh<T = any>(p: string): Promise<{ data?: T; error?: string }> {
    try { return { data: await this.gh<T>("GET", p) }; } catch (e: any) { return { error: e?.message ?? String(e) }; }
  }
  private async variables(): Promise<Record<string, string>> {
    const r = await this.gh<any>("GET", `${this.repoP}/actions/variables?per_page=100`);
    return Object.fromEntries((r?.variables ?? []).map((v: any) => [String(v.name), String(v.value)]));
  }
  private async setVariable(name: string, value: string, env?: string): Promise<void> {
    const base = env ? `${this.repoP}/environments/${encodeURIComponent(env)}/variables` : `${this.repoP}/actions/variables`;
    try { await this.gh("POST", base, { name, value }); }
    catch { await this.gh("PATCH", `${base}/${encodeURIComponent(name)}`, { name, value }); }
  }
  private async installations(): Promise<{ list: { id: number; slug: string; selection: string }[]; error?: string }> {
    const r = await this.tryGh<any>(`/orgs/${encodeURIComponent(this.org())}/installations?per_page=100`);
    return { list: (r.data?.installations ?? []).map((i: any) => ({ id: Number(i.id), slug: String(i.app_slug), selection: String(i.repository_selection ?? "") })), error: r.error };
  }
  /** Leftover credential secrets on the repo and its environments: [scope ("" = repo), name][]. */
  private async leftovers(): Promise<{ found: [string, string][]; lines: string[]; error?: string }> {
    const lines: string[] = [];
    const found: [string, string][] = [];
    let repoNames: string[];
    try { repoNames = await this.s.connections.repoSecretNames(); } catch (e: any) { return { found, lines, error: e?.message ?? String(e) }; }
    for (const n of leftoverCredentials(repoNames)) found.push(["", n]);
    lines.push(`repository secrets: ${repoNames.join(", ") || "none"}`);
    const envs = await this.tryGh<any>(`${this.repoP}/environments?per_page=100`);
    for (const e of envs.data?.environments ?? []) {
      const name = String(e.name);
      const sec = await this.tryGh<any>(`${this.repoP}/environments/${encodeURIComponent(name)}/secrets?per_page=100`);
      const names = (sec.data?.secrets ?? []).map((x: any) => String(x.name));
      lines.push(`environment ${name}: ${names.join(", ") || "none"}`);
      for (const n of leftoverCredentials(names)) found.push([name, n]);
    }
    return { found, lines };
  }
  private async runners() {
    const r = await this.tryGh<any>(`${this.repoP}/actions/runners?per_page=100`);
    return { list: parseRunners(r.data), error: r.error };
  }
  private async connectionLines(ids: string[]): Promise<{ lines: string[]; off: string[] }> {
    const lines: string[] = [];
    const off: string[] = [];
    for (const cid of ids) {
      const st = await this.s.connections.check(cid as ConnectionId).catch(() => undefined);
      lines.push(`${st?.label ?? cid}: ${st?.state ?? "unknown"}${st?.detail ? " (" + st.detail + ")" : ""}`);
      if (!st || st.state !== "connected") off.push(st?.label ?? cid);
    }
    return { lines, off };
  }
  private async confirm(text: string, button: string, detail?: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(text, { modal: true, detail }, button)) === button;
  }
  /** acli is a real executable (acli.exe on Windows): no shell, arguments passed verbatim. */
  private acli(args: string[], timeoutMs = 60_000) {
    return run("acli", args, { cwd: this.s.root, timeoutMs, shell: false });
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
          const r = await run(t.cmd, t.args, { cwd: this.s.root, timeoutMs: 30_000, shell: t.cmd === "acli" ? false : undefined });
          const v = r.code === 0 ? versionOf(r.stdout + " " + r.stderr) : undefined;
          if (v) found.push(`${t.name} ${v}`); else if (t.required) missing.push(t.name); else found.push(`${t.name} missing (optional)`);
        }));
        // sf is sf.cmd on Windows: let run() use its shell default there (shell: false gives ENOENT).
        const plugins = await run("sf", ["plugins"], { cwd: this.s.root, timeoutMs: 60_000 });
        const ca = plugins.stdout.match(/code-analyzer\s+(\d[\w.]*)/);
        const order = (x: string) => TOOLS.findIndex((t) => x.startsWith(t.name + " "));
        found.sort((a, b) => order(a) - order(b));
        const list = found.map((f) => (f.startsWith("sf ") && ca ? `${f} (code-analyzer ${ca[1]})` : f));
        if (!ca) missing.push("sf plugin code-analyzer");
        if (missing.includes("acli")) list.push("acli: install it from developer.atlassian.com/cloud/acli (B6 shows the command)");
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
        if (!c.jiraKey || /[<>]/.test(c.jiraKey)) gaps.push("jira.project_key");
        if (!c.spaceKey) gaps.push("confluence.space_key");
        const lines = c.visibility === "public" ? ["github.visibility is public: self-hosted runners should almost never serve public repositories"] : undefined;
        return gaps.length ? warn(`Still empty: ${gaps.join(", ")}`, lines) : lines ? warn("Filled, but the repository is public", lines) : ok("Filled");
      }
      case "b0.hc1": {
        const want = ["github", "claude", "acli", "sf-dev", "sf-qa", "slack"];
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
      case "b1.actions": {
        const repo = await this.gh<any>("GET", this.repoP);
        const perms = await this.tryGh<any>(`${this.repoP}/actions/permissions/workflow`);
        const lines = [`Visibility: ${repo?.private ? "private" : "public"}`,
          `Default workflow token: ${perms.data?.default_workflow_permissions ?? (perms.error ? `not readable (${perms.error})` : "unknown")}`];
        let approval: string | undefined;
        if (!repo?.private) {
          const a = await this.tryGh<any>(`${this.repoP}/actions/permissions/fork-pr-contributor-approval`);
          approval = a.data?.approval_policy;
          lines.push(`Fork PR approval: ${approval ?? (a.error ? `not readable (${a.error})` : "unknown")}`);
        } else lines.push("Fork pull request workflows: check in Settings > Actions that \"Run workflows from fork pull requests\" is off (not readable by API)");
        if (!repo?.private && approval !== "all_external_contributors") return err("Public repository without approval for all external contributors: a fork PR could run on the self-hosted runner", lines);
        if (perms.data && perms.data.default_workflow_permissions !== "read") return warn("Workflow tokens default to write: set \"Read repository contents and packages permissions\"", lines);
        return repo?.private ? ok("Private repository; read-only workflow tokens", lines) : warn("Public repository: keep approval for all external contributors", lines);
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
      case "b1.nosecrets": {
        const l = await this.leftovers();
        if (l.error) return warn(`Secrets not readable (needs repo admin): ${l.error}`);
        if (!l.found.length) return ok("No stored credentials on the repository or its environments", l.lines);
        return err(`Stored credentials still present: ${l.found.map(([e, n]) => (e ? `${e}/${n}` : n)).join(", ")}. v3 uses logins only: delete them.`, l.lines);
      }
      case "b2.circuit":
      case "b2.logins":
      case "b2.release": {
        const r = await this.runners();
        if (r.error) return warn(`Runners not readable (needs repo admin): ${r.error}`);
        const c = this.config();
        const kind = step.id === "b2.release" ? "release" : "circuit";
        const labels = c?.runners[kind].labels ?? [kind === "release" ? "circuit-release" : "circuit"];
        const ready = runnerReady(r.list, labels);
        const lines = [ready.line, ...r.list.map((x) => `${x.name}: ${x.status}; labels ${x.labels.join(", ")}`)];
        if (step.id === "b2.logins" && ready.ok) lines.push("Logins live on the runner: prove them with scripts/ci/runner-check.sh there (the checklist records it).");
        if (kind === "circuit" && ready.ok) {
          const both = r.list.filter((x) => x.labels.map((l) => l.toLowerCase()).includes("circuit-release") && x.labels.map((l) => l.toLowerCase()).includes("circuit"));
          if (both.length) return err(`Runner ${both.map((x) => x.name).join(", ")} has both circuit and circuit-release: the PR runner must never hold the production login`, lines);
        }
        return ready.ok ? ok(ready.line, lines) : warn(ready.line, lines);
      }
      case "b3.orgs": {
        const a = this.aliases();
        const lines: string[] = [];
        let bad = false;
        for (const [role, alias] of [["dev", a.dev], ["qa", a.qa]] as const) {
          const r = await this.sfOrgDisplay(alias);
          const j = parseJson<any>(r.stdout)?.result;
          if (r.code === 0 && j) lines.push(`${role} (${alias}): ${j.connectedStatus ?? "connected"}${j.instanceUrl ? ` at ${j.instanceUrl}` : ""}`);
          else { lines.push(`${role} (${alias}): not available`); bad = true; }
        }
        const list = await run("sf", ["org", "list", "--json"], { cwd: this.s.root, timeoutMs: 60_000 });
        const res = parseJson<any>(list.stdout)?.result ?? {};
        const allAliases = Object.values(res).flatMap((v: any) => (Array.isArray(v) ? v : [])).map((o: any) => String(o?.alias ?? "").toLowerCase()).filter(Boolean);
        const prod = prodAliases(a.prod).filter((p) => allAliases.includes(p));
        if (prod.length) lines.push(`Production alias on this machine: ${prod.join(", ")} (AI sessions are blocked from it by the guard)`);
        if (bad) return warn("A DEV or QA alias is not connected: use Log in to DEV and QA", lines);
        return prod.length ? warn("dev and qa connected; a production alias is also logged in here", lines) : ok("dev and qa connected; no production alias here", lines);
      }
      case "b4.branch": return this.branchResult("pipeline/foundation");
      case "b4.install": {
        const want = ["CLAUDE.md", ".claude/hooks/circuit-guard.mjs", ".claude/agents/architect.md", ".claude/agents/developer.md", ".claude/agents/tester.md",
          ".claude/personas/architect.mcp.json", ".github/CODEOWNERS", ".coderabbit.yaml", "scripts/ci/runner-check.sh", ".specify/extensions/sf/sf-config.yml", "build.config.yml"];
        const missing = want.filter((w) => !this.exists(w));
        const lines = want.map((w) => `${this.exists(w) ? "present" : "missing"}  ${w}`);
        const stale = ["scripts/ci/sf-login.sh", ...V2_WORKFLOWS.map((w) => `.github/workflows/${w}`)].filter((w) => this.exists(w));
        if (stale.length) lines.push(`v2 files still here (installer --prune removes them): ${stale.join(", ")}`);
        return missing.length ? warn(`${missing.length} file(s) missing`, lines) : stale.length ? warn("Circuit files present; v2 files remain", lines) : ok("Circuit files present", lines);
      }
      case "b4.mcp": {
        const dir = this.file(".claude/personas");
        if (!fs.existsSync(dir)) return err(".claude/personas does not exist (run the installer)");
        const lines: string[] = [];
        for (const f of fs.readdirSync(dir).filter((x) => /\.mcp\.json$/.test(x) && !/\.local\./.test(x))) {
          const t = fs.readFileSync(path.join(dir, f), "utf8");
          const n = (t.match(/"VERIFY/g) ?? []).length;
          const keyed = /"(Authorization|x-api-key|api[_-]?key|token)"\s*:/i.test(t);
          lines.push(`${f}: ${n ? `${n} VERIFY placeholder(s)` : "OK"}${keyed ? "; has an auth header (v3 uses OAuth sign-in only)" : ""}`);
        }
        if (lines.some((l) => /auth header/.test(l))) return err("A persona MCP config carries a credential header", lines);
        return lines.some((l) => /VERIFY/.test(l)) ? warn("VERIFY placeholders remain", lines) : ok("All persona MCP URLs filled", lines);
      }
      case "b4.pr": return this.prResult("pipeline/foundation");
      case "b5.skills": {
        const left = ["deploy", "hotfix", "pr"].filter((x) => this.exists(`.claude/skills/speckit-sf-${x}`));
        return left.length ? warn(`Still present: ${left.map((x) => "speckit-sf-" + x).join(", ")}`) : ok("Deploy, hotfix and PR skills removed");
      }
      case "b5.check": {
        const lines: string[] = [];
        const has = this.exists(".specify");
        lines.push(`.specify/: ${has ? "present" : "missing"}`);
        const ext = this.exists(".specify/extensions/sf/extension.yml") ? fs.readFileSync(this.file(".specify/extensions/sf/extension.yml"), "utf8").match(/version:\s*"?([\d.]+)"?/)?.[1] : undefined;
        lines.push(`spec-kit-sf: ${ext ?? "not installed"}`);
        const ignored = (await run("git", ["check-ignore", "-q", ".specify/specs/x"], { cwd: this.s.root, shell: false })).code === 0;
        lines.push(`.specify/specs/: ${ignored ? "gitignored" : "NOT ignored"}`);
        const cfg = this.exists(".specify/extensions/sf/sf-config.yml") ? fs.readFileSync(this.file(".specify/extensions/sf/sf-config.yml"), "utf8") : "";
        const prod = cfg.match(/^\s*prod(?:_alias)?:\s*"?([\w.-]+)"?/m)?.[1];
        lines.push(`sf-config production alias: ${prod ?? (cfg ? "not named" : "file missing")}`);
        lines.push(`constitution: ${this.exists(".specify/memory/constitution.md") ? "present" : "missing"}`);
        if (!has || !ext) return err("Spec Kit or spec-kit-sf is not installed", lines);
        if (!ignored) return err(".specify/specs/ must be gitignored: specs live in Confluence and Jira, never in the repo", lines);
        return ext === "2.0.1" ? ok(`spec-kit-sf ${ext}`, lines) : warn(`spec-kit-sf ${ext} (the circuit was verified with 2.0.1)`, lines);
      }
      case "b5.constitution": {
        const f = ".specify/memory/constitution.md";
        if (!this.exists(f)) return warn("No constitution yet");
        const t = fs.readFileSync(this.file(f), "utf8");
        return /Article\s+X\b/i.test(t) ? ok("Constitution with Article X") : warn("Constitution has no Article X (house rules) yet");
      }
      case "b6.acli": {
        const v = await this.acli(["--version"], 30_000);
        if (v.code !== 0) return err("acli is not installed: run the install command above, then sign in", [(v.stderr || v.stdout).trim().split(/\r?\n/)[0] ?? ""].filter(Boolean));
        const st = await this.acli(["jira", "auth", "status"]);
        const s = acliStatus(st.code, st.stdout + "\n" + st.stderr);
        const lines = [`acli ${versionOf(v.stdout + v.stderr) ?? "?"} (each version is supported for 6 months)`, `auth: ${s.detail}`];
        return s.signedIn ? ok(`acli signed in${/signed in to/.test(s.detail) ? `: ${s.detail.replace(/^signed in to /, "")}` : ""}`, lines) : warn("acli is not signed in: acli jira auth login --web", lines);
      }
      case "b6.hc6": {
        const c = this.config();
        if (!c?.jiraKey || !/^[A-Z][A-Z0-9_]{0,19}$/.test(c.jiraKey)) return err("Set a valid jira.project_key in build.config.yml");
        const r = await this.acli(["jira", "workitem", "search", "--jql", `project = ${c.jiraKey}`, "--limit", "1", "--json"]);
        const lines = [`acli search in ${c.jiraKey}: ${r.code === 0 ? "works" : (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? "failed"}`,
          "Fields, groups and transition conditions are not readable through acli: try Approve design as a non-architect and Ready for Dev as a non-tester on test issues."];
        return r.code === 0 ? ok(`Project ${c.jiraKey} readable with your acli login`, lines) : warn(`Project ${c.jiraKey} not readable with acli`, lines);
      }
      case "b6.app": {
        const inst = await this.installations();
        if (inst.error) return warn(`Installed apps not readable: ${inst.error}`);
        const app = inst.list.find((i) => /jira|atlassian/i.test(i.slug));
        return app ? ok(`GitHub for Atlassian installed (${app.slug}, ${app.selection || "?"} repositories)`) : warn("GitHub for Atlassian is not installed on the org");
      }
      case "b6.config": {
        const f = ".specify/extensions/jira/jira-config.json";
        if (!this.exists(f)) return warn(`${f} does not exist yet: the Architect builds it once with arch-jira-push and commits it`);
        const j = parseJson<any>(fs.readFileSync(this.file(f), "utf8"));
        if (!j) return err(`${f} is not valid JSON`);
        const text = JSON.stringify(j);
        if (STORED_CREDENTIAL_REF.test(text) || /"(token|apiToken|password)"\s*:/i.test(text)) return err(`${f} holds a credential: remove it (v3 stores none)`);
        const named = ["design", "approved"].filter((k) => new RegExp(k, "i").test(text));
        return named.length === 2 ? ok(`${f} names the Design page and Approved design version fields`) : warn(`${f} does not name both the Design page and Approved design version fields`);
      }
      case "b7.space": {
        const { lines, off } = await this.connectionLines(["mcp-atlassian"]);
        lines.push("Content status and page restrictions are set in Confluence; arch-approve-design checks the approver from page history.");
        return off.length ? warn("Sign in to the Atlassian MCP (/mcp) so Claude can read the design pages", lines) : ok("Atlassian MCP connected", lines);
      }
      case "b7.mcp": {
        const { lines, off } = await this.connectionLines(["mcp-atlassian", "mcp-lucid", "mcp-fireflies"]);
        return off.length ? warn(`Not signed in yet: ${off.join(", ")} (this checks your own machine; each person signs in on theirs)`, lines) : ok("Atlassian, Lucid and Fireflies MCP signed in", lines);
      }
      case "b8.hc8": {
        const { lines, off } = await this.connectionLines(["mcp-slack"]);
        const inst = await this.installations();
        lines.push(inst.error ? `Installed apps: not readable (${inst.error})` : `GitHub app for Slack: ${inst.list.some((i) => /slack/i.test(i.slug)) ? "installed" : "not installed"}`);
        return off.length ? warn("Slack MCP not signed in on this machine", lines) : ok("Slack MCP connected", lines);
      }
      case "b8.signin": {
        const { lines, off } = await this.connectionLines(["mcp-slack"]);
        return off.length ? warn("Sign in to Slack in Claude (/mcp)", lines) : ok("Slack MCP signed in", lines);
      }
      case "b9.branch": {
        const wf = await this.tryGh<any>(`${this.repoP}/actions/workflows`);
        const paths = (wf.data?.workflows ?? []).map((w: any) => String(w.path).split("/").pop());
        if (V3_WORKFLOWS.every((w) => paths.includes(w))) return ok("The v3 workflows are already on GitHub");
        return this.branchResult("pipeline/workflows");
      }
      case "b9.lint": {
        const dir = this.file(".github/workflows");
        if (!fs.existsSync(dir)) return err(".github/workflows does not exist");
        const files = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
        if (!files.length) return err("No workflow files");
        const lines: string[] = [];
        const creds = files.filter((f) => STORED_CREDENTIAL_REF.test(fs.readFileSync(this.file(f), "utf8")));
        if (creds.length) lines.push(`Reads a stored credential: ${creds.join(", ")}`);
        const v2 = V2_WORKFLOWS.filter((w) => files.includes(`.github/workflows/${w}`));
        if (v2.length) lines.push(`v2 workflows still present: ${v2.join(", ")}`);
        const missingV3 = V3_WORKFLOWS.filter((w) => !files.includes(`.github/workflows/${w}`));
        if (missingV3.length) lines.push(`v3 workflows missing: ${missingV3.join(", ")}`);
        // actionlint and shellcheck are real executables: no shell, file names passed verbatim.
        const al = await run("actionlint", files, { cwd: this.s.root, timeoutMs: 120_000, shell: false });
        const alOut = (al.stdout + al.stderr).trim().split(/\r?\n/).filter(Boolean);
        const alMissing = al.code !== 0 && /ENOENT|not recognized|not found/i.test(alOut.join(" ") || "ENOENT");
        lines.push(al.code === 0 ? `actionlint clean (${files.length} files)` : alMissing ? "actionlint is not installed" : `actionlint: ${alOut.length} finding(s)`, ...(al.code !== 0 && !alMissing ? alOut.slice(0, 20) : []));
        const ciDir = this.file("scripts/ci");
        const sh = fs.existsSync(ciDir) ? fs.readdirSync(ciDir).filter((f) => /^[\w.-]+\.sh$/.test(f)).map((f) => `scripts/ci/${f}`) : [];
        let scBad = false;
        if (sh.length) {
          const sc = await run("shellcheck", sh, { cwd: this.s.root, timeoutMs: 120_000, shell: false });
          const scOut = (sc.stdout + sc.stderr).trim().split(/\r?\n/).filter(Boolean);
          const scMissing = sc.code !== 0 && /ENOENT|not recognized|not found/i.test(scOut.join(" ") || "ENOENT");
          scBad = sc.code !== 0 && !scMissing;
          lines.push(sc.code === 0 ? `shellcheck clean (${sh.length} scripts)` : scMissing ? "shellcheck is not installed" : `shellcheck: ${scOut.length} line(s) of findings`, ...(scBad ? scOut.slice(0, 10) : []));
        }
        if (creds.length || v2.length) return err(creds.length ? "A workflow reads a stored credential" : "v2 workflows must be removed", lines);
        if ((al.code !== 0 && !alMissing) || scBad) return err("Lint findings", lines);
        if (alMissing || missingV3.length) return warn(alMissing ? "actionlint is not installed" : "Some v3 workflows are missing", lines);
        return ok(lines[lines.length - (sh.length ? 2 : 1)] ?? "clean", lines);
      }
      case "b9.coderabbit": {
        const inst = await this.installations();
        if (inst.error) return warn(`Installed apps not readable: ${inst.error}`);
        const cr = inst.list.find((i) => i.slug === "coderabbitai");
        if (!cr) return warn("CodeRabbit is not installed on the org");
        if (cr.selection === "all") return ok("CodeRabbit installed with access to all repositories");
        const repos = await this.tryGh<any>(`/user/installations/${cr.id}/repositories?per_page=100`);
        if (repos.error) return warn(`CodeRabbit installed (selected repositories); access not readable: ${repos.error}`);
        const has = (repos.data?.repositories ?? []).some((r: any) => String(r.full_name).toLowerCase() === `${id.owner}/${id.repo}`.toLowerCase());
        return has ? ok(`CodeRabbit has access to ${id.owner}/${id.repo}`) : warn(`CodeRabbit is installed but has no access to ${id.owner}/${id.repo}: add it under the app's repository access`);
      }
      case "b9.pr": {
        const wf = await this.tryGh<any>(`${this.repoP}/actions/workflows`);
        if (wf.error) return warn(`Workflows not readable: ${wf.error}`);
        const paths = (wf.data?.workflows ?? []).map((w: any) => String(w.path).split("/").pop() as string);
        const missing = V3_WORKFLOWS.filter((w) => !paths.includes(w));
        const v2 = V2_WORKFLOWS.filter((w) => paths.includes(w));
        const lines = [`On GitHub: ${paths.join(", ") || "none"}`];
        if (v2.length) return err(`v2 workflows still on GitHub: ${v2.join(", ")}`, lines);
        return missing.length ? warn(`Not on GitHub yet: ${missing.join(", ")} (after the PR is merged)`, lines) : ok("The five v3 workflows are active", lines);
      }
      case "b10.rulesets": {
        const rs = await this.tryGh<any[]>(`${this.repoP}/rulesets?per_page=100`);
        if (rs.error) return warn(`Rulesets not readable: ${rs.error}`);
        const names = (rs.data ?? []).map((r: any) => String(r.name));
        const missing = ["circuit-main-gates", "circuit-merge-architects-only"].filter((n) => !names.includes(n));
        return missing.length ? warn(`Missing rulesets: ${missing.join(", ")}`, names) : ok("Both rulesets active", names);
      }
      case "b10.env": {
        const e = await this.tryGh<any>(`${this.repoP}/environments/production`);
        if (!e.data) return warn("Environment production does not exist");
        const rr = (e.data.protection_rules ?? []).find((p: any) => p.type === "required_reviewers");
        const teams = (rr?.reviewers ?? []).filter((r: any) => r.type === "Team").map((r: any) => String(r.reviewer?.slug));
        const lines = [`Reviewers: ${teams.join(", ") || "none"}`, `Prevent self-review: ${rr?.prevent_self_review ? "yes" : "no"}`,
          `Branch policy: ${e.data.deployment_branch_policy ? (e.data.deployment_branch_policy.custom_branch_policies ? "selected branches" : "protected branches") : "any branch"}`];
        return teams.includes(this.teams().architect) && rr?.prevent_self_review && e.data.deployment_branch_policy ? ok("Production needs an architect's approval", lines) : warn("Production is not fully protected", lines);
      }
      case "b11.people": {
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
      case "b12.vars": {
        const v = await this.variables();
        const env = await this.tryGh(`${this.repoP}/environments/production-dryrun`);
        const rel = env.data ? await this.tryGh<any>(`${this.repoP}/environments/production-dryrun/variables/CIRCUIT_RELEASE_ALIAS`) : { data: undefined };
        const qa = this.aliases().qa;
        const lines = [`DEPLOY_ENVIRONMENT = ${v.DEPLOY_ENVIRONMENT ?? "(not set)"}`, `FIX_ROUTER_DRY_RUN = ${v.FIX_ROUTER_DRY_RUN ?? "(not set)"}`,
          `environment production-dryrun: ${env.data ? "exists" : "missing"}`, `production-dryrun CIRCUIT_RELEASE_ALIAS = ${rel.data?.value ?? "(not set)"}`];
        return v.DEPLOY_ENVIRONMENT === "production-dryrun" && v.FIX_ROUTER_DRY_RUN === "false" && env.data && rel.data?.value === qa
          ? ok("Dry-run settings active", lines) : warn("Dry-run settings not active", lines);
      }
      case "b12.hc10": {
        const lines: string[] = [];
        for (const w of V3_WORKFLOWS) {
          const r = await this.tryGh<any>(`${this.repoP}/actions/workflows/${encodeURIComponent(w)}/runs?per_page=1`);
          const run0 = r.data?.workflow_runs?.[0];
          lines.push(`${w}: ${run0 ? `${run0.conclusion ?? run0.status} (${String(run0.created_at ?? "").slice(0, 10)})` : r.error ? "not readable" : "no runs yet"}`);
        }
        return lines.some((l) => /no runs yet|not readable/.test(l)) ? warn("Not every v3 workflow has run yet", lines) : ok("Every v3 workflow has run", lines);
      }
      case "b12.cleanup": {
        const v = await this.variables();
        return v.DEPLOY_ENVIRONMENT === "production-dryrun" ? warn("DEPLOY_ENVIRONMENT still points at production-dryrun") : ok("Deploys target production again");
      }
      case "b13.live": {
        const f = this.file("build-state.md");
        const st = fs.existsSync(f) ? parseBuildState(fs.readFileSync(f, "utf8")) : undefined;
        const open = (st?.rows ?? []).filter((r) => r.id !== "B13" && statusKind(r.status) !== "done").map((r) => r.id);
        return open.length ? warn(`Not DONE yet: ${open.join(", ")}`) : ok("B0-B12 are DONE");
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
      case "b4.install": {
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
      case "b1.nosecrets": {
        const l = await this.leftovers();
        if (l.error) return err(`Secrets not readable: ${l.error}`);
        if (!l.found.length) return ok("Nothing to delete");
        const names = l.found.map(([e, n]) => (e ? `${e}/${n}` : n));
        if (!(await this.confirm(`Delete ${names.length} stored credential secret(s) from ${id.owner}/${id.repo}?`, "Delete",
          `${names.join("\n")}\n\nv3 uses logins only (gh, sf, acli, claude, MCP OAuth, runner service users). Remove the values at their source too (revoke the token, delete the key).`))) return undefined;
        const lines: string[] = [];
        for (const [env, name] of l.found) {
          if (!secretNameOk(name)) continue;
          const p = env ? `${this.repoP}/environments/${encodeURIComponent(env)}/secrets/${encodeURIComponent(name)}` : `${this.repoP}/actions/secrets/${encodeURIComponent(name)}`;
          await this.gh("DELETE", p);
          lines.push(`deleted ${env ? `${env}/` : ""}${name}`);
        }
        this.log(`setup: deleted ${lines.length} leftover credential secret(s) as ${id.login}`);
        return ok(`Deleted ${lines.length} secret(s)`, lines);
      }
      case "b4.branch": return this.switchBranch("pipeline/foundation");
      case "b9.branch": return this.switchBranch("pipeline/workflows");
      case "b4.mcp": {
        const dir = this.file(".claude/personas");
        if (!fs.existsSync(dir)) return err(".claude/personas does not exist (run the installer)");
        const files = fs.readdirSync(dir).filter((x) => /\.mcp\.json$/.test(x) && !/\.local\./.test(x));
        const changes = files.map((f) => ({ f, r: fillMcpUrls(fs.readFileSync(path.join(dir, f), "utf8")) })).filter((x) => x.r.changed.length || x.r.unknown.length);
        if (!changes.some((x) => x.r.changed.length)) return changes.length ? warn(`Unknown placeholders: ${changes.flatMap((x) => x.r.unknown).join(", ")}`) : ok("Nothing to fill");
        const detail = changes.map((x) => `${x.f}: ${x.r.changed.join(", ")}`).join("\n");
        if (!(await this.confirm("Fill the vendor MCP URLs in the persona configs?", "Fill", detail))) return undefined;
        for (const x of changes) if (x.r.changed.length) fs.writeFileSync(path.join(dir, x.f), x.r.text, "utf8");
        const unknown = changes.flatMap((x) => x.r.unknown);
        return unknown.length ? warn(`Filled; still to check by hand: ${unknown.join(", ")}`, detail.split("\n")) : ok("Persona MCP URLs filled", detail.split("\n"));
      }
      case "b5.skills": {
        const left = ["deploy", "hotfix", "pr"].map((x) => `.claude/skills/speckit-sf-${x}`).filter((x) => this.exists(x));
        if (!left.length) return ok("Already removed");
        if (!(await this.confirm("Delete these skill folders?", "Delete", left.join("\n")))) return undefined;
        for (const x of left) fs.rmSync(this.file(x), { recursive: true, force: true });
        return ok(`Removed ${left.join(", ")}`);
      }
      case "b10.rulesets": {
        const archSlug = this.teams().architect;
        const team = await this.gh<any>("GET", `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(archSlug)}`);
        const dir = path.join(this.s.pluginRoot, "templates", "github");
        const payloads = ["ruleset-main.json", "ruleset-merge-architects.json"].map((f) => rulesetWithTeam(fs.readFileSync(path.join(dir, f), "utf8"), Number(team.id)));
        const existing = new Set(((await this.tryGh<any[]>(`${this.repoP}/rulesets?per_page=100`)).data ?? []).map((r: any) => String(r.name)));
        const todo = payloads.filter((p) => !existing.has(p.name));
        if (!todo.length) return ok("Both rulesets already exist");
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(todo, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: true });
        if (!(await this.confirm(`HC-9: create ${todo.map((p) => p.name).join(" and ")} on ${id.owner}/${id.repo}?`, "Create rulesets", "The payloads are open in the editor. After this, only architects can merge into main, through a PR with every gate green."))) return undefined;
        for (const p of todo) await this.gh("POST", `${this.repoP}/rulesets`, p);
        return ok(`Created ${todo.map((p) => p.name).join(", ")}`);
      }
      case "b10.env": {
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
      case "b12.vars": {
        const qa = this.aliases().qa;
        if (!(await this.confirm("Switch deploys to the dry-run environment?", "Set",
          `DEPLOY_ENVIRONMENT = production-dryrun\nFIX_ROUTER_DRY_RUN = false\nEnvironment production-dryrun with CIRCUIT_RELEASE_ALIAS = ${qa}.\nA person also signs the release runner's service user in to ${qa} for the dry run (and out afterwards).`))) return undefined;
        await this.gh("PUT", `${this.repoP}/environments/production-dryrun`, {});
        await this.setVariable("CIRCUIT_RELEASE_ALIAS", qa, "production-dryrun");
        await this.setVariable("DEPLOY_ENVIRONMENT", "production-dryrun");
        await this.setVariable("FIX_ROUTER_DRY_RUN", "false");
        return ok("Dry-run settings active");
      }
      case "b12.cleanup": {
        if (!(await this.confirm("Remove DEPLOY_ENVIRONMENT so deploys target production again?", "Reset", "Sign the release runner out of the QA org yourself."))) return undefined;
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

  // ---------- terminals (interactive logins and tools; fixed programs, validated arguments) ----------
  async terminal(step: StepDef): Promise<void> {
    const root = this.s.root;
    const open = (name: string, shellPath: string, shellArgs: string[], env?: Record<string, string | null>) => {
      const t = vscode.window.createTerminal({ name, cwd: root, shellPath, shellArgs, env });
      t.show();
      this.log(`setup: terminal ${name}`);
    };
    /** A normal terminal that runs one fixed command line and stays open (logins print what to do next). */
    const login = (name: string, line: string) => {
      const t = vscode.window.createTerminal({ name, cwd: root });
      t.show();
      t.sendText(line, true);
      this.log(`setup: terminal ${name}`);
    };
    const persona = (): Persona => this.s.identity.get()?.active ?? "architect";
    switch (step.id) {
      case "b3.login": {
        const a = this.aliases();
        const pick = await vscode.window.showQuickPick([{ label: a.dev, description: "DEV org" }, { label: a.qa, description: "QA org" }],
          { title: "Log in to which org alias?", placeHolder: "Any connected org can be DEV or QA. Never the production alias from here." });
        if (!pick) return;
        if (!ALIAS.test(pick.label) || prodAliases(a.prod).includes(pick.label.toLowerCase())) throw new Error(`Refusing alias ${pick.label}`);
        return login(`sf login ${pick.label}`, `sf org login web --alias ${pick.label}`);
      }
      case "b5.init": return open("specify init", "specify", ["init", "--here", "--integration", "claude", "--integration-options=--no-model-invocation"]);
      case "b5.ext": return open("specify extension add", "specify", ["extension", "add", "sf", "--from", SPEC_KIT_SF_URL]);
      case "b6.acli": return login("acli login", "acli jira auth login --web");
      case "b5.constitution":
        await this.s.sessions.start("architect", "/speckit-sf-constitution", { title: "Constitution" });
        return;
      case "b7.mcp":
      case "b8.signin":
        // An interactive Claude session as the person's persona; /mcp lists the servers to sign in to (OAuth in the browser).
        await this.s.sessions.start(persona(), "/mcp", { mode: "terminal", title: "MCP sign-in" });
        return;
      default:
        throw new Error("No terminal for this step");
    }
  }
}
