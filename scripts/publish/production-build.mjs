import { runCommand, runCommandPhase } from "./phase.mjs";

await runCommand("node", ["scripts/publish/validate-contract.mjs"]);
await runCommand("pnpm", ["run", "check:deployment-context"]);

await runCommandPhase("typecheck:production", "pnpm", ["run", "typecheck:production"], {
  scope: ["@workspace/api-server", "@workspace/print-agent-web"],
  cacheStatus: "tsbuildinfo-observed-by-tsc",
});
await runCommandPhase("build:api-server", "pnpm", [
  "--filter",
  "@workspace/api-server",
  "run",
  "build",
], { package: "@workspace/api-server" });
await runCommand("pnpm", [
  "--filter",
  "@workspace/print-agent-web",
  "run",
  "build",
]);