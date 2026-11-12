// GitHub Actions secrets, read-only: what workflows reference and which names v3 bans (no stored credentials).
// No vscode import. The extension never writes a secret.

/** v3: no stored credentials. Secrets and env vars no workflow may read and the extension never stores. */
export const BANNED_SECRET_RE = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|SF_JWT_\w+|SF_CLIENT_ID_\w+|JIRA_\w*TOKEN\w*|ATLASSIAN_\w*TOKEN\w*|FIREFLIES_\w+)$/;

export function isBannedSecret(name: string): boolean { return BANNED_SECRET_RE.test(name); }

/** Workflow files that read a banned secret (secrets.X or a bare env reference), for the v3 compliance row. */
export function bannedSecretRefs(files: { file: string; text: string }[]): { file: string; names: string[] }[] {
  const out: { file: string; names: string[] }[] = [];
  for (const f of files) {
    const names = new Set<string>();
    for (const m of f.text.matchAll(/\b(?:secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (isBannedSecret(m[1])) names.add(m[1]);
    if (names.size) out.push({ file: f.file, names: [...names].sort() });
  }
  return out;
}

