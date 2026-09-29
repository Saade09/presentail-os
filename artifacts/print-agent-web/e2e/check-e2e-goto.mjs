#!/usr/bin/env node
/**
 * check-e2e-goto.mjs
 *
 * Scans every *.spec.ts file in this directory and reports any `page.goto(`
 * call that either:
 *   1. Does not pass a `waitUntil` option at all, OR
 *   2. Uses `waitUntil: "networkidle"`, which causes tests to silently hang
 *      whenever Clerk.js CDN chunks or SSE endpoints keep the network busy, OR
 *   3. Is NOT followed by a readiness assertion within the next 10 lines.
 *
 * Accepted readiness assertions (any one of these within 10 lines is enough):
 *   - getByRole("heading"  — page heading is visible
 *   - getByRole("alert"    — error banner is visible (sign-in error pages)
 *   - toHaveURL(           — navigation redirected to expected URL
 *   - waitForFunction(     — Clerk/JS state confirmed (e.g. user loaded)
 *   - waitForTimeout(      — synchronous-execution pages (e.g. SSO callback)
 *
 * The correct pattern is `waitUntil: "domcontentloaded"` paired with an
 * explicit heading/element assertion to confirm the page has mounted:
 *
 *   await page.goto("/some/path", { waitUntil: "domcontentloaded" });
 *   await expect(page.getByRole("heading", { name: "…" })).toBeVisible({
 *     timeout: 15_000,
 *   });
 *
 * Multi-line calls are handled correctly: the check collects all text from the
 * opening `page.goto(` up to its matching closing `)` before deciding.
 *
 * Usage: node e2e/check-e2e-goto.mjs
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOTO_NEEDLE = "page.goto(";
const NETWORKIDLE = 'waitUntil: "networkidle"';

/** Patterns that count as a valid readiness assertion after a goto. */
const READINESS_PATTERNS = [
  'getByRole("heading"',
  "getByRole('heading'",
  'getByRole("alert"',
  "getByRole('alert'",
  "toHaveURL(",
  "waitForFunction(",
  "waitForTimeout(",
];

/** Number of lines after the goto line to search for a readiness assertion. */
const READINESS_WINDOW = 10;

/**
 * Extract the full text of a `page.goto(…)` call starting at `startIdx`
 * (which points to the `(` character of `page.goto(`).
 *
 * Tracks parenthesis depth to handle nested objects and multi-line calls.
 */
function extractGotoCall(content, startIdx) {
  let depth = 0;
  let i = startIdx;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return content.slice(startIdx, i + 1);
    }
    i++;
  }
  return content.slice(startIdx);
}

/**
 * Return the 1-based line number for character position `idx` in `content`.
 */
function lineNumberAt(content, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Given the lines array and the 0-based index of the goto line, return true
 * if any of the READINESS_PATTERNS appears within the next READINESS_WINDOW
 * lines.
 */
function hasReadinessCheck(lines, gotoLineIdx) {
  const end = Math.min(gotoLineIdx + READINESS_WINDOW, lines.length - 1);
  for (let i = gotoLineIdx + 1; i <= end; i++) {
    for (const pattern of READINESS_PATTERNS) {
      if (lines[i].includes(pattern)) return true;
    }
  }
  return false;
}

const specFiles = readdirSync(__dirname).filter((f) => f.endsWith(".spec.ts"));

const violations = [];

for (const file of specFiles) {
  const fullPath = join(__dirname, file);
  const content = readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  let searchFrom = 0;
  while (true) {
    const needleIdx = content.indexOf(GOTO_NEEDLE, searchFrom);
    if (needleIdx === -1) break;

    const parenIdx = needleIdx + GOTO_NEEDLE.length - 1;
    const callText = extractGotoCall(content, parenIdx);

    const lineStart = content.lastIndexOf("\n", needleIdx) + 1;
    const lineEnd = content.indexOf("\n", needleIdx);
    const sourceLine =
      lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd);

    const lineNum = lineNumberAt(content, needleIdx);
    const gotoLineIdx = lineNum - 1;

    const trimmedLine = sourceLine.trimStart();
    const isCommentLine =
      trimmedLine.startsWith("//") || trimmedLine.startsWith("*");

    if (!isCommentLine) {
      if (callText.includes(NETWORKIDLE)) {
        violations.push({
          file,
          line: lineNum,
          callText: callText.trim(),
          reason: 'uses waitUntil: "networkidle" which hangs when Clerk CDN or SSE keeps the network busy',
        });
      } else if (!callText.includes("waitUntil")) {
        violations.push({
          file,
          line: lineNum,
          callText: callText.trim(),
          reason: 'missing waitUntil option (add waitUntil: "domcontentloaded")',
        });
      } else if (!hasReadinessCheck(lines, gotoLineIdx)) {
        violations.push({
          file,
          line: lineNum,
          callText: callText.trim(),
          reason:
            `missing readiness assertion within ${READINESS_WINDOW} lines after goto — add ` +
            `await expect(page.getByRole("heading", { name: "…" })).toBeVisible({ timeout: 15_000 })`,
        });
      }
    }

    searchFrom = needleIdx + GOTO_NEEDLE.length;
  }
}

if (violations.length > 0) {
  console.error(
    `\nERROR: The following e2e spec file(s) contain page.goto() calls that need\n` +
      `to be updated.\n\n` +
      `Use waitUntil: "domcontentloaded" and add an explicit readiness assertion:\n\n` +
      `  await page.goto("/some/path", { waitUntil: "domcontentloaded" });\n` +
      `  await expect(page.getByRole("heading", { name: "…" })).toBeVisible({\n` +
      `    timeout: 15_000,\n` +
      `  });\n\n` +
      `Accepted readiness patterns (any one within ${READINESS_WINDOW} lines):\n` +
      `  getByRole("heading"  getByRole("alert"  toHaveURL(\n` +
      `  waitForFunction(     waitForTimeout(\n\n` +
      `Do NOT use waitUntil: "networkidle" — it hangs when Clerk CDN chunks or\n` +
      `SSE endpoints keep the network busy.\n\n` +
      `Affected calls:\n`,
  );
  for (const { file, line, callText, reason } of violations) {
    const preview =
      callText.length > 80 ? callText.slice(0, 77) + "…" : callText;
    console.error(`  • e2e/${file}:${line}  ${preview}`);
    console.error(`    reason: ${reason}`);
  }
  console.error();
  process.exit(1);
} else {
  process.exit(0);
}
