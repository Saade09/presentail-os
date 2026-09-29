const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const workspaceRoot = process.env.METRO_TEST_WORKSPACE_ROOT
  ? path.resolve(process.env.METRO_TEST_WORKSPACE_ROOT)
  : path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.server = {
  ...config.server,
  host: "127.0.0.1",
};

const libDir = process.env.METRO_TEST_LIB_DIR
  ? path.resolve(process.env.METRO_TEST_LIB_DIR)
  : path.join(workspaceRoot, "lib");
const libPackageDirs = fs.existsSync(libDir)
  ? fs
      .readdirSync(libDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(libDir, entry.name))
  : [];
const libNodeModulesPaths = libPackageDirs
  .map((p) => path.join(p, "node_modules"))
  .filter((p) => fs.existsSync(p));

// During production builds, Metro must be able to serve bundle files from the
// pnpm virtual store (.pnpm/). Metro only serves files that are inside a
// watchFolder, so we add .pnpm here. Expo Launch invokes `expo export:embed`
// directly and does not pass the artifact's eas.json env block, so detect
// that export from NODE_ENV/argv as well as the explicit build.js flag.
// Development workflows omit this so three concurrent Metro instances don't
// exhaust the 65536 inotify watcher limit.
const pnpmStoreDir = path.join(workspaceRoot, "node_modules", ".pnpm");
const isProductionExport =
  process.env.METRO_WATCH_PNPM === "1" ||
  process.env.NODE_ENV === "production" ||
  process.argv.some((arg) => arg === "export:embed" || arg.endsWith("/export:embed"));
const extraWatchFolders =
  isProductionExport && fs.existsSync(pnpmStoreDir)
    ? [pnpmStoreDir]
    : [];

config.watchFolders = [
  projectRoot,
  libDir,
  ...libPackageDirs,
  ...extraWatchFolders,
];

config.resolver = {
  ...config.resolver,
  unstable_enableSymlinks: true,
  nodeModulesPaths: [
    path.join(projectRoot, "node_modules"),
    path.join(workspaceRoot, "node_modules"),
    path.join(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
    ...libNodeModulesPaths,
  ],
  resolveRequest: (context, moduleName, platform) => {
    // Force a SINGLE copy of React, React Native, Expo, and Expo Modules Core
    // bundle-wide. The pnpm virtual store's
    // hoisted directory (node_modules/.pnpm/node_modules) can hold a
    // DIFFERENT react version than the app's own (e.g. react@19.2.7 hoisted
    // vs react@19.1.0 here). Packages without their own react link (e.g.
    // @expo-google-fonts/inter) resolve react by walking up from their real
    // path in the store and land on the hoisted copy. In dev that copy is
    // outside Metro's watchFolders so resolution falls through to the app's
    // react and everything works; in production builds METRO_WATCH_PNPM=1
    // adds .pnpm to watchFolders, the hoisted copy becomes resolvable, and
    // the bundle ships TWO reacts — crashing at startup with
    // "Cannot read property 'useState' of null" (null hook dispatcher).
    // Redirecting all react imports to the app's own copy removes the
    // dev/prod divergence entirely.
    //
    // The same applies to @tanstack/react-query: lib/api-client-react links a
    // DIFFERENT pnpm peer-variant (…react-query@X_react@19.2.7) than the app
    // (…_react@19.1.0). Two react-query module instances mean the generated
    // hooks read a different context than the app's QueryClientProvider
    // writes, so every query silently never runs (blank screen in release).
    // Native Expo view packages use requireNativeViewManager from
    // expo-modules-core, which in turn registers views through React Native.
    // If Metro bundles peer variants from different .pnpm paths, native views
    // register in one JS registry while the renderer reads another. Release
    // builds then fail on first render with errors such as
    // "View config getter callback ... must be a function (received undefined)"
    // for otherwise valid views (ExpoAppleAuthentication, ExpoBlurView, etc.).
    //
    // @tanstack/query-core is pinned alongside react-query (resolved from the app's
    // react-query package) so the QueryClient and the hooks share one core.
    if (moduleName === "react" || moduleName.startsWith("react/")) {
      return context.resolveRequest(
        { ...context, originModulePath: path.join(projectRoot, "package.json") },
        moduleName,
        platform
      );
    }
    if (
      moduleName === "react-native" ||
      moduleName.startsWith("react-native/")
    ) {
      return context.resolveRequest(
        { ...context, originModulePath: path.join(projectRoot, "package.json") },
        moduleName,
        platform
      );
    }
    if (moduleName === "expo" || moduleName.startsWith("expo/")) {
      return context.resolveRequest(
        { ...context, originModulePath: path.join(projectRoot, "package.json") },
        moduleName,
        platform
      );
    }
    if (
      moduleName === "expo-modules-core" ||
      moduleName.startsWith("expo-modules-core/")
    ) {
      try {
        const appExpoPkg = require.resolve("expo/package.json", {
          paths: [projectRoot],
        });
        return context.resolveRequest(
          { ...context, originModulePath: appExpoPkg },
          moduleName,
          platform
        );
      } catch {
        // fall through to default resolution below
      }
    }
    if (
      moduleName === "@tanstack/react-query" ||
      moduleName.startsWith("@tanstack/react-query/")
    ) {
      return context.resolveRequest(
        { ...context, originModulePath: path.join(projectRoot, "package.json") },
        moduleName,
        platform
      );
    }
    if (
      moduleName === "@tanstack/query-core" ||
      moduleName.startsWith("@tanstack/query-core/")
    ) {
      // Resolve query-core relative to the app's react-query copy so the
      // exact dependency version of that copy wins.
      try {
        const appReactQueryPkg = require.resolve(
          "@tanstack/react-query/package.json",
          { paths: [projectRoot] }
        );
        return context.resolveRequest(
          { ...context, originModulePath: appReactQueryPkg },
          moduleName,
          platform
        );
      } catch {
        // fall through to default resolution below
      }
    }
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch (defaultError) {
      if (!fs.existsSync(libDir)) throw defaultError;
      let entries;
      try {
        entries = fs.readdirSync(libDir, { withFileTypes: true });
      } catch {
        throw defaultError;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nodeModulesPath = path.join(libDir, entry.name, "node_modules");
        if (
          !context.nodeModulesPaths.includes(nodeModulesPath) &&
          fs.existsSync(nodeModulesPath)
        ) {
          try {
            return context.resolveRequest(
              {
                ...context,
                nodeModulesPaths: [
                  ...context.nodeModulesPaths,
                  nodeModulesPath,
                ],
              },
              moduleName,
              platform
            );
          } catch {
          }
        }
      }
      throw defaultError;
    }
  },
};

// Watch lib/ for package directory additions and removals while Metro is
// running.  Metro holds references to these arrays, so in-place mutations
// propagate to the running bundler without a restart.
//
// Addition: when a new lib/<pkg> directory appears, push it into
// watchFolders and its node_modules into nodeModulesPaths.
//
// Removal: when a lib/<pkg> directory is deleted, splice the stale entries
// out of both arrays so Metro stops watching a path that no longer exists.
//
// Lib-dir deletion: when lib/ itself is removed, a watcher on workspaceRoot
// detects the rename event, closes the (now-dead) lib watcher, and prunes
// every lib-originated entry from both arrays so stale paths do not linger.
//
// Workspace-root move/rename: a watcher on the parent of workspaceRoot
// detects when workspaceRoot itself disappears and closes all open watchers
// so they do not linger silently without receiving events.
let libWatcher = null;
let workspaceRootWatcher = null;
let parentWatcher = null;

if (fs.existsSync(libDir)) {
  const libDebounceTimers = new Map(); // pkgDir → timer
  libWatcher = fs.watch(libDir, (eventType, filename) => {
    if (!filename) return;
    if (filename.startsWith(".")) return;
    const pkgDir = path.join(libDir, filename);
    const nodeModulesPath = path.join(pkgDir, "node_modules");

    // Debounce addition: tests create and immediately delete temp directories.
    // If the directory still exists after 150 ms, it's real and we add it.
    const existing = libDebounceTimers.get(pkgDir);
    if (existing) clearTimeout(existing);
    libDebounceTimers.set(
      pkgDir,
      setTimeout(() => {
        libDebounceTimers.delete(pkgDir);
        let stat;
        try {
          stat = fs.statSync(pkgDir);
        } catch {
          // Directory no longer exists — prune stale entries.
          const wfIdx = config.watchFolders.indexOf(pkgDir);
          if (wfIdx !== -1) config.watchFolders.splice(wfIdx, 1);
          const nmIdx = config.resolver.nodeModulesPaths.indexOf(nodeModulesPath);
          if (nmIdx !== -1) config.resolver.nodeModulesPaths.splice(nmIdx, 1);
          return;
        }
        if (!stat.isDirectory()) return;
        if (!config.watchFolders.includes(pkgDir)) {
          config.watchFolders.push(pkgDir);
        }
        if (
          fs.existsSync(nodeModulesPath) &&
          !config.resolver.nodeModulesPaths.includes(nodeModulesPath)
        ) {
          config.resolver.nodeModulesPaths.push(nodeModulesPath);
        }
      }, 150),
    );
  });
}

// Watch the workspace root to detect deletion of the entire lib/ directory.
// When lib/ disappears, close the (now-dead) lib watcher and prune every
// lib-originated entry from both config arrays in reverse-index order.
workspaceRootWatcher = fs.watch(workspaceRoot, (eventType, filename) => {
  if (filename !== "lib") return;
  if (fs.existsSync(libDir)) return; // lib/ is still present — ignore
  if (libWatcher) {
    try {
      libWatcher.close();
    } catch {
      // ignore
    }
    libWatcher = null;
  }
  const libPrefix = libDir + path.sep;
  // Prune all lib-originated entries from watchFolders (reverse order).
  let i = config.watchFolders.length;
  while (i--) {
    const entry = config.watchFolders[i];
    if (entry === libDir || entry.startsWith(libPrefix)) {
      config.watchFolders.splice(i, 1);
    }
  }
  // Prune all lib-originated entries from nodeModulesPaths (reverse order).
  let j = config.resolver.nodeModulesPaths.length;
  while (j--) {
    if (config.resolver.nodeModulesPaths[j].startsWith(libPrefix)) {
      config.resolver.nodeModulesPaths.splice(j, 1);
    }
  }
});

// Watch the parent of workspaceRoot to detect if workspaceRoot itself is
// moved or renamed (e.g. during a monorepo restructure).  When workspaceRoot
// disappears the libWatcher and workspaceRootWatcher would silently stop
// receiving events; closing them here prevents stale handles from lingering.
const workspaceParentDir = path.dirname(workspaceRoot);
const workspaceBasename = path.basename(workspaceRoot);

try {
  parentWatcher = fs.watch(workspaceParentDir, (eventType, filename) => {
    if (filename !== workspaceBasename) return;
    if (fs.existsSync(workspaceRoot)) return; // still present — ignore
    // workspaceRoot is gone — close all open watchers.
    if (libWatcher) {
      try {
        libWatcher.close();
      } catch {
        // ignore
      }
      libWatcher = null;
    }
    if (workspaceRootWatcher) {
      try {
        workspaceRootWatcher.close();
      } catch {
        // ignore
      }
      workspaceRootWatcher = null;
    }
    if (parentWatcher) {
      try {
        parentWatcher.close();
      } catch {
        // ignore
      }
      parentWatcher = null;
    }
  });
} catch {
  // Parent directory may not be watchable (e.g. filesystem restrictions).
}

// Expose watcher handles for test inspection only — not part of the public API.
Object.defineProperty(config, "_getWatchers", {
  get: () => ({ libWatcher, workspaceRootWatcher, parentWatcher }),
  enumerable: false,
  configurable: true,
});

module.exports = config;
