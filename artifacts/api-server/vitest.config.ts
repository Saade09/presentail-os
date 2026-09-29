import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 60000,
    pool: "threads",
    maxWorkers: 8,
    minWorkers: 2,
    isolate: false,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage/unit",
      include: ["src/**/*.ts"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.ts",
        "**/*.integration.test.ts",
      ],
    },
  },
});
