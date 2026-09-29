import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./src/vitest.integration.globalSetup.ts"],
    include: ["**/*.integration.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage/integration",
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
