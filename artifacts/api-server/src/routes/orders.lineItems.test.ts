import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockDbConnect = vi.fn(async () => ({
  query: (...args: unknown[]) => mockClientQuery(...args),
  release: (...args: unknown[]) => mockClientRelease(...args),
}));

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockDbConnect(),
  },
  // Run the transactional callback immediately for unit tests.
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { mockRefundsCreate, MockStripeError } = vi.hoisted(() => {
  class MockStripeError extends Error {}
  return { mockRefundsCreate: vi.fn(), MockStripeError };
});

vi.mock("stripe", () => {
  class StripeMock {
    refunds = { create: (...args: unknown[]) => mockRefundsCreate(...args) };
    static errors = { StripeError: MockStripeError };
  }
  return { default: StripeMock };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubAllowedPages: string[] | null = null;
let stubUserId = "user_editor_1";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.allowedPages = stubAllowedPages;
    wreq.userId = stubUserId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn(),
}));

vi.mock("../lib/email", () => ({
  sendOrderStatusEmail: vi.fn().mockResolvedValue(undefined),
  ORDER_STATUS_EMAIL_STATUSES: new Set([
    "processing",
    "ready_for_delivery",
    "out_for_delivery",
    "completed",
  ]),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn().mockResolvedValue({
        firstName: "Test",
        lastName: "Editor",
        primaryEmailAddress: { emailAddress: "editor@example.com" },
      }),
    },
  },
}));

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: vi.fn(),
  retryTookanDeliveryTask: vi.fn(),
  backfillTookanDeliveryTasks: vi.fn(),
  editTookanDeliveryTask: vi.fn(),
}));

import ordersRouter from "./orders";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...a: unknown[]) => void> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use(ordersRouter);
  return app;
}

const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const ITEM_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ITEM_ID = "33333333-3333-3333-3333-333333333333";

function orderLockRow(
  totals: Record<string, unknown> | null = { subtotal: 50, total: 55, shipping: 5 },
  status: string = "processing",
  extra: {
    tookan_status?: string | null;
    fleet_assignment_status?: string | null;
    payment_currency?: string | null;
    payment_amount?: string | number | null;
    payment_amount_usd?: string | number | null;
  } = {},
) {
  return {
    rows: [
      {
        id: ORDER_ID,
        totals,
        status,
        tookan_status: extra.tookan_status ?? null,
        fleet_assignment_status: extra.fleet_assignment_status ?? null,
        payment_currency: extra.payment_currency ?? null,
        payment_amount: extra.payment_amount ?? null,
        payment_amount_usd: extra.payment_amount_usd ?? null,
      },
    ],
    rowCount: 1,
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        id: 42,
        name: "Red Roses",
        sku: "ROSE-42",
        price_usd: "30.00",
        discount_price_usd: null,
        main_image_url: "/objects/owner_123/products/rose.png",
        image_public_path: "products/42",
        ...overrides,
      },
    ],
    rowCount: 1,
  };
}

function lineItemRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        id: ITEM_ID,
        order_id: ORDER_ID,
        product_id: 42,
        name: "Red Roses",
        sku: "ROSE-42",
        quantity: 2,
        unit_price: "30.00",
        line_total: "60.00",
        image_url: null,
        custom_input: null,
        ...overrides,
      },
    ],
    rowCount: 1,
  };
}

const emptyResult = { rows: [], rowCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  stubWorkspaceOwnerId = "owner_123";
  stubActualRole = "owner";
  stubAllowedPages = null;
  stubUserId = "user_editor_1";
  // recordOrderEvent fire-and-forget insert
  mockDbQuery.mockResolvedValue(emptyResult);
});

describe("GET /orders/:id/line-items", () => {
  it("returns market-filtered products with one resolved order-currency price", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          totals: { total: 100, paid_total: 375, paid_currency: "SAR" },
          delivery_address: { countryCode: "AE" },
          payment_currency: null,
          payment_amount: null,
          payment_amount_usd: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
      .mockResolvedValueOnce(productRow());

    const res = await request(makeApp()).get(`/orders/${ORDER_ID}/line-items?q=rose`);

    expect(res.status).toBe(200);
    expect(res.body.market).toEqual(expect.objectContaining({
      label: "United Arab Emirates catalog",
      country_code: "AE",
      currency: "SAR",
    }));
    expect(res.body.products[0]).toEqual(expect.objectContaining({
      id: 42,
      unit_price: 112.5,
      currency: "SAR",
      available: true,
    }));
    const productSql = String(mockDbQuery.mock.calls[2][0]);
    expect(productSql).toContain("product_country_availability");
    expect(productSql).toContain("product_city_availability");
    expect(productSql).toContain("p.sku ILIKE");
    expect(productSql).toContain("pp.public_title ILIKE");
  });

  it("keeps a product visible but unavailable when its order-currency price cannot be resolved", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          totals: { total: 0, paid_currency: "SAR" },
          delivery_address: { countryCode: "AE" },
          payment_currency: null,
          payment_amount: null,
          payment_amount_usd: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
      .mockResolvedValueOnce(productRow());

    const res = await request(makeApp()).get(`/orders/${ORDER_ID}/line-items`);

    expect(res.status).toBe(200);
    expect(res.body.products[0]).toEqual(expect.objectContaining({
      unit_price: null,
      available: false,
      status: "unavailable_price",
      price_error: "Price unavailable for this order currency",
    }));
  });

  it("blocks the picker when totals and payment currencies conflict", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        totals: { total: 100, paid_total: 375, paid_currency: "SAR" },
        delivery_address: { countryCode: "AE" },
        payment_currency: "AED",
        payment_amount: 367,
        payment_amount_usd: 100,
      }],
      rowCount: 1,
    });

    const res = await request(makeApp()).get(`/orders/${ORDER_ID}/line-items`);

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Order currency is inconsistent");
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/line-items
// ---------------------------------------------------------------------------

describe("POST /orders/:id/line-items", () => {
  it("adds a product, recomputes totals, and records an event", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow()) // lock order
      .mockResolvedValueOnce(productRow()) // load product
      .mockResolvedValueOnce(lineItemRow()) // INSERT RETURNING
      .mockResolvedValueOnce({ rows: [{ subtotal: "110.00" }], rowCount: 1 }) // SUM(line_total)
      .mockResolvedValueOnce(emptyResult); // UPDATE orders totals

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.line_item.name).toBe("Red Roses");
    // subtotal 110 + shipping 5 = 115
    expect(res.body.totals.subtotal).toBe(110);
    expect(res.body.totals.total).toBe(115);
    expect(res.body.totals.shipping).toBe(5);

    // INSERT used product-captured pricing: unit 30, line_total 60
    const insertCall = mockClientQuery.mock.calls[2];
    expect(insertCall[0]).toContain("INSERT INTO order_line_items");
    expect(insertCall[1]).toEqual(
      expect.arrayContaining([ORDER_ID, 42, "Red Roses", "ROSE-42", 2, 30, 60]),
    );

    // fire-and-forget event insert
    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_added"]),
      );
    });
  });

  it("uses the discount price when set", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(productRow({ discount_price_usd: "25.50" }))
      .mockResolvedValueOnce(lineItemRow())
      .mockResolvedValueOnce({ rows: [{ subtotal: "25.50" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls[2];
    expect(insertCall[1]).toEqual(expect.arrayContaining([25.5]));
  });

  it("caps custom_input handling via normalization (trims to null)", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce(lineItemRow())
      .mockResolvedValueOnce({ rows: [{ subtotal: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 2, custom_input: "   " });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls[2];
    expect(insertCall[1][8]).toBeNull();
  });

  it("404s when the order is not in the workspace", async () => {
    mockClientQuery.mockResolvedValueOnce(emptyResult); // lock finds nothing

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Order not found");
  });

  it("404s when the product does not exist", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(emptyResult) // eligible product lookup
      .mockResolvedValueOnce(emptyResult); // product existence lookup

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 999, quantity: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Product not found");
  });

  it("400s on an invalid payload", async () => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 0 });

    expect(res.status).toBe(400);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("400s when custom_input exceeds 22 characters", async () => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, custom_input: "x".repeat(23) });

    expect(res.status).toBe(400);
  });

  it("403s for a member without the orders page", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["products"];

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(403);
  });

  it("409s when the order is completed", async () => {
    mockClientQuery.mockResolvedValueOnce(orderLockRow(undefined, "completed"));

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Line items cannot be modified on a completed order");
    // no INSERT issued
    const insertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_line_items"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("409s when the order has the legacy delivered status", async () => {
    mockClientQuery.mockResolvedValueOnce(orderLockRow(undefined, "delivered"));

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Line items cannot be modified on a completed order");
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/line-items — complimentary
// ---------------------------------------------------------------------------

describe("POST /orders/:id/line-items — complimentary", () => {
  it("adds a complimentary item at $0, capturing the catalog price/reason and recording a distinct event", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(productRow()) // catalog price $30
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          quantity: 2,
          unit_price: "0.00",
          line_total: "0.00",
          is_complimentary: true,
          complimentary_original_price: "30.00",
          complimentary_reason: "customer_service_gesture",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00", complimentary_value: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({
        product_id: 42,
        quantity: 2,
        complimentary: { reason: "customer_service_gesture" },
      });

    expect(res.status).toBe(201);

    // Selling price is forced to $0 while the catalog price is preserved
    // separately as the immutable original value.
    const insertCall = mockClientQuery.mock.calls[3];
    expect(insertCall[0]).toContain("is_complimentary");
    expect(insertCall[1][5]).toBe(0); // unit_price
    expect(insertCall[1][6]).toBe(0); // line_total
    expect(insertCall[1][12]).toBe(true); // is_complimentary
    expect(insertCall[1][13]).toBe(30); // complimentary_original_price (catalog price)
    expect(insertCall[1][14]).toBe("customer_service_gesture");
    expect(insertCall[1][15]).toBeNull(); // no note supplied
    expect(insertCall[1][16]).toBe("Test Editor"); // resolved actor display name
    expect(insertCall[1][17]).toBeInstanceOf(Date);

    // Merchandise subtotal shows full retail value; complimentary_total is
    // the negative deduction; the customer-owed subtotal/total stay at $0
    // extra (this order has no other items in the SUM mock).
    expect(res.body.totals.subtotal).toBe(0);
    expect(res.body.totals.merchandise_subtotal).toBe(60);
    expect(res.body.totals.complimentary_total).toBe(-60);

    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_complimentary_added"]),
      );
      const payload = JSON.parse(eventCall![1][3] as string);
      expect(payload).toMatchObject({
        name: "Red Roses",
        quantity: 2,
        reason: "customer_service_gesture",
        original_value: 60,
      });
    });
  });

  it("keeps a fully paid order's customer total unchanged when a complimentary item is added", async () => {
    // Order already totals $854 (fully paid). Adding 4 complimentary
    // balloons worth $7.50 each ($30 retail) must not change totals.total —
    // it stays a $0 gesture layered on top of the existing paid amount.
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ subtotal: 854, total: 854, shipping: 0 }))
      .mockResolvedValueOnce(productRow({ price_usd: "7.50" }))
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          name: "Red Heart Balloons",
          quantity: 4,
          unit_price: "0.00",
          line_total: "0.00",
          is_complimentary: true,
          complimentary_original_price: "7.50",
          complimentary_reason: "customer_service_gesture",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ subtotal: "854.00", complimentary_value: "30.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({
        product_id: 42,
        quantity: 4,
        complimentary: { reason: "customer_service_gesture" },
      });

    expect(res.status).toBe(201);
    expect(res.body.totals.subtotal).toBe(854);
    expect(res.body.totals.total).toBe(854); // unchanged — nothing new is owed
    expect(res.body.totals.merchandise_subtotal).toBe(884);
    expect(res.body.totals.complimentary_total).toBe(-30);
  });

  it("aggregates multiple complimentary items into a single complimentary_total", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ subtotal: 100, total: 100, shipping: 0 }))
      .mockResolvedValueOnce(productRow({ price_usd: "10.00" }))
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          unit_price: "0.00",
          line_total: "0.00",
          is_complimentary: true,
          complimentary_original_price: "10.00",
        }),
      )
      // Two prior complimentary lines ($15 total) plus this new $10 one.
      .mockResolvedValueOnce({ rows: [{ subtotal: "100.00", complimentary_value: "25.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "vip_gesture" } });

    expect(res.status).toBe(201);
    expect(res.body.totals.merchandise_subtotal).toBe(125);
    expect(res.body.totals.complimentary_total).toBe(-25);
  });

  it("400s when reason is 'other' without a note", async () => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "other" } });

    expect(res.status).toBe(400);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("400s when reason is 'other' with a blank note", async () => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "other", note: "   " } });

    expect(res.status).toBe(400);
  });

  it("accepts an 'other' reason once a note is provided", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          unit_price: "0.00",
          line_total: "0.00",
          is_complimentary: true,
          complimentary_original_price: "30.00",
          complimentary_reason: "other",
          complimentary_note: "Wrong item shipped last time",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00", complimentary_value: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({
        product_id: 42,
        quantity: 2,
        complimentary: { reason: "other", note: "Wrong item shipped last time" },
      });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls[3];
    expect(insertCall[1][14]).toBe("other");
    expect(insertCall[1][15]).toBe("Wrong item shipped last time");
  });

  it("400s on an invalid complimentary reason", async () => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "not_a_real_reason" } });

    expect(res.status).toBe(400);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("409s adding a complimentary item once the order is ready_for_delivery and recipe consumption has been posted", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "vip_gesture" } });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
  });

  it("409s adding a complimentary item after the order moved on from ready_for_delivery, since consumption is still posted", async () => {
    // The order transitioned past ready_for_delivery (e.g. put on_hold) but its
    // posted consumption was never reversed — the lock must key off that durable
    // evidence, not the order's current status.
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "on_hold"))
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "vip_gesture" } });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
  });

  it("409s adding a complimentary item once consumption is posted even if recipe consumption is later disabled workspace-wide", async () => {
    // The workspace flag no longer being enabled must not reopen the lock on an
    // order whose stock was already deducted while the flag was on.
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1, complimentary: { reason: "vip_gesture" } });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
  });

  it("still allows adding a complimentary item on a ready_for_delivery order when no consumption has been posted for it", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          unit_price: "0.00",
          line_total: "0.00",
          is_complimentary: true,
          complimentary_original_price: "30.00",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00", complimentary_value: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 2, complimentary: { reason: "vip_gesture" } });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Out-for-delivery lock (all three delivery signals)
// ---------------------------------------------------------------------------

describe("line-item lock when out for delivery", () => {
  const OUT_FOR_DELIVERY_ERROR =
    "Line items cannot be modified while the order is out for delivery";

  it("409s when the order status is out_for_delivery", async () => {
    mockClientQuery.mockResolvedValueOnce(orderLockRow(undefined, "out_for_delivery"));

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(OUT_FOR_DELIVERY_ERROR);
  });

  it.each(["started", "in_progress", "arrived"])(
    "409s when the Tookan status is %s",
    async (tookanStatus) => {
      mockClientQuery.mockResolvedValueOnce(
        orderLockRow(undefined, "processing", { tookan_status: tookanStatus }),
      );

      const res = await request(makeApp())
        .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
        .send({ quantity: 3 });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(OUT_FOR_DELIVERY_ERROR);
    },
  );

  it.each(["picked_up", "out_for_delivery"])(
    "409s when the fleet assignment status is %s",
    async (fleetStatus) => {
      mockClientQuery.mockResolvedValueOnce(
        orderLockRow(undefined, "processing", { fleet_assignment_status: fleetStatus }),
      );

      const res = await request(makeApp()).delete(
        `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(OUT_FOR_DELIVERY_ERROR);
    },
  );

  it("still allows edits before pickup (Tookan assigned, fleet accepted)", async () => {
    mockClientQuery
      .mockResolvedValueOnce(
        orderLockRow(undefined, "ready_for_delivery", {
          tookan_status: "assigned",
          fleet_assignment_status: "accepted",
        }),
      )
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce(lineItemRow())
      .mockResolvedValueOnce({ rows: [{ subtotal: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 2 });

    expect(res.status).toBe(201);
  });

  it("keeps the completed message when the order is completed AND out for delivery signals exist", async () => {
    mockClientQuery.mockResolvedValueOnce(
      orderLockRow(undefined, "completed", { tookan_status: "started" }),
    );

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Line items cannot be modified on a completed order");
  });
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id/line-items/:itemId
// ---------------------------------------------------------------------------

describe("PATCH /orders/:id/line-items/:itemId", () => {
  it("changes quantity, recomputes line_total and totals, records event", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow()) // lock order
      .mockResolvedValueOnce(lineItemRow()) // existing item (qty 2, unit 30)
      .mockResolvedValueOnce(lineItemRow({ quantity: 5, line_total: "150.00" })) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [{ subtotal: "150.00" }], rowCount: 1 }) // SUM
      .mockResolvedValueOnce(emptyResult); // UPDATE totals

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body.totals.subtotal).toBe(150);
    expect(res.body.totals.total).toBe(155);

    // simple UPDATE path: quantity 5, line_total 150
    const updateCall = mockClientQuery.mock.calls[2];
    expect(updateCall[0]).toContain("SET quantity");
    expect(updateCall[1]).toEqual([ITEM_ID, ORDER_ID, 5, 150, null, null, null, null, null, null]);

    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_quantity_changed"]),
      );
    });
  });

  it("replaces the product, re-capturing name/sku/price", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(lineItemRow()) // existing "Red Roses" qty 2
      .mockResolvedValueOnce(
        productRow({ id: 77, name: "White Lilies", sku: "LILY-77", price_usd: "40.00" }),
      ) // replacement product
      .mockResolvedValueOnce(
        lineItemRow({ product_id: 77, name: "White Lilies", unit_price: "40.00", line_total: "80.00" }),
      ) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [{ subtotal: "80.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ product_id: 77 });

    expect(res.status).toBe(200);
    expect(res.body.line_item.name).toBe("White Lilies");

    const updateCall = mockClientQuery.mock.calls[3];
    expect(updateCall[0]).toContain("SET product_id");
    // quantity kept at 2, unit 40 → line_total 80
    expect(updateCall[1]).toEqual(
      expect.arrayContaining([ITEM_ID, ORDER_ID, 77, "White Lilies", "LILY-77", 40, 2, 80]),
    );

    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_replaced"]),
      );
    });
  });

  it("edits the custom input and records the event", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(lineItemRow({ custom_input: "Old text" }))
      .mockResolvedValueOnce(lineItemRow({ custom_input: "New text" }))
      .mockResolvedValueOnce({ rows: [{ subtotal: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ custom_input: "New text" });

    expect(res.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls[2];
    expect(updateCall[1]).toEqual([ITEM_ID, ORDER_ID, 2, 60, "New text", null, null, null, null, null]);

    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_custom_input_changed"]),
      );
    });
  });

  it("does not record an event when quantity is unchanged", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(lineItemRow()) // qty already 2
      .mockResolvedValueOnce(lineItemRow())
      .mockResolvedValueOnce({ rows: [{ subtotal: "60.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    // allow any pending fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));
    const eventCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
    );
    expect(eventCall).toBeUndefined();
  });

  it("404s when the line item is missing", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(emptyResult); // item lookup

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 3 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Line item not found");
  });

  it("400s when no editable field is provided", async () => {
    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("409s when the order is completed", async () => {
    mockClientQuery.mockResolvedValueOnce(orderLockRow(undefined, "completed"));

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Line items cannot be modified on a completed order");
    // no UPDATE issued
    const updateCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("UPDATE order_line_items"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("rejects replacing the product on a complimentary line item (immutable — remove and re-add instead)", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "30.00",
        }),
      );

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ product_id: 77 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/can't be replaced or repriced/);
    const updateCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("UPDATE order_line_items"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("rejects a direct unit_price edit on a complimentary line item", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "30.00",
        }),
      );

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ unit_price: 25 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/can't be replaced or repriced/);
    const updateCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("UPDATE order_line_items"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("still allows a quantity-only edit on a complimentary line item and keeps its price at $0.00", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          quantity: 4,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "7.50",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          quantity: 6,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "7.50",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 6 });

    expect(res.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls[3];
    expect(updateCall[0]).toContain("SET quantity");
    // quantity 6, line_total stays 0 (unit price preserved at $0.00)
    expect(updateCall[1]).toEqual([ITEM_ID, ORDER_ID, 6, 0, null, null, null, null, null, null]);
  });

  it("409s a complimentary quantity edit once the order is ready_for_delivery and recipe consumption has been posted", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          quantity: 4,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "7.50",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 6 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
    const updateCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("UPDATE order_line_items"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("409s a complimentary quantity edit after the order moved on from ready_for_delivery, since consumption is still posted", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "processing"))
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          quantity: 4,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "7.50",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 6 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
  });

  it("still allows a complimentary quantity edit on a ready_for_delivery order when no consumption has been posted for it", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          quantity: 4,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "7.50",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce(
        lineItemRow({
          is_complimentary: true,
          quantity: 6,
          unit_price: "0.00",
          line_total: "0.00",
          complimentary_original_price: "7.50",
        }),
      )
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 6 });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Paid-currency line pricing maintenance on edit
// ---------------------------------------------------------------------------

describe("paid-currency line price maintenance", () => {
  const PAID_TOTALS = {
    subtotal: 140,
    total: 155,
    shipping: 15,
    paid_currency: "EUR",
    paid_total: 155,
    paid_subtotal: 140,
    paid_shipping: 15,
  };

  it("keeps paid_unit_price and rescales paid_line_total on a quantity-only change", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ ...PAID_TOTALS }))
      .mockResolvedValueOnce(
        lineItemRow({ paid_unit_price: "15.00", paid_line_total: "30.00" }),
      ) // existing (qty 2)
      .mockResolvedValueOnce(
        lineItemRow({ quantity: 3, line_total: "90.00", paid_unit_price: "15.00", paid_line_total: "45.00" }),
      ) // UPDATE RETURNING
      .mockResolvedValueOnce({
        rows: [{ subtotal: "90.00", paid_subtotal: "45.00", unpaid_lines: 0, total_lines: 1 }],
        rowCount: 1,
      }) // SUM
      .mockResolvedValueOnce(emptyResult); // UPDATE totals

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls[2];
    expect(updateCall[0]).toContain("paid_unit_price = $9");
    // quantity 3 → line_total 90, paid_unit_price kept 15, paid_line_total 45
    expect(updateCall[1]).toEqual([ITEM_ID, ORDER_ID, 3, 90, null, null, null, null, 15, 45]);
    // paid_subtotal recomputed from SUM(paid_line_total)
    expect(res.body.totals.paid_subtotal).toBe(45);
    expect(res.body.totals.paid_total).toBe(155); // untouched charge record
  });

  it("clears paid pricing when the USD unit price is edited", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ ...PAID_TOTALS }))
      .mockResolvedValueOnce(
        lineItemRow({ paid_unit_price: "15.00", paid_line_total: "30.00" }),
      )
      .mockResolvedValueOnce(lineItemRow({ unit_price: "50.00", line_total: "100.00" }))
      .mockResolvedValueOnce({
        rows: [{ subtotal: "100.00", paid_subtotal: "0", unpaid_lines: 1, total_lines: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ unit_price: 50 });

    expect(res.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls[2];
    // paid_unit_price / paid_line_total cleared to NULL
    expect(updateCall[1]).toEqual([ITEM_ID, ORDER_ID, 2, 100, null, null, 50, null, null, null]);
    // paid_subtotal removed — explicit fallback to base pricing
    expect(res.body.totals.paid_subtotal).toBeUndefined();
  });

  it("clears paid pricing when the product is replaced", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ ...PAID_TOTALS }))
      .mockResolvedValueOnce(
        lineItemRow({ paid_unit_price: "15.00", paid_line_total: "30.00" }),
      )
      .mockResolvedValueOnce(
        productRow({ id: 77, name: "White Lilies", sku: "LILY-77", price_usd: "40.00" }),
      )
      .mockResolvedValueOnce(
        lineItemRow({ product_id: 77, name: "White Lilies", unit_price: "40.00", line_total: "80.00" }),
      )
      .mockResolvedValueOnce({
        rows: [{ subtotal: "80.00", paid_subtotal: "0", unpaid_lines: 1, total_lines: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .patch(`/orders/${ORDER_ID}/line-items/${ITEM_ID}`)
      .send({ product_id: 77 });

    expect(res.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls[3];
    expect(updateCall[0]).toContain("paid_unit_price = NULL, paid_line_total = NULL");
    expect(res.body.totals.paid_subtotal).toBeUndefined();
  });

  it("updates the commercial paid-currency subtotal without changing money already collected", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ ...PAID_TOTALS }))
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce(lineItemRow())
      .mockResolvedValueOnce({
        rows: [{ subtotal: "170.00", paid_subtotal: "90.00", unpaid_lines: 0, total_lines: 2 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.totals.paid_subtotal).toBe(90);
    expect(res.body.totals.paid_total).toBe(155);
    expect(res.body.totals.paid_shipping).toBe(15);
    const insertCall = mockClientQuery.mock.calls[2];
    expect(insertCall[1][7]).toBe(30);
    expect(insertCall[1][8]).toBe(60);
  });

  it("normalizes a payment-row-only currency and persists matching line prices", async () => {
    mockClientQuery
      .mockResolvedValueOnce(
        orderLockRow(
          { subtotal: 40, total: 40 },
          "processing",
          { payment_currency: "SAR", payment_amount: 150, payment_amount_usd: 40 },
        ),
      )
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce(lineItemRow({ paid_unit_price: "112.50", paid_line_total: "112.50" }))
      .mockResolvedValueOnce({
        rows: [{ subtotal: "70.00", paid_subtotal: "262.50", unpaid_lines: 0, total_lines: 2 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls[2];
    expect(insertCall[1][7]).toBe(112.5);
    expect(insertCall[1][8]).toBe(112.5);
    expect(res.body.totals.paid_currency).toBe("SAR");
    expect(res.body.totals.paid_subtotal).toBe(262.5);
    expect(res.body.totals.paid_total).toBeUndefined();
  });

  it("keeps three-decimal order-currency precision in line and subtotal amounts", async () => {
    mockClientQuery
      .mockResolvedValueOnce(
        orderLockRow(
          { subtotal: 70, total: 70, paid_currency: "KWD", paid_subtotal: 5.555 },
          "processing",
          { payment_currency: "KWD", payment_amount: 33.335, payment_amount_usd: 100 },
        ),
      )
      .mockResolvedValueOnce(productRow())
      .mockResolvedValueOnce(lineItemRow({ paid_unit_price: "10.001", paid_line_total: "10.001" }))
      .mockResolvedValueOnce({
        rows: [{ subtotal: "100.00", paid_subtotal: "15.556", unpaid_lines: 0, total_lines: 2 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/line-items`)
      .send({ product_id: 42, quantity: 1 });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls[2];
    expect(insertCall[1][7]).toBe(10.001);
    expect(insertCall[1][8]).toBe(10.001);
    expect(res.body.totals.paid_subtotal).toBe(15.556);
  });

  it("recomputes paid_subtotal after removing an item when all remaining lines have paid totals", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ ...PAID_TOTALS }))
      .mockResolvedValueOnce({
        rows: [{ id: ITEM_ID, name: "Red Roses", quantity: 2 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult) // DELETE
      .mockResolvedValueOnce({
        rows: [{ subtotal: "65.00", paid_subtotal: "75.00", unpaid_lines: 0, total_lines: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totals.paid_subtotal).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// DELETE /orders/:id/line-items/:itemId
// ---------------------------------------------------------------------------

describe("DELETE /orders/:id/line-items/:itemId", () => {
  it("removes an item, recomputes totals, and records an event", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow()) // lock order
      .mockResolvedValueOnce({
        rows: [{ id: ITEM_ID, name: "Red Roses", quantity: 2 }],
        rowCount: 1,
      }) // existing item
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 }) // COUNT
      .mockResolvedValueOnce(emptyResult) // DELETE
      .mockResolvedValueOnce({ rows: [{ subtotal: "30.00" }], rowCount: 1 }) // SUM
      .mockResolvedValueOnce(emptyResult); // UPDATE totals

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totals.subtotal).toBe(30);
    expect(res.body.totals.total).toBe(35);

    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_removed"]),
      );
    });
  });

  it("409s when removing the last remaining item", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce({
        rows: [{ id: OTHER_ITEM_ID, name: "Red Roses", quantity: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 }); // COUNT = 1

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${OTHER_ITEM_ID}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cannot remove the last item on an order");
    // no DELETE issued
    const deleteCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("DELETE FROM order_line_items"),
    );
    expect(deleteCall).toBeUndefined();
  });

  it("404s when the line item is missing", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(404);
  });

  it("403s for a member without the orders page", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["products"];

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(403);
  });

  it("409s when the order is completed", async () => {
    mockClientQuery.mockResolvedValueOnce(orderLockRow(undefined, "completed"));

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Line items cannot be modified on a completed order");
    // no DELETE issued
    const deleteCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("DELETE FROM order_line_items"),
    );
    expect(deleteCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /orders/:id/line-items/:itemId — complimentary
// ---------------------------------------------------------------------------

describe("DELETE /orders/:id/line-items/:itemId — complimentary", () => {
  it("removes a complimentary item, restores the plain totals, and logs a distinct removal event", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow({ subtotal: 854, total: 854, shipping: 0 }))
      .mockResolvedValueOnce({
        rows: [
          {
            id: ITEM_ID,
            name: "Red Heart Balloons",
            quantity: 4,
            is_complimentary: true,
            complimentary_reason: "customer_service_gesture",
            complimentary_note: "Customer complained about delayed delivery",
            complimentary_original_price: "7.50",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult) // DELETE
      .mockResolvedValueOnce({ rows: [{ subtotal: "854.00", complimentary_value: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totals.total).toBe(854);
    // No complimentary lines remain — the conditional rows disappear again.
    expect(res.body.totals.merchandise_subtotal).toBeUndefined();
    expect(res.body.totals.complimentary_total).toBeUndefined();

    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
      expect(eventCall![1]).toEqual(
        expect.arrayContaining([ORDER_ID, "line_item_complimentary_removed"]),
      );
      const payload = JSON.parse(eventCall![1][3] as string);
      expect(payload).toMatchObject({
        name: "Red Heart Balloons",
        quantity: 4,
        reason: "customer_service_gesture",
        note: "Customer complained about delayed delivery",
        original_value: 30,
      });
    });
  });

  it("does not emit the plain line_item_removed event for a complimentary item", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow())
      .mockResolvedValueOnce({
        rows: [
          {
            id: ITEM_ID,
            name: "Red Heart Balloons",
            quantity: 1,
            is_complimentary: true,
            complimentary_reason: "vip_gesture",
            complimentary_original_price: "10.00",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ rows: [{ subtotal: "50.00", complimentary_value: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      const eventCall = mockDbQuery.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO order_events"),
      );
      expect(eventCall).toBeTruthy();
    });
    const plainRemovedCall = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("INSERT INTO order_events") &&
        (c[1] as unknown[]).includes("line_item_removed"),
    );
    expect(plainRemovedCall).toBeUndefined();
  });

  it("409s removing a complimentary item once the order is ready_for_delivery and recipe consumption has been posted", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce({
        rows: [
          {
            id: ITEM_ID,
            name: "Red Heart Balloons",
            quantity: 4,
            is_complimentary: true,
            complimentary_reason: "customer_service_gesture",
            complimentary_original_price: "7.50",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
    const deleteCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("DELETE FROM order_line_items"),
    );
    expect(deleteCall).toBeUndefined();
  });

  it("409s removing a complimentary item after the order moved on from ready_for_delivery, since consumption is still posted", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "on_hold"))
      .mockResolvedValueOnce({
        rows: [
          {
            id: ITEM_ID,
            name: "Red Heart Balloons",
            quantity: 4,
            is_complimentary: true,
            complimentary_reason: "customer_service_gesture",
            complimentary_original_price: "7.50",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
  });

  it("409s removing a complimentary item once consumption is posted even if recipe consumption is later disabled workspace-wide", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce({
        rows: [
          {
            id: ITEM_ID,
            name: "Red Heart Balloons",
            quantity: 4,
            is_complimentary: true,
            complimentary_reason: "customer_service_gesture",
            complimentary_original_price: "7.50",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: true }], rowCount: 1 });

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/entered fulfilment/);
  });

  it("still allows removing a complimentary item on a ready_for_delivery order when no consumption has been posted for it", async () => {
    mockClientQuery
      .mockResolvedValueOnce(orderLockRow(undefined, "ready_for_delivery"))
      .mockResolvedValueOnce({
        rows: [
          {
            id: ITEM_ID,
            name: "Red Heart Balloons",
            quantity: 4,
            is_complimentary: true,
            complimentary_reason: "customer_service_gesture",
            complimentary_original_price: "7.50",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ has_active_consumption: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult) // DELETE
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00", complimentary_value: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce(emptyResult);

    const res = await request(makeApp()).delete(
      `/orders/${ORDER_ID}/line-items/${ITEM_ID}`,
    );

    expect(res.status).toBe(200);
  });
});
