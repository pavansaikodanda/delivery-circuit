// Actions: AI actions start a Claude session as the persona (the person's logged-in claude, no tokens); gate actions
// are human actions done with the person's own GitHub token after a modal confirmation; nav actions open other views.
// v3: dev:start-story, qa:add-tests, dev:fix, review:open-room, review:record-verdict and decision:record are skill
// sessions; arch:approve-design opens the Confluence design page and explains the human approval (G1). Every run is
// logged (no secrets).
import * as vscode from "vscode";
import type { ActionRef, ActionsService, ConnectionsService, Identity, IdentityService, ProjectContextService, SessionsService } from "../core/contracts";
import { openLink, type ModuleBase } from "../core/util";
import {
  ActionError, approvableEnvironments, confirmText, denyReason, failureContext, mergeMethods, parseAction, pinnedHead,
  type ConfirmContext, type ParsedAction,
} from "./grammar";

const str = (v: unknown): string | undefined => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim());
import { designPageOf } from "./design";

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
      default:
        throw new ActionError("Not a gate action");
    }
  }

  /** G1 is a human act in Confluence: open the design page and say exactly what to do there. */
  async function approveDesign(id: Identity, p: Extract<ParsedAction, { type: "approve-design" }>): Promise<void> {
    let url = p.url;
    if (!url && p.key) {
      const f = await project.feature(p.key).catch(() => undefined);
      url = designPageOf(f);
    }
    const text = confirmText(p, ctxFor(id));
    const detail = [
      "1. Read the page (and its Org snapshot child page) as it is now.",
      "2. Set the page status to Approved (status menu next to the title). Only members of the architects group may do this; the circuit checks who set it from the page history.",
      "3. Refresh Delivery Circuit: the approved version number is recorded on the epic's stories, and any later page change fails design-gate until it is re-approved (C5).",
      "Claude cannot approve a design.",
    ].join("\n");
    if (!url) {
      await vscode.window.showWarningMessage(`${text}\n\nNo design page is linked to ${p.key ?? "this feature"} yet. Run Design first so the page exists.`, { modal: true, detail });
      return log(`approve-design: no page for ${p.key ?? "?"}`);
    }
    const pick = await vscode.window.showInformationMessage(text, { modal: true, detail }, "Open design page");
    if (pick !== "Open design page") return log(`cancelled: approve design ${p.key ?? url}`);
    await openLink(base.root, { kind: "confluence", label: "Design", target: url });
    log(`approve-design: opened ${p.key ?? ""} design page for ${id.login}`);
  }

  /** decision:record without a text asks for it (optional: the skill asks for what is missing). */
  async function withDecisionText(action: ActionRef): Promise<ActionRef | undefined> {
    if (action.id !== "decision:record" || (action.args?.text !== undefined && String(action.args.text).trim())) return action;
    const text = await vscode.window.showInputBox({
      title: "Record decision", prompt: "What was decided? Claude adds it to the design page's Decisions (date, who, why, source link).",
      placeHolder: "e.g. Escalations route to the Tier 2 queue, not to the account owner", ignoreFocusOut: true,
    });
    if (text === undefined) return undefined;
    return text.trim() ? { ...action, args: { ...(action.args ?? {}), text: text.trim() } } : action;
  }

  /** dev:fix without a failure text: read the failed check runs of the PR head (person's GitHub login) as context. */
  async function withFailureContext(id: Identity, action: ActionRef): Promise<ActionRef> {
    if (action.id !== "dev:fix" || str(action.args?.failure)) return action;
    try {
      const pr = Number(action.args?.pr ?? action.args?.arg);
      const repo = repoPath(id);
      const head = (await connections.githubRequest<any>("GET", `${repo}/pulls/${pr}`))?.head?.sha;
      if (!/^[0-9a-f]{40}$/i.test(head ?? "")) return action;
      const runs = await connections.githubRequest<any>("GET", `${repo}/commits/${head}/check-runs?per_page=100`);
      const failure = failureContext(runs?.check_runs ?? []);
      return failure ? { ...action, args: { ...(action.args ?? {}), failure } } : action;
    } catch (e: any) {
      log(`dev:fix: could not read check runs (${e?.message ?? e}); the skill reads them itself`);
      return action;
    }
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
    if (p.type === "ai" && p.named === "decision:record") {
      const withText = await withDecisionText(action);
      if (!withText) return log(`cancelled: ${action.id}`);
      try { p = parseAction(withText); } catch (e: any) { vscode.window.showErrorMessage(e.message); return; }
    }
    if (p.type === "ai" && p.named === "dev:fix") {
      try { p = parseAction(await withFailureContext(id, action)); } catch (e: any) { vscode.window.showErrorMessage(e.message); return; }
    }
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
        case "approve-design":
          await approveDesign(id, p);
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
