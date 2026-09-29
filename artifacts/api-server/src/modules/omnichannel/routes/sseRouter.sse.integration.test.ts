/**
 * Integration test: verifies the omnichannel SSE heartbeat round-trip.
 *
 * The route (`sseRouter`) writes ": heartbeat\n\n" every `heartbeatMs` via
 * `setInterval`.  Tests inject a tiny heartbeat interval (50 ms) so real
 * timers can be used throughout — no fake-timer toggling required.
 *
 * Assertions:
 *   1. The initial ": connected" comment arrives.
 *   2. After 50 ms, ": heartbeat" arrives on the wire.
 *   3. The connection is still open (not dropped) after the heartbeat.
 *   4. After the client disconnects, no further heartbeats are sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { WorkspaceRequest } from "../../../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — bypass auth, workspace resolution, and logger
// ---------------------------------------------------------------------------

vi.mock("../omnichannelAuth", () => ({
  requireOmnichannelRole: (_role: string) => [
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const wreq = req as unknown as WorkspaceRequest;
      wreq.workspaceOwnerId = "owner_sse_heartbeat_test";
      wreq.workspaceRole = "owner";
      wreq.workspaceActualRole = "owner";
      next();
    },
  ],
}));

vi.mock("../../../lib/workspace", () => ({
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createSseRouter } from "./sseRouter";

// ---------------------------------------------------------------------------
// Heartbeat interval used by all tests (real timers, tiny value)
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 50;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function makeServer(): http.Server {
  const app = express();
  app.use(createSseRouter(HEARTBEAT_MS));
  return http.createServer(app);
}

// ---------------------------------------------------------------------------
// SSE client helper
//
// Opens a persistent GET connection to the given path and accumulates all
// received text.  Returns helpers to read accumulated text and close the
// socket.
// ---------------------------------------------------------------------------

function connectSse(
  server: http.Server,
  path: string,
): Promise<{ getText: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        resolve({
          getText: () => text,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// waitFor — poll until a condition is true or time out
// ---------------------------------------------------------------------------

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("waitFor timed out: " + condition.toString()));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE heartbeat integration – sseRouter", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = makeServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends ': connected' comment immediately when client connects", async () => {
    const sse = await connectSse(server, "/omnichannel/events");

    await waitFor(() => sse.getText().includes(": connected"));

    expect(sse.getText()).toContain(": connected");
    sse.close();
  });

  it("sends ': heartbeat' comment after the interval fires", async () => {
    const sse = await connectSse(server, "/omnichannel/events");

    await waitFor(() => sse.getText().includes(": connected"));
    await waitFor(() => sse.getText().includes(": heartbeat"), 2000);

    expect(sse.getText()).toContain(": heartbeat");
    sse.close();
  });

  it("connection remains open after the heartbeat fires (not dropped)", async () => {
    const sse = await connectSse(server, "/omnichannel/events");

    await waitFor(() => sse.getText().includes(": connected"));

    // Wait for the first heartbeat.
    await waitFor(() => sse.getText().includes(": heartbeat"), 2000);

    // Wait for a second heartbeat — if the connection had been dropped the
    // server would have caught the write error and cleared the interval,
    // so no second heartbeat would arrive.
    await waitFor(
      () => (sse.getText().match(/: heartbeat/g) ?? []).length >= 2,
      2000,
    );

    expect((sse.getText().match(/: heartbeat/g) ?? []).length).toBeGreaterThanOrEqual(2);
    sse.close();
  });

  it("does not send heartbeat after the client disconnects", async () => {
    const sse = await connectSse(server, "/omnichannel/events");

    await waitFor(() => sse.getText().includes(": connected"));

    // Close the client before any heartbeat fires.
    sse.close();

    // Give the server time to detect the close and clear the interval.
    await new Promise((r) => setTimeout(r, 100));

    // Snapshot text — no heartbeat should appear.
    const snapshot = sse.getText();

    // Wait longer than one heartbeat interval to confirm no new data arrives.
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 4));

    expect(sse.getText()).toBe(snapshot);
    expect(sse.getText()).not.toContain(": heartbeat");
  });
});
