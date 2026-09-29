/**
 * Integration test: verifies that a connected driver SSE client receives the
 * "assignment" event when a native order is assigned to that driver.
 *
 * Unlike fleet.test.ts (which mocks driverSse), this file uses the REAL
 * subscribe/broadcast implementation so the full pipeline is exercised:
 *   assign-driver route calls broadcast(driverId)
 *     → broadcast() writes `event: assignment\ndata: {}\n\n` to every
 *       registered Response for that driver
 *     → the SSE client (simulated browser tab) receives the event.
 *
 * The database is mocked so the test runs without a live Postgres instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — everything EXCEPT driverSse (the module under test)
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

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: {
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

const OWNER_ID = "__sse_integration_owner__";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = OWNER_ID;
    wreq.userEmail = "sse-owner@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

// Keep the real driverTokenAuth module so the SSE endpoint's dynamic import
// of DRIVER_TOKEN_PREFIX and hashDriverToken resolves correctly.  The DB mock
// is what controls whether the token is accepted.
import fleetRouter from "./fleet";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DRIVER_ID = 42;
const ORDER_ID = "ord-sse-501";
const ORDER_DISPLAY_NUM = "9001";
const ASSIGNMENT_ID = 1001;

// A fake token that passes the prefix check (fdt_live_).
// The actual hash is computed by the route; the DB mock returns a valid row
// unconditionally, so the hash value doesn't matter.
const FAKE_TOKEN = "fdt_live_sse_integration_test_token";

function makeOrderRow() {
  return {
    id: ORDER_ID,
    display_order_number: ORDER_DISPLAY_NUM,
    delivery_address: { address_1: "1 SSE Street", city: "Beirut" },
  };
}

function makeDriverRow() {
  return { id: DRIVER_ID, onboarding_status: "approved", expo_push_token: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(): http.Server {
  const app = express();
  app.use(express.json());
  app.use(fleetRouter);
  return http.createServer(app);
}

/**
 * Open a persistent SSE connection and return helpers for inspecting the
 * accumulated response text and closing the socket.
 */
function connectSse(
  server: http.Server,
  token: string,
): Promise<{ getText: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const path = `/fleet/me/sse?token=${encodeURIComponent(token)}`;
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

/**
 * POST (or PATCH) to the server and return the parsed response.
 */
function httpRequest(
  server: http.Server,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Poll until condition() is true or the timeout elapses. */
function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("waitFor timed out"));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("SSE integration – real driverSse module", () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    server = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connected driver receives 'assignment' event when an order is assigned", async () => {
    // ── Set up DB mock sequence ───────────────────────────────────────────
    // Call 1: SSE endpoint token lookup
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ driver_id: DRIVER_ID, onboarding_status: "approved", deleted_at: null }],
        rowCount: 1,
      })
      // Call 2: assign-driver — order existence check
      .mockResolvedValueOnce({ rows: [makeOrderRow()], rowCount: 1 })
      // Call 3: assign-driver — driver approval check
      .mockResolvedValueOnce({ rows: [makeDriverRow()], rowCount: 1 })
      // Call 4: assign-driver — existing assignment check (none)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // Call 5: assign-driver — INSERT new assignment
      .mockResolvedValueOnce({ rows: [{ id: ASSIGNMENT_ID }], rowCount: 1 })
      // Call 6+: insertDriverNotification INSERT (fire-and-forget)
      .mockResolvedValue({ rows: [], rowCount: 0 });

    // ── Open SSE connection as the driver ────────────────────────────────
    const sse = await connectSse(server, FAKE_TOKEN);

    // Wait for the server's initial "connected" keep-alive comment.
    await waitFor(() => sse.getText().includes(": connected"));

    // ── Admin assigns the order to this driver ───────────────────────────
    const assignRes = await httpRequest(
      server,
      "PATCH",
      `/fleet/orders/${ORDER_ID}/assign-driver`,
      { driver_id: DRIVER_ID },
    );

    expect(assignRes.status).toBe(200);
    expect((assignRes.body as { success: boolean }).success).toBe(true);

    // ── Assert the SSE event arrived without a page reload ───────────────
    await waitFor(() => sse.getText().includes("event: assignment"));

    expect(sse.getText()).toContain("event: assignment");
    expect(sse.getText()).toContain("data: {}");

    sse.close();
  });

  it("driver receives 'assignment' event when an order is reassigned to them", async () => {
    const NEW_ASSIGNMENT_ID = 1002;
    const OTHER_DRIVER_ID = 99; // the driver being displaced

    mockDbQuery
      // Call 1: SSE token lookup for DRIVER_ID
      .mockResolvedValueOnce({
        rows: [{ driver_id: DRIVER_ID, onboarding_status: "approved", deleted_at: null }],
        rowCount: 1,
      })
      // Call 2: assign-driver — order existence check
      .mockResolvedValueOnce({ rows: [makeOrderRow()], rowCount: 1 })
      // Call 3: assign-driver — driver approval check (target driver)
      .mockResolvedValueOnce({ rows: [makeDriverRow()], rowCount: 1 })
      // Call 4: assign-driver — existing assignment (held by OTHER_DRIVER_ID)
      .mockResolvedValueOnce({
        rows: [{ id: NEW_ASSIGNMENT_ID, driver_id: OTHER_DRIVER_ID }],
        rowCount: 1,
      })
      // Call 5: UPDATE existing assignment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // Call 6: fetch expo_push_token for displaced driver
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 })
      // Call 7+: insertDriverNotification (fire-and-forget)
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const sse = await connectSse(server, FAKE_TOKEN);
    await waitFor(() => sse.getText().includes(": connected"));

    const assignRes = await httpRequest(
      server,
      "PATCH",
      `/fleet/orders/${ORDER_ID}/assign-driver`,
      { driver_id: DRIVER_ID },
    );

    expect(assignRes.status).toBe(200);

    await waitFor(() => sse.getText().includes("event: assignment"));

    expect(sse.getText()).toContain("event: assignment");
    expect(sse.getText()).toContain("data: {}");

    sse.close();
  });

  it("no SSE event is emitted when the order is not found", async () => {
    // SSE endpoint token lookup succeeds.
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ driver_id: DRIVER_ID, onboarding_status: "approved", deleted_at: null }],
        rowCount: 1,
      })
      // Order lookup returns nothing → 404.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const sse = await connectSse(server, FAKE_TOKEN);
    await waitFor(() => sse.getText().includes(": connected"));

    const textBefore = sse.getText();

    const assignRes = await httpRequest(
      server,
      "PATCH",
      `/fleet/orders/${ORDER_ID}/assign-driver`,
      { driver_id: DRIVER_ID },
    );

    expect(assignRes.status).toBe(404);

    // Give a brief window for any spurious SSE write to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sse.getText()).toBe(textBefore);

    sse.close();
  });

  it("SSE connection is rejected when the token is missing", async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const addr = server.address() as { port: number };
      const req = http.request(
        { host: "127.0.0.1", port: addr.port, path: "/fleet/me/sse", method: "GET" },
        (res) => resolve(res.statusCode!),
      );
      req.on("error", reject);
      req.end();
    });

    expect(result).toBe(401);
  });

  it("SSE connection is rejected when the token is invalid / not in DB", async () => {
    // DB returns no matching token row.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await new Promise<number>((resolve, reject) => {
      const addr = server.address() as { port: number };
      const path = `/fleet/me/sse?token=${encodeURIComponent(FAKE_TOKEN)}`;
      const req = http.request(
        { host: "127.0.0.1", port: addr.port, path, method: "GET" },
        (res) => resolve(res.statusCode!),
      );
      req.on("error", reject);
      req.end();
    });

    expect(result).toBe(401);
  });
});
