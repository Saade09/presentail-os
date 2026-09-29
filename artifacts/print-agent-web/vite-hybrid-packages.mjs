/**
 * vite-hybrid-packages.mjs
 *
 * Single source of truth for the known CJS/ESM hybrid packages that must be
 * listed in vite.config.ts's optimizeDeps.include.
 *
 * A package belongs here when:
 *   • its dist/ ships a .cjs (or .js) file alongside a .mjs file, OR
 *   • it uses a conditional "require" export that returns CJS, OR
 *   • it must be pre-bundled so Vite deduplicates a single copy of React.
 *
 * Both sync-vite-optimize-deps.mjs and check-vite-optimize-deps.mjs import
 * from here.  Add new hybrids in this one file only.
 */

export const knownHybrids = new Set([
  // Core React packages — ship CJS alongside ESM and must be pre-bundled so
  // Vite always resolves a single copy of React across the entire bundle.
  "react",
  "react-dom",
  "react/jsx-runtime",
  // Clerk client-side packages — must be pre-bundled to avoid duplicate React.
  // Note: @clerk/backend and @clerk/testing are server/test packages and must
  // NOT be included here.
  "@clerk/react",
  "@clerk/themes",
  // UI component hybrids
  "cmdk",
  "vaul",
  "input-otp",
  "embla-carousel-react",
  "recharts",
  "react-day-picker",
  "sonner",
  "framer-motion",
  "react-resizable-panels",
]);

/**
 * Returns true when the given package name (or sub-path import) is a known
 * CJS/ESM hybrid that must be pre-bundled by Vite, or is otherwise required
 * in optimizeDeps.include to ensure a single copy of React.
 *
 * @param {string} name  Full entry string from optimizeDeps.include,
 *                       e.g. "react/jsx-runtime" or "@radix-ui/react-dialog".
 * @returns {boolean}
 */
export function isCjsHybrid(name) {
  // All @radix-ui/* packages are hybrids
  if (name.startsWith("@radix-ui/")) return true;
  return knownHybrids.has(name);
}

/**
 * Strips single-line (//) comments from a block of source text so that
 * quoted strings inside comments are not accidentally treated as package names.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const commentIdx = line.indexOf("//");
      return commentIdx === -1 ? line : line.slice(0, commentIdx);
    })
    .join("\n");
}

/**
 * Resolves a vite optimizeDeps entry to the npm package name that would
 * appear in package.json.  Handles sub-path imports such as
 * "react/jsx-runtime" → "react" and scoped packages like
 * "@radix-ui/react-dialog" → "@radix-ui/react-dialog".
 *
 * @param {string} entry
 * @returns {string}
 */
export function entryToPackageName(entry) {
  if (entry.startsWith("@")) {
    // Scoped: @scope/name or @scope/name/subpath → @scope/name
    const parts = entry.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : entry;
  }
  // Unscoped: name or name/subpath → name
  return entry.split("/")[0];
}

/**
 * Returns the subset of `includedEntries` that are stale and should be pruned
 * from optimizeDeps.include.  An entry is stale when either:
 *   (a) its npm package is no longer present in `installedPackages`, OR
 *   (b) it is not recognised as a required entry by isCjsHybrid.
 *
 * This is the pure computation that sync-vite-optimize-deps.mjs applies when
 * the --prune flag is passed, extracted here so it can be unit-tested without
 * touching the filesystem.
 *
 * @param {string[]} includedEntries  Current entries in optimizeDeps.include.
 * @param {Set<string>} installedPackages  Package names from package.json.
 * @returns {string[]}  Entries that should be removed.
 */
export function computeStale(includedEntries, installedPackages) {
  return includedEntries.filter((entry) => {
    const pkgName = entryToPackageName(entry);
    const notInstalled = !installedPackages.has(pkgName);
    const notHybrid = !isCjsHybrid(entry);
    return notInstalled || notHybrid;
  });
}
