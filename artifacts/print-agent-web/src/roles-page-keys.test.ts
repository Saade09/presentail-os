/**
 * Verifies that every hardcoded page key used in the Roles.tsx checkbox list
 * is registered in ALL_PAGES or SUB_PERMISSION_LABELS from @workspace/page-keys.
 *
 * The test covers two patterns:
 *
 * 1. Hardcoded string literal data-testid attributes of the form:
 *      data-testid="checkbox-page-{key}"
 *    These appear when a developer bypasses the PERMISSION_GROUPS loop.
 *
 * 2. Literal key values inside the PERMISSION_GROUPS constant:
 *      { key: "some-page-key", ... }
 *    This is the primary source of page keys in the new grouped-permissions
 *    editor.  Template-literal testids (`checkbox-page-${page.key}`) are
 *    derived from these at runtime, so they are validated here instead.
 *
 * Both patterns must reference only keys that exist in ALL_PAGES or
 * SUB_PERMISSION_LABELS from lib/page-keys/src/index.ts.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";
import {
  ALL_PAGES,
  CMC_POS_DASHBOARD_PAGE_KEY,
  CMC_POS_NEW_ORDER_PAGE_KEY,
  INVOICE_SCANNERS_PAGE_KEY,
  SUB_PERMISSION_LABELS,
} from "@workspace/page-keys";
import { PERMISSION_GROUPS } from "./pages/dashboard/permission-groups";

const ROLES_TSX_PATH = resolve(__dirname, "pages/dashboard/Roles.tsx");
const PERMISSION_GROUPS_PATH = resolve(__dirname, "pages/dashboard/permission-groups.ts");
const APP_TSX_PATH = resolve(__dirname, "App.tsx");

/**
 * Extracts hardcoded page keys from Roles.tsx by scanning for:
 *  1. String-literal data-testid attributes: data-testid="checkbox-page-{key}"
 *  2. Literal `key: "..."` entries inside PERMISSION_GROUPS
 *
 * Returns the extracted key strings.
 */
function extractHardcodedPageKeys(): string[] {
  const rolesSource = readFileSync(ROLES_TSX_PATH, "utf-8");

  const keys: string[] = [];

  // Pattern 1: hardcoded data-testid string literals (old style, in Roles.tsx)
  const testidPattern = /data-testid="checkbox-page-([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = testidPattern.exec(rolesSource)) !== null) {
    keys.push(match[1]);
  }

  // Pattern 2: literal key values inside PERMISSION_GROUPS (new grouped-editor style).
  // PERMISSION_GROUPS may be defined inline in Roles.tsx or extracted to
  // permission-groups.ts — scan both sources.
  const sourcesToScan: string[] = [rolesSource];
  try {
    sourcesToScan.push(readFileSync(PERMISSION_GROUPS_PATH, "utf-8"));
  } catch {
    // file may not exist in some environments; fall back to Roles.tsx only
  }

  for (const source of sourcesToScan) {
    // Matches `key: "some-page-key"` inside the PERMISSION_GROUPS constant.
    // We scope this to the region between "const PERMISSION_GROUPS" and the
    // closing "];" of that constant so we don't accidentally pick up other keys.
    const groupsStart = source.indexOf("const PERMISSION_GROUPS");
    const groupsEnd = source.indexOf("];\n", groupsStart);
    if (groupsStart !== -1 && groupsEnd !== -1) {
      const groupsSource = source.slice(groupsStart, groupsEnd);
      const keyPattern = /\bkey:\s*"([^"]+)"/g;
      let km: RegExpExecArray | null;
      while ((km = keyPattern.exec(groupsSource)) !== null) {
        keys.push(km[1]);
      }
    }
  }

  return [...new Set(keys)];
}

const ALL_PAGE_KEYS = new Set(ALL_PAGES.map((p) => p.key));
const ALL_SUB_KEYS = new Set(Object.keys(SUB_PERMISSION_LABELS));

describe("Roles page checkbox key coverage", () => {
  it("every hardcoded checkbox-page key in Roles.tsx is registered in @workspace/page-keys", () => {
    const hardcodedKeys = extractHardcodedPageKeys();

    // We must find at least one key (either from PERMISSION_GROUPS or testids).
    expect(hardcodedKeys.length).toBeGreaterThan(0);

    const unregistered = hardcodedKeys.filter(
      (key) => !ALL_PAGE_KEYS.has(key) && !ALL_SUB_KEYS.has(key),
    );

    if (unregistered.length > 0) {
      throw new Error(
        `The following page keys are used in Roles.tsx checkboxes but are ` +
          `not registered in lib/page-keys/src/index.ts:\n` +
          unregistered.map((k) => `  "${k}"`).join("\n") +
          `\n\nAdd each key to ALL_PAGES (top-level page) or ` +
          `SUB_PERMISSION_LABELS (sub-permission) in lib/page-keys/src/index.ts.`,
      );
    }
  });

  it("ALL_PAGES from @workspace/page-keys is non-empty", () => {
    expect(ALL_PAGES.length).toBeGreaterThan(0);
  });

  it("exposes Ops Dashboard as a distinct role permission", () => {
    expect(ALL_PAGES).toContainEqual({
      key: "ops-dashboard",
      label: "Ops Dashboard",
    });
    expect(extractHardcodedPageKeys()).toContain("ops-dashboard");
  });

  it("exposes CMC Dashboard and New Order as distinct role permissions", () => {
    expect(ALL_PAGES).toContainEqual({
      key: "cmc-pos-dashboard",
      label: "CMC POS Dashboard",
    });
    expect(ALL_PAGES).toContainEqual({
      key: "cmc-pos-new-order",
      label: "CMC POS New Order",
    });
    const cmcPages = PERMISSION_GROUPS.find((group) => group.id === "cmc-pos")?.pages ?? [];
    expect(cmcPages.map((page) => page.key)).toContain(CMC_POS_DASHBOARD_PAGE_KEY);
    expect(cmcPages.map((page) => page.key)).toContain(CMC_POS_NEW_ORDER_PAGE_KEY);
  });

  it("exposes Invoice Scanners as an independent role permission", () => {
    expect(ALL_PAGES).toContainEqual({
      key: INVOICE_SCANNERS_PAGE_KEY,
      label: "Invoice Scanners",
    });
    const corePages = PERMISSION_GROUPS.find((group) => group.id === "core")?.pages ?? [];
    expect(corePages.map((page) => page.key)).toContain(INVOICE_SCANNERS_PAGE_KEY);
  });

  it("guards each direct CMC page route with its matching permission", () => {
    const appSource = readFileSync(APP_TSX_PATH, "utf-8");
    expect(appSource).toMatch(
      /<Route path="\/cmc-pos\/new-order">[\s\S]*?<PageGuard page="cmc-pos-new-order" matchFn=\{hasCmcPosNewOrderAccess\}>/,
    );
    expect(appSource).toMatch(
      /<Route path="\/cmc-pos">[\s\S]*?<PageGuard page="cmc-pos-dashboard" matchFn=\{hasCmcPosDashboardAccess\}>/,
    );
  });

  it("guards the Invoice Scanners route with its independent permission", () => {
    const appSource = readFileSync(APP_TSX_PATH, "utf-8");
    expect(appSource).toMatch(
      /<Route path="\/settings\/devices\/scanners">[\s\S]*?<PageGuard page="invoice-scanners">/,
    );
  });
});
