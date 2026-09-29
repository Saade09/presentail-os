/**
 * Verifies that no dynamic-segment screen file (or directory) shadows a
 * static screen file (or directory) that lives in the same parent within an
 * Expo Router `app/` tree.
 *
 * The layout-level check in `expo-route-ordering.test.ts` catches ordering
 * problems declared inside `_layout.tsx` Stack/Tabs navigator blocks.  That
 * test cannot catch the case where a developer adds a new file such as
 * `[id].tsx` next to an existing `profile.tsx`, or a new directory `[id]/`
 * next to an existing `profile/` — both are valid Expo Router routes and the
 * filesystem determines the match order, but no layout file lists them, so
 * the layout-level scanner never sees them.
 *
 * This companion test closes that gap by scanning the raw filesystem:
 *
 *   For every directory under each mobile artifact's `app/` tree:
 *     - Collect all route files in that directory (`.tsx` / `.ts`, excluding
 *       layout, private, and special Expo files).
 *     - If the directory contains any dynamic-segment file (`[param].tsx`,
 *       `[...rest].tsx`) alongside a static file whose name the dynamic
 *       pattern would match, the test fails and names both files.
 *     - Also collect all sub-directories and apply the same dynamic-vs-static
 *       check at the directory level (e.g. `[id]/` shadowing `profile/`).
 *
 * Any new screen file or sub-directory added to a mobile artifact is
 * automatically covered without a manual test update.
 *
 * Shadowing rules (mirrors Expo Router first-match semantics):
 *   - `[param]`     — matches any single non-empty segment name
 *   - `[...rest]`   — matches every segment name (catch-all)
 *
 * Files excluded from the scan (they are not route screens):
 *   - `_layout` (and any other file whose base starts with `_`)
 *   - Files starting with `+` (e.g. `+not-found`)
 *   - Files that are not `.tsx` or `.ts`
 *
 * Directories excluded from the segment-shadowing check (they are Expo
 * Router group/private conventions, not navigable segments):
 *   - Names starting with `(` — route groups, e.g. `(tabs)/`
 *   - Names starting with `_` — private directories
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, join, relative, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverMobileArtifactDirs } from "./test-utils/discoverMobileArtifacts";

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = resolve(__dirname, "../../..");
const ARTIFACTS_ROOT = join(WORKSPACE_ROOT, "artifacts");

/** Full paths to every Expo mobile artifact root, discovered at test-load time. */
const MOBILE_ARTIFACT_DIRS = discoverMobileArtifactDirs();

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  "coverage",
  "__generated__",
]);

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the filename looks like a route screen file that Expo
 * Router would register as a navigable route.
 *
 * Excluded:
 *   - Non-TS/TSX extensions
 *   - Layout files (`_layout.tsx`)
 *   - Any private file whose base name starts with `_`
 *   - Special Expo files whose base starts with `+` (e.g. `+not-found`)
 */
function isRouteFile(name: string): boolean {
  if (!name.endsWith(".tsx") && !name.endsWith(".ts")) return false;
  const base = name.replace(/\.(tsx|ts)$/, "");
  if (base.startsWith("_")) return false;
  if (base.startsWith("+")) return false;
  return true;
}

/**
 * Returns true when the directory name is a navigable route segment that Expo
 * Router treats as part of the URL path.
 *
 * Excluded:
 *   - Route groups, e.g. `(tabs)` — they are transparent to the URL
 *   - Private directories starting with `_`
 *   - Build/tool directories listed in SKIP_DIRS
 */
function isRouteDirectory(name: string): boolean {
  if (SKIP_DIRS.has(name)) return false;
  if (name.startsWith("(")) return false; // route group — not a URL segment
  if (name.startsWith("_")) return false; // private directory
  return true;
}

/** Strip the file extension to get the Expo Router segment name. */
function segmentName(filename: string): string {
  return filename.replace(/\.(tsx|ts)$/, "");
}

/** True when the segment name is a dynamic Expo Router segment, e.g. `[id]`. */
function isDynamic(seg: string): boolean {
  return seg.startsWith("[");
}

/** True when the segment is a catch-all, e.g. `[...rest]`. */
function isCatchAll(seg: string): boolean {
  return /^\[\.\.\./.test(seg);
}

/**
 * Returns true when `dynamicSeg` would capture `staticSeg` at runtime.
 *
 * - `[...anything]` → captures every static segment name (catch-all)
 * - `[param]`       → captures every single-segment static name
 *
 * We only check dynamic vs static; two dynamic segments cannot shadow each
 * other in a meaningful way because Expo Router would warn independently.
 */
function shadows(dynamicSeg: string, staticSeg: string): boolean {
  if (isDynamic(staticSeg)) return false; // never compare two dynamic segs
  if (isCatchAll(dynamicSeg)) return true; // catch-all matches everything
  return true; // single [param] matches any non-dynamic segment
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/** Whether the conflict is between two files or two directories. */
type ViolationKind = "file" | "directory";

interface DirectoryViolation {
  /** Absolute path of the directory containing the conflict. */
  directory: string;
  /** Dynamic segment that does the shadowing, e.g. `[id]`. */
  dynamicSeg: string;
  /** Static segment that is shadowed, e.g. `profile`. */
  staticSeg: string;
  /** Whether the conflict is between sibling files or sibling directories. */
  kind: ViolationKind;
}

/**
 * Recursively walk `dir`, collecting one `DirectoryViolation` for each
 * (dynamic, static) pair in the same directory where the dynamic entry would
 * shadow the static entry.  Both file-level and directory-level shadowing are
 * detected:
 *
 *   - File shadowing:      `[id].tsx`  next to  `profile.tsx`
 *   - Directory shadowing: `[id]/`     next to  `profile/`
 */
function walkForShadowing(dir: string): DirectoryViolation[] {
  if (!existsSync(dir)) return [];

  const violations: DirectoryViolation[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  // ── File-level check ────────────────────────────────────────────────────
  const routeFiles = entries
    .filter((e) => e.isFile() && isRouteFile(e.name))
    .map((e) => segmentName(e.name));

  const dynamicFileSegs = routeFiles.filter(isDynamic);
  const staticFileSegs = routeFiles.filter((s) => !isDynamic(s));

  for (const dyn of dynamicFileSegs) {
    for (const stat of staticFileSegs) {
      if (shadows(dyn, stat)) {
        violations.push({
          directory: dir,
          dynamicSeg: dyn,
          staticSeg: stat,
          kind: "file",
        });
      }
    }
  }

  // ── Directory-level check ────────────────────────────────────────────────
  const routeDirs = entries
    .filter((e) => e.isDirectory() && isRouteDirectory(e.name))
    .map((e) => e.name);

  const dynamicDirSegs = routeDirs.filter(isDynamic);
  const staticDirSegs = routeDirs.filter((s) => !isDynamic(s));

  for (const dyn of dynamicDirSegs) {
    for (const stat of staticDirSegs) {
      if (shadows(dyn, stat)) {
        violations.push({
          directory: dir,
          dynamicSeg: dyn,
          staticSeg: stat,
          kind: "directory",
        });
      }
    }
  }

  // ── Recurse into sub-directories ─────────────────────────────────────────
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    violations.push(...walkForShadowing(join(dir, entry.name)));
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Collect violations across all mobile artifacts
// ---------------------------------------------------------------------------

interface ArtifactResult {
  artifact: string;
  violations: DirectoryViolation[];
}

const results: ArtifactResult[] = MOBILE_ARTIFACT_DIRS.map((dir) => ({
  artifact: basename(dir),
  violations: walkForShadowing(join(dir, "app")),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Filesystem shadowing — Expo Router dynamic vs static screen files", () => {
  it(
    "at least one mobile artifact app/ directory exists " +
      "(sanity check that the scanner can find the source tree)",
    () => {
      const found = MOBILE_ARTIFACT_DIRS.some((dir) =>
        existsSync(join(dir, "app")),
      );
      expect(
        found,
        `None of the expected mobile artifact app/ directories were found ` +
          `under ${ARTIFACTS_ROOT}. ` +
          `Either the artifact directory names changed or the test root is wrong.`,
      ).toBe(true);
    },
  );

  for (const { artifact, violations } of results) {
    const fileViolations = violations.filter((v) => v.kind === "file");
    const dirViolations = violations.filter((v) => v.kind === "directory");

    it(
      `${artifact}: no dynamic-segment file shadows a static file in the same directory`,
      () => {
        if (fileViolations.length === 0) return;

        const lines = fileViolations.map(({ directory, dynamicSeg, staticSeg }) => {
          const rel = relative(WORKSPACE_ROOT, directory);
          return (
            `  ${rel}/\n` +
            `    dynamic: ${dynamicSeg}.tsx  →  shadows  static: ${staticSeg}.tsx`
          );
        });

        throw new Error(
          `Shadowed screen files detected in ${artifact}.\n\n` +
            `A dynamic-segment file like [param].tsx placed in the same directory\n` +
            `as a static file will silently capture that static route at runtime\n` +
            `because Expo Router matches dynamic segments before falling through.\n\n` +
            lines.join("\n\n") +
            `\n\nFix: rename or move the static screen so it cannot be matched by\n` +
            `the dynamic segment, or remove the dynamic file if it was added by mistake.`,
        );
      },
    );

    it(
      `${artifact}: no dynamic-segment directory shadows a static directory in the same parent`,
      () => {
        if (dirViolations.length === 0) return;

        const lines = dirViolations.map(({ directory, dynamicSeg, staticSeg }) => {
          const rel = relative(WORKSPACE_ROOT, directory);
          return (
            `  ${rel}/\n` +
            `    dynamic dir: ${dynamicSeg}/  →  shadows  static dir: ${staticSeg}/`
          );
        });

        throw new Error(
          `Shadowed route directories detected in ${artifact}.\n\n` +
            `A dynamic-segment directory like [id]/ placed alongside a static\n` +
            `directory like profile/ will silently capture all requests that\n` +
            `would have gone to the static directory, because Expo Router resolves\n` +
            `dynamic segments before falling through to named siblings.\n\n` +
            lines.join("\n\n") +
            `\n\nFix: rename or move the static directory so its name cannot be\n` +
            `matched by the dynamic segment, or remove the dynamic directory if it\n` +
            `was added by mistake.`,
        );
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Unit tests for walkForShadowing — directory-level shadowing detection
// ---------------------------------------------------------------------------

describe("walkForShadowing unit tests — directory-level shadowing", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(
      "/tmp",
      `expo-shadowing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Helper: create a directory (and any missing parents) under tmpRoot.
   */
  function mkdir(...parts: string[]): void {
    mkdirSync(join(tmpRoot, ...parts), { recursive: true });
  }

  /**
   * Helper: create an empty file under tmpRoot.
   */
  function touch(...parts: string[]): void {
    const fullPath = join(tmpRoot, ...parts);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, "");
  }

  it("detects a catch-all directory ([...rest]/) shadowing a static sibling directory", () => {
    // Synthetic app/ layout:
    //   app/
    //     [...rest]/        ← catch-all dynamic directory
    //       index.tsx
    //     profile/          ← static directory — should be reported as shadowed
    //       index.tsx
    mkdir("app", "[...rest]");
    touch("app", "[...rest]", "index.tsx");
    mkdir("app", "profile");
    touch("app", "profile", "index.tsx");

    const violations = walkForShadowing(join(tmpRoot, "app"));

    const dirViolations = violations.filter((v) => v.kind === "directory");
    expect(dirViolations).toHaveLength(1);
    expect(dirViolations[0].dynamicSeg).toBe("[...rest]");
    expect(dirViolations[0].staticSeg).toBe("profile");
  });

  it("detects a single-param directory ([id]/) shadowing a static sibling directory", () => {
    // Synthetic app/ layout:
    //   app/
    //     [id]/             ← single dynamic directory
    //       index.tsx
    //     settings/         ← static directory — should be reported as shadowed
    //       index.tsx
    mkdir("app", "[id]");
    touch("app", "[id]", "index.tsx");
    mkdir("app", "settings");
    touch("app", "settings", "index.tsx");

    const violations = walkForShadowing(join(tmpRoot, "app"));

    const dirViolations = violations.filter((v) => v.kind === "directory");
    expect(dirViolations).toHaveLength(1);
    expect(dirViolations[0].dynamicSeg).toBe("[id]");
    expect(dirViolations[0].staticSeg).toBe("settings");
    expect(dirViolations[0].kind).toBe("directory");
  });

  it("does NOT report a violation when a route group (tabs)/ sits beside a static directory", () => {
    // Route groups (names wrapped in parentheses) are transparent to the URL
    // and must never be flagged as dynamic shadows.
    //
    //   app/
    //     (tabs)/           ← route group — NOT a navigable segment
    //       index.tsx
    //     profile/          ← static directory — safe, no shadowing
    //       index.tsx
    mkdir("app", "(tabs)");
    touch("app", "(tabs)", "index.tsx");
    mkdir("app", "profile");
    touch("app", "profile", "index.tsx");

    const violations = walkForShadowing(join(tmpRoot, "app"));

    const dirViolations = violations.filter((v) => v.kind === "directory");
    expect(dirViolations).toHaveLength(0);
  });

  it("does NOT report a violation when only static directories are present", () => {
    //   app/
    //     orders/
    //       index.tsx
    //     profile/
    //       index.tsx
    mkdir("app", "orders");
    touch("app", "orders", "index.tsx");
    mkdir("app", "profile");
    touch("app", "profile", "index.tsx");

    const violations = walkForShadowing(join(tmpRoot, "app"));
    expect(violations.filter((v) => v.kind === "directory")).toHaveLength(0);
  });

  it("detects directory shadowing in a nested sub-directory (recursive walk)", () => {
    // The violation lives two levels deep — the walker must recurse.
    //
    //   app/
    //     orders/
    //       [id]/           ← dynamic directory inside orders/
    //         index.tsx
    //       summary/        ← static sibling — shadowed
    //         index.tsx
    mkdir("app", "orders", "[id]");
    touch("app", "orders", "[id]", "index.tsx");
    mkdir("app", "orders", "summary");
    touch("app", "orders", "summary", "index.tsx");

    const violations = walkForShadowing(join(tmpRoot, "app"));

    const dirViolations = violations.filter((v) => v.kind === "directory");
    expect(dirViolations).toHaveLength(1);
    expect(dirViolations[0].dynamicSeg).toBe("[id]");
    expect(dirViolations[0].staticSeg).toBe("summary");
  });

  it("returns an empty array when the target directory does not exist", () => {
    const result = walkForShadowing(join(tmpRoot, "nonexistent"));
    expect(result).toEqual([]);
  });
});
