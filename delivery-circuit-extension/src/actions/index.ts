// Actions: AI actions start a Claude session as the persona; gate actions are human actions done with the person's
// own GitHub token after a modal confirmation; nav actions open other views. Every run is logged (no secrets).
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ActionRef, ActionsService, ConnectionsService, Identity, IdentityService, ProjectContextService, SessionsService } from "../core/contracts";
import { gitBranch, run, type ModuleBase } from "../core/util";
import {
  ActionError, approvableEnvironments, confirmText, denyReason, isProtectedBranch, mergeMethods, parseAction, pinnedHead, signoffMessage,
  type ConfirmContext, type ParsedAction,
} from "./grammar";
import { applySignOff, signOffItems } from "./signoff";

type Deps = { identity: IdentityService; connections: ConnectionsService; sessions: SessionsService; project: ProjectContextService };

export function createActions(base: ModuleBase, deps: Deps): ActionsService {
  const { identity, connections, sessions, project } = deps;
  const log = (m: string) => base.log(`action: ${m}`);

  async function confirm(text: string, button: string): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(text, { modal: true }, button);
    return pick === button;
  }

  function ctxFor(id: Identity, extra: Partial<ConfirmContext> = {}): ConfirmContext {
    return { login: id.login, owner: id.owner, repo: id.repo, ...extra };
  }

  const repoPath = (id: Identity) => `/repos/${encodeURIComponent(id.owner)}/${encodeURIComponent(id.repo)}`;

  async function runGate(id: Identity, p: ParsedAction): Promise<void> {
    const repo = repoPath(id);
    /** Current head of a PR, checked against the head the person was shown. */
    const headOf = async (pr: number, seen?: string) =>
      pinnedHead(pr, seen, (await connections.githubRequest<any>("GET", `${repo}/pulls/${pr}`))?.head?.sha);
    switch (p.type) {
      case "label": {
        const text = confirmText(p, ctxFor(id));
        if (!(await confirm(text, "Add label"))) return log(`cancelled: ${text}`);
        await connections.githubRequest("POST", `${repo}/issues/${p.pr}/labels`, { labels: [p.label] });
        log(`done: ${text}`);
        vscode.window.showInformationMessage(`Label ${p.label} added to PR #${p.pr}.`);
        break;
      }
      case "review": {
        let body: string | undefined = "";
        if (p.event === "REQUEST_CHANGES") {
          body = await vscode.window.showInputBox({
            title: `Request changes on PR #${p.pr}`, prompt: "What needs to change? This becomes the review comment.",
            ignoreFocusOut: true, validateInput: (v) => (v.trim() ? null : "A comment is required to request changes"),
          });
          if (body === undefined) return log(`cancelled: request changes on PR #${p.pr}`);
        }
        const head = await headOf(p.pr, p.sha);
        const text = confirmText(p, ctxFor(id, { headSha: head }));
        if (!(await confirm(text, p.event === "APPROVE" ? "Approve" : "Request changes"))) return log(`cancelled: ${text}`);
        // commit_id pins the review to the commit shown in the confirmation, even if a push lands meanwhile.
        await connections.githubRequest("POST", `${repo}/pulls/${p.pr}/reviews`, body ? { event: p.event, body, commit_id: head } : { event: p.event, commit_id: head });
        log(`done: ${text}`);
        vscode.window.showInformationMessage(p.event === "APPROVE" ? `PR #${p.pr} approved.` : `Changes requested on PR #${p.pr}.`);
        break;
      }
      case "merge": {
        const info = await connections.githubRequest<any>("GET", repo);
        const methods = mergeMethods(info ?? {});
        if (!methods.length) throw new ActionError("This repository allows no merge method");
        let method = methods[0];
        if (methods.length > 1) {
          const pick = await vscode.window.showQuickPick(methods.map((m) => ({ label: m, description: m === methods[0] ? "first allowed in repo settings" : undefined })),
            { title: `Merge PR #${p.pr}`, placeHolder: "Merge method (allowed by the repository settings)" });
          if (!pick) return log(`cancelled: merge PR #${p.pr}`);
          method = pick.label as typeof method;
        }
        const head = await headOf(p.pr, p.sha);
        const text = confirmText(p, ctxFor(id, { mergeMethod: method, headSha: head }));
        if (!(await confirm(text, "Merge"))) return log(`cancelled: ${text}`);
        try {
          // sha: GitHub refuses (409) if the head moved after the confirmation, instead of merging unreviewed commits.
          await connections.githubRequest("PUT", `${repo}/pulls/${p.pr}/merge`, { merge_method: method, sha: head });
        } catch (e: any) {
          log(`refused: ${text}: ${e?.message ?? e}`);
          vscode.window.showErrorMessage(`GitHub refused the merge of PR #${p.pr}: ${e?.message ?? e}`, { modal: true });
          return;
        }
        log(`done: ${text}`);
        vscode.window.showInformationMessage(`PR #${p.pr} merged (${method}).`);
        break;
      }
      case "deploy": {
        const pending = await connections.githubRequest<any[]>("GET", `${repo}/actions/runs/${p.runId}/pending_deployments`);
        const { approvable, blocked } = approvableEnvironments(pending ?? []);
        if (!approvable.length) {
          throw new ActionError(blocked.length
            ? `You are not a required reviewer for ${blocked.join(", ")} on run #${p.runId}`
            : `Run #${p.runId} is not waiting for a production approval`);
        }
        const text = confirmText(p, ctxFor(id, { environments: approvable.map((e) => e.name) }));
        if (!(await confirm(text, "Approve deployment"))) return log(`cancelled: ${text}`);
        await connections.githubRequest("POST", `${repo}/actions/runs/${p.runId}/pending_deployments`, {
          environment_ids: approvable.map((e) => e.id), state: "approved", comment: `Approved by ${id.login} from Delivery Circuit (G9)`,
        });
        log(`done: ${text}`);
        vscode.window.showInformationMessage(`Deployment of run #${p.runId} approved.`);
        break;
      }
      case "signoff":
        await signOff(id, p);
        break;
      default:
        throw new ActionError("Not a gate action");
    }
  }

  async function git(args: string[], input?: string) {
    const r = await run("git", args, { cwd: base.root, timeoutMs: 120_000, input, shell: false });
    if (r.code !== 0) throw new ActionError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" ")}`);
    return r.stdout.trim();
  }

  async function signOff(id: Identity, p: Extract<ParsedAction, { type: "signoff" }>): Promise<void> {
    const feature = await project.feature(p.featureId);
    if (!feature) throw new ActionError(`Feature ${p.featureId} not found under .specify/specs`);
    const rel = path.posix.join(feature.dir.split(path.sep).join("/"), "plan.md");
    const abs = path.join(base.root, rel);
    if (!fs.existsSync(abs)) throw new ActionError(`${rel} does not exist yet`);
    if (!/^[\w./-]+$/.test(rel)) throw new ActionError(`Unexpected characters in the path ${rel}`);

    const branch = await gitBranch(base.root);
    if (isProtectedBranch(branch)) throw new ActionError(`You are on ${branch || "a detached HEAD"}. Switch to the spec branch (spec/${feature.slug}) first; sign-off is never committed on main.`);
    if (!/^[\w./-]+$/.test(branch)) throw new ActionError(`Branch name ${branch} has characters this action does not push`);
    const gitName = await git(["config", "user.name"]).catch(() => "");
    const gitEmail = await git(["config", "user.email"]).catch(() => "");
    if (!gitName || !gitEmail) throw new ActionError("Set your git identity first (git config user.name / user.email); the commit must be yours");

    const dirty = await git(["status", "--porcelain", "--", rel]);
    const doc = await vscode.workspace.openTextDocument(abs);
    await vscode.window.showTextDocument(doc, { preview: false });
    if (doc.isDirty) throw new ActionError(`${rel} has unsaved edits. Save or revert them first.`);

    const plan = doc.getText();
    const items = signOffItems(plan);
    if (!items.length) throw new ActionError(`${rel} has no Architect Sign-Off section`);
    const picks = await vscode.window.showQuickPick(
      items.map((it) => ({ label: it.text, description: it.section, picked: true, it, detail: it.checked ? "already ticked" : undefined })),
      { canPickMany: true, title: `Architect Sign-Off: ${feature.slug}`, placeHolder: "Untick anything you have not reviewed. Overall APPROVED is required.", ignoreFocusOut: true },
    );
    if (!picks) return log(`cancelled: sign-off ${feature.slug}`);
    if (!picks.some((x) => x.it.overall)) throw new ActionError("Sign-off not recorded: the Overall APPROVED box was not ticked");

    const text = confirmText(p, ctxFor(id, { planPath: rel, branch, gitName, gitEmail }));
    if (!(await confirm(dirty ? `${text}\n\nplan.md also has your uncommitted edits; they are included in this commit.` : text, "Sign off"))) return log(`cancelled: ${text}`);

    const updated = applySignOff(plan, picks.map((x) => x.it.line), gitName, new Date().toISOString());
    fs.writeFileSync(abs, updated, "utf8");
    await git(["add", "--", rel]);
    // Message via stdin: user-visible text never goes through a shell.
    await git(["commit", "-F", "-", "--", rel], signoffMessage(feature.slug) + "\n");
    const push = await run("git", ["push", "-u", "origin", branch], { cwd: base.root, timeoutMs: 120_000, shell: false });
    if (push.code !== 0) {
      log(`committed but push failed: ${text}`);
      vscode.window.showErrorMessage(`Signed off and committed locally, but the push failed: ${(push.stderr || push.stdout).trim().split(/\r?\n/).slice(-2).join(" ")}`);
      return;
    }
    log(`done: ${text}`);
    vscode.window.showInformationMessage(`Architect sign-off for ${feature.slug} committed and pushed on ${branch}.`);
    project.refresh().catch(() => {});
  }

  async function runAction(action: ActionRef): Promise<void> {
    const id = identity.get();
    const reason = denyReason(id, action);
    if (reason || !id) {
      log(`denied ${action.id} (${action.persona}) for ${id?.login ?? "nobody"}: ${reason}`);
      vscode.window.showWarningMessage(`${action.label}: ${reason}`);
      return;
    }
    let p: ParsedAction;
    try { p = parseAction(action); } catch (e: any) { vscode.window.showErrorMessage(e.message); return; }
    log(`start ${action.id} as ${id.login} (${action.persona}) ${JSON.stringify(action.args ?? {})}`);
    try {
      switch (p.type) {
        case "ai":
          await sessions.start(action.persona, p.prompt, { title: action.label });
          log(`session started: ${action.persona} "${p.prompt}"`);
          break;
        case "nav-feature":
          await vscode.commands.executeCommand("deliveryCircuit.openPersona", action.persona, { featureId: p.featureId });
          break;
        case "nav-testing":
          await vscode.commands.executeCommand("deliveryCircuit.openTesting", p.suite ? { suite: p.suite } : undefined);
          break;
        case "nav-connections":
          await vscode.commands.executeCommand("deliveryCircuit.openConnections");
          break;
        default:
          await runGate(id, p);
          project.refresh().catch(() => {});
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      log(`failed ${action.id}: ${msg}`);
      vscode.window.showErrorMessage(`${action.label}: ${msg}`);
    }
  }

  return {
    run: runAction,
    allowed: (action) => denyReason(identity.get(), action) === null,
  };
}

export { denyReason, parseAction } from "./grammar";
