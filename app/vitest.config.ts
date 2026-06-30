import { defineConfig } from "vitest/config";

// Backend (serverless API) unit tests. The SPA build (`tsc -b`, include: src)
// ignores these; vitest runs them against the Node runtime.
export default defineConfig({
  test: {
    environment: "node",
    include: ["api/**/*.test.ts"],
  },
});
