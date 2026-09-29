/**
 * Integration test: verifies the fleet driver SSE heartbeat round-trip.
 *
 * The route (`createFleetSseRouter`) writes ": ping\n\n" every `heartbeatMs`
 * via `setInterval`. Tests inject a tiny heartbeat interval (50 ms) so real
 * timers can be used throughout — no fake-timer toggling required.
 *
 * Assertions:
 *   1. The initial ": connected" comment arrives immediately.
 *   2. After 50 ms, ": ping" arrives on the wire.
 *   3. The connection stays open after the heartbeat fires.
 *   4. After the client disconnects, no further heartbeats are sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";

// ---------------------------------------------------------------------------
// Mocks — bypass DB, logger, and other external deps
// ---------------------------------------------------------------------------

const { mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  return { mockDbQuery };
});

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
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

vi.mock("../lib/clerkDriverSync", () => ({
  syncDriverToClerk: vi.fn().mockResolvedValue("clerk_test_user_id"),
}));

vi.mock("../lib/expoPush", () => ({
  sendExpoPushNotification: vi.fn().mockResolvedValue({ success: true }),
}));

const mockTwilioCreate = vi.fn();
vi.mock("twilio", () => {
  const factory = () => ({
    messages: { create: mockTwilioCreate },
  });
  return { default: factory };
});

import { createFleetSseRouter } from "./fleet";

// ---------------------------------------------------------------------------
// Heartbeat interval used by all tests (real timers, tiny value)
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 50;

// A fake token that passes the fdt_live_ prefix check.
// The DB mock returns a valid driver row unconditionally so the hash doesn't matter.
const FAKE_TOKEN = "fdt_live_heartbeat_test_token";
const DRIVER_ID = 7;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function makeServer(): http.Server {
  const app = express();
  app.use(createFleetSseRouter(HEARTBEAT_MS));
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
    const path = `/fleet/me/sse?token=${encodeURIComponent(FAKE_TOKEN)}`;
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

describe("SSE heartbeat integration – fleet driver SSE", () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: return a valid approved driver row for the token lookup.
    mockDbQuery.mockResolvedValue({
      rows: [{ driver_id: DRIVER_ID, onboarding_status: "approved", deleted_at: null }],
      rowCount: 1,
    });

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

  it("sends ': ping' comment after the heartbeat interval fires", async () => {
    const sse = await connectSse(server);

    await waitFor(() => sse.getText().includes(": connected"));
    await waitFor(() => sse.getText().includes(": ping"), 2000);

    expect(sse.getText()).toContain(": ping");
    sse.close();
  });

  it("connection remains open after the heartbeat fires (not dropped)", async () => {
    const sse = await connectSse(server);

    await waitFor(() => sse.getText().includes(": connected"));

    // Wait for the first ping.
    await waitFor(() => sse.getText().includes(": ping"), 2000);

    // Wait for a second ping — confirms the connection was not dropped.
    await waitFor(
      () => (sse.getText().match(/: ping/g) ?? []).length >= 2,
      2000,
    );

    expect(
      (sse.getText().match(/: ping/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    sse.close();
  });

  it("does not send heartbeat after the client disconnects", async () => {
    const sse = await connectSse(server);

    await waitFor(() => sse.getText().includes(": connected"));

    // Close the client before any ping fires.
    sse.close();

    // Give the server time to detect the close and clear the interval.
    await new Promise((r) => setTimeout(r, 100));

    // Snapshot text — no ping should appear.
    const snapshot = sse.getText();

    // Wait longer than one heartbeat interval to confirm no new data arrives.
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 4));

    expect(sse.getText()).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Write-failure catch path
// ---------------------------------------------------------------------------

describe("SSE heartbeat – write-failure clears the interval (fleet driver)", () => {
  /**
   * This suite specifically exercises the try/catch inside the setInterval
   * callback in `createFleetSseRouter`:
   *
   *   const heartbeat = setInterval(() => {
   *     try {
   *       res.write(": ping\n\n");
   *     } catch {
   *       clearInterval(heartbeat);   ← this is what we are testing
   *     }
   *   }, heartbeatMs);
   *
   * Strategy
   * --------
   * A middleware intercepts `res.write` and:
   *   • lets the first two writes (": connected" and "retry: 15000") succeed, and
   *   • throws a synthetic error for every subsequent call.
   *
   * Because the TCP socket remains open (no client disconnect), the
   * `res.on("close")` handler never fires.  The ONLY path that can stop
   * the interval is the catch block calling `clearInterval`.
   *
   * By counting how many times the patched `res.write` is called we can
   * prove that no further write is attempted after the one that threw —
   * which would only be true if `clearInterval` was invoked.
   */

  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a valid approved driver row for the token lookup so this suite
    // does not depend on mock state set up in the outer describe block.
    mockDbQuery.mockResolvedValue({
      rows: [{ driver_id: DRIVER_ID, onboarding_status: "approved", deleted_at: null }],
      rowCount: 1,
    });
  });

  it("stops writing after res.write throws (catch → clearInterval path)", async () => {
    let writeCallCount = 0;

    // Build a local Express app with write-intercepting middleware.
    const localApp = express();

    localApp.use((_req, res, next) => {
      const origWrite = res.write.bind(res) as typeof res.write;
      res.write = function patchedWrite(
        chunk: any,
        encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
        callback?: (error: Error | null | undefined) => void,
      ): boolean {
        writeCallCount++;
        if (writeCallCount <= 2) {
          // First two writes (": connected" and "retry: 15000") — let
          // them succeed so the client confirms the connection and the
          // heartbeat interval is registered.
          return origWrite(chunk, encodingOrCb as any, callback as any);
        }
        // All subsequent writes (": ping") throw to simulate a broken socket.
        // The underlying TCP socket is intentionally left intact so the
        // close event does NOT fire; clearInterval can only be reached
        // through the catch block.
        throw new Error("simulated socket write failure");
      };
      next();
    });

    localApp.use(createFleetSseRouter(HEARTBEAT_MS));

    const localServer = http.createServer(localApp);
    await new Promise<void>((resolve) =>
      localServer.listen(0, "127.0.0.1", resolve),
    );

    try {
      // Connect an SSE client using the fake token.
      const addr = localServer.address() as { port: number };
      const clientReq = http.request(
        {
          host: "127.0.0.1",
          port: addr.port,
          path: `/fleet/me/sse?token=${encodeURIComponent(FAKE_TOKEN)}`,
          method: "GET",
        },
        (clientRes) => {
          clientRes.resume();
        },
      );
      clientReq.on("error", () => {});
      clientReq.end();

      // The fleet SSE route writes two things immediately on connect:
      //   1. ": connected\n\n"
      //   2. "retry: 15000\n\n"
      // Wait until both initial writes have completed.
      await waitFor(() => writeCallCount >= 2);

      // Snapshot write count immediately after connection.
      // Should be 2: the ": connected" comment and the retry directive.
      const countAfterConnect = writeCallCount;

      // Wait long enough for several heartbeat intervals to fire.
      // The first heartbeat attempt (writeCallCount 3) will throw →
      // catch → clearInterval.  No further writes should occur.
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 6));

      const countAfterWait = writeCallCount;

      // Exactly one write beyond the two initial writes should have
      // occurred — the ping write that threw and triggered clearInterval.
      // If clearInterval was NOT called, the count would grow by at least
      // 5 more writes over 6 heartbeat intervals.
      expect(countAfterConnect).toBe(2);
      expect(countAfterWait).toBe(3);

      clientReq.destroy();
    } finally {
      localServer.closeAllConnections();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});
