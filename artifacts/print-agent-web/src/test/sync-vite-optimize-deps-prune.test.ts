/**
 * Unit tests for the --prune logic in sync-vite-optimize-deps.mjs.
 *
 * The prune computation is a pure function (`computeStale`) exported from
 * vite-hybrid-packages.mjs and used by the script.  Testing it here avoids
 * any filesystem or process.exit side-effects while still covering every
 * meaningful branch of the prune path.
 *
 * Three cases are tested:
 *   1. Stale-by-uninstall   — entry's package is absent from package.json.
 *   2. Stale-by-no-longer-hybrid — package is installed but isCjsHybrid
 *                                   returns false for the entry.
 *   3. No-op                — every included entry is installed AND hybrid;
 *                             the stale list must be empty.
 */

import { describe, it, expect } from "vitest";
import { computeStale } from "../../vite-hybrid-packages.mjs";

describe("computeStale (--prune logic)", () => {
  it("flags an entry whose package is no longer in package.json (stale-by-uninstall)", () => {
    const includedEntries = ["react", "react-dom", "old-removed-lib"];
    const installedPackages = new Set(["react", "react-dom"]);

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toEqual(["old-removed-lib"]);
  });

  it("flags an entry that is installed but is no longer recognised as a hybrid (stale-by-not-hybrid)", () => {
    const includedEntries = ["react", "some-pure-esm-package"];
    const installedPackages = new Set(["react", "some-pure-esm-package"]);

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toEqual(["some-pure-esm-package"]);
  });

  it("returns an empty array when every entry is both installed and a known hybrid (no-op)", () => {
    const includedEntries = ["react", "react-dom", "react/jsx-runtime"];
    const installedPackages = new Set([
      "react",
      "react-dom",
    ]);

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toHaveLength(0);
  });

  it("handles sub-path entries correctly: maps entry to its package for the install check", () => {
    const includedEntries = ["react/jsx-runtime"];
    const installedPackages = new Set<string>();

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toEqual(["react/jsx-runtime"]);
  });

  it("handles sub-path entries correctly: does not flag when package IS installed and entry IS hybrid", () => {
    const includedEntries = ["react/jsx-runtime"];
    const installedPackages = new Set(["react"]);

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toHaveLength(0);
  });

  it("flags a scoped @radix-ui entry whose package was uninstalled", () => {
    const includedEntries = [
      "react",
      "@radix-ui/react-dialog",
    ];
    const installedPackages = new Set(["react"]);

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toEqual(["@radix-ui/react-dialog"]);
  });

  it("does not flag a scoped @radix-ui entry that is still installed", () => {
    const includedEntries = ["@radix-ui/react-dialog"];
    const installedPackages = new Set(["@radix-ui/react-dialog"]);

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toHaveLength(0);
  });

  it("returns all entries as stale when both installed set and hybrid list are empty", () => {
    const includedEntries = ["old-pkg-a", "old-pkg-b"];
    const installedPackages = new Set<string>();

    const stale = computeStale(includedEntries, installedPackages);

    expect(stale).toEqual(["old-pkg-a", "old-pkg-b"]);
  });

  it("returns an empty array when includedEntries is empty", () => {
    const stale = computeStale([], new Set(["react"]));

    expect(stale).toHaveLength(0);
  });
});
