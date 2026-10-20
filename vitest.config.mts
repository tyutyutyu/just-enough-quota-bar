import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The VS Code entry point is covered by the integration test.
      exclude: ["src/extension.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 80,
      },
    },
  },
});
