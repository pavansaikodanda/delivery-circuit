// The testing engine as one object: suites, runs, generation, validation and export. No VS Code here, so the same
// code runs inside the extension (index.ts wraps it) and from a plain node script (smoke runs).
import * as fs from "fs";
import * as path from "path";
import { runSuite } from "./runner";
import { loadSuite, saveSuite, validateCase } from "./suite";
import { readStatus, readAll, recordResult } from "./status";
import { OrgMeta, contextsForCases } from "./orgmeta";
import { authenticate } from "./auth";
import { generateCases } from "./generate";
import { resolveTarget } from "./target";
import { caseHash, caseText } from "./hash";
import { catalog, listSuiteFiles, newSuitePath, suiteKey, suiteRecord, SUITE_DIR, type SuiteRecord } from "./catalog";
import { listRuns, readRun, TOOL_DIR, type RunInfo } from "./runs";
import { exec, shellArg } from "./exec";
import type { RunAnalysis } from "./analyst";
import { collectReport, writeExcel, writePdf } from "./export";
import type { LoginOptions, OrgConfig, RunEvent, Status, TestCase, TestMode, TestSuite } from "./types";

export interface EngineSettings {
  headless: boolean;
  models: string[];
  workers: number;
  maxTurns: number;
}

export interface EngineConfig {
  /** client Salesforce DX repo */
  workspaceDir: string;
  /** folder holding node_modules/@playwright/mcp (the extension) */
  toolRoot: string;
  settings: () => EngineSettings;
  /** sf CLI alias for an org role */
  sfAlias: (role: "dev" | "qa") => string;
  log?: (m: string) => void;
}

export interface EngineRunRequest { suite: string; caseIds?: string[]; mode: TestMode; orgRole: "dev" | "qa" }

/** What the page and the contract's onEvent receive. */
export interface EngineEvent { type: string; message?: string; caseId?: string; status?: Status; mode?: string; model?: string; runDir?: string }

export interface GenerateInput {
  requirement: string;
  count: number;
  orgRole: "dev" | "qa";
  /** suite name; defaults to the first line of the requirement */
  name?: string;
  context?: string;
  /** let the AI look at the logged-in org read-only to ground labels and picklists */
  explore?: boolean;
}

export interface ValidationResult { ran: boolean; ok: boolean; output: string; command?: string }

const SAFE_ALIAS = /^[\w.@+-]+$/;
export const VALIDATOR = ".claude/skills/sf-ai-tester-suites/scripts/validate_suite.py";

const LOGIN: LoginOptions = { browserMode: "auto", browser: "default", timeoutMinutes: 5, sessionMaxAgeHours: 8 };

export class TestingEngine {
  private abort: AbortController | undefined;
  private busyWith: "run" | "generate" | "export" | undefined;

  constructor(private cfg: EngineConfig) {}

  get busy(): "run" | "generate" | "export" | undefined {
    return this.busyWith;
  }

  private get ws() {
    return this.cfg.workspaceDir;
  }

  /** Absolute path of a workspace-relative suite path; refuses paths outside the workspace. */
  resolveSuite(rel: string): string {
    const file = path.resolve(this.ws, rel);
    const r = path.relative(this.ws, file);
    if (!r || r.startsWith("..") || path.isAbsolute(r)) throw new Error(`Suite must be inside the workspace: ${rel}`);
    return file;
  }

  suites(): SuiteRecord[] {
    return catalog(this.ws);
  }

  suite(rel: string): SuiteRecord {
    return suiteRecord(this.ws, this.resolveSuite(rel));
  }

  runs(limit = 20): RunInfo[] {
    return listRuns(this.ws, limit);
  }

  cancel(): void {
    this.abort?.abort();
  }

  private alias(role: "dev" | "qa"): string {
    const alias = this.cfg.sfAlias(role);
    if (!alias || !SAFE_ALIAS.test(alias)) throw new Error(`No usable sf CLI alias for the ${role} org (got "${alias}"). Connect it on the Connections page.`);
    return alias;
  }

  private sfOrg(role: "dev" | "qa"): OrgConfig {
    const alias = this.alias(role);
    // sfcli: token-based frontdoor from the sf CLI login; no username or password is ever stored.
    return { name: alias, authMode: "sfcli", loginUrl: "https://login.salesforce.com", sfAlias: alias };
  }

  private orgMeta(alias: string): OrgMeta | undefined {
    try {
      return new OrgMeta(alias, path.join(this.ws, TOOL_DIR, "meta"));
    } catch {
      return undefined;
    }
  }

  /** Runs a suite (or some of its cases). Resolves with the run as written to .sf-ai-tester/runs/<ts>/. */
  async run(req: EngineRunRequest, onEvent: (e: EngineEvent) => void = () => undefined): Promise<RunInfo> {
    if (this.busyWith) throw new Error(`Busy: a ${this.busyWith} is already in progress.`);
    const file = this.resolveSuite(req.suite);
    const loaded = loadSuite(file);
    const wanted = req.caseIds?.length ? new Set(req.caseIds) : undefined;
    // The mode picked for the run applies to every selected case (as in SF AI Tester's console).
    const cases: TestCase[] = loaded.cases.filter((c) => !wanted || wanted.has(c.id)).map((c) => ({ ...c, mode: undefined }));
    if (!cases.length) throw new Error("Select at least one test case.");
    if (!["manual", "automation", "both"].includes(req.mode)) throw new Error(`Unknown mode ${req.mode}`);
    if (req.mode !== "manual" && !fs.existsSync(path.join(this.ws, "node_modules", "@playwright", "test"))) {
      throw new Error(`Automation needs @playwright/test in ${this.ws} (npm i -D @playwright/test), or use manual mode.`);
    }
    const suite: TestSuite = { ...loaded, cases };
    const key = suiteKey(this.ws, file);
    const settings = this.cfg.settings();
    const sfCases = cases.filter((c) => resolveTarget(c, suite) === "salesforce");
    const org: OrgConfig = sfCases.length ? this.sfOrg(req.orgRole) : { name: "web", authMode: "interactive", loginUrl: suite.baseUrl ?? "" };

    const abort = new AbortController();
    this.abort = abort;
    this.busyWith = "run";
    let runDir: string | undefined;
    const log = (message: string) => {
      this.cfg.log?.(message);
      onEvent({ type: "log", message });
    };
    try {
      log(`Run ${new Date().toLocaleString()} - ${suite.name}: ${cases.length} case(s), ${req.mode}, org ${org.name}`);
      const meta = sfCases.length ? this.orgMeta(org.sfAlias!) : undefined;
      const orgContexts = meta ? await contextsForCases(meta, sfCases.map((c) => ({ id: c.id, text: caseText(c) })), 60_000, log) : {};
      // Automation re-runs replay a passing, unchanged spec with plain Playwright (no AI).
      const prior = readStatus(this.ws, key);
      const replay = (tc: TestCase) => {
        const a = prior[tc.id]?.automation;
        const ok = a?.status === "passed" && a.specFile && (!a.caseHash || a.caseHash === caseHash(tc)) && fs.existsSync(path.join(this.ws, a.specFile));
        return ok ? a!.specFile : undefined;
      };
      await runSuite(
        suite,
        org,
        {
          mode: req.mode,
          workspaceDir: this.ws,
          toolRoot: this.cfg.toolRoot,
          headless: settings.headless,
          login: LOGIN,
          models: settings.models,
          maxTurns: settings.maxTurns,
          useSubscription: true, // subscription auth only: ANTHROPIC_API_KEY is stripped from the agent env
          continuity: "continue",
          workers: settings.workers,
          replay,
          replayManual: true,
          analyze: true,
          orgContext: (tc) => orgContexts[tc.id],
        },
        (e: RunEvent) => {
          switch (e.type) {
            case "log":
              return log(e.message);
            case "needsUser":
              this.cfg.log?.(e.message);
              return onEvent({ type: "needsUser", message: e.message });
            case "caseStart":
              return onEvent({ type: "caseStart", caseId: e.id, mode: e.mode, model: e.model, message: `${e.id} ${e.mode} started (${e.model || "default"})` });
            case "escalate":
              return onEvent({ type: "escalate", caseId: e.id, mode: e.mode, model: e.to, message: e.reason });
            case "caseEnd":
              runDir = e.runDir;
              recordResult(this.ws, key, e.result, e.runDir);
              return onEvent({ type: "caseEnd", caseId: e.result.id, mode: e.result.mode, status: e.result.status, message: e.result.summary, runDir: e.runDir });
            case "analysis":
              runDir = e.runDir;
              this.saveAnalysis(key, e.analysis, e.runDir);
              return onEvent({ type: "analysis", message: e.analysis.headline, runDir: e.runDir });
            case "runEnd":
              runDir = e.runDir;
              return onEvent({ type: "runEnd", runDir: e.runDir });
          }
        },
        abort,
      );
    } finally {
      this.abort = undefined;
      this.busyWith = undefined;
    }
    const info = runDir ? readRun(runDir) : undefined;
    if (!info) throw new Error(abort.signal.aborted ? "Run cancelled before any result was written." : "The run wrote no results.");
    return info;
  }

  /** analysis.json keyed by suite (same file SF AI Tester's console keeps). */
  private saveAnalysis(key: string, analysis: RunAnalysis, runDir: string) {
    const file = path.join(this.ws, TOOL_DIR, "analysis.json");
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      all = {};
    }
    all[key] = { ...analysis, runDir };
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  }

  /** Drafts cases for a requirement with AI and writes them as a NEW suite after validation. */
  async generate(input: GenerateInput, log: (m: string) => void = () => undefined): Promise<{ file: string; key: string; cases: TestCase[]; model: string; validation: ValidationResult }> {
    if (this.busyWith) throw new Error(`Busy: a ${this.busyWith} is already in progress.`);
    const requirement = input.requirement.trim();
    if (requirement.length < 10) throw new Error("Describe the requirement (at least a sentence).");
    const count = Math.max(1, Math.min(20, Math.round(Number(input.count) || 5)));
    const abort = new AbortController();
    this.abort = abort;
    this.busyWith = "generate";
    try {
      const settings = this.cfg.settings();
      const alias = this.alias(input.orgRole);
      const existingIds = this.suites().flatMap((s) => s.cases.map((c) => c.id));
      let orgMeta: string | undefined;
      const meta = this.orgMeta(alias);
      if (meta) {
        const res = await Promise.race([meta.contextFor(requirement).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 60_000))]);
        if (res?.text) {
          orgMeta = res.text;
          log(`Org metadata for generation: ${res.objects.map((o) => o.label).join(", ")}`);
        }
      }
      let explore;
      if (input.explore) {
        const auth = await authenticate(this.sfOrg(input.orgRole), path.join(this.ws, TOOL_DIR, "auth"), LOGIN, { log, needsUser: log });
        const evidenceDir = path.join(this.ws, TOOL_DIR, "generate");
        fs.mkdirSync(evidenceDir, { recursive: true });
        explore = { auth, toolRoot: this.cfg.toolRoot, evidenceDir, headless: settings.headless };
      }
      const { cases, model } = await generateCases({
        prompt: requirement,
        count,
        suiteContext: input.context,
        orgMeta,
        existingIds,
        explore,
        models: settings.models,
        useSubscription: true,
        workspaceDir: this.ws,
        abort,
        log,
      });
      cases.forEach((c, i) => validateCase(c, `generated case #${i + 1}`));
      const name = (input.name?.trim() || requirement.split(/\r?\n/)[0]).slice(0, 80);
      const file = newSuitePath(this.ws, name);
      saveSuite(file, { name, context: input.context?.trim() || undefined, cases });
      loadSuite(file); // round trip: the file must load exactly as a run will load it
      log(`Wrote ${cases.length} case(s) to ${suiteKey(this.ws, file)} (${model}).`);
      const validation = await this.validate(suiteKey(this.ws, file));
      return { file, key: suiteKey(this.ws, file), cases, model, validation };
    } finally {
      this.abort = undefined;
      this.busyWith = undefined;
    }
  }

  /** Runs the circuit's suite validator (python) when the repo has it; otherwise the engine's own load check. */
  async validate(rel: string): Promise<ValidationResult> {
    const file = this.resolveSuite(rel);
    const key = suiteKey(this.ws, file);
    const own = (() => {
      try {
        const s = loadSuite(file);
        return { ok: true, output: `${s.cases.length} case(s) load correctly.` };
      } catch (e) {
        return { ok: false, output: (e as Error).message.replace(file, key) };
      }
    })();
    if (!fs.existsSync(path.join(this.ws, VALIDATOR))) {
      return { ran: false, ok: own.ok, output: `${own.output}\n(The circuit validator ${VALIDATOR} is not in this repo.)` };
    }
    const args = [VALIDATOR, key].map((a) => shellArg(a));
    for (const [cmd, pre] of [["python", []], ["py", ["-3"]], ["python3", []]] as [string, string[]][]) {
      const r = await exec(cmd, [...pre, ...args], { cwd: this.ws, timeoutMs: 60_000 });
      const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.replace(/\r\n/g, "\n").trim();
      // Not installed / Windows Store stub: try the next interpreter.
      if (r.code !== 0 && /not recognized|not found|No such file|Python was not found|ENOENT/i.test(output) && !/validate_suite/i.test(output)) continue;
      return { ran: true, ok: r.code === 0 && own.ok, output: output || (r.code === 0 ? "No problems found." : `Validator exited with ${r.code}.`), command: `${cmd} ${[...pre, VALIDATOR, key].join(" ")}` };
    }
    return { ran: false, ok: own.ok, output: `${own.output}\n(Python was not found, so the circuit validator did not run.)` };
  }

  /** Excel (and optionally PDF) test report over every suite, under .sf-ai-tester/exports/. */
  async export(formats: ("xlsx" | "pdf")[]): Promise<string[]> {
    if (this.busyWith) throw new Error(`Busy: a ${this.busyWith} is already in progress.`);
    this.busyWith = "export";
    try {
      const data = collectReport(this.ws, listSuiteFiles(this.ws), readAll(this.ws));
      const dir = path.join(this.ws, TOOL_DIR, "exports");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const out: string[] = [];
      if (formats.includes("xlsx")) {
        const f = path.join(dir, `test-report-${stamp}.xlsx`);
        await writeExcel(data, f);
        out.push(f);
      }
      if (formats.includes("pdf")) {
        const f = path.join(dir, `test-report-${stamp}.pdf`);
        await writePdf(data, f, { screenshots: true });
        out.push(f);
      }
      return out;
    } finally {
      this.busyWith = undefined;
    }
  }
}

export { SUITE_DIR };
