#!/usr/bin/env node
/**
 * sync-vite-optimize-deps.mjs
 *
 * Postinstall hook that automatically adds any newly-installed CJS/ESM hybrid
 * packages to the optimizeDeps.include list in vite.config.ts.
 *
 * This removes the manual fix step — if you install a known CJS/ESM hybrid
 * package, vite.config.ts is patched automatically the next time
 * `pnpm install` runs.
 *
 * The existing lint check (check-vite-optimize-deps.mjs) still confirms the
 * list is correct after the fact.
 *
 * Flags
 * -----
 *   --prune   Also remove stale entries from optimizeDeps.include.
 *             A stale entry is one whose package is no longer installed,
 *             or that is not recognised as a CJS/ESM hybrid by isCjsHybrid.
 *
 * Usage:
 *   node artifacts/print-agent-web/sync-vite-optimize-deps.mjs
 *   node artifacts/print-agent-web/sync-vite-optimize-deps.mjs --prune
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  isCjsHybrid,
  entryToPackageName,
  stripLineComments,
  computeStale,
} from "./vite-hybrid-packages.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const shouldPrune = process.argv.includes("--prune");

// ---------------------------------------------------------------------------
// 1. Parse optimizeDeps.include from vite.config.ts
// ---------------------------------------------------------------------------

const viteConfigPath = join(__dirname, "vite.config.ts");
const viteConfigSource = readFileSync(viteConfigPath, "utf-8");

// Capture everything between "include: [" and the matching closing "]".
// Uses the same regex as check-vite-optimize-deps.mjs for consistency.
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

const includedEntries = [
  ...stripLineComments(includeBlockMatch[1]).matchAll(/["']([^"']+)["']/g),
].map((m) => m[1]);

const includedPackages = new Set(includedEntries);

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
// 4. Find stale entries (only relevant when --prune is passed)
//
// An entry is stale when either:
//   (a) its npm package is no longer present in package.json, OR
//   (b) it is not recognised as a required entry by isCjsHybrid
// ---------------------------------------------------------------------------

const stale = shouldPrune ? computeStale(includedEntries, installedPackages) : [];

// ---------------------------------------------------------------------------
// 5. Short-circuit when nothing to do
// ---------------------------------------------------------------------------

if (missing.length === 0 && stale.length === 0) {
  if (shouldPrune) {
    console.log(
      "✓ optimizeDeps.include is already up to date — nothing to add or prune.",
    );
  } else {
    console.log(
      "✓ optimizeDeps.include is already up to date — nothing to add.",
    );
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 6. Patch vite.config.ts
//
// Strategy:
//   • Build the desired final set of entries: existing entries minus stale
//     ones, plus any newly missing entries appended at the end.
//   • Rebuild the include array in-place, preserving the indentation style
//     detected from the existing content.
//
// The include array in vite.config.ts uses indented string literals, e.g.:
//
//   optimizeDeps: {
//     include: [
//       "react",
//       "@radix-ui/react-dialog",
//     ],
//   },
// ---------------------------------------------------------------------------

const patchRegex =
  /(optimizeDeps\s*:\s*\{[^}]*include\s*:\s*\[)([\s\S]*?)(\])/;

const patchMatch = viteConfigSource.match(patchRegex);

if (!patchMatch) {
  console.error(
    "ERROR: Could not patch vite.config.ts — include array pattern not found.\n" +
      "Please make the following changes manually to optimizeDeps.include:\n" +
      (missing.length > 0
        ? "Add:\n" + missing.map((n) => `  + ${n}`).join("\n")
        : "") +
      (stale.length > 0
        ? "\nRemove:\n" + stale.map((n) => `  - ${n}`).join("\n")
        : ""),
  );
  process.exit(1);
}

const [fullMatch, openPart, contentPart] = patchMatch;

// Determine indentation from the existing content lines (first quoted entry)
const indentMatch = contentPart.match(/\n(\s+)["']/);
const indent = indentMatch ? indentMatch[1] : "      ";

// Closing-bracket indentation: strip two spaces from entry indent (4→2, 6→4)
const closingIndent = indent.length >= 2 ? indent.slice(0, -2) : "";

// Build the pruned entry list (existing entries minus stale ones)
const staleSet = new Set(stale);
const keptEntries = includedEntries.filter((e) => !staleSet.has(e));

// Append newly discovered missing entries at the end
const finalEntries = [...keptEntries, ...missing];

// Reconstruct the array body
const newBody = finalEntries.map((name) => `${indent}"${name}",`).join("\n");

const patched = viteConfigSource.replace(
  fullMatch,
  `${openPart}\n${newBody}\n${closingIndent}]`,
);

writeFileSync(viteConfigPath, patched, "utf-8");

// ---------------------------------------------------------------------------
// 7. Report what changed
// ---------------------------------------------------------------------------

if (missing.length > 0) {
  console.log(
    `✓ Patched vite.config.ts — added ${missing.length} package(s) to optimizeDeps.include:`,
  );
  for (const name of missing) {
    console.log(`  + ${name}`);
  }
}

if (stale.length > 0) {
  console.log(
    `✓ Patched vite.config.ts — pruned ${stale.length} stale entry/entries from optimizeDeps.include:`,
  );
  for (const name of stale) {
    console.log(`  - ${name}`);
  }
}
