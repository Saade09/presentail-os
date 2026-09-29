/**
 * Verifies that static screens are declared BEFORE dynamic-segment screens
 * that could shadow them inside Expo Router Stack/Tabs navigator blocks.
 *
 * Expo Router uses first-match semantics within a navigator, so a dynamic
 * screen like `order/[id]` declared before a static screen like `order/index`
 * would silently swallow the static route — it would never render.
 *
 * The test auto-discovers every `_layout.tsx` file inside the `app/`
 * directory of each mobile artifact.
 * Generated output directories and node_modules are excluded.
 *
 * For each discovered layout file the test groups every
 * `Stack.Screen name="..."` (and `Tabs.Screen name="..."`) by its enclosing
 * navigator block, then checks:
 *   1. No dynamic screen (`[param]`) appears before a static sibling that it
 *      would match.
 *   2. The Expo Router catch-all (`+not-found`) is not declared before any
 *      specific screen in the same navigator block.
 *
 * Any new `_layout.tsx` file added to any of the scanned mobile artifacts is
 * automatically covered without a manual test update.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";
import { discoverMobileArtifactDirs } from "./test-utils/discoverMobileArtifacts";

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = resolve(__dirname, "../../..");

/** Full paths to every Expo mobile artifact root, discovered at test-load time. */
const MOBILE_ARTIFACT_DIRS = discoverMobileArtifactDirs();

/**
 * Directories that are never meaningful to scan.  These names appear at any
 * depth within an artifact and are skipped during the walk.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  "coverage",
  "__generated__",
]);

/** Recursively collect every `_layout.tsx` file under `dir`, skipping SKIP_DIRS. */
function walkLayoutFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkLayoutFiles(full));
    } else if (entry.isFile() && entry.name === "_layout.tsx") {
      results.push(full);
    }
  }
  return results;
}

/** Collect layout files from each mobile artifact's `app/` directory. */
function allMobileLayoutFiles(): string[] {
  const files: string[] = [];
  for (const dir of MOBILE_ARTIFACT_DIRS) {
    const appDir = join(dir, "app");
    files.push(...walkLayoutFiles(appDir));
  }
  return files;
}

/**
 * Quick pre-filter: returns true when the file contains at least one
 * Stack.Screen or Tabs.Screen name attribute — i.e. it explicitly lists
 * screens rather than relying purely on the filesystem.
 */
function hasScreenDeclarations(filePath: string): boolean {
  const src = readFileSync(filePath, "utf-8");
  return /(?:Stack|Tabs)\.Screen\s+name=/.test(src);
}

const layoutFiles = allMobileLayoutFiles().filter(hasScreenDeclarations);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface ScreenEntry {
  name: string;
  /** Zero-based line index where the Screen declaration starts. */
  line: number;
}

interface NavigatorGroup {
  /** Tag used: "Stack" or "Tabs". */
  kind: "Stack" | "Tabs";
  /** Ordinal of this navigator in the file (0-based). */
  navigatorIndex: number;
  screens: ScreenEntry[];
}

/**
 * Parse a layout file and return screens grouped by their enclosing navigator
 * block.
 *
 * Uses a simple stack to track navigator open/close events so that only
 * sibling screens within the same block are placed in the same group.
 * Self-closing `<Stack />` tags (no children) are ignored.
 *
 * Handles both JSX forms:
 *   <Stack>  and  <Stack screenOptions={…}>
 *   <Tabs>   and  <Tabs screenOptions={…}>
 */
function extractScreensByNavigator(filePath: string): NavigatorGroup[] {
  const source = readFileSync(filePath, "utf-8");
  const groups: NavigatorGroup[] = [];

  // Stack used to track nested navigators: each entry is the group index it
  // maps to in `groups`.
  const navStack: number[] = [];

  // Match, in document order:
  //   (1) opening <Stack ...> or <Tabs ...> (not self-closing, not .Screen)
  //   (2) closing </Stack> or </Tabs>
  //   (3) Stack.Screen or Tabs.Screen with a name="..." attribute
  //
  // The Screen pattern also captures which kind (Stack|Tabs) it is, and the
  // name value (which may span a line break between name= and the quote).
  const tokenRe =
    /<(Stack|Tabs)(?:\s[^>]*)?>(?!\s*\/>)|<\/(Stack|Tabs)>|(?:Stack|Tabs)\.Screen\s+name="([^"]+)"/g;

  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(source)) !== null) {
    const [, openKind, closeKind, screenName] = m;

    if (openKind) {
      // Opening <Stack> or <Tabs>
      const kind = openKind as "Stack" | "Tabs";
      const idx = groups.length;
      groups.push({ kind, navigatorIndex: idx, screens: [] });
      navStack.push(idx);
    } else if (closeKind) {
      // Closing </Stack> or </Tabs>
      navStack.pop();
    } else if (screenName !== undefined && navStack.length > 0) {
      // Screen declaration inside a navigator
      const before = source.slice(0, m.index);
      const line = (before.match(/\n/g) ?? []).length;
      groups[navStack[navStack.length - 1]].screens.push({
        name: screenName,
        line,
      });
    }
  }

  return groups;
}

/**
 * True if the screen name contains a dynamic segment, i.e. includes `[…]`.
 *
 * Examples:
 *   `order/[id]`       → true
 *   `order/[id]/index` → true
 *   `[...rest]`        → true
 *   `+not-found`       → false  (handled separately as the catch-all)
 */
function isDynamic(name: string): boolean {
  return /\[/.test(name);
}

/**
 * True if the screen name is the Expo Router catch-all (not-found) route.
 */
function isCatchAll(name: string): boolean {
  return name === "+not-found" || /\[\.\.\./.test(name);
}

/**
 * Convert a dynamic Expo Router screen name to a RegExp that matches any
 * screen name that it would capture at the same nesting level.
 *
 * Rules:
 *   - `[param]` in a single segment → matches any non-slash segment
 *   - `[...rest]` or similar        → matches any remaining path
 *
 * Example: `order/[id]`       → /^order\/[^/]+$/
 *          `order/[id]/index` → /^order\/[^/]+\/index$/
 *          `[...slug]`        → /^.+$/
 */
function dynamicNameToRegExp(name: string): RegExp {
  if (/\[\.\.\./.test(name)) {
    // Catch-all segment — matches everything
    return /^.+$/;
  }
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape regex special chars
    .replace(/\\\[([^\]]+)\\]/g, "[^/]+"); // replace \[param\] with segment
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Route ordering — Expo Router _layout.tsx navigator blocks", () => {
  it(
    "discovers at least one layout file to check " +
      "(scans mobile artifact app/ directories for Stack/Tabs Screen declarations)",
    () => {
      expect(
        layoutFiles.length,
        `No _layout.tsx file under the mobile artifact app/ directories contains ` +
          `Stack.Screen or Tabs.Screen name attributes. ` +
          `This likely means the scanner is broken or the routing pattern has changed.`,
      ).toBeGreaterThan(0);
    },
  );

  for (const filePath of layoutFiles) {
    const label = relative(WORKSPACE_ROOT, filePath);

    describe(label, () => {
      it(
        "static screens are not shadowed by preceding dynamic screens, " +
          "and +not-found comes after all specific screens (per navigator group)",
        () => {
          const groups = extractScreensByNavigator(filePath);

          const totalScreens = groups.reduce(
            (n, g) => n + g.screens.length,
            0,
          );
          expect(
            totalScreens,
            `${label} was selected for the ordering check but no Screen name="..." was found ` +
              `inside a Stack or Tabs block. Either the file no longer uses explicit screen ` +
              `declarations or the parser needs updating.`,
          ).toBeGreaterThan(0);

          const violations: string[] = [];

          for (const group of groups) {
            const { screens, navigatorIndex, kind } = group;

            for (let i = 0; i < screens.length; i++) {
              const current = screens[i];

              // Rule 1: +not-found / catch-all must not precede specific screens
              if (isCatchAll(current.name)) {
                for (let j = i + 1; j < screens.length; j++) {
                  const later = screens[j];
                  if (!isCatchAll(later.name)) {
                    violations.push(
                      `[${kind} #${navigatorIndex}] Line ${later.line + 1}: screen "${later.name}" ` +
                        `is shadowed by catch-all screen "${current.name}" ` +
                        `declared earlier on line ${current.line + 1}.`,
                    );
                  }
                }
                // Once we've flagged all post-catch-all screens, we're done
                // with this navigator (remaining screens after i are already
                // covered by the inner loop above).
                break;
              }

              // Rule 2: dynamic screens must not shadow later static screens
              if (!isDynamic(current.name)) continue;

              const pattern = dynamicNameToRegExp(current.name);

              for (let j = i + 1; j < screens.length; j++) {
                const later = screens[j];
                if (isDynamic(later.name) || isCatchAll(later.name)) continue;

                if (pattern.test(later.name)) {
                  violations.push(
                    `[${kind} #${navigatorIndex}] Line ${later.line + 1}: static screen "${later.name}" ` +
                      `is shadowed by dynamic screen "${current.name}" ` +
                      `declared earlier on line ${current.line + 1}.`,
                  );
                }
              }
            }
          }

          if (violations.length > 0) {
            throw new Error(
              `Route ordering bug detected in ${label}.\n` +
                `Static screens must appear BEFORE any dynamic screen that would match them,\n` +
                `and catch-all screens (+not-found, [...rest]) must come last,\n` +
                `because Expo Router uses first-match semantics within a navigator.\n\n` +
                violations.join("\n") +
                `\n\nFix: move the static or specific screen(s) above the dynamic or catch-all screen(s) that shadow them.`,
            );
          }
        },
      );
    });
  }
});
