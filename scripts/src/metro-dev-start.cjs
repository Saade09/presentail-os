/**
 * Shared Metro dev-start logic for all Expo mobile artifacts.
 *
 * Usage (from each artifact's scripts/dev-start.cjs):
 *
 *   require('../../scripts/src/metro-dev-start.cjs')({ defaultPort: 22179 });
 */

"use strict";

const { spawn, execSync } = require("child_process");
const net = require("net");

// ---------------------------------------------------------------------------
// Port-availability helpers
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host: "127.0.0.1" }, () => {
      probe.destroy();
      resolve(false); // something answered → port is in use
    });
    probe.on("error", () => resolve(true)); // connection refused → port is free
  });
}

function killPortOccupant(port) {
  return new Promise((resolve) => {
    try {
      // Linux: fuser; macOS fallback: lsof | xargs kill
      try {
        execSync(`fuser -k ${port}/tcp`, { stdio: "pipe" });
      } catch {
        execSync(`lsof -ti:${port} | xargs kill -9`, {
          stdio: "pipe",
          shell: true,
        });
      }
    } catch {
      // ignore — process may have already exited
    }
    setTimeout(resolve, 600); // brief pause for the OS to reclaim the port
  });
}

async function resolveMetroPort(startPort) {
  const MAX_PROBE = 10;
  let port = startPort;

  for (let i = 0; i < MAX_PROBE; i++) {
    if (await isPortFree(port)) {
      if (port !== startPort) {
        process.stderr.write(
          `Metro will use port ${port} (originally wanted ${startPort}).\n`
        );
      }
      return port;
    }

    if (i === 0) {
      // First collision: try to free the original port before giving up on it.
      process.stderr.write(
        `Metro port ${port} is busy — attempting to kill the occupant…\n`
      );
      await killPortOccupant(port);
      if (await isPortFree(port)) {
        process.stderr.write(`Port ${port} freed successfully.\n`);
        return port;
      }
      process.stderr.write(
        `Could not free port ${port}, scanning for a free port…\n`
      );
    } else {
      process.stderr.write(`Port ${port} still busy, trying ${port + 1}…\n`);
    }

    port++;
  }

  process.stderr.write(
    `Warning: could not confirm a free port after ${MAX_PROBE} attempts; using ${port} anyway.\n`
  );
  return port;
}

// ---------------------------------------------------------------------------
// TCP bridge factory
// ---------------------------------------------------------------------------

/**
 * Creates a handler function for a net.Server that:
 * - Responds to GET /status (or any path ending in /status) immediately with
 *   the Metro packager-status:running body so the platform health check passes
 *   even before Metro fully warms up.
 * - Proxies everything else straight through to Metro on METRO_PORT.
 *
 * @param {number} METRO_PORT
 * @param {string} STATUS_HTTP
 * @param {RegExp} statusRegex
 */
function makeClientHandler(METRO_PORT, STATUS_HTTP, statusRegex) {
  return (clientSocket) => {
    let chunks = [];
    let decided = false;

    const decide = (buf) => {
      if (decided) return;
      decided = true;

      const preview = buf.toString("utf8", 0, Math.min(buf.length, 256));
      if (statusRegex.test(preview)) {
        clientSocket.end(STATUS_HTTP);
        return;
      }

      // Forward to Metro
      const upstream = net.connect(METRO_PORT, "127.0.0.1");
      upstream.write(buf);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    };

    clientSocket.on("data", (chunk) => {
      if (decided) return;
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      if (combined.indexOf(0x0a) !== -1 || combined.length >= 64) {
        decide(combined);
      }
    });

    clientSocket.on("end", () => {
      if (!decided) decide(Buffer.concat(chunks));
    });

    clientSocket.on("error", () => {});
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {{ defaultPort: number, statusRegex?: RegExp }} options
 */
function startMetro({ defaultPort, statusRegex }) {
  const PORT = parseInt(process.env.PORT || String(defaultPort), 10);
  const DESIRED_METRO_PORT = PORT + 1;

  resolveMetroPort(DESIRED_METRO_PORT).then((METRO_PORT) => {
    const env = { ...process.env, PORT: String(METRO_PORT), CI: "1" };

    const metro = spawn(
      "pnpm",
      ["exec", "expo", "start", "--offline", "--port", String(METRO_PORT)],
      { stdio: "inherit", env, cwd: process.cwd() }
    );

    const STATUS_BODY = "packager-status:running"; // 23 bytes
    const STATUS_HTTP =
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: 23\r\n" +
      "Connection: close\r\n" +
      "\r\n" +
      STATUS_BODY;

    // IPv4 bridge
    const bridge = net.createServer(makeClientHandler(METRO_PORT, STATUS_HTTP, statusRegex));

    // Retry binding on EADDRINUSE (port may linger from a prior SIGKILL)
    let retries = 8;
    function tryListen() {
      bridge.listen(PORT, "0.0.0.0", () => {
        process.stdout.write(
          `IPv4 bridge ready: 0.0.0.0:${PORT} → :${METRO_PORT}\n`
        );
      });
    }

    bridge.on("error", (err) => {
      if (err.code === "EADDRINUSE" && retries-- > 0) {
        process.stderr.write(`Port ${PORT} busy, retrying in 1s…\n`);
        setTimeout(tryListen, 1000);
      } else {
        process.stderr.write(`Bridge error: ${err.message}\n`);
        process.exit(1);
      }
    });

    tryListen();

    // Also bind on IPv6 loopback so the platform health-checker can reach us via ::1
    const bridge6 = net.createServer(
      makeClientHandler(METRO_PORT, STATUS_HTTP, statusRegex)
    );
    bridge6.listen(PORT, "::1", () => {
      process.stdout.write(
        `IPv6 bridge ready: [::1]:${PORT} → :${METRO_PORT}\n`
      );
    });
    bridge6.on("error", () => {}); // ignore if IPv6 not available

    process.on("SIGTERM", () => {
      metro.kill("SIGTERM");
      bridge.close();
      bridge6.close();
    });
    process.on("SIGINT", () => {
      metro.kill("SIGINT");
      bridge.close();
    });
    metro.on("exit", (code) => {
      bridge.close();
      process.exit(code || 0);
    });
  });
}

module.exports = startMetro;
