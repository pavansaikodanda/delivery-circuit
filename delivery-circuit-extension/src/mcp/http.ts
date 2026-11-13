// Loopback-only Streamable HTTP host for the Circuit MCP. Stateless: one MCP server instance per POST, bound
// to the scope of the bearer token. No vscode import (tested with the MCP client).
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const MCP_PATH = "/mcp";
const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface CircuitHttpOptions {
  /** scope -> bearer token */
  tokens: Record<string, string>;
  makeServer(persona: string): McpServer;
  /** Re-checked on every request: false answers 403 even for a valid token (the role was switched or the person signed out). */
  authorize?(persona: string): boolean;
  log?: (msg: string) => void;
  /** default 0 = random free port */
  port?: number;
}

export interface CircuitHttp { port: number; url: string; close(): Promise<void> }

export function newToken(): string { return randomBytes(32).toString("base64url"); }

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time lookup: every token is compared, no early exit, equal-length digests. */
export function personaForToken(presented: string | undefined, tokens: Record<string, string>): string | undefined {
  if (!presented) return undefined;
  const d = digest(presented);
  let found: string | undefined;
  for (const [p, t] of Object.entries(tokens) as [string, string][]) {
    if (timingSafeEqual(d, digest(t)) && !found) found = p;
  }
  return found;
}

export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try { const u = new URL(origin); return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); } catch { return false; }
}

function send(res: http.ServerResponse, code: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

export async function startCircuitHttp(opts: CircuitHttpOptions): Promise<CircuitHttp> {
  let port = 0;
  const srv = http.createServer(async (req, res) => {
    try {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) { req.socket.destroy(); return; }
      if (!isLoopbackHost(req.headers.host, port) || !isLoopbackOrigin(req.headers.origin as string | undefined)) return send(res, 403, "Forbidden");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== MCP_PATH) return send(res, 404, "Not found");
      const auth = String(req.headers.authorization ?? "");
      const persona = personaForToken(/^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim(), opts.tokens);
      if (!persona) return send(res, 401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="circuit"' });
      if (opts.authorize && !opts.authorize(persona)) return send(res, 403, "Forbidden: this token is no longer valid");
      if (req.method !== "POST") return send(res, 405, "Method not allowed", { Allow: "POST" });
      let body: unknown;
      try { body = await readBody(req); } catch (e: any) { return send(res, e?.message === "too large" ? 413 : 400, e?.message === "too large" ? "Request too large" : "Parse error"); }
      const server = opts.makeServer(persona);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req as any, res, body);
    } catch (e: any) {
      opts.log?.(`circuit mcp: request failed: ${String(e?.message ?? e).slice(0, 200)}`);
      send(res, 500, "Internal error");
    }
  });
  srv.headersTimeout = 30_000;
  srv.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(opts.port ?? 0, "127.0.0.1", () => { srv.off("error", reject); resolve(); });
  });
  port = (srv.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    close: () => new Promise<void>((resolve) => { srv.closeAllConnections?.(); srv.close(() => resolve()); }),
  };
}
