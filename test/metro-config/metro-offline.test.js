/**
 * Guards the offline-safe startup of all three Expo mobile artifacts.
 *
 * The shared dev-start helper (scripts/src/metro-dev-start.cjs) must invoke
 * `expo start` with the `--offline` flag so a flaky network response during
 * Expo CLI's remote dependency-version check cannot crash the app on startup.
 *
 * Strategy
 * --------
 * 1. Monkey-patch `child_process.spawn` to capture the args passed to the
 *    `expo start` invocation instead of actually launching Expo.
 * 2. Monkey-patch `net.connect` (so the internal port probe reports the port
 *    as free) and `net.createServer` (so no real TCP bridge is bound).
 * 3. Require the helper fresh and call it.
 * 4. Poll until spawn was called, then assert the captured args include
 *    `--offline`.
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const net = require("net");
const cp = require("child_process");

const METRO_DEV_START_PATH = path.join(
  __dirname,
  "../../scripts/src/metro-dev-start.cjs"
);

function pollUntil(predicate, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 25);
    })();
  });
}

/**
 * Run startMetro with spawn/net stubbed out and return the args array that
 * would have been passed to child_process.spawn for `expo start`.
 */
async function captureExpoStartArgs() {
  const originalSpawn = cp.spawn;
  const originalConnect = net.connect;
  const originalCreateServer = net.createServer;

  let captured = null;

  cp.spawn = (_command, args) => {
    captured = args;
    return {
      kill() {},
      on() {},
    };
  };

  // Port probe: emit "error" so isPortFree() resolves true (port is free).
  net.connect = () => {
    const probe = {
      handlers: {},
      on(event, cb) {
        this.handlers[event] = cb;
        return this;
      },
      destroy() {},
    };
    setImmediate(() => {
      if (probe.handlers.error) probe.handlers.error(new Error("refused"));
    });
    return probe;
  };

  // Bridge servers: no-op stand-ins so nothing is actually bound.
  net.createServer = () => ({
    listen() {},
    on() {},
    close() {},
  });

  try {
    delete require.cache[require.resolve(METRO_DEV_START_PATH)];
    const startMetro = require(METRO_DEV_START_PATH);
    startMetro({ defaultPort: 22179 });
    await pollUntil(() => captured !== null);
    return captured;
  } finally {
    cp.spawn = originalSpawn;
    net.connect = originalConnect;
    net.createServer = originalCreateServer;
    delete require.cache[require.resolve(METRO_DEV_START_PATH)];
  }
}

describe("metro-dev-start offline-safe startup", () => {
  test("expo start is invoked with --offline", async () => {
    const args = await captureExpoStartArgs();

    assert.ok(
      Array.isArray(args),
      "expected child_process.spawn to be called with an args array"
    );
    assert.ok(
      args.includes("--offline"),
      `expected expo start args to include "--offline", got: ${JSON.stringify(
        args
      )}`
    );
    // Sanity check that we captured the expo start invocation specifically.
    assert.ok(
      args.includes("expo") && args.includes("start"),
      `expected the captured args to be the "expo start" invocation, got: ${JSON.stringify(
        args
      )}`
    );
  });
});
