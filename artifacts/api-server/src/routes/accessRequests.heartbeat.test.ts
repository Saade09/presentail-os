/**
 * Integration test: verifies the access-requests SSE heartbeat round-trip.
 *
 * The route (`createAccessRequestsRouter`) writes ": heartbeat\n\n" every
 * `heartbeatMs` via `setInterval`. Tests inject a tiny heartbeat interval
 * (50 ms) so real timers can be used throughout — no fake-timer toggling
 * required.
 *
 * Assertions:
 *   1. The initial ": connected" comment arrives immediately.
 *   2. After 50 ms, ": heartbeat" arrives on the wire.
 *   3. The connection stays open after the heartbeat fires.
 *   4. After the client disconnects, no further heartbeats are sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — bypass auth, workspace resolution, db, logger, and email
// ---------------------------------------------------------------------------

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_hb_test";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "user_hb_test";
    wreq.userEmail = "hb-owner@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/db", () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: vi.fn() },
  withTransaction: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/email", () => ({
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
  sendAccessRejectionEmail: vi.fn().mockResolvedValue(undefined),
}));

import { createAccessRequestsRouter } from "./accessRequests";

// ---------------------------------------------------------------------------
// Heartbeat interval used by all tests (real timers, tiny value)
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 50;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function makeServer(): http.Server {
  const app = express();
  app.use(express.json());
  app.use(createAccessRequestsRouter(HEARTBEAT_MS));
  return http.createServer(app);
}

// ---------------------------------------------------------------------------
// SSE client helper
// ---------------------------------------------------------------------------

function connectSse(
  server: http.Server,
): Promise<{ getText: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path: "/access-requests/events",
        method: "GET",
      },
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

describe("SSE heartbeat integration – access-requests SSE", () => {
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
    const sse = await connectSse(server);

    await waitFor(() => sse.getText().includes(": connected"));

    expect(sse.getText()).toContain(": connected");
    sse.close();
  });

  it("sends ': heartbeat' comment after the interval fires", async () => {
    const sse = await connectSse(server);

    await waitFor(() => sse.getText().includes(": connected"));
    await waitFor(() => sse.getText().includes(": heartbeat"), 2000);

    expect(sse.getText()).toContain(": heartbeat");
    sse.close();
  });

  it("connection remains open after the heartbeat fires (not dropped)", async () => {
    const sse = await connectSse(server);

    await waitFor(() => sse.getText().includes(": connected"));

    // Wait for the first heartbeat.
    await waitFor(() => sse.getText().includes(": heartbeat"), 2000);

    // Wait for a second heartbeat — confirms the connection was not dropped.
    await waitFor(
      () => (sse.getText().match(/: heartbeat/g) ?? []).length >= 2,
      2000,
    );

    expect(
      (sse.getText().match(/: heartbeat/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    sse.close();
  });

  it("does not send heartbeat after the client disconnects", async () => {
    const sse = await connectSse(server);

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

// ---------------------------------------------------------------------------
// Write-failure catch path
// ---------------------------------------------------------------------------

describe("SSE heartbeat – write-failure clears the interval", () => {
  /**
   * This suite specifically exercises the try/catch inside the setInterval
   * callback in `createAccessRequestsRouter`:
   *
   *   const heartbeat = setInterval(() => {
   *     try {
   *       res.write(": heartbeat\n\n");
   *     } catch {
   *       clearInterval(heartbeat);   ← this is what we are testing
   *     }
   *   }, heartbeatMs);
   *
   * Strategy
   * --------
   * A middleware intercepts `res.write` and:
   *   • lets the first call (": connected") succeed normally, and
   *   • throws a synthetic error for every subsequent call.
   *
   * Because the TCP socket remains open (no client disconnect), the
   * `req.on("close")` handler never fires.  The ONLY path that can stop
   * the interval is the catch block calling `clearInterval`.
   *
   * By counting how many times the patched `res.write` is called we can
   * prove that no further write is attempted after the one that threw —
   * which would only be true if `clearInterval` was invoked.
   */
  it("stops writing after res.write throws (catch → clearInterval path)", async () => {
    let writeCallCount = 0;

    // Build a local Express app with write-intercepting middleware.
    const localApp = express();
    localApp.use(express.json());

    localApp.use((_req, res, next) => {
      const origWrite = res.write.bind(res) as typeof res.write;
      res.write = function patchedWrite(
        chunk: any,
        encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
        callback?: (error: Error | null | undefined) => void,
      ): boolean {
        writeCallCount++;
        if (writeCallCount === 1) {
          // First write (": connected") — let it succeed so the client
          // confirms the connection is established.
          return origWrite(chunk, encodingOrCb as any, callback as any);
        }
        // All subsequent writes throw to simulate a broken socket.
        // The underlying TCP socket is intentionally left intact so the
        // close event does NOT fire; clearInterval can only be reached
        // through the catch block.
        throw new Error("simulated socket write failure");
      };
      next();
    });

    localApp.use(createAccessRequestsRouter(HEARTBEAT_MS));

    const localServer = http.createServer(localApp);
    await new Promise<void>((resolve) =>
      localServer.listen(0, "127.0.0.1", resolve),
    );

    try {
      // Connect an SSE client.
      const addr = localServer.address() as { port: number };
      const clientReq = http.request(
        {
          host: "127.0.0.1",
          port: addr.port,
          path: "/access-requests/events",
          method: "GET",
        },
        (clientRes) => {
          clientRes.resume();
        },
      );
      clientReq.on("error", () => {});
      clientReq.end();

      // Wait until the initial ": connected" write has succeeded
      // (writeCallCount becomes 1).
      await waitFor(() => writeCallCount >= 1);

      // Snapshot write count immediately after connection.
      const countAfterConnect = writeCallCount; // should be 1

      // Wait long enough for several heartbeat intervals to fire.
      // The first heartbeat attempt (writeCallCount 2) will throw →
      // catch → clearInterval.  No further writes should occur.
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 6));

      const countAfterWait = writeCallCount;

      // Exactly one write beyond the initial ": connected" should have
      // occurred — the heartbeat write that threw and triggered
      // clearInterval.  If clearInterval was NOT called, the count would
      // grow by at least 5 more writes over 6 heartbeat intervals.
      expect(countAfterConnect).toBe(1);
      expect(countAfterWait).toBe(2);

      clientReq.destroy();
    } finally {
      localServer.closeAllConnections();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});
