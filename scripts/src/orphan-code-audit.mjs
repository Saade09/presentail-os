#!/usr/bin/env node

/**
 * Guard the cleanup candidates confirmed by
 * .agents/outputs/orphan-code-dynamic-entrypoint-verification-2026-08-29.md.
 *
 * This is deliberately a focused guard, not a guessed whole-repository
 * dead-code detector. It checks whether any of the confirmed orphan paths
 * have returned and, if they have, looks for the kinds of entrypoints the
 * audit was required to consider before reporting a violation.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");

export const CONFIRMED_ORPHAN_PATHS = Object.freeze([
  "artifacts/api-server/src/lib/publicHolidayHelper.ts",
  "artifacts/api-server/src/lib/inventoryLedger.ts",
  "artifacts/api-server/src/modules/omnichannel/adapters/MetaAdapter.ts",
  "artifacts/print-agent-web/src/pages/dashboard/cmc-pos/CmcPosRecentActivity.tsx",
  "artifacts/print-agent-web/src/components/ui/aspect-ratio.tsx",
  "artifacts/print-agent-web/src/components/ui/button-group.tsx",
  "artifacts/print-agent-web/src/components/ui/carousel.tsx",
  "artifacts/print-agent-web/src/components/ui/context-menu.tsx",
  "artifacts/print-agent-web/src/components/ui/input-group.tsx",
  "artifacts/print-agent-web/src/components/ui/input-otp.tsx",
  "artifacts/print-agent-web/src/components/ui/menubar.tsx",
  "artifacts/print-agent-web/src/components/ui/navigation-menu.tsx",
  "artifacts/print-agent-web/src/components/ui/sonner.tsx",
  "artifacts/os-mobile/components/StartupErrorScreen.tsx",
  "artifacts/pos/components/KeyboardAwareScrollViewCompat.tsx",
  "scripts/src/copy-binary-files.cjs",
  "scripts/src/migrate-from-source-db.cjs",
  "scripts/src/generate-google-ads-pdf.mjs",
]);

const TEXT_FILE_RE =
  /\.(?:cjs|css|html|js|json|md|mjs|sql|ts|tsx|yml|yaml)$/i;
const TEST_FILE_RE =
  /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|(?:^|\/)[^/]*(?:test|spec)\.[^.]+$/i;
const DOCUMENTATION_FILE_RE = /\.(?:md|mdx|txt)$/i;
const EXCLUDED_PATH_RE =
  /^(?:\.git|\.cache|\.local|\.agents\/outputs|attached_assets|node_modules|coverage|dist|build|release|test-results)(?:\/|$)/;

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function withoutExtension(filePath) {
  return filePath.replace(/\.(?:cjs|css|html|js|json|md|mjs|sql|ts|tsx|yml|yaml)$/i, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAnalyzablePath(filePath) {
  const normalized = normalizePath(filePath);
  return TEXT_FILE_RE.test(normalized) && !EXCLUDED_PATH_RE.test(normalized);
}

/**
 * Framework and packaging conventions which are entrypoints even without a
 * normal import edge. Keep these explicit so a future audit cannot mistake a
 * route file or packaged desktop module for dead code.
 */
export function getFrameworkEntrypointReason(filePath) {
  const normalized = normalizePath(filePath);

  if (
    /^artifacts\/(?:os-mobile|pos)\/app\/.+\.(?:js|jsx|ts|tsx)$/.test(
      normalized,
    )
  ) {
    return "Expo Router filesystem route";
  }

  if (/^artifacts\/scanner-agent\/src\/.+\.(?:js|jsx|ts|tsx)$/.test(normalized)) {
    return "Electron scanner source packaged from scanner-agent";
  }

  return null;
}

function getPathSpecificTokens(filePath) {
  const normalized = normalizePath(filePath);
  const localPath = normalized.replace(/^artifacts\/[^/]+\/src\//, "");
  const relativePath = withoutExtension(normalized);
  const localWithoutExtension = withoutExtension(localPath);
  const basename = path.posix.basename(localWithoutExtension);

  return new Set([
    normalized,
    relativePath,
    localPath,
    localWithoutExtension,
    `./${localPath}`,
    `@/${localWithoutExtension}`,
    basename,
  ]);
}

function containsToken(content, token) {
  if (token.includes("/") || token.startsWith("@/") || token.startsWith("./")) {
    return content.includes(token);
  }

  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(content);
}

function getReferenceKind(sourcePath, targetPath, content) {
  const normalizedSourcePath = normalizePath(sourcePath);
  const targetTokens = getPathSpecificTokens(targetPath);
  const matchingToken = [...targetTokens].find((token) =>
    containsToken(content, token),
  );

  if (!matchingToken) {
    return null;
  }

  if (normalizedSourcePath.endsWith("package.json")) {
    return "package script/export reference";
  }

  if (normalizedSourcePath.startsWith(".github/")) {
    return "CI/workflow reference";
  }

  if (TEST_FILE_RE.test(normalizedSourcePath)) {
    return "test reference";
  }

  if (DOCUMENTATION_FILE_RE.test(normalizedSourcePath)) {
    return "documented operator reference";
  }

  if (
    /\/adapters\/[^/]+\.[cm]?[jt]sx?$/.test(targetPath) &&
    /adapterRegistry(?:\.[cm]?[jt]sx?)?$/.test(normalizedSourcePath)
  ) {
    return "adapter registry reference";
  }

  const basename = path.posix.basename(withoutExtension(targetPath));
  const importLineRe = new RegExp(
    `(?:^|\\b)(?:import|from|require|export|lazy)\\b[^\\n;]*\\b${escapeRegExp(basename)}\\b`,
  );
  if (importLineRe.test(content)) {
    return "static or lazy import reference";
  }

  return "source reference";
}

/**
 * Return evidence that a currently present candidate is intentionally
 * reachable. `files` is an array of `{ path, content }` records so the
 * classifier remains easy to test without creating a temporary repository.
 */
export function findEntrypointEvidence(targetPath, files) {
  const normalizedTargetPath = normalizePath(targetPath);
  const evidence = [];

  for (const file of files) {
    const sourcePath = normalizePath(file.path);
    if (
      sourcePath === normalizedTargetPath ||
      !isAnalyzablePath(sourcePath)
    ) {
      continue;
    }

    const kind = getReferenceKind(sourcePath, normalizedTargetPath, file.content);
    if (kind) {
      evidence.push({ path: sourcePath, kind });
    }
  }

  const frameworkReason = getFrameworkEntrypointReason(normalizedTargetPath);
  if (frameworkReason) {
    evidence.unshift({ path: normalizedTargetPath, kind: frameworkReason });
  }

  return evidence;
}

/**
 * Analyze a repository snapshot. Only paths in the confirmed audit baseline
 * are candidates; all other files are intentionally outside this guard's
 * scope to avoid false positives from generated code and convention-based
 * entrypoints.
 */
export function findOrphanCandidates(
  files,
  candidatePaths = CONFIRMED_ORPHAN_PATHS,
) {
  const fileMap = new Map(
    files.map((file) => [normalizePath(file.path), { ...file, path: normalizePath(file.path) }]),
  );
  const findings = [];

  for (const candidatePath of candidatePaths) {
    const normalizedCandidatePath = normalizePath(candidatePath);
    const candidate = fileMap.get(normalizedCandidatePath);
    if (!candidate) {
      continue;
    }

    const evidence = findEntrypointEvidence(normalizedCandidatePath, files);
    if (evidence.length === 0) {
      findings.push({
        path: normalizedCandidatePath,
        message:
          "confirmed orphan has returned without a static, framework, package, CI, test, or documented operator entrypoint",
      });
    }
  }

  return findings;
}

export function collectRepositoryFiles(rootDir = REPOSITORY_ROOT) {
  const output = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd: rootDir },
  );

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter(isAnalyzablePath)
    .map((filePath) => ({
      path: filePath,
      content: readFileSync(path.join(rootDir, filePath), "utf8"),
    }));
}

export function auditRepository(rootDir = REPOSITORY_ROOT) {
  const files = collectRepositoryFiles(rootDir);
  return {
    filesScanned: files.length,
    findings: findOrphanCandidates(files),
  };
}

function main() {
  const result = auditRepository();

  if (result.findings.length > 0) {
    console.error(
      `Orphan-code audit failed: ${result.findings.length} confirmed cleanup candidate(s) returned.`,
    );
    for (const finding of result.findings) {
      console.error(`  - ${finding.path}`);
      console.error(`    ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Orphan-code audit passed: ${CONFIRMED_ORPHAN_PATHS.length} confirmed cleanup paths absent; ${result.filesScanned} repository files checked for entrypoint evidence.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}