#!/usr/bin/env node
/**
 * Project health check script.
 * Run this after making changes to verify the project is in a good state.
 */

import { execSync } from "child_process";

const checks: { name: string; cmd: string; cwd?: string }[] = [
  { name: "Codegen sync", cmd: "bash scripts/check-codegen-sync.sh" },
  { name: "Typecheck libs", cmd: "pnpm run typecheck:libs" },
  { name: "Typecheck print-agent-web", cmd: "pnpm --filter @workspace/print-agent-web run typecheck", cwd: "artifacts/print-agent-web" },
  { name: "Typecheck api-server", cmd: "pnpm --filter @workspace/api-server run typecheck", cwd: "artifacts/api-server" },
  { name: "Typecheck pos", cmd: "pnpm --filter @workspace/pos run typecheck", cwd: "artifacts/pos" },
  { name: "Typecheck os-mobile", cmd: "pnpm --filter @workspace/os-mobile run typecheck", cwd: "artifacts/os-mobile" },
  { name: "Unit tests: api-server", cmd: "pnpm --filter @workspace/api-server test" },
  { name: "Unit tests: print-agent-web", cmd: "pnpm --filter @workspace/print-agent-web test" },
  { name: "Integration tests", cmd: "pnpm --filter @workspace/api-server run test:integration:local" },
  { name: "Lint: e2e", cmd: "pnpm --filter @workspace/print-agent-web run lint:e2e" },
  { name: "Lint: vite deps", cmd: "pnpm --filter @workspace/print-agent-web run lint:vite-deps" },
  { name: "Metro config tests", cmd: "node --test --test-force-exit test/metro-config/metro-watch.test.js" },
  { name: "Print agent tests", cmd: "cd print-agent && python -m unittest test_print_agent -v" },
];

let failures = 0;
for (const check of checks) {
  process.stdout.write(`${check.name} ... `);
  try {
    execSync(check.cmd, {
      cwd: check.cwd ?? undefined,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 300_000,
    });
    console.log("PASS");
  } catch (err: any) {
    console.log("FAIL");
    console.error(`  Command: ${check.cmd}`);
    console.error(`  ${err.stderr?.slice(0, 500) ?? err.message}`);
    failures++;
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
