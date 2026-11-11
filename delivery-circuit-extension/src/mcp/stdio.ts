// Stand-alone stdio entry of the Circuit MCP server (dist/circuit-mcp.js) for CI and terminal sessions:
//   claude --mcp-config '{"mcpServers":{"circuit":{"command":"node","args":["<ext>/dist/circuit-mcp.js"]}}}'
// Repository-only tools (no secrets, no transcripts); the repository is the current working directory.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { repoData } from "./repoData";
import { createCircuitServer } from "./tools";

async function main(): Promise<void> {
  const root = process.cwd();
  const server = createCircuitServer("repo", repoData(root));
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr only
  process.stderr.write(`circuit-mcp: serving ${root} (repository tools only)\n`);
}

main().catch((e) => {
  process.stderr.write(`circuit-mcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
