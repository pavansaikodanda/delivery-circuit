import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL("./test/unit/vscode-mock.ts", import.meta.url)) } },
  test: { include: ["test/unit/**/*.test.ts"], environment: "node", testTimeout: 20000 },
});
