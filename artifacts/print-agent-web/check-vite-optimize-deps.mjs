#!/usr/bin/env node
/**
 * check-vite-optimize-deps.mjs
 *
 * Cross-references the packages installed in package.json against the
 * optimizeDeps.include list in vite.config.ts.
 *
 * Vite pre-bundles packages listed in optimizeDeps.include so that every
 * dependency shares a single copy of React.  Packages that ship both a CJS
 * entry AND an ESM entry (so-called "CJS/ESM hybrids") MUST be listed there;
 * without an entry, Vite may load multiple copies of React at runtime, which
 * triggers the "duplicate React" invariant violation and produces a blank page.
 *
 * Known offenders
 * ---------------
 * All @radix-ui/* packages, cmdk, vaul, input-otp, embla-carousel-react,
 * recharts, react-day-picker, sonner, framer-motion, and
 * react-resizable-panels are confirmed CJS/ESM hybrids.  This list is encoded
 * in vite-hybrid-packages.mjs.  When a new package in that set is installed,
 * this script will immediately flag it so the developer knows to add it to
 * optimizeDeps.include.
 *
 * Stale entry detection
 * ---------------------
 * This script also reports entries already in optimizeDeps.include that are
 * stale — meaning the package is no longer installed, or it is not recognised
 * as a CJS/ESM hybrid (or otherwise required entry) by isCjsHybrid.  Stale
 * entries slow down Vite's pre-bundling step needlessly.
 *
 * Fix
 * ---
 * If this script fails, open artifacts/print-agent-web/vite.config.ts and
 * add/remove the flagged package name(s) from the optimizeDeps.include array.
 * Alternatively run sync-vite-optimize-deps.mjs --prune to auto-fix both
 * missing additions and stale removals.
 *
 * Usage: node artifacts/print-agent-web/check-vite-optimize-deps.mjs
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  isCjsHybrid,
  entryToPackageName,
  stripLineComments,
} from "./vite-hybrid-packages.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. Parse optimizeDeps.include from vite.config.ts
// ---------------------------------------------------------------------------

const viteConfigPath = join(__dirname, "vite.config.ts");
const viteConfigSource = readFileSync(viteConfigPath, "utf-8");

// Capture everything between "include: [" and the matching closing "]".
// The config always uses string literals on separate lines inside that array.
const includeBlockMatch = viteConfigSource.match(
  /optimizeDeps\s*:\s*\{[^}]*include\s*:\s*\[([\s\S]*?)\]/,
);

if (!includeBlockMatch) {
  console.error(
    "ERROR: Could not locate optimizeDeps.include in vite.config.ts.\n" +
      "Ensure the array exists and is formatted consistently.",
  );
  process.exit(1);
}

const includedPackages = new Set(
  [...stripLineComments(includeBlockMatch[1]).matchAll(/["']([^"']+)["']/g)].map(
    (m) => m[1],
  ),
);

// ---------------------------------------------------------------------------
// 2. Collect all installed packages from package.json
// ---------------------------------------------------------------------------

const pkgPath = join(__dirname, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const installedPackages = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

// ---------------------------------------------------------------------------
// 3. Find installed hybrid packages that are missing from optimizeDeps.include
//    (isCjsHybrid is imported from vite-hybrid-packages.mjs)
// ---------------------------------------------------------------------------

const missing = [...installedPackages]
  .filter((name) => isCjsHybrid(name) && !includedPackages.has(name))
  .sort();

// ---------------------------------------------------------------------------
// 4. Find stale entries in optimizeDeps.include
//
// An entry is stale when either:
//   (a) its npm package is no longer present in package.json, OR
//   (b) it is not recognised as a required entry by isCjsHybrid
//
// entryToPackageName resolves sub-path imports (e.g. "react/jsx-runtime" →
// "react") so the installed-packages check works correctly for those.
// ---------------------------------------------------------------------------

const stale = [...includedPackages]
  .filter((entry) => {
    const pkgName = entryToPackageName(entry);
    const notInstalled = !installedPackages.has(pkgName);
    const notHybrid = !isCjsHybrid(entry);
    return notInstalled || notHybrid;
  })
  .sort();

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------

let exitCode = 0;

if (missing.length === 0 && stale.length === 0) {
  console.log(
    "✓ optimizeDeps.include is correct — no missing or stale entries.",
  );
  process.exit(0);
}

if (missing.length > 0) {
  exitCode = 1;
  console.error(
    `\nERROR: The following installed package(s) ship CJS/ESM hybrid bundles but are\n` +
      `missing from the optimizeDeps.include list in vite.config.ts.\n\n` +
      `Without an entry in that list, Vite may load multiple copies of React at\n` +
      `runtime and produce a blank page.\n\n` +
      `Fix: open artifacts/print-agent-web/vite.config.ts and add each package\n` +
      `below to the optimizeDeps.include array, or run:\n` +
      `  node artifacts/print-agent-web/sync-vite-optimize-deps.mjs\n\n` +
      `Missing package(s):\n`,
  );
  for (const name of missing) {
    console.error(`  • ${name}`);
  }
  console.error();
}

if (stale.length > 0) {
  exitCode = 1;
  console.error(
    `\nERROR: The following entry/entries in optimizeDeps.include are stale.\n` +
      `A stale entry is one whose package is no longer installed, or that is not\n` +
      `recognised as a CJS/ESM hybrid (or otherwise required entry).\n\n` +
      `Stale entries slow down Vite's pre-bundling step needlessly.\n\n` +
      `Fix: remove each entry below from optimizeDeps.include in\n` +
      `artifacts/print-agent-web/vite.config.ts, or run:\n` +
      `  node artifacts/print-agent-web/sync-vite-optimize-deps.mjs --prune\n\n` +
      `Stale entry/entries:\n`,
  );
  for (const entry of stale) {
    const pkgName = entryToPackageName(entry);
    const notInstalled = !installedPackages.has(pkgName);
    const notHybrid = !isCjsHybrid(entry);
    const reasons = [];
    if (notInstalled) reasons.push("not installed");
    if (notHybrid) reasons.push("not a recognised hybrid");
    console.error(`  • ${entry}  (${reasons.join(", ")})`);
  }
  console.error();
}

process.exit(exitCode);
