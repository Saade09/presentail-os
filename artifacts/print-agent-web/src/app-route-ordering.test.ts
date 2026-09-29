/**
 * Verifies three correctness properties of wouter <Switch> blocks across all
 * artifact routing files:
 *
 * 1. ORDERING — static routes are declared BEFORE dynamic-segment routes that
 *    could shadow them.  Wouter uses first-match semantics, so a wildcard
 *    route like /people/:id placed before /people/access will silently swallow
 *    the specific route — the "Invites & Access" page would never render.
 *
 * 2. DUPLICATES — no two sibling routes in the same Switch share the exact
 *    same path string.  The second occurrence can never be reached and the
 *    page it points to is effectively invisible.
 *
 * 3. CATCH-ALL TRAP — a root-level single-param route (e.g. `/:id`, `/:slug`)
 *    matches EVERY top-level path, so placing one early in a Switch silently
 *    swallows all sibling routes that follow it — both static ones like
 *    `/dashboard` and dynamic ones like `/:section`.  This check flags any
 *    such pattern that appears before a sibling it would subsume.
 *
 * The test auto-discovers every .tsx file across ALL artifact directories
 * under the workspace `artifacts/` folder that contains both a wouter
 * <Switch> block and at least one <Route path="..."> attribute.  Generated
 * output directories and node_modules are excluded.
 *
 * Because discovery is fully dynamic — driven by the filesystem — any new
 * routing file added to any artifact (present or future) is automatically
 * covered without a manual test update.
 *
 * Within each discovered file the test groups every <Route path="..."> by its
 * enclosing <Switch> block, then runs all three checks per group.
 *
 * Routes in different Switch blocks are never compared against each other
 * because wouter's first-match semantics only apply within a single Switch.
 *
 * ---------------------------------------------------------------------------
 *
 * A second suite covers Expo Router / React Navigation navigator blocks
 * (Stack, Tabs, NativeTabs) across all discovered Expo mobile artifacts. Within
 * each navigator block, duplicate
 * `name` props on sibling Screen / Trigger elements are detected and reported
 * with the file path, navigator type, navigator index, and line numbers.
 *
 * React Navigation uses first-match semantics for named routes just like
 * wouter's Switch, so a duplicated name makes the second screen permanently
 * unreachable.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";
import { discoverMobileArtifactDirs } from "./test-utils/discoverMobileArtifacts";

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = resolve(__dirname, "../../..");
const ARTIFACTS_ROOT = join(WORKSPACE_ROOT, "artifacts");

/**
 * Directories that are never meaningful to scan.  These names appear at any
 * depth within an artifact and are skipped during the walk.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  ".next",
  "coverage",
  "__generated__",
]);

/** Recursively collect every *.tsx file under `dir`, skipping SKIP_DIRS. */
function walkTsx(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsx(full));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Enumerate all artifact source directories by listing every immediate
 * subdirectory of `artifacts/`.  Each one is its own product artifact, and we
 * scan all of its .tsx files (minus generated/build output).
 */
function allArtifactTsxFiles(): string[] {
  if (!existsSync(ARTIFACTS_ROOT)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    files.push(...walkTsx(join(ARTIFACTS_ROOT, entry.name)));
  }
  return files;
}

/**
 * Quick pre-filter: returns true only when the file source contains both a
 * wouter <Switch> opening tag AND at least one <Route path="…"> attribute.
 * Files that match only one (e.g. shadcn UI <Switch> toggles, or standalone
 * <Route> redirects) are excluded from the ordering check.
 */
function hasRouterSwitch(filePath: string): boolean {
  const src = readFileSync(filePath, "utf-8");
  return src.includes("<Switch") && src.includes('<Route path="');
}

/** All .tsx files that contain wouter Switch+Route routing blocks. */
const routingFiles = allArtifactTsxFiles().filter(hasRouterSwitch);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface RouteEntry {
  path: string;
  /** Zero-based index of the line where the <Route … was found. */
  line: number;
}

interface SwitchGroup {
  /** Ordinal of this Switch in the file (0-based). */
  switchIndex: number;
  routes: RouteEntry[];
}

/**
 * Parse a TSX file and return routes grouped by their enclosing <Switch> block.
 *
 * Uses a simple stack to track Switch open/close events so that only sibling
 * routes within the same Switch are placed in the same group.  Routes that
 * fall outside any Switch (e.g. standalone <Route> redirects) are ignored
 * because they don't participate in wouter first-match competition.
 */
function extractRoutesBySwitch(filePath: string): SwitchGroup[] {
  const source = readFileSync(filePath, "utf-8");
  const groups: SwitchGroup[] = [];
  const stack: number[] = [];

  // Match, in document order:
  //   (1) an opening <Switch> tag — with or without JSX props
  //   (2) a closing </Switch> tag
  //   (3) a <Route path="..."> attribute
  const tokenRe =
    /(<Switch(?:\s[^>]*)?>)|(<\/Switch>)|<Route\s+path="([^"]+)"/g;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(source)) !== null) {
    if (m[1]) {
      // Opening <Switch ...>
      const idx = groups.length;
      groups.push({ switchIndex: idx, routes: [] });
      stack.push(idx);
    } else if (m[2]) {
      // Closing </Switch>
      stack.pop();
    } else if (m[3] !== undefined && stack.length > 0) {
      // <Route path="..."> inside a Switch
      const before = source.slice(0, m.index);
      const line = (before.match(/\n/g) ?? []).length;
      groups[stack[stack.length - 1]].routes.push({ path: m[3], line });
    }
  }

  return groups;
}

/** True if the path contains at least one dynamic segment (:param). */
function isDynamic(path: string): boolean {
  return /\/:[^/]+/.test(path);
}

/**
 * True if every non-empty segment of the path is a dynamic parameter.
 *
 * Examples that return true:  "/:id", "/:section/:id", "/:a/:b/:c"
 * Examples that return false: "/people/:id", "/:section/edit", "/dashboard"
 *
 * Used by collectShadowViolations to distinguish fully-dynamic routes
 * (which can never be "shadowed" in a meaningful way — they match the same
 * universe of URLs as another fully-dynamic route of the same arity) from
 * partially-static routes like "/:section/edit" that have at least one
 * literal segment and CAN be shadowed by a preceding all-dynamic pattern.
 */
function isFullyDynamic(path: string): boolean {
  return path
    .split("/")
    .filter(Boolean)
    .every((seg) => seg.startsWith(":"));
}

/**
 * Convert a dynamic route path to a RegExp that matches any path the route
 * would claim, using wouter-style matching (each :param matches one non-slash
 * segment, and the pattern must match the entire path).
 *
 * Example: /people/:id  →  /^\/people\/[^/]+$/
 */
function dynamicRouteToRegExp(path: string): RegExp {
  const escaped = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape regex special chars
    .replace(/\/:[^/]+/g, "/[^/]+"); // replace :param with a segment matcher
  return new RegExp(`^${escaped}$`);
}

/**
 * Inspect a list of Switch groups and return one violation string for every
 * static route that is fully subsumed by a dynamic route declared earlier in
 * the same group.
 *
 * This is the core detection kernel — extracted here so it can be exercised
 * directly in the self-check tests below as well as in the file-scan tests.
 */
function collectShadowViolations(groups: SwitchGroup[]): string[] {
  const violations: string[] = [];

  for (const group of groups) {
    const { routes, switchIndex } = group;

    for (let i = 0; i < routes.length; i++) {
      const dynamic = routes[i];
      if (!isDynamic(dynamic.path)) continue;

      const pattern = dynamicRouteToRegExp(dynamic.path);

      for (let j = i + 1; j < routes.length; j++) {
        const later = routes[j];
        // Skip routes where every segment is dynamic (e.g. /:a/:b after
        // /:section/:id).  Two fully-dynamic routes of the same arity match
        // the same URL universe; flagging them here would be a false positive
        // — their interaction is an ordering / duplicate concern, not a
        // static-route shadow.  Partially-static routes like /:section/edit
        // (which have at least one literal segment) ARE checked, because a
        // preceding all-dynamic pattern like /:section/:id genuinely subsumes
        // them.
        if (isFullyDynamic(later.path)) continue;

        if (pattern.test(later.path)) {
          violations.push(
            `[Switch #${switchIndex}] Line ${later.line + 1}: static route "${later.path}" is shadowed by ` +
              `dynamic route "${dynamic.path}" declared earlier on line ${dynamic.line + 1}.`,
          );
        }
      }
    }
  }

  return violations;
}

/**
 * True if `path` is a root-level catch-all in any of the supported forms:
 *
 *   • Single-segment param: `/:id`, `/:slug`, `/:section`
 *     — matches every top-level (single-segment) path.
 *
 *   • Glob wildcards: `/*` or `/**`
 *     — matches every path regardless of depth (any number of segments).
 *
 * Examples that qualify:      "/:id", "/:slug", "/:section", "/*", "/**"
 * Examples that do NOT:  "/dashboard/:id", "/:a/:b", "/people"
 */
function isRootLevelCatchAll(path: string): boolean {
  return /^\/:[^/]+$/.test(path) || path === "/*" || path === "/**";
}

/**
 * True if `path` is a glob-style wildcard catch-all (`/*` or `/**`) that
 * matches every path at any depth, not just single-segment top-level paths.
 */
function isGlobWildcard(path: string): boolean {
  return path === "/*" || path === "/**";
}

/**
 * True if `path` is a nested-prefix wildcard catch-all — a `/*` or `/**`
 * suffix appended to at least one non-wildcard prefix segment.
 *
 * Examples that qualify:  "/dashboard/*", "/dashboard/**", "/a/b/c/*"
 * Examples that do NOT:   "/*", "/**"  (root-level, handled separately)
 */
function isNestedCatchAll(path: string): boolean {
  return (
    (path.endsWith("/*") || path.endsWith("/**")) &&
    path !== "/*" &&
    path !== "/**"
  );
}

/**
 * Extract the static prefix from a nested catch-all by stripping the
 * trailing `/*` or `/**`.
 *
 * "/dashboard/*"     →  "/dashboard"
 * "/dashboard/sub/*" →  "/dashboard/sub"
 */
function nestedCatchAllPrefix(path: string): string {
  return path.replace(/\/\*\*?$/, "");
}

/**
 * True if `laterPath` is subsumed by a nested catch-all whose prefix is
 * `prefix`.  The later path must descend into the prefix (i.e. start with
 * `prefix + "/"`).
 *
 * Note: the bare prefix itself (e.g. "/dashboard") is NOT subsumed because
 * wouter's `/*` and `/**` patterns require at least one trailing segment —
 * `/dashboard/*` does not match the bare `/dashboard` path.
 */
function isSubsumedByNestedCatchAll(
  laterPath: string,
  prefix: string,
): boolean {
  return laterPath.startsWith(prefix + "/");
}

/**
 * True if `path` can be subsumed by a root-level catch-all, i.e. the path
 * consists of exactly one segment (no second slash).  Both static top-level
 * routes (`/dashboard`) and other single-segment dynamic routes (`/:section`)
 * satisfy this condition.
 */
function isSubsumedByRootCatchAll(path: string): boolean {
  // Must start with "/" and contain no additional "/" after the first char.
  return /^\/[^/]+$/.test(path);
}

/**
 * Collect violations where a root-level catch-all appears BEFORE sibling
 * routes it would subsume.
 *
 * Three catch-all forms are recognised:
 *
 *   • `/:param` — matches every *top-level* (single-segment) path.  Only
 *     later siblings that are themselves single-segment are flagged.
 *
 *   • `/*` / `/**` — glob wildcards that match every path regardless of
 *     depth.  ALL later siblings are flagged, including multi-segment routes
 *     like `/dashboard/products`.
 *
 *   • `/prefix/*` / `/prefix/**` — nested-prefix wildcards that match every
 *     path under a specific prefix (e.g. `/dashboard/*` subsumes later
 *     siblings like `/dashboard/products` and `/dashboard/settings`).  Only
 *     later siblings whose path starts with `prefix/` are flagged.
 *
 * Complements collectShadowViolations: unlike that function, this check also
 * flags later DYNAMIC single-segment routes (e.g. `/:section` after `/:id`)
 * because a root catch-all swallows every top-level path — not only static
 * ones.
 */
function collectCatchAllViolations(groups: SwitchGroup[]): string[] {
  const violations: string[] = [];

  for (const group of groups) {
    const { routes, switchIndex } = group;

    for (let i = 0; i < routes.length; i++) {
      const catchAll = routes[i];

      if (isRootLevelCatchAll(catchAll.path)) {
        const glob = isGlobWildcard(catchAll.path);

        // Human-readable description of what the pattern matches, used in
        // the violation message.
        const matchDescription = glob
          ? `A "${catchAll.path}" glob pattern matches every path at any depth`
          : `A "/:param" pattern matches every top-level path`;

        // Flag every later sibling subsumed by this root-level catch-all.
        for (let j = i + 1; j < routes.length; j++) {
          const later = routes[j];
          // Exact duplicates are handled by the duplicate check, not here.
          if (later.path === catchAll.path) continue;

          // Glob wildcards subsume every path; /:param only subsumes
          // single-segment paths.
          const subsumed = glob || isSubsumedByRootCatchAll(later.path);
          if (!subsumed) continue;

          violations.push(
            `[Switch #${switchIndex}] Line ${later.line + 1}: route "${later.path}" is shadowed by ` +
              `root-level catch-all "${catchAll.path}" declared earlier on line ${catchAll.line + 1}. ` +
              `${matchDescription} and must be placed last in its Switch.`,
          );
        }
      } else if (isNestedCatchAll(catchAll.path)) {
        const prefix = nestedCatchAllPrefix(catchAll.path);
        const matchDescription = `A "${catchAll.path}" nested wildcard matches every path under "${prefix}/"`;

        // Flag every later sibling whose path descends into the same prefix.
        for (let j = i + 1; j < routes.length; j++) {
          const later = routes[j];
          // Exact duplicates are handled by the duplicate check, not here.
          if (later.path === catchAll.path) continue;

          if (!isSubsumedByNestedCatchAll(later.path, prefix)) continue;

          violations.push(
            `[Switch #${switchIndex}] Line ${later.line + 1}: route "${later.path}" is shadowed by ` +
              `nested catch-all "${catchAll.path}" declared earlier on line ${catchAll.line + 1}. ` +
              `${matchDescription} and must be placed last among its siblings under that prefix.`,
          );
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Self-check: verify the shadow-detection logic on synthetic data
// ---------------------------------------------------------------------------

describe("Self-check: collectShadowViolations kernel", () => {
  it("flags a static route that follows a dynamic route which fully subsumes it", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/people/:id", line: 5 },
          { path: "/people/new", line: 10 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("/people/new");
    expect(violations[0]).toContain("/people/:id");
    expect(violations[0]).toContain("Line 11"); // line 10 + 1 for 1-based display
  });

  it("flags every shadowed static route when multiple follow the same dynamic route", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:id", line: 0 },
          { path: "/new", line: 1 },
          { path: "/settings", line: 2 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("/new");
    expect(violations[1]).toContain("/settings");
  });

  it("does not flag a static route that precedes a dynamic route (correct ordering)", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/people/new", line: 5 },
          { path: "/people/:id", line: 10 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag a static route that is NOT matched by the preceding dynamic route", () => {
    // /fleet/:id does not match /people/new — different prefix
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/fleet/:id", line: 0 },
          { path: "/people/new", line: 1 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag two dynamic routes against each other", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:section", line: 0 },
          { path: "/:section/:id", line: 1 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("flags a partially-static nested route shadowed by a preceding multi-segment dynamic route", () => {
    // /:section/:id matches ANY two-segment path, including /:section/edit.
    // The later route has a static second segment ("edit"), so it is reachable
    // only when placed BEFORE the all-dynamic pattern.
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:section/:id", line: 3 },
          { path: "/:section/edit", line: 8 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("/:section/edit");
    expect(violations[0]).toContain("/:section/:id");
    expect(violations[0]).toContain("Line 9"); // line 8 + 1 for 1-based display
  });

  it("does not flag a fully-dynamic route that follows another fully-dynamic route of the same arity", () => {
    // /:a/:b and /:section/:id match the same URL universe — neither shadows
    // the other in any meaningful way; they are equivalent patterns.
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:a/:b", line: 0 },
          { path: "/:section/:id", line: 1 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("flags a partially-static route while leaving a fully-dynamic sibling unflagged", () => {
    // Same Switch: /:section/:id precedes both /:section/edit (partially-static,
    // should be flagged) and /:a/:b (fully-dynamic, should NOT be flagged).
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:section/:id", line: 0 },
          { path: "/:section/edit", line: 5 },
          { path: "/:a/:b", line: 10 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("/:section/edit");
  });

  it("reports the correct Switch index in violation messages for multi-Switch files", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/a/new", line: 1 },
          { path: "/a/:id", line: 2 },
        ],
      },
      {
        switchIndex: 1,
        routes: [
          { path: "/b/:id", line: 10 },
          { path: "/b/edit", line: 11 },
        ],
      },
    ];
    const violations = collectShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Switch #1");
    expect(violations[0]).toContain("/b/edit");
  });
});

// ---------------------------------------------------------------------------
// Self-check: verify the catch-all detection logic on synthetic data
// ---------------------------------------------------------------------------

describe("Self-check: collectCatchAllViolations kernel", () => {
  it("flags a static top-level route that follows a root-level catch-all", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:id", line: 0 },
          { path: "/dashboard", line: 1 },
          { path: "/settings", line: 2 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("/dashboard");
    expect(violations[0]).toContain("/:id");
    expect(violations[0]).toContain("catch-all");
    expect(violations[1]).toContain("/settings");
  });

  it("flags a dynamic single-segment route that follows a root-level catch-all", () => {
    // This is the gap the existing collectShadowViolations doesn't cover:
    // dynamic-vs-dynamic at root level.
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:id", line: 0 },
          { path: "/:section", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("/:section");
    expect(violations[0]).toContain("/:id");
  });

  it("does not flag routes that come BEFORE the catch-all (correct ordering)", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard", line: 0 },
          { path: "/settings", line: 1 },
          { path: "/:id", line: 2 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag multi-segment routes after the catch-all (different arity, no shadowing)", () => {
    // "/:id" matches only single-segment paths; "/dashboard/products" has two
    // segments and would NOT be matched by the root catch-all.
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:id", line: 0 },
          { path: "/dashboard/products", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag routes that are not subsumed because they have a prefix", () => {
    // "/fleet/:id" is NOT a root-level catch-all (has a prefix).
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/fleet/:id", line: 0 },
          { path: "/dashboard", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("skips exact-duplicate paths (those are caught by the duplicate check)", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/:id", line: 0 },
          { path: "/:id", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("reports the correct Switch index in violation messages for multi-Switch files", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/ok", line: 0 },
          { path: "/:id", line: 1 },
        ],
      },
      {
        switchIndex: 1,
        routes: [
          { path: "/:slug", line: 10 },
          { path: "/new", line: 11 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Switch #1");
    expect(violations[0]).toContain("/new");
    expect(violations[0]).toContain("/:slug");
  });
});

// ---------------------------------------------------------------------------
// Self-check: nested-prefix wildcard catch-all detection
// ---------------------------------------------------------------------------

describe("Self-check: collectCatchAllViolations — nested-prefix wildcards", () => {
  it("flags static sub-routes that follow a /prefix/* nested catch-all", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/*", line: 2 },
          { path: "/dashboard/products", line: 5 },
          { path: "/dashboard/settings", line: 8 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("/dashboard/products");
    expect(violations[0]).toContain("/dashboard/*");
    expect(violations[0]).toContain("catch-all");
    expect(violations[1]).toContain("/dashboard/settings");
  });

  it("flags routes subsumed by /prefix/** (double-star) as well as /prefix/*", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/**", line: 0 },
          { path: "/dashboard/products", line: 3 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("/dashboard/products");
    expect(violations[0]).toContain("/dashboard/**");
  });

  it("does not flag routes BEFORE the nested catch-all (correct ordering)", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/products", line: 0 },
          { path: "/dashboard/settings", line: 1 },
          { path: "/dashboard/*", line: 2 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag routes under a DIFFERENT prefix (no cross-prefix shadowing)", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/*", line: 0 },
          { path: "/settings/profile", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag the bare prefix path itself (/* does not match the prefix without a trailing segment)", () => {
    // /dashboard/* matches /dashboard/anything but NOT /dashboard on its own.
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/*", line: 0 },
          { path: "/dashboard", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("handles nested catch-alls at deeper paths", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/a/b/*", line: 0 },
          { path: "/a/b/c", line: 1 },
          { path: "/a/b/d", line: 2 },
          { path: "/a/x", line: 3 }, // different prefix — must NOT be flagged
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("/a/b/c");
    expect(violations[1]).toContain("/a/b/d");
  });

  it("skips exact-duplicate paths for nested catch-alls (handled by duplicate check)", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/*", line: 0 },
          { path: "/dashboard/*", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("reports the correct Switch index for nested catch-all violations in multi-Switch files", () => {
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/ok/page", line: 0 },
          { path: "/ok/*", line: 1 },
        ],
      },
      {
        switchIndex: 1,
        routes: [
          { path: "/dash/*", line: 10 },
          { path: "/dash/sub", line: 11 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Switch #1");
    expect(violations[0]).toContain("/dash/sub");
    expect(violations[0]).toContain("/dash/*");
  });

  it("also flags dynamic sub-routes subsumed by a nested catch-all", () => {
    // /dashboard/* subsumes /dashboard/:id just as much as /dashboard/products.
    const groups: SwitchGroup[] = [
      {
        switchIndex: 0,
        routes: [
          { path: "/dashboard/*", line: 0 },
          { path: "/dashboard/:id", line: 1 },
        ],
      },
    ];
    const violations = collectCatchAllViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("/dashboard/:id");
    expect(violations[0]).toContain("/dashboard/*");
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Expo Router / React Navigation — navigator-block duplicate-name scanner
// ---------------------------------------------------------------------------

/** All Expo mobile artifact roots in this workspace, discovered at test-load time. */
const EXPO_ARTIFACT_DIRS = discoverMobileArtifactDirs();

/**
 * Quick pre-filter: returns true when the file contains at least one React
 * Navigation Screen or Trigger element with a name prop, which is the minimal
 * signal that the file declares navigator routes.
 *
 * We require both the component-qualified form (Stack.Screen, Tabs.Screen,
 * NativeTabs.Trigger) AND a name=" attribute to be present somewhere in the
 * source.  This intentionally excludes page-component files that use
 * `<Stack.Screen options={…} />` (no name prop) to configure their own header
 * — those are not navigator declarations and cannot contain duplicates.
 */
function hasNavigatorScreens(filePath: string): boolean {
  const src = readFileSync(filePath, "utf-8");
  const hasScreenDeclaration =
    src.includes("Stack.Screen") ||
    src.includes("Tabs.Screen") ||
    src.includes("NativeTabs.Trigger");
  return hasScreenDeclaration && src.includes('name="');
}

/** All .tsx files across the Expo artifact directories that declare navigator screens. */
const expoRoutingFiles = EXPO_ARTIFACT_DIRS.flatMap((dir) =>
  walkTsx(dir).filter(hasNavigatorScreens),
);

interface ScreenEntry {
  name: string;
  /** Zero-based index of the line where this screen element starts. */
  line: number;
}

interface NavigatorGroup {
  /** Ordinal of this navigator in the file (0-based). */
  navigatorIndex: number;
  /** Component type that owns this group: "Stack", "Tabs", or "NativeTabs". */
  navigatorType: string;
  screens: ScreenEntry[];
}

/**
 * Parse a TSX file and return screen names grouped by their enclosing
 * React Navigation navigator block (Stack, Tabs, or NativeTabs).
 *
 * Algorithm
 * ---------
 * We tokenize the source with a single regex that matches, in document order:
 *
 *   • An opening navigator tag:  <Stack, <Tabs, or <NativeTabs
 *     — distinguished from <Stack.Screen etc. by requiring the next char to
 *       be whitespace or the closing ">".
 *
 *   • A closing navigator tag:   </Stack>, </Tabs>, or </NativeTabs>
 *
 *   • A screen element opening:  <Stack.Screen … name="…"
 *                               or <Tabs.Screen … name="…"
 *     — the [^/]*? between the tag name and the name= attr matches across
 *       line breaks so multiline JSX elements are handled correctly.
 *
 *   • A NativeTabs trigger:      <NativeTabs.Trigger … name="…"
 *
 * Each navigator type maintains its own open-navigator index stack so nested
 * navigators of the same type each get their own isolated group.  A
 * Stack.Screen is attributed to the innermost open Stack; a Tabs.Screen to
 * the innermost open Tabs; a NativeTabs.Trigger to the innermost open
 * NativeTabs.
 *
 * Groups whose screen list ends up empty (navigators with no matched children)
 * are dropped from the result before returning.
 */
function extractScreensByNavigator(filePath: string): NavigatorGroup[] {
  const source = readFileSync(filePath, "utf-8");
  const groups: NavigatorGroup[] = [];

  // Per-type stacks of groups[] indices for open navigators.
  const openStacks: Record<string, number[]> = {
    Stack: [],
    Tabs: [],
    NativeTabs: [],
  };

  // Combined tokenizer regex.  Capture groups:
  //   m[1] — opening navigator type  (Stack | Tabs | NativeTabs)
  //   m[2] — closing navigator type  (Stack | Tabs | NativeTabs)
  //   m[3] — screen parent type      (Stack | Tabs)   for .Screen children
  //   m[4] — screen name from a Stack.Screen or Tabs.Screen
  //   m[5] — screen name from a NativeTabs.Trigger
  //
  // The dotAll (`s`) flag lets [^/]*? and [^>]* span across newlines so we
  // correctly capture name= props that appear on a line after the tag name.
  const tokenRe =
    /<(Stack|Tabs|NativeTabs)(?=[\s>])|<\/(Stack|Tabs|NativeTabs)>|<(Stack|Tabs)\.Screen\b[^/]*?name="([^"]+)"|<NativeTabs\.Trigger\b[^>]*name="([^"]+)"/gs;

  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(source)) !== null) {
    if (m[1]) {
      // Opening navigator: push a new group and record its index on the type stack.
      const type = m[1];
      const idx = groups.length;
      groups.push({ navigatorIndex: idx, navigatorType: type, screens: [] });
      openStacks[type].push(idx);
    } else if (m[2]) {
      // Closing navigator: pop the innermost open navigator of that type.
      openStacks[m[2]].pop();
    } else if (m[4] !== undefined) {
      // Stack.Screen or Tabs.Screen: attribute to innermost open navigator of that type.
      const type = m[3]; // "Stack" or "Tabs"
      const typeStack = openStacks[type];
      if (typeStack.length > 0) {
        const before = source.slice(0, m.index);
        const line = (before.match(/\n/g) ?? []).length;
        groups[typeStack[typeStack.length - 1]].screens.push({ name: m[4], line });
      }
    } else if (m[5] !== undefined) {
      // NativeTabs.Trigger: attribute to innermost open NativeTabs.
      const typeStack = openStacks["NativeTabs"];
      if (typeStack.length > 0) {
        const before = source.slice(0, m.index);
        const line = (before.match(/\n/g) ?? []).length;
        groups[typeStack[typeStack.length - 1]].screens.push({ name: m[5], line });
      }
    }
  }

  // Drop navigator groups that contain no screen entries (e.g. empty shells).
  return groups.filter((g) => g.screens.length > 0);
}

/** True if the screen name is an Expo Router dynamic segment: e.g. "[id]", "[param]". */
function isExpoParam(name: string): boolean {
  return /^\[[^\]]+\]$/.test(name);
}

/**
 * Inspect a list of NavigatorGroups and return one violation string for every
 * literal screen name that is shadowed by an Expo Router dynamic-segment name
 * (e.g. `[id]`) declared earlier in the same navigator.
 *
 * In React Navigation / Expo Router, a screen named `[id]` participates in
 * first-match routing — any literal name that follows it inside the same
 * navigator can never be reached.  Dynamic-after-dynamic pairs are skipped
 * because two `[param]` names would already be caught by the duplicate check.
 */
function collectExpoShadowViolations(groups: NavigatorGroup[]): string[] {
  const violations: string[] = [];

  for (const group of groups) {
    const { screens, navigatorIndex, navigatorType } = group;

    for (let i = 0; i < screens.length; i++) {
      const screen = screens[i];
      if (!isExpoParam(screen.name)) continue;

      for (let j = i + 1; j < screens.length; j++) {
        const later = screens[j];
        // Only flag literals; dynamic-after-dynamic is a duplicate concern.
        if (isExpoParam(later.name)) continue;

        violations.push(
          `[${navigatorType} #${navigatorIndex}] Line ${later.line + 1}: ` +
            `screen name="${later.name}" is shadowed by dynamic-segment screen ` +
            `name="${screen.name}" declared earlier on line ${screen.line + 1}. ` +
            `Expo Router uses first-match semantics — the literal screen can never be reached.`,
        );
      }
    }
  }

  return violations;
}

/**
 * Inspect a list of NavigatorGroups and return one violation string for every
 * screen name that appears more than once within the same navigator group.
 *
 * React Navigation uses first-match semantics for named routes: when two
 * sibling screens share the same name, the second occurrence is permanently
 * unreachable.
 *
 * Extracted into a standalone function so it can be exercised directly in the
 * self-check tests below, mirroring the pattern used by collectShadowViolations
 * and collectCatchAllViolations for the wouter suite.
 */
function collectDuplicateScreenViolations(groups: NavigatorGroup[]): string[] {
  const violations: string[] = [];

  for (const group of groups) {
    const { screens, navigatorIndex, navigatorType } = group;
    const seen = new Map<string, number>();

    for (const screen of screens) {
      const firstLine = seen.get(screen.name);
      if (firstLine === undefined) {
        seen.set(screen.name, screen.line);
      } else {
        violations.push(
          `[${navigatorType} #${navigatorIndex}] Line ${screen.line + 1}: name="${screen.name}" is already ` +
            `declared on line ${firstLine + 1} in the same navigator — ` +
            `the second occurrence can never be reached.`,
        );
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Self-check: verify the Expo / React Navigation parser on synthetic source
// ---------------------------------------------------------------------------

describe("Self-check: extractScreensByNavigator parser", () => {
  /**
   * Helper: build synthetic TSX source strings from an indented template
   * literal and run extractScreensByNavigator over them via a temp file-like
   * approach — we exercise the regex engine directly on a string by passing
   * it to a stripped-down clone of the extractor.
   *
   * Rather than writing real files to disk, we replicate the pure-regex
   * heart of extractScreensByNavigator so the self-checks remain hermetic.
   */
  function parseSource(source: string): NavigatorGroup[] {
    const groups: NavigatorGroup[] = [];
    const openStacks: Record<string, number[]> = {
      Stack: [],
      Tabs: [],
      NativeTabs: [],
    };
    const tokenRe =
      /<(Stack|Tabs|NativeTabs)(?=[\s>])|<\/(Stack|Tabs|NativeTabs)>|<(Stack|Tabs)\.Screen\b[^/]*?name="([^"]+)"|<NativeTabs\.Trigger\b[^>]*name="([^"]+)"/gs;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(source)) !== null) {
      if (m[1]) {
        const type = m[1];
        const idx = groups.length;
        groups.push({ navigatorIndex: idx, navigatorType: type, screens: [] });
        openStacks[type].push(idx);
      } else if (m[2]) {
        openStacks[m[2]].pop();
      } else if (m[4] !== undefined) {
        const type = m[3];
        const typeStack = openStacks[type];
        if (typeStack.length > 0) {
          const before = source.slice(0, m.index);
          const line = (before.match(/\n/g) ?? []).length;
          groups[typeStack[typeStack.length - 1]].screens.push({
            name: m[4],
            line,
          });
        }
      } else if (m[5] !== undefined) {
        const typeStack = openStacks["NativeTabs"];
        if (typeStack.length > 0) {
          const before = source.slice(0, m.index);
          const line = (before.match(/\n/g) ?? []).length;
          groups[typeStack[typeStack.length - 1]].screens.push({
            name: m[5],
            line,
          });
        }
      }
    }
    return groups.filter((g) => g.screens.length > 0);
  }

  it("parses a simple Stack navigator with two screens", () => {
    const src = `
      <Stack>
        <Stack.Screen name="home" />
        <Stack.Screen name="profile" />
      </Stack>
    `;
    const groups = parseSource(src);
    expect(groups).toHaveLength(1);
    expect(groups[0].navigatorType).toBe("Stack");
    expect(groups[0].screens.map((s) => s.name)).toEqual(["home", "profile"]);
  });

  it("parses a Tabs navigator and assigns screens to the correct group", () => {
    const src = `
      <Tabs>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="orders" />
        <Tabs.Screen name="catalog" />
      </Tabs>
    `;
    const groups = parseSource(src);
    expect(groups).toHaveLength(1);
    expect(groups[0].navigatorType).toBe("Tabs");
    expect(groups[0].screens).toHaveLength(3);
    expect(groups[0].screens[1].name).toBe("orders");
  });

  it("parses NativeTabs.Trigger elements as tab screens", () => {
    const src = `
      <NativeTabs>
        <NativeTabs.Trigger name="home" />
        <NativeTabs.Trigger name="catalog" />
      </NativeTabs>
    `;
    const groups = parseSource(src);
    expect(groups).toHaveLength(1);
    expect(groups[0].navigatorType).toBe("NativeTabs");
    expect(groups[0].screens.map((s) => s.name)).toEqual(["home", "catalog"]);
  });

  it("isolates sibling navigators of the same type into separate groups", () => {
    const src = `
      <Stack>
        <Stack.Screen name="auth" />
      </Stack>
      <Stack>
        <Stack.Screen name="app" />
      </Stack>
    `;
    const groups = parseSource(src);
    expect(groups).toHaveLength(2);
    expect(groups[0].screens[0].name).toBe("auth");
    expect(groups[1].screens[0].name).toBe("app");
  });

  it("handles a nested Stack inside Tabs (assigns each screen to the correct parent)", () => {
    const src = `
      <Tabs>
        <Tabs.Screen name="home" />
        <Stack>
          <Stack.Screen name="detail" />
        </Stack>
        <Tabs.Screen name="profile" />
      </Tabs>
    `;
    const groups = parseSource(src);
    const tabsGroup = groups.find((g) => g.navigatorType === "Tabs");
    const stackGroup = groups.find((g) => g.navigatorType === "Stack");
    expect(tabsGroup?.screens.map((s) => s.name)).toEqual(["home", "profile"]);
    expect(stackGroup?.screens.map((s) => s.name)).toEqual(["detail"]);
  });

  it("captures name= props on the same line as the tag", () => {
    const src = `<Stack><Stack.Screen name="one" /><Stack.Screen name="two" /></Stack>`;
    const groups = parseSource(src);
    expect(groups[0].screens.map((s) => s.name)).toEqual(["one", "two"]);
  });

  it("captures name= props that appear on a subsequent line (multiline JSX)", () => {
    const src = `
      <Stack>
        <Stack.Screen
          name="detail"
          options={{ headerShown: false }}
        />
      </Stack>
    `;
    const groups = parseSource(src);
    expect(groups[0].screens[0].name).toBe("detail");
  });

  it("drops navigator groups that contain no matched screens (empty shell navigators)", () => {
    const src = `
      <Stack>
        {/* no Screen declarations here */}
      </Stack>
      <Tabs>
        <Tabs.Screen name="active" />
      </Tabs>
    `;
    const groups = parseSource(src);
    expect(groups).toHaveLength(1);
    expect(groups[0].navigatorType).toBe("Tabs");
  });

  it("does NOT pick up Stack.Screen elements that appear outside a navigator (no open Stack)", () => {
    // A page component that uses <Stack.Screen options={...} /> to configure its
    // own header should not be attributed to any navigator group.
    const src = `
      export default function Page() {
        return (
          <>
            <Stack.Screen options={{ title: "My Page" }} />
            <View />
          </>
        );
      }
    `;
    const groups = parseSource(src);
    expect(groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Self-check: verify the duplicate-screen detection kernel on synthetic data
// ---------------------------------------------------------------------------

describe("Self-check: collectDuplicateScreenViolations kernel", () => {
  it("flags a screen name that appears twice in the same navigator", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "home", line: 2 },
          { name: "profile", line: 4 },
          { name: "home", line: 8 },
        ],
      },
    ];
    const violations = collectDuplicateScreenViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('name="home"');
    expect(violations[0]).toContain("Stack #0");
    expect(violations[0]).toContain("Line 9"); // line 8 + 1 for 1-based display
    expect(violations[0]).toContain("line 3"); // first occurrence: line 2 + 1
  });

  it("flags every duplicate independently when multiple names are duplicated", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Tabs",
        screens: [
          { name: "index", line: 0 },
          { name: "orders", line: 1 },
          { name: "index", line: 2 },
          { name: "orders", line: 3 },
        ],
      },
    ];
    const violations = collectDuplicateScreenViolations(groups);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('"index"');
    expect(violations[1]).toContain('"orders"');
  });

  it("does not flag screens with distinct names in the same navigator", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "home", line: 0 },
          { name: "profile", line: 1 },
          { name: "settings", line: 2 },
        ],
      },
    ];
    const violations = collectDuplicateScreenViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag identically-named screens that live in different navigator groups", () => {
    // Two separate Stack navigators may legitimately both have a "home" screen.
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [{ name: "home", line: 1 }],
      },
      {
        navigatorIndex: 1,
        navigatorType: "Stack",
        screens: [{ name: "home", line: 10 }],
      },
    ];
    const violations = collectDuplicateScreenViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("includes the correct navigator type in violation messages", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "NativeTabs",
        screens: [
          { name: "catalog", line: 5 },
          { name: "catalog", line: 12 },
        ],
      },
    ];
    const violations = collectDuplicateScreenViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("NativeTabs #0");
  });

  it("reports the correct navigator index when violations occur in the second of two groups", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "a", line: 0 },
          { name: "b", line: 1 },
        ],
      },
      {
        navigatorIndex: 1,
        navigatorType: "Tabs",
        screens: [
          { name: "x", line: 10 },
          { name: "x", line: 11 },
        ],
      },
    ];
    const violations = collectDuplicateScreenViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Tabs #1");
    expect(violations[0]).toContain('"x"');
  });

  it("handles an empty groups array without errors", () => {
    expect(collectDuplicateScreenViolations([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-check: verify the Expo shadow-detection logic on synthetic data
// ---------------------------------------------------------------------------

describe("Self-check: collectExpoShadowViolations kernel", () => {
  it("flags a literal screen that follows a dynamic-segment screen", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "[id]", line: 5 },
          { name: "settings", line: 10 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("settings");
    expect(violations[0]).toContain("[id]");
    expect(violations[0]).toContain("Line 11"); // line 10 + 1 for 1-based display
  });

  it("flags every shadowed literal when multiple literals follow a dynamic screen", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "[id]", line: 0 },
          { name: "home", line: 1 },
          { name: "profile", line: 2 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("home");
    expect(violations[1]).toContain("profile");
  });

  it("does not flag a literal screen that precedes a dynamic screen (correct ordering)", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "settings", line: 5 },
          { name: "[id]", line: 10 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag a dynamic screen that follows another dynamic screen", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "[id]", line: 0 },
          { name: "[slug]", line: 1 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("does not flag when there are no dynamic-segment screens at all", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "home", line: 0 },
          { name: "settings", line: 1 },
          { name: "profile", line: 2 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });

  it("reports the correct navigator type and index in violation messages", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "Stack",
        screens: [
          { name: "home", line: 0 },
          { name: "[id]", line: 1 },
        ],
      },
      {
        navigatorIndex: 1,
        navigatorType: "Tabs",
        screens: [
          { name: "[param]", line: 10 },
          { name: "overview", line: 11 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Tabs #1");
    expect(violations[0]).toContain("overview");
    expect(violations[0]).toContain("[param]");
  });

  it("flags only the literal screens, leaving already-flagged dynamic siblings unflagged", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "NativeTabs",
        screens: [
          { name: "[id]", line: 0 },
          { name: "settings", line: 1 },
          { name: "[other]", line: 2 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("settings");
  });

  it("flags a literal NativeTabs.Trigger that follows a dynamic-segment Trigger and includes NativeTabs in the message", () => {
    // A NativeTabs navigator where [param] precedes a literal trigger —
    // the literal tab can never be reached because NativeTabs uses first-match
    // semantics just like Stack and Tabs navigators.
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "NativeTabs",
        screens: [
          { name: "[tab]", line: 3 },
          { name: "catalog", line: 8 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("NativeTabs");
    expect(violations[0]).toContain("catalog");
    expect(violations[0]).toContain("[tab]");
    expect(violations[0]).toContain("Line 9"); // line 8 + 1 for 1-based display
  });

  it("flags every shadowed literal trigger in a NativeTabs group when multiple literals follow a dynamic trigger", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "NativeTabs",
        screens: [
          { name: "[param]", line: 0 },
          { name: "home", line: 1 },
          { name: "orders", line: 2 },
          { name: "profile", line: 3 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(3);
    expect(violations[0]).toContain("NativeTabs #0");
    expect(violations[0]).toContain("home");
    expect(violations[1]).toContain("orders");
    expect(violations[2]).toContain("profile");
  });

  it("does not flag a NativeTabs group where literal triggers precede the dynamic trigger (correct ordering)", () => {
    const groups: NavigatorGroup[] = [
      {
        navigatorIndex: 0,
        navigatorType: "NativeTabs",
        screens: [
          { name: "home", line: 0 },
          { name: "catalog", line: 1 },
          { name: "[tab]", line: 2 },
        ],
      },
    ];
    const violations = collectExpoShadowViolations(groups);
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expo Router file-based routing — duplicate dynamic segment scanner
// ---------------------------------------------------------------------------

/**
 * Represents the direct children of a single directory in an Expo app/ tree.
 * Each entry is either a file name (e.g. "[id].tsx") or a sub-directory name
 * (e.g. "[id]").  The caller is responsible for stripping SKIP_DIRS entries
 * before constructing the list.
 */
interface DirContents {
  /** Relative or absolute path of the directory being described. */
  dir: string;
  /** Names of every direct child (files and sub-directories) in this directory. */
  entries: string[];
}

/**
 * True if the given file or directory name is an Expo Router dynamic segment.
 *
 * Expo Router treats any file whose base name is fully wrapped in brackets as
 * a dynamic route segment.  Both file entries and directory entries are
 * detected:
 *
 *   "[id].tsx"          → true   (dynamic file)
 *   "[orderId].tsx"     → true   (dynamic file, different param name)
 *   "[...slug].tsx"     → true   (catch-all dynamic file)
 *   "[id]"              → true   (dynamic directory)
 *   "index.tsx"         → false  (static file)
 *   "_layout.tsx"       → false  (layout file)
 *   "+not-found.tsx"    → false  (Expo special file)
 */
function isExpoDynamicEntry(name: string): boolean {
  const base = name.endsWith(".tsx") ? name.slice(0, -4) : name;
  return base.startsWith("[") && base.endsWith("]");
}

/**
 * Inspect a list of DirContents and return one violation string for every
 * directory that contains more than one Expo Router dynamic-segment entry
 * (bracket-named file or directory) at the same level.
 *
 * Expo Router resolves dynamic segments by position in the file tree, not by
 * bracket name.  When two sibling entries both claim the same dynamic slot
 * (e.g. "[id].tsx" and "[orderId].tsx" in the same directory), only the first
 * one Expo encounters is ever reachable — the second is silently dead code.
 *
 * Both file entries ("[id].tsx") and directory entries ("[id]") are checked.
 */
function collectExpoDynamicRouteConflicts(dirs: DirContents[]): string[] {
  const violations: string[] = [];

  for (const { dir, entries } of dirs) {
    const dynamic = entries.filter(isExpoDynamicEntry);
    if (dynamic.length > 1) {
      const list = dynamic.join(", ");
      violations.push(
        `Directory "${dir}" has ${dynamic.length} dynamic-segment entries at the same level: ${list}. ` +
          `Expo Router maps all bracket-named files/directories at the same directory level to a single ` +
          `dynamic route slot — only the first is reachable; the others are permanently dead routes.`,
      );
    }
  }

  return violations;
}

/**
 * Walk an Expo app/ root and collect a DirContents record for every directory
 * in the tree.  SKIP_DIRS entries are excluded from both traversal and the
 * entry lists, mirroring how walkTsx filters generated output directories.
 *
 * @param appDir Absolute path to the Expo artifact's `app/` directory.
 */
function scanExpoAppDirContents(appDir: string): DirContents[] {
  if (!existsSync(appDir)) return [];
  const results: DirContents[] = [];

  function walk(dir: string): void {
    let children: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const entries: string[] = [];
    for (const entry of children) {
      if (SKIP_DIRS.has(entry.name)) continue;
      entries.push(entry.name);
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
    results.push({ dir, entries });
  }

  walk(appDir);
  return results;
}

// ---------------------------------------------------------------------------
// Self-check: verify collectExpoDynamicRouteConflicts on synthetic data
// ---------------------------------------------------------------------------

describe("Self-check: collectExpoDynamicRouteConflicts kernel", () => {
  it("flags a directory with two bracket-named files at the same level", () => {
    const dirs: DirContents[] = [
      {
        dir: "app/orders",
        entries: ["[id].tsx", "[orderId].tsx", "index.tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("app/orders");
    expect(violations[0]).toContain("[id].tsx");
    expect(violations[0]).toContain("[orderId].tsx");
    expect(violations[0]).toContain("dynamic-segment");
  });

  it("flags a directory with three bracket-named files", () => {
    const dirs: DirContents[] = [
      {
        dir: "app/items",
        entries: ["[id].tsx", "[slug].tsx", "[uid].tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("3 dynamic-segment entries");
  });

  it("flags a directory with a bracket-named file and a bracket-named subdirectory at the same level", () => {
    const dirs: DirContents[] = [
      {
        dir: "app",
        entries: ["[id].tsx", "[orderId]", "_layout.tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("[id].tsx");
    expect(violations[0]).toContain("[orderId]");
  });

  it("does not flag a directory with only one bracket-named entry", () => {
    const dirs: DirContents[] = [
      {
        dir: "app/orders",
        entries: ["[id].tsx", "index.tsx", "_layout.tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(0);
  });

  it("does not flag a directory with no bracket-named entries", () => {
    const dirs: DirContents[] = [
      {
        dir: "app/(tabs)",
        entries: ["index.tsx", "orders.tsx", "catalog.tsx", "_layout.tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(0);
  });

  it("detects conflicts independently across multiple directories", () => {
    const dirs: DirContents[] = [
      {
        dir: "app",
        entries: ["[id].tsx", "index.tsx"],
      },
      {
        dir: "app/orders",
        entries: ["[id].tsx", "[orderId].tsx"],
      },
      {
        dir: "app/(tabs)",
        entries: ["home.tsx", "profile.tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("app/orders");
  });

  it("does not flag non-bracket entries regardless of how many there are", () => {
    const dirs: DirContents[] = [
      {
        dir: "app",
        entries: ["index.tsx", "_layout.tsx", "+not-found.tsx", "(tabs)", "(auth)"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(0);
  });

  it("correctly identifies a catch-all bracket entry ([...slug].tsx) as a dynamic segment", () => {
    const dirs: DirContents[] = [
      {
        dir: "app/docs",
        entries: ["[id].tsx", "[...slug].tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("[...slug].tsx");
  });

  it("handles an empty dirs array without errors", () => {
    expect(collectExpoDynamicRouteConflicts([])).toEqual([]);
  });

  it("handles a directory with an empty entries list without errors", () => {
    const dirs: DirContents[] = [{ dir: "app", entries: [] }];
    expect(collectExpoDynamicRouteConflicts(dirs)).toEqual([]);
  });

  it("reports the correct directory path in violation messages", () => {
    const dirs: DirContents[] = [
      {
        dir: "artifacts/os-mobile/app/orders",
        entries: ["[id].tsx", "[deliveryId].tsx"],
      },
    ];
    const violations = collectExpoDynamicRouteConflicts(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("artifacts/os-mobile/app/orders");
  });
});

// ---------------------------------------------------------------------------
// Integration: scan all discovered Expo apps for dynamic-segment conflicts
// ---------------------------------------------------------------------------

describe("Expo Router file-based routing — duplicate dynamic segments in app/ trees", () => {
  it(
    "scanner discovers at least one directory entry across all Expo app/ trees " +
      "(sanity check that the scanner is working)",
    () => {
      const allDirs = EXPO_ARTIFACT_DIRS.flatMap((artifactDir) =>
        scanExpoAppDirContents(join(artifactDir, "app")),
      );
      expect(
        allDirs.length,
        `scanExpoAppDirContents returned zero directories across the discovered mobile artifacts. ` +
          `Either the app/ directories do not exist or the scanner is broken.`,
      ).toBeGreaterThan(0);
    },
  );

  for (const artifactDir of EXPO_ARTIFACT_DIRS) {
    const appDir = join(artifactDir, "app");
    const label = relative(WORKSPACE_ROOT, appDir);

    it(`no directory in ${label} has more than one dynamic-segment entry at the same level`, () => {
      const dirs = scanExpoAppDirContents(appDir);
      const violations = collectExpoDynamicRouteConflicts(dirs);

      if (violations.length > 0) {
        throw new Error(
          `Duplicate dynamic route segment(s) detected under ${label}.\n` +
            `Expo Router maps all bracket-named files/directories at the same level to a single ` +
            `dynamic route slot — only the first one encountered is ever reachable; the others are dead routes.\n\n` +
            violations.join("\n") +
            `\n\nFix: remove or rename the duplicate bracket-named file(s) or directory(ies) so that ` +
            `each directory contains at most one dynamic-segment entry.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Self-check: verify the mobile artifact discovery logic
// ---------------------------------------------------------------------------

describe("Self-check: discoverMobileArtifactDirs", () => {
  it("discovers mobile artifacts from artifact.toml", () => {
    expect(
      EXPO_ARTIFACT_DIRS.length,
      `discoverMobileArtifactDirs() found no mobile artifacts under ${ARTIFACTS_ROOT}. ` +
        `Check that an artifact's .replit-artifact/artifact.toml contains kind = "mobile".`,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Expo Router / React Navigation tests
// ---------------------------------------------------------------------------

describe("Duplicate screen names — Expo Router / React Navigation navigator blocks", () => {
  it(
    "discovers at least one Expo routing file to check " +
      "(scans discovered mobile artifacts for Stack.Screen / Tabs.Screen / NativeTabs.Trigger)",
    () => {
      expect(
        expoRoutingFiles.length,
        `No .tsx file under the Expo artifact directories contains Stack.Screen, ` +
          `Tabs.Screen, or NativeTabs.Trigger. ` +
          `This likely means the scanner is broken or the navigator pattern has changed.`,
      ).toBeGreaterThan(0);
    },
  );

  for (const filePath of expoRoutingFiles) {
    const label = relative(WORKSPACE_ROOT, filePath);

    describe(label, () => {
      const groups = extractScreensByNavigator(filePath);

      it("every navigator routing file yields at least one parsed navigator group (parser sanity)", () => {
        expect(
          groups.length,
          `${label} was selected for the navigator check but no screens were found inside ` +
            `a Stack, Tabs, or NativeTabs block. ` +
            `Either the file no longer uses React Navigation / Expo Router, ` +
            `or the parser needs updating.`,
        ).toBeGreaterThan(0);
      });

      it("no two sibling screens in the same navigator share the same name (duplicate detection)", () => {
        const violations = collectDuplicateScreenViolations(groups);

        if (violations.length > 0) {
          throw new Error(
            `Duplicate screen name(s) detected in ${label}.\n` +
              `React Navigation uses first-match semantics — any later screen with the same name ` +
              `inside the same navigator is permanently unreachable.\n\n` +
              violations.join("\n") +
              `\n\nFix: remove or rename the duplicate screen(s).`,
          );
        }
      });

      it("literal screen names are not shadowed by preceding dynamic-segment names (ordering check)", () => {
        const violations = collectExpoShadowViolations(groups);

        if (violations.length > 0) {
          throw new Error(
            `Screen ordering bug detected in ${label}.\n` +
              `Literal screen names must appear BEFORE any dynamic-segment screen (e.g. "[id]") ` +
              `that would shadow them, because Expo Router uses first-match semantics.\n\n` +
              violations.join("\n") +
              `\n\nFix: move the literal screen(s) above the dynamic-segment screen(s) that shadow them.`,
          );
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Wouter <Switch> tests (unchanged)
// ---------------------------------------------------------------------------

describe("Route ordering — wouter <Switch> blocks", () => {
  it(
    "discovers at least one routing file to check " +
      "(scans all artifact .tsx files for <Switch> + <Route path=>)",
    () => {
      expect(
        routingFiles.length,
        `No .tsx file under ${ARTIFACTS_ROOT} contains both <Switch> and <Route path="...">. ` +
          `This likely means the scanner is broken or the routing pattern has changed.`,
      ).toBeGreaterThan(0);
    },
  );

  for (const filePath of routingFiles) {
    const label = relative(WORKSPACE_ROOT, filePath);

    describe(label, () => {
      // Parsed once and shared between the two checks below.
      const groups = extractRoutesBySwitch(filePath);

      it("every routing file contains at least one Switch group with routes (parser sanity)", () => {
        const totalRoutes = groups.reduce((n, g) => n + g.routes.length, 0);
        expect(
          totalRoutes,
          `${label} was selected for the routing check but no <Route path="..."> was found inside a <Switch>. ` +
            `Either the file no longer uses wouter Switch+Route or the parser needs updating.`,
        ).toBeGreaterThan(0);
      });

      it("static routes are not shadowed by preceding dynamic-segment routes (per Switch group)", () => {
        const violations = collectShadowViolations(groups);

        if (violations.length > 0) {
          throw new Error(
            `Route ordering bug detected in ${label}.\n` +
              `Static routes must appear BEFORE any dynamic-segment route that would match them,\n` +
              `because wouter uses first-match semantics inside <Switch>.\n\n` +
              violations.join("\n") +
              `\n\nFix: move the static route(s) above the dynamic route(s) that shadow them.`,
          );
        }
      });

      it("no two sibling routes in the same Switch share the same path (duplicate detection)", () => {
        const violations: string[] = [];

        for (const group of groups) {
          const { routes, switchIndex } = group;

          // Build a map of path → first-seen line within this Switch.
          const seen = new Map<string, number>();

          for (const route of routes) {
            const firstLine = seen.get(route.path);
            if (firstLine === undefined) {
              seen.set(route.path, route.line);
            } else {
              violations.push(
                `[Switch #${switchIndex}] Line ${route.line + 1}: path "${route.path}" is already declared ` +
                  `on line ${firstLine + 1} in the same Switch — the second occurrence can never be reached.`,
              );
            }
          }
        }

        if (violations.length > 0) {
          throw new Error(
            `Duplicate route path(s) detected in ${label}.\n` +
              `Within a wouter <Switch>, the first matching route wins — any later route with the same path ` +
              `is permanently unreachable.\n\n` +
              violations.join("\n") +
              `\n\nFix: remove or rename the duplicate route(s).`,
          );
        }
      });

      it("no root-level catch-all route appears before sibling routes it would swallow (catch-all trap)", () => {
        const violations = collectCatchAllViolations(groups);

        if (violations.length > 0) {
          throw new Error(
            `Root-level catch-all trap detected in ${label}.\n` +
              `A route like "/:param" matches EVERY top-level path, so placing it before specific siblings\n` +
              `in a wouter <Switch> silently swallows those routes — they can never be reached.\n\n` +
              violations.join("\n") +
              `\n\nFix: move the catch-all route(s) to the END of their Switch block.`,
          );
        }
      });
    });
  }
});
