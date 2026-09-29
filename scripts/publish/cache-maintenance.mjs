import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { pnpmStorePath, runCommandPhase } from "./phase.mjs";

const intervalDays = Number(process.env.PNPM_STORE_PRUNE_INTERVAL_DAYS || 30);
if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) {
  throw new Error("PNPM_STORE_PRUNE_INTERVAL_DAYS must be an integer between 1 and 365");
}

if (process.env.PUBLISH_ALLOW_STORE_PRUNE !== "true") {
  console.log(
    JSON.stringify({
      schema: "presentail.publish.v1",
      event: "publish.cache-maintenance",
      status: "skipped",
      reason: "Set PUBLISH_ALLOW_STORE_PRUNE=true for intentional bounded maintenance.",
      intervalDays,
    }),
  );
  process.exit(0);
}

const storePath = pnpmStorePath();
if (!storePath || !existsSync(storePath)) {
  throw new Error("pnpm store path is unavailable");
}
const stampPath = path.join(storePath, ".presentail-last-prune");
let lastPrunedAt = 0;
try {
  lastPrunedAt = Date.parse((await readFile(stampPath, "utf8")).trim());
} catch {
  // First intentional maintenance run.
}
const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
if (Number.isFinite(lastPrunedAt) && Date.now() - lastPrunedAt < intervalMs) {
  console.log(
    JSON.stringify({
      schema: "presentail.publish.v1",
      event: "publish.cache-maintenance",
      status: "skipped",
      reason: "Maintenance interval has not elapsed.",
      intervalDays,
      lastPrunedAt: new Date(lastPrunedAt).toISOString(),
    }),
  );
  process.exit(0);
}

await runCommandPhase("cache-maintenance", "pnpm", ["store", "prune"], {
  cacheStatus: "bounded-manual-maintenance",
  intervalDays,
});
await writeFile(stampPath, `${new Date().toISOString()}\n`);