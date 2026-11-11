// GitHub Actions secrets: name rules, what the circuit's workflows need, and sealed-box encryption.
// No vscode import. Values are never logged or returned.

/** GitHub rules: letters, digits, underscore; not starting with a digit or GITHUB_; at most 255 chars. */
export function validateSecretName(name: string): string | undefined {
  if (!name) return "Secret name is empty.";
  if (name.length > 255) return "Secret name is longer than 255 characters.";
  if (!/^[A-Za-z0-9_]+$/.test(name)) return "Secret names may only contain letters, digits and underscores.";
  if (/^[0-9]/.test(name)) return "Secret names must not start with a digit.";
  if (/^GITHUB_/i.test(name)) return "Secret names must not start with GITHUB_.";
  return undefined;
}

export function validateEnvironmentName(env: string): string | undefined {
  if (!env || env.length > 255) return "Environment name is empty or too long.";
  if (!/^[A-Za-z0-9_.-]+$/.test(env)) return "Environment names may only contain letters, digits, '.', '-' and '_'.";
  return undefined;
}

export interface WorkflowNeeds {
  secrets: string[];
  /** Environments jobs deploy into (from `environment:`; `${{ vars.X || 'production' }}` resolves to the default). */
  environments: string[];
  /** secret -> environment, for secrets used only inside a job that declares an environment */
  envOf: Record<string, string>;
}

/** Scans workflow YAML texts for `secrets.NAME` and `environment:` per job (line-based, tolerant). */
export function scanWorkflows(texts: string[]): WorkflowNeeds {
  const secrets = new Set<string>(); const envs = new Set<string>();
  const outside = new Set<string>(); const inEnv: Record<string, Set<string>> = {};
  for (const text of texts) {
    // split into jobs: lines with exactly two-space-indented "name:" under "jobs:"
    const lines = text.split(/\r?\n/);
    let inJobs = false; let jobEnv: string | undefined;
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; jobEnv = undefined; continue; }
      if (/^\S/.test(line)) { inJobs = false; jobEnv = undefined; }
      if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) jobEnv = undefined;
      const em = inJobs && line.match(/^\s{4}environment:\s*(.+?)\s*$/);
      if (em) { const e = resolveEnv(em[1]); if (e) { envs.add(e); jobEnv = e; } }
      for (const m of line.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = m[1];
        if (name === "GITHUB_TOKEN") continue;
        secrets.add(name);
        if (jobEnv) (inEnv[name] ??= new Set()).add(jobEnv); else outside.add(name);
      }
    }
  }
  const envOf: Record<string, string> = {};
  for (const [name, set] of Object.entries(inEnv)) if (!outside.has(name) && set.size === 1) envOf[name] = [...set][0];
  return { secrets: [...secrets].sort(), environments: [...envs].sort(), envOf };
}

function resolveEnv(raw: string): string | undefined {
  let s = raw.trim().replace(/^["']|["']$/g, "");
  const expr = s.match(/^\$\{\{(.*)\}\}$/);
  if (expr) { const d = expr[1].match(/\|\|\s*'([^']+)'/); s = d ? d[1] : ""; }
  const nm = s.match(/^name:\s*(.+)$/); if (nm) s = nm[1].trim();
  return s && !validateEnvironmentName(s) ? s : undefined;
}

export type SecretKind = "slack-webhook" | "claude" | "jira" | "salesforce" | "github-app" | "other";
export function secretKind(name: string): SecretKind {
  if (/^SLACK_WEBHOOK/.test(name)) return "slack-webhook";
  if (name === "CLAUDE_CODE_OAUTH_TOKEN") return "claude";
  if (/^JIRA_/.test(name)) return "jira";
  if (/^SF_/.test(name)) return "salesforce";
  if (/^APP_(ID|PRIVATE_KEY)$/.test(name)) return "github-app";
  return "other";
}

/** Secrets whose value is usually a file (PEM keys). */
export function isFileSecret(name: string): boolean { return /(^|_)(PRIVATE_KEY|JWT_KEY|PEM|CERT)(_|$)/.test(name); }

export interface Sodium {
  ready: Promise<unknown>;
  from_base64(s: string, variant?: number): Uint8Array;
  to_base64(b: Uint8Array, variant?: number): string;
  from_string(s: string): Uint8Array;
  crypto_box_seal(m: Uint8Array, pk: Uint8Array): Uint8Array;
  base64_variants: { ORIGINAL: number };
}

export async function loadSodium(): Promise<Sodium> {
  const m: any = await import("libsodium-wrappers");
  const sodium: Sodium = m.default ?? m;
  await sodium.ready;
  return sodium;
}

/** libsodium sealed box with the repo/environment public key (base64), as GitHub requires. */
export async function sealSecret(value: string, publicKeyB64: string, sodium?: Sodium): Promise<string> {
  const s = sodium ?? await loadSodium();
  const key = s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL);
  return s.to_base64(s.crypto_box_seal(s.from_string(value), key), s.base64_variants.ORIGINAL);
}
