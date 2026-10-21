import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Each test file starts a database of its own and builds every table, all files at once:
  // on a busy machine that can take longer than the usual 10 seconds.
  test: { include: ["src/**/*.test.ts"], hookTimeout: 60_000, testTimeout: 30_000 },
});
