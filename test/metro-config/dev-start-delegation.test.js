/**
 * Guards that every Expo mobile artifact's per-app dev-start script delegates
 * to the shared startup helper (scripts/src/metro-dev-start.cjs).
 *
 * Why
 * ---
 * The shared helper launches Expo in offline-safe mode (see
 * metro-offline.test.js). Each app's scripts/dev-start.cjs is meant to be a
 * thin wrapper that just requires/invokes the shared helper. If one of those
 * per-app files is edited to bypass the shared helper (e.g. spawning `expo
 * start` directly), the offline-safe guard would be silently skipped for that
 * app and no existing test would catch it.
 *
 * Strategy
 * --------
 * For each artifact:
 * 1. Replace the shared helper in require.cache with a stub that records that
 *    it was invoked and with what config.
 * 2. Require the app's scripts/dev-start.cjs fresh.
 * 3. Assert the stub was invoked exactly once (i.e. the app delegated to the
 *    shared helper rather than doing its own thing).
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const SHARED_HELPER_PATH = path.join(
  WORKSPACE_ROOT,
  "scripts/src/metro-dev-start.cjs"
);

/**
 * Discover every mobile artifact by scanning artifacts/*\/.replit-artifact/
 * artifact.toml for `kind = "mobile"`. Returns the sorted list of artifact
 * directory names.
 */
function discoverMobileApps() {
  const artifactsDir = path.join(WORKSPACE_ROOT, "artifacts");
  const entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
  const mobileApps = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tomlPath = path.join(
      artifactsDir,
      entry.name,
      ".replit-artifact/artifact.toml"
    );
    if (!fs.existsSync(tomlPath)) continue;
    const contents = fs.readFileSync(tomlPath, "utf8");
    const isMobile = contents
      .split(/\r?\n/)
      .some((line) => /^\s*kind\s*=\s*"mobile"\s*$/.test(line));
    if (isMobile) {
      mobileApps.push(entry.name);
    }
  }
  return mobileApps.sort();
}

const APPS = discoverMobileApps();

function appDevStartPath(app) {
  return path.join(WORKSPACE_ROOT, "artifacts", app, "scripts/dev-start.cjs");
}

function appArtifactTomlPath(app) {
  return path.join(
    WORKSPACE_ROOT,
    "artifacts",
    app,
    ".replit-artifact/artifact.toml"
  );
}

/**
 * Read the PORT declared under [services.env] in an app's artifact.toml.
 * Returns the port as a number, or undefined if it can't be found.
 */
function readArtifactTomlPort(app) {
  const tomlPath = appArtifactTomlPath(app);
  const contents = fs.readFileSync(tomlPath, "utf8");
  const lines = contents.split(/\r?\n/);

  let inServicesEnv = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inServicesEnv = trimmed === "[services.env]";
      continue;
    }
    if (!inServicesEnv) continue;
    const match = trimmed.match(/^PORT\s*=\s*"?(\d+)"?\s*$/);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Require the app's dev-start.cjs with the shared helper stubbed out, and
 * return how many times (and with what args) the stub was invoked.
 */
function loadAppDevStartWithStubbedHelper(app) {
  const sharedResolved = require.resolve(SHARED_HELPER_PATH);
  const appResolved = require.resolve(appDevStartPath(app));

  const originalSharedEntry = require.cache[sharedResolved];

  const calls = [];
  const stub = (...args) => {
    calls.push(args);
  };

  // Install the stub in require.cache under the shared helper's resolved path
  // so the app's `require("../../../scripts/src/metro-dev-start.cjs")` resolves
  // to it without executing the real helper (which would spawn Expo).
  require.cache[sharedResolved] = {
    id: sharedResolved,
    filename: sharedResolved,
    loaded: true,
    exports: stub,
  };

  // Ensure the app file is loaded fresh so its top-level require runs now.
  delete require.cache[appResolved];

  try {
    require(appResolved);
    return calls;
  } finally {
    delete require.cache[appResolved];
    if (originalSharedEntry) {
      require.cache[sharedResolved] = originalSharedEntry;
    } else {
      delete require.cache[sharedResolved];
    }
  }
}

describe("mobile dev-start scripts delegate to the shared startup helper", () => {
  for (const app of APPS) {
    test(`${app}/scripts/dev-start.cjs delegates to metro-dev-start.cjs`, () => {
      const calls = loadAppDevStartWithStubbedHelper(app);

      assert.equal(
        calls.length,
        1,
        `expected ${app}/scripts/dev-start.cjs to invoke the shared helper exactly once, got ${calls.length} invocation(s)`
      );

      const [config] = calls[0];
      assert.ok(
        config && typeof config === "object",
        `expected ${app}/scripts/dev-start.cjs to pass a config object to the shared helper, got: ${JSON.stringify(
          config
        )}`
      );
      assert.equal(
        typeof config.defaultPort,
        "number",
        `expected ${app}/scripts/dev-start.cjs config to include a numeric defaultPort, got: ${JSON.stringify(
          config
        )}`
      );
    });
  }
});

describe("mobile dev-start scripts use correct port and status settings", () => {
  const configsByApp = {};
  for (const app of APPS) {
    const calls = loadAppDevStartWithStubbedHelper(app);
    configsByApp[app] = calls.length === 1 ? calls[0][0] : undefined;
  }

  test("each app passes a unique defaultPort so two apps never collide", () => {
    const seen = new Map();
    for (const app of APPS) {
      const config = configsByApp[app];
      assert.ok(
        config && typeof config.defaultPort === "number",
        `expected ${app}/scripts/dev-start.cjs to pass a numeric defaultPort`
      );
      const port = config.defaultPort;
      const existing = seen.get(port);
      assert.equal(
        existing,
        undefined,
        `defaultPort ${port} is shared by "${existing}" and "${app}"; each mobile app must use a unique port to avoid startup collisions`
      );
      seen.set(port, app);
    }
  });

  for (const app of APPS) {
    test(`${app} passes a valid statusRegex that compiles to a RegExp`, () => {
      const config = configsByApp[app];
      assert.ok(
        config && typeof config === "object",
        `expected ${app}/scripts/dev-start.cjs to pass a config object`
      );
      assert.ok(
        config.statusRegex instanceof RegExp,
        `expected ${app}/scripts/dev-start.cjs config.statusRegex to be a RegExp, got: ${typeof config.statusRegex}`
      );
      // A malformed RegExp would have thrown at construction time, but guard
      // against a non-compiling source by re-compiling it explicitly.
      assert.doesNotThrow(
        () => new RegExp(config.statusRegex.source, config.statusRegex.flags),
        `expected ${app}/scripts/dev-start.cjs config.statusRegex to be a compilable RegExp`
      );
    });
  }

  // Guards against the exact drift that caused a past startup-port collision:
  // an app's dev-start.cjs declared a defaultPort (e.g. 22179) that did not
  // match the PORT in its artifact.toml (e.g. 22171). Because the workflow
  // passes PORT via env, the dev-start fallback only matters when env is
  // absent, so the mismatch stays invisible until two apps collide.
  for (const app of APPS) {
    test(`${app} defaultPort matches the PORT in its artifact.toml`, () => {
      const config = configsByApp[app];
      assert.ok(
        config && typeof config.defaultPort === "number",
        `expected ${app}/scripts/dev-start.cjs to pass a numeric defaultPort`
      );
      const tomlPort = readArtifactTomlPort(app);
      assert.ok(
        typeof tomlPort === "number" && Number.isFinite(tomlPort),
        `expected to find a numeric [services.env].PORT in ${app}/.replit-artifact/artifact.toml, got: ${tomlPort}`
      );
      assert.equal(
        config.defaultPort,
        tomlPort,
        `${app}/scripts/dev-start.cjs defaultPort (${config.defaultPort}) must equal the PORT in its artifact.toml (${tomlPort}); a mismatch is invisible until two apps' startup ports collide`
      );
    });
  }
});
