// GitHub REST/GraphQL client used by ConnectionsService (the person's VS Code GitHub sign-in). No vscode import; token and fetch are injected.

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export const GITHUB_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "GitHubError"; }
}

/** A message that says what went wrong and what to do. Never includes the token. */
export function githubErrorMessage(status: number, method: string, path: string, bodyText: string, headers: { get(n: string): string | null }): string {
  let apiMsg = "";
  try { const j = JSON.parse(bodyText); apiMsg = typeof j?.message === "string" ? j.message : ""; } catch { apiMsg = bodyText.slice(0, 200); }
  const base = `GitHub ${status} on ${method} ${path}${apiMsg ? `: ${apiMsg}` : ""}`;
  if (status === 401) return `${base}. Your GitHub sign-in has expired or was revoked; connect GitHub again.`;
  if (status === 403 && headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    const at = reset ? new Date(reset * 1000).toLocaleTimeString() : "later";
    return `${base}. GitHub rate limit reached; it resets at ${at}.`;
  }
  if (status === 403) return `${base}. Your account lacks permission (or the org restricts OAuth apps; ask an org owner to approve VS Code).`;
  if (status === 404) return `${base}. Not found, or your token cannot see it (needs scopes repo and read:org, and access to the repo).`;
  if (status === 422) return `${base}. GitHub rejected the request data.`;
  return base;
}

export function checkPath(path: string): void {
  if (!path.startsWith("/") || path.includes("://") || /\s/.test(path)) throw new Error(`Invalid GitHub API path: ${path}`);
}

export class GitHubClient {
  constructor(private token: () => Promise<string>, private fetchFn: FetchLike = (globalThis.fetch as unknown as FetchLike)) {}

  async request<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
    checkPath(path);
    const token = await this.token();
    const res = await this.fetchFn(GITHUB_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "delivery-circuit", ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(githubErrorMessage(res.status, method, path, text, res.headers), res.status);
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
  }

  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.token();
    const res = await this.fetchFn(GITHUB_API + "/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "delivery-circuit" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(githubErrorMessage(res.status, "POST", "/graphql", text, res.headers), res.status);
    const j = JSON.parse(text);
    if (Array.isArray(j.errors) && j.errors.length) {
      throw new GitHubError(`GitHub GraphQL: ${j.errors.map((e: any) => e?.message).filter(Boolean).join("; ")}`, 200);
    }
    return j.data as T;
  }
}
