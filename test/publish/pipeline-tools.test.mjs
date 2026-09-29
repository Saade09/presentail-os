import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production build is explicitly scoped to API and web", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts.build, "pnpm run build:production");
  const buildScript = await readFile("scripts/publish/production-build.mjs", "utf8");
  assert.match(buildScript, /@workspace\/api-server/);
  assert.match(buildScript, /@workspace\/print-agent-web/);
  assert.doesNotMatch(buildScript, /pnpm -r/);
  const contract = JSON.parse(
    await readFile("scripts/publish/production-services.json", "utf8"),
  );
  assert.deepEqual(
    contract.services.map((service) => service.package),
    ["@workspace/api-server", "@workspace/print-agent-web"],
  );
  assert.ok(contract.excludedFromRootProductionBuild.includes("@workspace/os-mobile"));
  assert.ok(contract.excludedFromRootProductionBuild.includes("@workspace/pos"));
  const apiBuild = await readFile("scripts/deploy-build-api-server.sh", "utf8");
  const webPackage = JSON.parse(
    await readFile("artifacts/print-agent-web/package.json", "utf8"),
  );
  assert.match(apiBuild, /validate-contract\.mjs/);
  assert.match(apiBuild, /check:deployment-context/);
  assert.match(apiBuild, /typecheck:production/);
  assert.match(webPackage.scripts.build, /validate-contract\.mjs/);
  assert.match(webPackage.scripts.build, /context-inventory\.mjs --check/);
});

test("store pruning is opt-in and bounded", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const repl = await readFile(".replit", "utf8");
  assert.equal(packageJson.scripts["publish:cache-maintenance"], "node scripts/publish/cache-maintenance.mjs");
  assert.doesNotMatch(repl, /pnpm[" ,]+store[" ,]+prune/);
  const maintenance = await readFile("scripts/publish/cache-maintenance.mjs", "utf8");
  assert.match(maintenance, /PUBLISH_ALLOW_STORE_PRUNE/);
  assert.match(maintenance, /PNPM_STORE_PRUNE_INTERVAL_DAYS/);
  assert.match(maintenance, /Maintenance interval has not elapsed/);
});

test("context exclusions have an executable reference guard", async () => {
  const script = await readFile("scripts/publish/context-inventory.mjs", "utf8");
  assert.match(script, /runtimeReferenceGuard/);
  assert.match(script, /Presentail-Fleet_/);
  assert.match(script, /chromium_headless_shell-/);
});