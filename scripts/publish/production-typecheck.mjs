import { readFile } from "node:fs/promises";
import { runCommand, runPhase } from "./phase.mjs";

await runPhase(
  "typecheck:production",
  async () => {
    const manifest = JSON.parse(
      await readFile("scripts/publish/production-services.json", "utf8"),
    );
    if (
      manifest.services.map((service) => service.package).join(",") !==
      "@workspace/api-server,@workspace/print-agent-web"
    ) {
      throw new Error(
        "Production service contract changed without updating validation",
      );
    }
    await runCommand("pnpm", ["run", "typecheck:libs"]);
    await runCommand("pnpm", [
      "--filter",
      "@workspace/api-server",
      "run",
      "typecheck",
    ]);
    await runCommand("pnpm", [
      "--filter",
      "@workspace/print-agent-web",
      "exec",
      "tsc",
      "-p",
      "tsconfig.production.json",
      "--noEmit",
    ]);
  },
  {
    scope: ["@workspace/api-server", "@workspace/print-agent-web"],
    cacheStatus: "tsbuildinfo-observed-by-tsc",
  },
);