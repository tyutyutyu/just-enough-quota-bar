import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The files that import `vscode` are covered by the integration test.
      exclude: ["src/extension.ts", "src/statusbar/vscodeSink.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 80,
      },
    },
  },
});
