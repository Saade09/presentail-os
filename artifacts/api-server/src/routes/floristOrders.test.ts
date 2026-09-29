import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn().mockResolvedValue({
      query: (sql: unknown, ...args: unknown[]) => {
        if (
          sql === "BEGIN" ||
          sql === "COMMIT" ||
          sql === "ROLLBACK"
        ) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return mockDbQuery(sql, ...args);
      },
      release: vi.fn(),
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.userId = "user_abc";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockBroadcastEvent = vi.fn();
vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: (...args: unknown[]) => mockBroadcastEvent(...args),
}));

const mockNotifyFloristAssignmentAlerts = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/orderAlerts", () => ({
  notifyFloristAssignmentAlerts: (...args: unknown[]) =>
    mockNotifyFloristAssignmentAlerts(...args),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./orders", () => ({
  notifyOrderStatusEmail: vi.fn().mockResolvedValue(undefined),
  recordOrderEvent: vi.fn(),
}));

vi.mock("../lib/translation", () => ({
  translateDescriptionToArabic: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/giftCardPdf", () => ({
  buildGiftCardPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

import floristOrdersRouter from "./floristOrders";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, typeof mockReqLog> }).log = {
      error: mockReqLog,
      warn: mockReqLog,
      info: mockReqLog,
      debug: mockReqLog,
    };
    next();
  });
  app.use(floristOrdersRouter);
  return app;
}

const ORDER_ID = "11111111-2222-3333-4444-555555555555";

function orderRow(status = "preparing") {
  return {
    rows: [
      {
        id: ORDER_ID,
        status,
        external_order_id: null,
        display_order_number: "M-1005",
      },
    ],
    rowCount: 1,
  };
}

function assignmentRow(locationId: number) {
  return {
    rows: [
      {
        id: 1,
        order_id: ORDER_ID,
        location_id: locationId,
        status: "pending",
        started_at: null,
        completed_at: null,
        created_at: "2026-07-15T00:00:00Z",
        updated_at: "2026-07-15T00:00:00Z",
      },
    ],
    rowCount: 1,
  };
}

describe("POST /orders/:id/send-to-florist — florist assignment notifications", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("broadcasts order.assigned_to_florist and pushes to the florist location on a NEW assignment", async () => {
    mockDbQuery
      .mockResolvedValueOnce(orderRow()) // order lookup
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // location lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no previous assignment
      .mockResolvedValueOnce(assignmentRow(5)); // upsert

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/send-to-florist`)
      .send({ locationId: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(mockBroadcastEvent).toHaveBeenCalledTimes(1);
    expect(mockBroadcastEvent).toHaveBeenCalledWith("owner_123", {
      event: "order.assigned_to_florist",
      workspaceId: "owner_123",
      data: {
        id: ORDER_ID,
        displayOrderNumber: "M-1005",
        locationId: 5,
        assignedAt: expect.any(String),
      },
    });

    expect(mockNotifyFloristAssignmentAlerts).toHaveBeenCalledTimes(1);
    expect(mockNotifyFloristAssignmentAlerts).toHaveBeenCalledWith(
      "owner_123",
      ORDER_ID,
      5,
    );
  });

  it("does NOT notify when the order is re-sent to the same florist location", async () => {
    mockDbQuery
      .mockResolvedValueOnce(orderRow())
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ location_id: 5 }], rowCount: 1 }) // same location
      .mockResolvedValueOnce(assignmentRow(5));

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/send-to-florist`)
      .send({ locationId: 5 });

    expect(res.status).toBe(200);
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
    expect(mockNotifyFloristAssignmentAlerts).not.toHaveBeenCalled();
  });

  it("notifies the NEW location when the order is reassigned to a different florist", async () => {
    mockDbQuery
      .mockResolvedValueOnce(orderRow())
      .mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ location_id: 5 }], rowCount: 1 }) // previously location 5
      .mockResolvedValueOnce(assignmentRow(9));

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/send-to-florist`)
      .send({ locationId: 9 });

    expect(res.status).toBe(200);
    expect(mockBroadcastEvent).toHaveBeenCalledTimes(1);
    expect(mockBroadcastEvent.mock.calls[0][1]).toMatchObject({
      event: "order.assigned_to_florist",
      data: { id: ORDER_ID, locationId: 9 },
    });
    expect(mockNotifyFloristAssignmentAlerts).toHaveBeenCalledWith(
      "owner_123",
      ORDER_ID,
      9,
    );
  });

  it("still auto-advances a pending order to preparing after notifying", async () => {
    mockDbQuery
      .mockResolvedValueOnce(orderRow("pending"))
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce(assignmentRow(5))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // status UPDATE

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/send-to-florist`)
      .send({ locationId: 5 });

    expect(res.status).toBe(200);
    expect(mockBroadcastEvent).toHaveBeenCalledTimes(1);
    const updateCall = mockDbQuery.mock.calls[4];
    expect(String(updateCall[0])).toContain("SET status = 'preparing'");
  });

  it("rejects a completed parent without creating or reopening an assignment", async () => {
    mockDbQuery.mockResolvedValueOnce(orderRow("completed"));

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/send-to-florist`)
      .send({ locationId: 5 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("order_completed");
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(
      mockDbQuery.mock.calls.some(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO order_florist_assignments"),
      ),
    ).toBe(false);
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
    expect(mockNotifyFloristAssignmentAlerts).not.toHaveBeenCalled();
  });
});

describe("GET /florist-orders — image_url resolution", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("prefers a product public image over order_line_items.image_url when a product is linked", async () => {
    const FLORIST_ORDER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const PRODUCT_ID = 42;
    const RAW_GCS_URL = "https://storage.googleapis.com/my-bucket/img.jpg";
    const PRODUCT_IMAGE_URL = "/objects/products/42/main.jpg";
    const PRODUCT_PUBLIC_PATH = "products/42/main-display.webp";

    mockDbQuery
      // 1. florist assignments query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            order_id: FLORIST_ORDER_ID,
            order_number: "M-2001",
            location_id: 7,
            location_name: "Downtown",
            status: "pending",
            started_at: null,
            completed_at: null,
            created_at: "2026-07-20T10:00:00Z",
            updated_at: "2026-07-20T10:00:00Z",
            has_card: false,
            window_start: null,
            window_end: null,
          },
        ],
        rowCount: 1,
      })
      // 2. line items query — raw GCS URL stored at order-creation time
      .mockResolvedValueOnce({
        rows: [
          {
            order_id: FLORIST_ORDER_ID,
            name: "Rose Bouquet",
            quantity: 1,
            image_url: RAW_GCS_URL,
            custom_input: null,
            product_id: PRODUCT_ID,
            sku: null,
          },
        ],
        rowCount: 1,
      })
      // 3. recipes query (product is linked, so this runs)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // 4. product images/descriptions query
      .mockResolvedValueOnce({
        rows: [
          {
            id: PRODUCT_ID,
            main_image_url: PRODUCT_IMAGE_URL,
            image_public_path: "products/42/main.jpg",
            image_display_public_path: PRODUCT_PUBLIC_PATH,
            description: "Fresh roses",
            description_ar: "ورود طازجة",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).get("/florist-orders");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const items: { image_url: string | null }[] = res.body.florist_orders[0].items;
    expect(items).toHaveLength(1);
    expect(items[0].image_url).toBe(
      `https://os.presentail.com/api/storage/public-objects/${PRODUCT_PUBLIC_PATH}`,
    );
    expect(items[0].image_url).not.toBe(RAW_GCS_URL);
  });

  it("falls back to order_line_items.image_url when no product is linked", async () => {
    const FLORIST_ORDER_ID = "11111111-2222-3333-4444-000000000001";
    const LINE_ITEM_URL = "/objects/some-legacy-path.jpg";

    mockDbQuery
      // 1. florist assignments query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 2,
            order_id: FLORIST_ORDER_ID,
            order_number: "M-2002",
            location_id: 7,
            location_name: "Downtown",
            status: "pending",
            started_at: null,
            completed_at: null,
            created_at: "2026-07-20T10:00:00Z",
            updated_at: "2026-07-20T10:00:00Z",
            has_card: false,
            window_start: null,
            window_end: null,
          },
        ],
        rowCount: 1,
      })
      // 2. line items — no product_id, but has a stored image_url
      .mockResolvedValueOnce({
        rows: [
          {
            order_id: FLORIST_ORDER_ID,
            name: "Mystery Bundle",
            quantity: 2,
            image_url: LINE_ITEM_URL,
            custom_input: null,
            product_id: null,
            sku: null,
          },
        ],
        rowCount: 1,
      });
    // No further queries: productIds is empty (no linked product, no SKU/name to resolve)

    const res = await request(app).get("/florist-orders");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const items: { image_url: string | null }[] = res.body.florist_orders[0].items;
    expect(items).toHaveLength(1);
    expect(items[0].image_url).toBe(LINE_ITEM_URL);
  });
});
