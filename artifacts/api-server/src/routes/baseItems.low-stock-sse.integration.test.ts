/**
 * Integration test: verifies that submitting a stock adjustment that crosses
 * the low-stock threshold causes the SSE stream to emit a `low_stock` event.
 *
 * Everything except lowStockSse is mocked, so the full crossing-guard logic
 * inside fireAndForgetLowStockAlert runs against a deterministic set of mock
 * DB rows, and the REAL subscribeToLowStock / broadcastLowStock pipeline
 * delivers the event to the connected HTTP client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — everything EXCEPT lowStockSse
// ---------------------------------------------------------------------------

const { mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  return { mockDbQuery };
});

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn(),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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

vi.mock("../lib/email", () => ({
  sendLowStockAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {},
}));

let stubWorkspaceOwnerId = "workspace_low_stock_test";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubUserId = "user_owner_test";
let stubUserEmail: string | null = "owner@example.com";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import baseItemsRouter from "./baseItems";

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------

function makeServer() {
  const app = express();
  app.use(express.json());
  app.use(baseItemsRouter);
  return http.createServer(app);
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from accessRequests.sse.integration.test.ts)
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

function post(
  server: http.Server,
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
        method: "POST",
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

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
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
// Fixtures
// ---------------------------------------------------------------------------

/** Seed all DB mocks for the POST /base-items/1/adjustments happy path.
 *
 * Route queries (in order):
 *   1. existing item check        → { id:1, stock:"10" }
 *   2. location + current stock   → { location_id:5, stock:"10", location_name:"Warehouse A" }
 *   3. upsert location stock      → { rowCount:1 }
 *   4. sum total stock            → { rows:[{ total:"2" }] }
 *   5. update base_items.stock    → { rowCount:1 }
 *   6. insert adjustment RETURNING → adjustment row
 *
 * fireAndForgetLowStockAlert queries (async, after response):
 *   7. SELECT item name           → { name:"Ficus Plant" }
 *   8. SELECT location details    → { location_name:"Warehouse A", country:"AE", loc_threshold:"5" }
 *   9. SELECT country threshold   → { rowCount:0 } (none)
 *  10. INSERT dedup RETURNING id  → { rows:[{id:1}], rowCount:1 } (passes dedup)
 *  11. SELECT email recipients    → { rows:[{member_email:"owner@example.com"}] }
 */
function seedCrossingScenario() {
  mockDbQuery
    // 1. item exists, global stock=10
    .mockResolvedValueOnce({ rows: [{ id: 1, stock: "10" }], rowCount: 1 })
    // 2. active location, current location stock=10
    .mockResolvedValueOnce({
      rows: [{ location_id: 5, stock: "10", location_name: "Warehouse A" }],
      rowCount: 1,
    })
    // 3. upsert location stock
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    // 4. sum total stock across all locations → 2 after adjustment
    .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 })
    // 5. update base_items.stock
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    // 6. insert adjustment record
    .mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          workspace_owner_id: stubWorkspaceOwnerId,
          base_item_id: 1,
          quantity_change: -8,
          reason: "correction",
          movement_type: null,
          note: null,
          stock_after: 2,
          created_by_user_id: stubUserId,
          location_id: 5,
          created_at: new Date().toISOString(),
          transfer_id: null,
        },
      ],
      rowCount: 1,
    })
    // 7. (fireAndForgetLowStockAlert) fetch item name
    .mockResolvedValueOnce({ rows: [{ name: "Ficus Plant" }], rowCount: 1 })
    // 8. fetch location name + country + per-location threshold (loc_threshold=5 > 0)
    .mockResolvedValueOnce({
      rows: [{ location_name: "Warehouse A", country: "AE", loc_threshold: "5" }],
      rowCount: 1,
    })
    // 9. no country-level threshold
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    // 10. dedup INSERT returns a row → alert is new, not suppressed
    .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
    // 11. email recipients
    .mockResolvedValueOnce({
      rows: [{ member_email: "owner@example.com" }],
      rowCount: 1,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("baseItems low-stock SSE integration — crossing transition fires low_stock event", () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "workspace_low_stock_test";
    stubUserId = "user_owner_test";
    stubUserEmail = "owner@example.com";

    server = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("SSE subscriber receives 'low_stock' event after a stock adjustment crosses the threshold", async () => {
    seedCrossingScenario();

    const sse = await connectSse(server, "/base-items/low-stock-events");

    // Wait for SSE connection confirmation
    await waitFor(() => sse.getText().includes(": connected"));

    // POST an adjustment: stock goes from 10 → 2, threshold is 5 → crossing
    const response = await post(server, "/base-items/1/adjustments", {
      quantity_change: -8,
      reason: "correction",
      location_id: 5,
    });

    expect(response.status).toBe(201);

    // Wait for the async fireAndForgetLowStockAlert to broadcast
    await waitFor(() => sse.getText().includes("event: low_stock"));

    const text = sse.getText();
    expect(text).toContain("event: low_stock");
    expect(text).toContain(`"itemName":"Ficus Plant"`);
    expect(text).toContain(`"locationName":"Warehouse A"`);
    expect(text).toContain(`"currentStock":2`);
    expect(text).toContain(`"baseItemId":1`);

    sse.close();
  });

  it("SSE subscriber does NOT receive an event when stock adjustment does not cross the threshold", async () => {
    // Stock goes from 3 → 2 (already below threshold of 5 — no new crossing)
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, stock: "3" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ location_id: 5, stock: "3", location_name: "Warehouse A" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 43,
            workspace_owner_id: stubWorkspaceOwnerId,
            base_item_id: 1,
            quantity_change: -1,
            reason: "correction",
            movement_type: null,
            note: null,
            stock_after: 2,
            created_by_user_id: stubUserId,
            location_id: 5,
            created_at: new Date().toISOString(),
            transfer_id: null,
          },
        ],
        rowCount: 1,
      })
      // fireAndForgetLowStockAlert: item exists, location ok, threshold = 5
      .mockResolvedValueOnce({ rows: [{ name: "Ficus Plant" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ location_name: "Warehouse A", country: "AE", loc_threshold: "5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // No further calls expected because the crossing guard exits early

    const sse = await connectSse(server, "/base-items/low-stock-events");

    await waitFor(() => sse.getText().includes(": connected"));

    const initialText = sse.getText();

    await post(server, "/base-items/1/adjustments", {
      quantity_change: -1,
      reason: "correction",
      location_id: 5,
    });

    // Brief pause to confirm no event arrives
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sse.getText()).toBe(initialText);

    sse.close();
  });

  it("dedup: SSE event is suppressed when the dedup INSERT returns no row (alert already sent < 24 h ago)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, stock: "10" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ location_id: 5, stock: "10", location_name: "Warehouse A" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 44,
            workspace_owner_id: stubWorkspaceOwnerId,
            base_item_id: 1,
            quantity_change: -8,
            reason: "correction",
            movement_type: null,
            note: null,
            stock_after: 2,
            created_by_user_id: stubUserId,
            location_id: 5,
            created_at: new Date().toISOString(),
            transfer_id: null,
          },
        ],
        rowCount: 1,
      })
      // fireAndForgetLowStockAlert: item + location queries succeed
      .mockResolvedValueOnce({ rows: [{ name: "Ficus Plant" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ location_name: "Warehouse A", country: "AE", loc_threshold: "5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // dedup INSERT returns EMPTY → alert was already sent < 24h ago → abort
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const sse = await connectSse(server, "/base-items/low-stock-events");

    await waitFor(() => sse.getText().includes(": connected"));

    const initialText = sse.getText();

    await post(server, "/base-items/1/adjustments", {
      quantity_change: -8,
      reason: "correction",
      location_id: 5,
    });

    // Short pause to confirm no event broadcasts when dedup blocks it
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sse.getText()).toBe(initialText);

    sse.close();
  });
});
