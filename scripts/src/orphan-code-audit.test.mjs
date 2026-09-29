import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIRMED_ORPHAN_PATHS,
  findEntrypointEvidence,
  findOrphanCandidates,
  getFrameworkEntrypointReason,
} from "./orphan-code-audit.mjs";

const orphanPath = CONFIRMED_ORPHAN_PATHS[0];

test("the baseline contains every confirmed orphan from the audit", () => {
  assert.equal(CONFIRMED_ORPHAN_PATHS.length, 18);
  assert.ok(
    CONFIRMED_ORPHAN_PATHS.includes(
      "artifacts/print-agent-web/src/components/ui/sonner.tsx",
    ),
  );
  assert.ok(CONFIRMED_ORPHAN_PATHS.includes("scripts/src/migrate-from-source-db.cjs"));
});

test("reports a reintroduced candidate with no entrypoint evidence", () => {
  const findings = findOrphanCandidates([
    { path: orphanPath, content: "export function isPublicHoliday() {}" },
  ]);

  assert.deepEqual(findings.map((finding) => finding.path), [orphanPath]);
});

test("accepts direct and lazy imports as intentional reachability", () => {
  const files = [
    { path: orphanPath, content: "export const helper = true;" },
    {
      path: "artifacts/api-server/src/routes/timeOff.ts",
      content: `import { helper } from "../lib/${orphanPath.split("/").pop().replace(".ts", "")}";`,
    },
    {
      path: "artifacts/print-agent-web/src/App.tsx",
      content: `const Helper = lazy(() => import("@/lib/${orphanPath.split("/").pop().replace(".ts", "")}"));`,
    },
  ];

  const evidence = findEntrypointEvidence(orphanPath, files);
  assert.ok(evidence.some((item) => item.kind === "static or lazy import reference"));
  assert.equal(findOrphanCandidates(files).length, 0);
});

test("accepts package scripts, CI, tests, and operator documentation", () => {
  const cases = [
    {
      path: "scripts/src/copy-binary-files.cjs",
      sourcePath: "scripts/package.json",
      content: '"copy-binaries": "node ./src/copy-binary-files.cjs"',
      expected: "package script/export reference",
    },
    {
      path: "scripts/src/copy-binary-files.cjs",
      sourcePath: ".github/workflows/ci.yml",
      content: "run: node scripts/src/copy-binary-files.cjs",
      expected: "CI/workflow reference",
    },
    {
      path: "scripts/src/copy-binary-files.cjs",
      sourcePath: "test/copy-binary-files.test.mjs",
      content: "import '../scripts/src/copy-binary-files.cjs';",
      expected: "test reference",
    },
    {
      path: "scripts/src/copy-binary-files.cjs",
      sourcePath: "docs/operator.md",
      content: "Run scripts/src/copy-binary-files.cjs after packaging.",
      expected: "documented operator reference",
    },
  ];

  for (const example of cases) {
    const evidence = findEntrypointEvidence(example.path, [
      { path: example.path, content: "" },
      { path: example.sourcePath, content: example.content },
    ]);
    assert.ok(
      evidence.some((item) => item.kind === example.expected),
      `${example.expected} should be recognized`,
    );
  }
});

test("keeps convention-based entrypoints out of the orphan findings", () => {
  const expoRoute = "artifacts/pos/app/(tabs)/orders.tsx";
  const scannerModule = "artifacts/scanner-agent/src/lib/watcher.ts";

  assert.equal(
    getFrameworkEntrypointReason(expoRoute),
    "Expo Router filesystem route",
  );
  assert.equal(
    getFrameworkEntrypointReason(scannerModule),
    "Electron scanner source packaged from scanner-agent",
  );
  assert.equal(
    findOrphanCandidates([
      { path: expoRoute, content: "export default function Orders() {}" },
      { path: scannerModule, content: "export function watch() {}" },
    ], [expoRoute, scannerModule]).length,
    0,
  );
});

test("recognizes adapter registry implementations", () => {
  const adapterPath =
    "artifacts/api-server/src/modules/omnichannel/adapters/ExampleAdapter.ts";
  const evidence = findEntrypointEvidence(adapterPath, [
    { path: adapterPath, content: "export class ExampleAdapter {}" },
    {
      path: "artifacts/api-server/src/modules/omnichannel/adapters/adapterRegistry.ts",
      content: "import { ExampleAdapter } from './ExampleAdapter';",
    },
  ]);

  assert.ok(evidence.some((item) => item.kind === "adapter registry reference"));
  assert.equal(findOrphanCandidates([
    { path: adapterPath, content: "export class ExampleAdapter {}" },
    {
      path: "artifacts/api-server/src/modules/omnichannel/adapters/adapterRegistry.ts",
      content: "import { ExampleAdapter } from './ExampleAdapter';",
    },
  ], [adapterPath]).length, 0);
});