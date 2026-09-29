/**
 * Verifies that every <Route> wrapped by <ProtectedDashboard> in App.tsx
 * is represented in the PROTECTED_ROUTES constant.
 *
 * When a developer adds a new protected route to App.tsx and forgets to add
 * it to protected-routes.ts, this test fails, making the omission impossible
 * to miss in CI.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";
import {
  PROTECTED_ROUTES,
  DYNAMIC_PROTECTED_ROUTE_PATHS,
} from "./protected-routes";

const APP_TSX_PATH = resolve(__dirname, "App.tsx");

/**
 * Reads App.tsx and extracts all route paths that are directly wrapped by
 * <ProtectedDashboard>.  The heuristic is simple and relies on the consistent
 * code style used throughout the file:
 *
 *   <Route path="/some-path">
 *     <ProtectedDashboard>
 *
 * Any path with dynamic segments (e.g. :id, :brandId) is normalised by
 * replacing every :param with "1" so it can be compared against the concrete
 * example values stored in PROTECTED_ROUTES.
 *
 * Returns an array of objects with:
 *   - normalised: the path with :params replaced by "1"
 *   - isDynamic:  true if the original path contained at least one :param
 */
function extractProtectedRoutePaths(): Array<{
  normalised: string;
  isDynamic: boolean;
}> {
  const source = readFileSync(APP_TSX_PATH, "utf-8");

  // Match: <Route path="/..."> immediately followed (possibly with whitespace)
  // by <ProtectedDashboard>
  const pattern = /<Route path="([^"]+)">\s*\n\s*<ProtectedDashboard>/g;

  const paths: Array<{ normalised: string; isDynamic: boolean }> = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const raw = match[1];
    const isDynamic = /\/:[^/]+/.test(raw);
    // Normalise dynamic segments: /locations/:id -> /locations/1
    const normalised = raw.replace(/\/:[^/]+/g, "/1");
    paths.push({ normalised, isDynamic });
  }

  return paths;
}

/**
 * Normalise a concrete route path by replacing any numeric-only segment
 * with "1".  This lets us compare App.tsx routes (which use :param placeholders
 * normalised to "1") against PROTECTED_ROUTES entries (which may contain real
 * seed IDs like 43, 58, 159, etc. sourced from the e2e DB fixture).
 *
 * Examples:
 *   /locations/43  → /locations/1
 *   /brands/58     → /brands/1
 *   /dashboard     → /dashboard   (unchanged — no numeric segment)
 */
function normaliseIds(route: string): string {
  return route.replace(/\/\d+/g, "/1");
}

describe("ProtectedDashboard route coverage", () => {
  it("every ProtectedDashboard route in App.tsx is listed in PROTECTED_ROUTES", () => {
    const routesInApp = extractProtectedRoutePaths();

    expect(routesInApp.length).toBeGreaterThan(0);

    const normalisedProtectedRoutes = PROTECTED_ROUTES.map(normaliseIds);

    const missing = routesInApp
      .map((r) => r.normalised)
      .filter((route) => !normalisedProtectedRoutes.includes(route));

    if (missing.length > 0) {
      throw new Error(
        `The following routes are wrapped by <ProtectedDashboard> in App.tsx ` +
          `but are missing from PROTECTED_ROUTES in protected-routes.ts:\n` +
          missing.map((r) => `  ${r}`).join("\n") +
          `\n\nAdd them to src/protected-routes.ts to fix this failure.`,
      );
    }
  });

  it(
    "every dynamic-segment ProtectedDashboard route in App.tsx is listed in DYNAMIC_PROTECTED_ROUTE_PATHS",
    () => {
      const routesInApp = extractProtectedRoutePaths();
      const dynamicRoutes = routesInApp
        .filter((r) => r.isDynamic)
        .map((r) => r.normalised);

      expect(dynamicRoutes.length).toBeGreaterThan(0);

      const normalisedDynamicPaths = new Set(
        [...DYNAMIC_PROTECTED_ROUTE_PATHS].map(normaliseIds),
      );

      const missing = dynamicRoutes.filter(
        (route) => !normalisedDynamicPaths.has(route),
      );

      if (missing.length > 0) {
        throw new Error(
          `The following dynamic-segment routes are wrapped by <ProtectedDashboard> ` +
            `in App.tsx but are missing from DYNAMIC_PROTECTED_ROUTE_PATHS in ` +
            `protected-routes.ts:\n` +
            missing.map((r) => `  ${r}`).join("\n") +
            `\n\nAdd them to DYNAMIC_PROTECTED_ROUTE_PATHS so the e2e sign-out ` +
            `test can verify the auth guard fires before any data fetch.`,
        );
      }
    },
  );
});
