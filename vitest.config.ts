import { defineConfig } from "vitest/config";

// The unit tests run real PGlite (WebAssembly PostgreSQL) in Node: starting one takes seconds, so the
// limits are generous and files run one after another to keep the memory of several databases apart.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**", "node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
  },
});
