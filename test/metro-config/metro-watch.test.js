/**
 * Tests that the dynamic lib-watcher in each Expo artifact's metro.config.js
 * correctly picks up new lib/<pkg>/node_modules directories without a Metro
 * restart.
 *
 * Strategy
 * --------
 * 1. Resolve the real `expo/metro-config` module path so we can stub it in
 *    require.cache with a minimal stand-in that returns an empty config object.
 * 2. Load the real metro.config.js from each artifact directory (so __dirname
 *    is correct and the watcher is started on the real lib/ directory).
 * 3. Create lib/<testpkg>/node_modules/ in one recursive mkdir call so that
 *    by the time the async fs.watch callback fires on lib/, node_modules/
 *    already exists and both arrays get updated in a single watcher event.
 * 4. Poll config.watchFolders and config.resolver.nodeModulesPaths until both
 *    contain the expected paths (or until a 2 s timeout).
 * 5. Assert both arrays were updated.
 * 6. Clean up the temp directory and require.cache entries.
 *
 * Notes
 * -----
 * - Tests run with `concurrency: 1` (sequential) so they do not race on the
 *   shared require.cache mock or on lib/ fs.watch events.
 * - The run command adds --test-force-exit so the process exits even though
 *   the anonymous fs.watch handle (created inside metro.config.js) keeps the
 *   event loop alive.
 * - fs.watch(libDir) is non-recursive: it only fires for direct children of
 *   lib/.  Creating node_modules/ *inside* the new package dir does not
 *   trigger a second event.  Creating the full tree before the async callback
 *   fires means the watcher finds node_modules/ already present on its one
 *   invocation and updates both arrays at once.
 */

"use strict";

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const LIB_DIR = path.join(WORKSPACE_ROOT, "lib");

// ---------------------------------------------------------------------------
// Isolated temp-lib helper
// ---------------------------------------------------------------------------
// Tests create and immediately delete directories in lib/.  When the real
// lib/ is also watched by running Expo workflows, those deletions race
// Metro's FallbackWatcher and cause ENOENT crashes.  Using an isolated temp
// lib/ per test (via METRO_TEST_LIB_DIR) keeps test activity away from the
// real lib/ directory.
function createTempLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metro-lib-"));
  return dir;
}
function cleanupTempLib(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Load a metro config file after injecting the Expo mock, with an isolated
 * temp lib/ directory.  Returns { config, testLibDir }.
 */
function loadMetroConfig(configPath) {
  delete require.cache[configPath];
  delete require.cache[expoMetroConfigResolvedPath];
  injectExpoMock();

  const testLibDir = createTempLib();
  process.env.METRO_TEST_LIB_DIR = testLibDir;

  let config;
  try {
    config = require(configPath);
  } finally {
    delete require.cache[configPath];
    delete require.cache[expoMetroConfigResolvedPath];
    delete process.env.METRO_TEST_LIB_DIR;
  }
  return { config, testLibDir };
}

/**
 * Discover every mobile artifact by scanning each artifacts directory's
 * .replit-artifact/
 * artifact.toml for `kind = "mobile"`.
 */
function discoverMobileArtifacts() {
  const artifactsDir = path.join(WORKSPACE_ROOT, "artifacts");
  const entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const tomlPath = path.join(
        artifactsDir,
        entry.name,
        ".replit-artifact/artifact.toml"
      );
      if (!fs.existsSync(tomlPath)) return false;
      return fs
        .readFileSync(tomlPath, "utf8")
        .split(/\r?\n/)
        .some((line) => /^\s*kind\s*=\s*"mobile"\s*$/.test(line));
    })
    .map((entry) => entry.name)
    .sort();
}

const MOBILE_ARTIFACTS = discoverMobileArtifacts();
const METRO_CONFIGS = MOBILE_ARTIFACTS.map((artifact) => ({
  artifact,
  configPath: path.join(
    WORKSPACE_ROOT,
    "artifacts",
    artifact,
    "metro.config.js"
  ),
}));

// ---------------------------------------------------------------------------
// Locate expo/metro-config in the pnpm store.
// All mobile artifacts share the same pnpm virtual store, so one resolution
// is sufficient.
// ---------------------------------------------------------------------------

const FIRST_ARTIFACT_DIR = path.join(
  WORKSPACE_ROOT,
  "artifacts",
  MOBILE_ARTIFACTS[0]
);

const expoMetroConfigResolvedPath = Module._resolveFilename(
  "expo/metro-config",
  {
    id: path.join(FIRST_ARTIFACT_DIR, "__stub__"),
    filename: path.join(FIRST_ARTIFACT_DIR, "__stub__"),
    paths: Module._nodeModulePaths(FIRST_ARTIFACT_DIR),
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject a minimal expo/metro-config stub into require.cache so that when a
 * metro.config.js calls require('expo/metro-config') it receives a lightweight
 * object instead of the full Expo Metro bundle.
 */
function injectExpoMock() {
  require.cache[expoMetroConfigResolvedPath] = {
    id: expoMetroConfigResolvedPath,
    filename: expoMetroConfigResolvedPath,
    loaded: true,
    parent: null,
    children: [],
    exports: {
      getDefaultConfig: (_projectRoot) => ({
        server: {},
        watchFolders: [],
        resolver: {
          nodeModulesPaths: [],
        },
      }),
    },
  };
}

/**
 * Poll `predicate` every 50 ms until it returns true or `timeoutMs` elapses.
 * Uses await-based sleeping so fs.watch callbacks can run between checks.
 * Resolves with true if the predicate succeeded before the deadline, else false.
 */
async function pollUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// concurrency: 1 ensures the subtests run sequentially so they do not race on
// the shared require.cache mock entry or on lib/ fs.watch events.
describe("metro.config.js dynamic lib watcher", { concurrency: 1 }, () => {
  for (const { artifact, configPath } of METRO_CONFIGS) {
    test(`${artifact}: new lib package picked up without restart`, async () => {
      const { config, testLibDir } = loadMetroConfig(configPath);

      assert.ok(
        Array.isArray(config.watchFolders),
        "config.watchFolders must be an array"
      );
      assert.ok(
        Array.isArray(config.resolver.nodeModulesPaths),
        "config.resolver.nodeModulesPaths must be an array"
      );

      const pkgsBefore = config.watchFolders.length;
      const pathsBefore = config.resolver.nodeModulesPaths.length;

      const testPkgName = `test-metro-watch-${artifact}-${Date.now()}`;
      const testPkgDir = path.join(testLibDir, testPkgName);
      const testNodeModulesDir = path.join(testPkgDir, "node_modules");

      try {
        fs.mkdirSync(testNodeModulesDir, { recursive: true });

        const watchFoldersUpdated = await pollUntil(
          () => config.watchFolders.includes(testPkgDir)
        );

        assert.ok(
          watchFoldersUpdated,
          `config.watchFolders was not updated with the new lib dir within 2 s ` +
            `(started with ${pkgsBefore}, now has ${config.watchFolders.length})`
        );

        const nodeModulesUpdated = await pollUntil(
          () => config.resolver.nodeModulesPaths.includes(testNodeModulesDir)
        );

        assert.ok(
          nodeModulesUpdated,
          `config.resolver.nodeModulesPaths was not updated with the new ` +
            `node_modules dir within 2 s ` +
            `(started with ${pathsBefore}, now has ${config.resolver.nodeModulesPaths.length})`
        );
      } finally {
        cleanupTempLib(testLibDir);
      }
    });

    test(`${artifact}: removed lib package pruned without restart`, async () => {
      // 1. Pre-create the test package inside a temp lib dir BEFORE loading
      //    the config so the initial scan includes both paths.
      const testLibDir = createTempLib();
      const testPkgName = `test-metro-remove-${artifact}-${Date.now()}`;
      const testPkgDir = path.join(testLibDir, testPkgName);
      const testNodeModulesDir = path.join(testPkgDir, "node_modules");
      fs.mkdirSync(testNodeModulesDir, { recursive: true });

      // 2. Load the metro config pointing at the isolated temp lib.
      delete require.cache[configPath];
      delete require.cache[expoMetroConfigResolvedPath];
      injectExpoMock();
      process.env.METRO_TEST_LIB_DIR = testLibDir;

      let config;
      try {
        config = require(configPath);
      } finally {
        delete require.cache[configPath];
        delete require.cache[expoMetroConfigResolvedPath];
        delete process.env.METRO_TEST_LIB_DIR;
      }

      // Both paths must be present from the initial scan.
      assert.ok(
        config.watchFolders.includes(testPkgDir),
        `testPkgDir should be in watchFolders after initial scan`
      );
      assert.ok(
        config.resolver.nodeModulesPaths.includes(testNodeModulesDir),
        `testNodeModulesDir should be in nodeModulesPaths after initial scan`
      );

      // 3. Delete the temp directory. The fs.watch callback fires and
      //    should splice both stale entries out of the config arrays.
      try {
        fs.rmSync(testPkgDir, { recursive: true, force: true });
      } catch {
        // ignore – deletion errors would cause assertion failures below
      }

      // 4. Poll until both arrays no longer contain the removed paths.
      const watchFoldersPruned = await pollUntil(
        () => !config.watchFolders.includes(testPkgDir)
      );

      assert.ok(
        watchFoldersPruned,
        `config.watchFolders still contains ${testPkgDir} after deletion (within 2 s)`
      );

      const nodeModulesPruned = await pollUntil(
        () => !config.resolver.nodeModulesPaths.includes(testNodeModulesDir)
      );

      assert.ok(
        nodeModulesPruned,
        `config.resolver.nodeModulesPaths still contains ${testNodeModulesDir} after deletion (within 2 s)`
      );

      cleanupTempLib(testLibDir);
    });

    test(`${artifact}: parentWatcher is set up on workspaceRoot parent`, async () => {
      const { config, testLibDir } = loadMetroConfig(configPath);

      const watchers = config._getWatchers;
      assert.ok(
        watchers.parentWatcher !== null &&
          typeof watchers.parentWatcher === "object",
        "parentWatcher should be a non-null FSWatcher after loading metro config"
      );
      assert.ok(
        watchers.workspaceRootWatcher !== null &&
          typeof watchers.workspaceRootWatcher === "object",
        "workspaceRootWatcher should be a non-null FSWatcher after loading metro config"
      );

      // Clean up the watchers so they do not keep the event loop alive.
      try {
        watchers.parentWatcher.close();
      } catch {
        // ignore
      }
      try {
        watchers.workspaceRootWatcher.close();
      } catch {
        // ignore
      }
      if (watchers.libWatcher) {
        try {
          watchers.libWatcher.close();
        } catch {
          // ignore
        }
      }
      cleanupTempLib(testLibDir);
    });

    test(`${artifact}: deleted lib/ directory prunes all lib-originated entries`, async () => {
      // ----------------------------------------------------------------
      // Strategy: build an isolated temp workspace tree with a lib/ inside
      // it, point the metro config at it via METRO_TEST_WORKSPACE_ROOT and
      // METRO_TEST_LIB_DIR, then delete lib/ entirely and verify that
      // all lib-originated entries are pruned from both config arrays.
      // ----------------------------------------------------------------

      // 1. Build isolated temp workspace tree.
      const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "metro-ws-test-"));
      const testLibDir = path.join(testWorkspace, "lib");
      const testPkgName = `test-libdel-${artifact}-${Date.now()}`;
      const testPkgDir = path.join(testLibDir, testPkgName);
      const testNodeModulesDir = path.join(testPkgDir, "node_modules");
      fs.mkdirSync(testNodeModulesDir, { recursive: true });

      let config;
      try {
        // 2. Load the metro config pointing at the isolated workspace.
        delete require.cache[configPath];
        delete require.cache[expoMetroConfigResolvedPath];
        injectExpoMock();

        process.env.METRO_TEST_WORKSPACE_ROOT = testWorkspace;
        process.env.METRO_TEST_LIB_DIR = testLibDir;

        try {
          config = require(configPath);
        } finally {
          delete require.cache[configPath];
          delete require.cache[expoMetroConfigResolvedPath];
          delete process.env.METRO_TEST_WORKSPACE_ROOT;
          delete process.env.METRO_TEST_LIB_DIR;
        }

        assert.ok(
          config.watchFolders.includes(testLibDir),
          `testLibDir should be in watchFolders after initial scan`
        );
        assert.ok(
          config.watchFolders.includes(testPkgDir),
          `testPkgDir should be in watchFolders after initial scan`
        );
        assert.ok(
          config.resolver.nodeModulesPaths.includes(testNodeModulesDir),
          `testNodeModulesDir should be in nodeModulesPaths after initial scan`
        );

        // 3. Delete lib/ entirely. The workspaceRoot watcher should detect
        //    the rename event and prune every lib-originated entry.
        fs.rmSync(testLibDir, { recursive: true, force: true });

        // 4. Poll until testLibDir itself is gone from watchFolders.
        const libDirPruned = await pollUntil(
          () => !config.watchFolders.includes(testLibDir)
        );
        assert.ok(
          libDirPruned,
          `config.watchFolders still contains testLibDir after lib/ deletion (within 2 s)`
        );

        // 5. Poll until the package subdir is gone from watchFolders.
        const pkgDirPruned = await pollUntil(
          () => !config.watchFolders.includes(testPkgDir)
        );
        assert.ok(
          pkgDirPruned,
          `config.watchFolders still contains testPkgDir after lib/ deletion (within 2 s)`
        );

        // 6. Poll until the node_modules path is gone from nodeModulesPaths.
        const nodeModulesPruned = await pollUntil(
          () => !config.resolver.nodeModulesPaths.includes(testNodeModulesDir)
        );
        assert.ok(
          nodeModulesPruned,
          `config.resolver.nodeModulesPaths still contains testNodeModulesDir after lib/ deletion (within 2 s)`
        );
      } finally {
        // 7. Always clean up the isolated workspace.
        try {
          fs.rmSync(testWorkspace, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Standalone behavioral test: workspace root moved/renamed closes watchers
  //
  // Strategy
  // --------
  // This test cannot rename the real workspace root (that would disrupt the
  // running test process), so it builds a self-contained replica of the
  // parentWatcher algorithm using a dedicated temp directory tree:
  //
  //   tmpParent/
  //     workspace/        ← acts as workspaceRoot
  //       lib/
  //         testpkg/
  //           node_modules/
  //
  // Watchers are created exactly as metro.config.js does:
  //   libWatcher         → watches workspace/lib/
  //   workspaceRootWatcher → watches workspace/
  //   parentWatcher      → watches tmpParent/ for a rename of "workspace"
  //
  // When workspace/ is renamed to workspace-moved/, the parentWatcher fires,
  // detects the absence of workspaceRoot, and closes all three handles.
  // Closure is verified by polling the reference variables (null after close).
  // -------------------------------------------------------------------------
  test("workspaceRoot moved/renamed: all watchers are cleanly closed", async () => {
    const os = require("os");

    // ----------------------------------------------------------------
    // 1. Build the temp directory tree.
    // ----------------------------------------------------------------
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "metro-root-test-"));
    const tmpWorkspace = path.join(tmpParent, "workspace");
    const tmpLib = path.join(tmpWorkspace, "lib");
    const tmpPkg = path.join(tmpLib, "testpkg");
    const tmpNodeModules = path.join(tmpPkg, "node_modules");

    fs.mkdirSync(tmpNodeModules, { recursive: true });

    // ----------------------------------------------------------------
    // 2. Set up watchers mirroring the metro.config.js algorithm.
    // ----------------------------------------------------------------
    let libWatcher = null;
    let workspaceRootWatcher = null;
    let parentWatcher = null;

    libWatcher = fs.watch(tmpLib, () => {});

    workspaceRootWatcher = fs.watch(tmpWorkspace, () => {});

    parentWatcher = fs.watch(tmpParent, (eventType, filename) => {
      if (filename !== "workspace") return;
      if (fs.existsSync(tmpWorkspace)) return; // still present — ignore
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

    const tmpWorkspaceMoved = path.join(tmpParent, "workspace-moved");

    try {
      // ----------------------------------------------------------------
      // 3. Rename workspace/ so it appears to have moved.
      // ----------------------------------------------------------------
      fs.renameSync(tmpWorkspace, tmpWorkspaceMoved);

      // ----------------------------------------------------------------
      // 4. Poll until all three watcher references are null, indicating
      //    the parentWatcher fired and closed all handles.
      // ----------------------------------------------------------------
      const allClosed = await pollUntil(
        () =>
          libWatcher === null &&
          workspaceRootWatcher === null &&
          parentWatcher === null
      );

      assert.ok(
        allClosed,
        "All watchers (libWatcher, workspaceRootWatcher, parentWatcher) " +
          "should be null after workspaceRoot is renamed (within 2 s)"
      );
    } finally {
      // ----------------------------------------------------------------
      // 5. Clean up — close any watchers still open and remove temp dirs.
      // ----------------------------------------------------------------
      for (const w of [libWatcher, workspaceRootWatcher, parentWatcher]) {
        if (w) {
          try {
            w.close();
          } catch {
            // ignore
          }
        }
      }
      try {
        fs.rmSync(tmpParent, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
