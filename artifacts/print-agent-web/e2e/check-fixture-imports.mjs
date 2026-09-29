#!/usr/bin/env node
/**
 * check-fixture-imports.mjs
 *
 * Scans every *.spec.ts file in this directory and reports any file that
 * imports `test` or `expect` directly from `@playwright/test` instead of
 * from `./fixtures`.
 *
 * Importing from `@playwright/test` bypasses the auto `_fapiMock` fixture
 * that injects the signed-in Clerk session, so every test in the spec runs
 * as a signed-out user and lands on the marketing landing page — a failure
 * mode that is confusing to debug.
 *
 * Opt-out for intentionally-unauthenticated specs
 * ------------------------------------------------
 * Add the following marker comment anywhere in the file (typically the top):
 *
 *   // e2e-unauthenticated
 *
 * The fixture-import check will skip that file entirely. However, opted-out
 * files MUST also contain explicit session-clearing code so the test really
 * runs as a signed-out user. The accepted patterns are:
 *
 *   test.use({ storageState: { cookies: [], origins: [] } });
 *
 * — clears Playwright's stored cookies/origins so no Clerk session leaks in,
 * or:
 *
 *   test.use({ skipFapiMock: true });
 *
 * — disables the custom FAPI mock fixture entirely.
 *
 * Without one of these, the marker would silently bypass the lint while the
 * spec still ran with a signed-in session, producing false positives.
 *
 * Usage: node e2e/check-fixture-imports.mjs
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPT_OUT_MARKER = "// e2e-unauthenticated";

const PLAYWRIGHT_IMPORT_RE =
  /^\s*import\s+\{[^}]*\b(test|expect)\b[^}]*\}\s+from\s+['"]@playwright\/test['"]/m;

const STORAGE_STATE_CLEAR_RE =
  /storageState\s*:\s*\{\s*cookies\s*:\s*\[\s*\]\s*,\s*origins\s*:\s*\[\s*\]\s*\}/;

const SKIP_FAPI_MOCK_LITERAL = "skipFapiMock: true";

const specFiles = readdirSync(__dirname).filter((f) => f.endsWith(".spec.ts"));

const violations = [];
const optedOutFiles = [];

for (const file of specFiles) {
  const fullPath = join(__dirname, file);
  const content = readFileSync(fullPath, "utf-8");

  if (content.includes(OPT_OUT_MARKER)) {
    optedOutFiles.push({ file, content });
    continue;
  }

  if (PLAYWRIGHT_IMPORT_RE.test(content)) {
    violations.push(file);
  }
}

let hasError = false;

if (violations.length > 0) {
  hasError = true;
  console.error(
    `\nERROR: The following e2e spec file(s) import 'test' or 'expect' directly from\n` +
      `'@playwright/test' instead of from './fixtures'.\n\n` +
      `This bypasses the _fapiMock auto-fixture that injects the Clerk signed-in\n` +
      `session, causing every test to run as a signed-out user.\n\n` +
      `Fix: change the import to:\n\n` +
      `  import { test, expect } from './fixtures';\n\n` +
      `If the spec intentionally tests an unauthenticated flow, add this marker\n` +
      `comment anywhere in the file to opt out of this check:\n\n` +
      `  // e2e-unauthenticated\n\n` +
      `Affected files:\n`,
  );
  for (const file of violations) {
    console.error(`  • e2e/${file}`);
  }
  console.error();
}

const sessionViolations = [];
for (const { file, content } of optedOutFiles) {
  const hasStorageStateClear = STORAGE_STATE_CLEAR_RE.test(content);
  const hasSkipFapiMock = content.includes(SKIP_FAPI_MOCK_LITERAL);
  if (!hasStorageStateClear && !hasSkipFapiMock) {
    sessionViolations.push(file);
  }
}

if (sessionViolations.length > 0) {
  hasError = true;
  console.error(
    `\nERROR: The following e2e spec file(s) carry the '// e2e-unauthenticated'\n` +
      `marker but do not contain any explicit session-clearing code.\n\n` +
      `The marker only opts out of the fixture-import check — it does NOT clear\n` +
      `the signed-in Clerk session. Without an explicit opt-out, these specs\n` +
      `will silently run as a signed-in user and produce false positives.\n\n` +
      `Fix: add one of the following to the spec (typically inside test.describe):\n\n` +
      `  test.use({ storageState: { cookies: [], origins: [] } });\n\n` +
      `or:\n\n` +
      `  test.use({ skipFapiMock: true });\n\n` +
      `Affected files:\n`,
  );
  for (const file of sessionViolations) {
    console.error(`  • e2e/${file}`);
  }
  console.error();
}

if (hasError) {
  process.exit(1);
} else {
  process.exit(0);
}
