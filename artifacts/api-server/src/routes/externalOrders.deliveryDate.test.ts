import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockDbConnect = vi.fn();

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  resolveApiKeyWorkspace: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/contactUpsert", () => ({
  upsertContact: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/autoTags", () => ({
  applyAutoTagsForContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/email", () => ({
  sendOrderConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendNewOrderStaffEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderPaymentInstructionsEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/slack", () => ({
  notifyNewUaeOrderToSlack: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/tookan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tookan")>();
  return {
    ...actual,
    isTookanEnabled: () => false,
    createTookanDeliveryTask: vi.fn(),
  };
});

import router, { resolveDeliveryDate } from "./externalOrders";

// ---------------------------------------------------------------------------
// resolveDeliveryDate — pure unit tests
// ---------------------------------------------------------------------------

describe("resolveDeliveryDate", () => {
  const TZ = "UTC";

  it("corrects a delivery date before the order date to the order date", () => {
    const r = resolveDeliveryDate("2026-07-02", "2026-07-03T08:00:00.000Z", TZ);
    expect(r.date).toBe("2026-07-03");
    expect(r.review).toBe(
      "Delivery date automatically corrected from 02/07 to the order date 03/07",
    );
  });

  it("preserves a time suffix on the corrected date", () => {
    const r = resolveDeliveryDate("2026-07-02T18:00:00", "2026-07-03T08:00:00.000Z", TZ);
    expect(r.date).toBe("2026-07-03T18:00:00");
    expect(r.review).toContain("automatically corrected from 02/07 to the order date 03/07");
  });

  it("handles the midnight-boundary timezone case (picked today, checked out after midnight)", () => {
    // 22:30 UTC on July 2 is already 01:30 on July 3 in Asia/Beirut (UTC+3).
    // A customer who picked "today" (July 2) just before midnight local time
    // and checked out after midnight gets bumped to July 3.
    const r = resolveDeliveryDate("2026-07-02", "2026-07-02T22:30:00.000Z", "Asia/Beirut");
    expect(r.date).toBe("2026-07-03");
    expect(r.review).toBe(
      "Delivery date automatically corrected from 02/07 to the order date 03/07",
    );
  });

  it("does NOT correct when order and delivery are the same calendar day in the delivery timezone", () => {
    // 22:30 UTC July 2 is still July 2 in UTC — same calendar day as the
    // order, so no correction happens (contrast with the Asia/Beirut case
    // above, where the same instant is already July 3).
    const r = resolveDeliveryDate("2026-07-02", "2026-07-02T22:30:00.000Z", "UTC");
    expect(r.date).toBe("2026-07-02");
    expect(r.review ?? "").not.toContain("automatically corrected");
  });

  it("normalizes an overnight slot submitted for the next calendar day to its start day", () => {
    const r = resolveDeliveryDate(
      "2099-06-16",
      "2099-06-15T09:00:00.000Z",
      TZ,
      "11:00 PM - 1:00 AM",
    );
    expect(r).toEqual({ date: "2099-06-15", review: null });
  });

  it("uses the configured delivery timezone at a date boundary for overnight slots", () => {
    // This instant is June 16 in Beirut (UTC+3), even though it is still
    // June 15 in UTC. The checkout's June 17 date is the overnight window's
    // end date and must resolve to the June 16 start date.
    const r = resolveDeliveryDate(
      "2099-06-17",
      "2099-06-15T22:30:00.000Z",
      "Asia/Beirut",
      "11pm–1am",
    );
    expect(r).toEqual({ date: "2099-06-16", review: null });
  });

  it("leaves daytime and genuinely future overnight dates untouched", () => {
    expect(
      resolveDeliveryDate("2099-06-16", "2099-06-15T09:00:00.000Z", TZ, "9am - 12pm"),
    ).toEqual({ date: "2099-06-16", review: null });
    expect(
      resolveDeliveryDate("2099-06-18", "2099-06-15T09:00:00.000Z", TZ, "11pm - 1am"),
    ).toEqual({ date: "2099-06-18", review: null });
  });

  it("leaves a future delivery date untouched with no review flag", () => {
    const r = resolveDeliveryDate("2099-01-01", new Date().toISOString(), TZ);
    expect(r.date).toBe("2099-01-01");
    expect(r.review).toBeNull();
  });

  it("leaves a same-day delivery date untouched with no review flag", () => {
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    const r = resolveDeliveryDate(today, nowIso, TZ);
    expect(r.date).toBe(today);
    expect(r.review).toBeNull();
  });

  it("keeps the plain 'in the past' flag (no correction) when the date is past but not before the order date", () => {
    // Backdated order: delivery date is after the order date but before today.
    const r = resolveDeliveryDate("2020-06-01", "2020-01-01T00:00:00.000Z", TZ);
    expect(r.date).toBe("2020-06-01");
    expect(r.review).toBe("Delivery date 01/06 is in the past");
  });

  it("returns null date and no flag when the delivery date is missing", () => {
    expect(resolveDeliveryDate(null, new Date().toISOString(), TZ)).toEqual({
      date: null,
      review: null,
    });
    expect(resolveDeliveryDate(undefined, new Date().toISOString(), TZ)).toEqual({
      date: null,
      review: null,
    });
  });

  it("returns an unparseable date unchanged with no flag", () => {
    const r = resolveDeliveryDate("tomorrow-ish", new Date().toISOString(), TZ);
    expect(r.date).toBe("tomorrow-ish");
    expect(r.review).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route-level: the corrected date reaches the INSERT, raw_payload keeps the
// original, and the review flag carries the correction message.
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    (req as unknown as { userId: string }).userId = "owner_123";
    next();
  });
  app.use("/api", router);
  return app;
}

/**
 * Stub every client.query call: the orders INSERT returns a row, everything
 * else (BEGIN, SAVEPOINTs, child inserts, COMMIT) resolves empty. Avoids
 * fragile call-order stubbing.
 */
function stubClientQueries(orderId = "order-dd-1", wasInserted = true) {
  mockClientQuery.mockImplementation((sql: unknown) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO orders")) {
      return Promise.resolve({
        rows: [{ id: orderId, was_inserted: wasInserted }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

function getOrderInsertCall(): [string, unknown[]] {
  const call = mockClientQuery.mock.calls.find(
    (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO orders"),
  );
  expect(call).toBeDefined();
  return call as [string, unknown[]];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: mockClientRelease,
  });
});

describe("POST /api/orders — past delivery date auto-correction", () => {
  const PAST_DATE = "2026-07-01";
  const ORDERED_AT = "2026-07-03T09:00:00.000Z";

  it("stores the corrected date in delivery_address, keeps the original in raw_payload, and flags the correction", async () => {
    stubClientQueries();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-dd-1",
        ordered_at: ORDERED_AT,
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery: { cityId: "beirut", address: "Main St", date: PAST_DATE },
      });

    expect(res.status).toBe(201);
    const [, params] = getOrderInsertCall();

    // delivery_address JSON ($4 → index 3) carries the CORRECTED date.
    const deliveryAddress = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(deliveryAddress.date).toBe("2026-07-03");

    // raw_payload ($8 → index 7) keeps the ORIGINAL customer-picked date.
    const rawPayload = JSON.parse(params[7] as string) as {
      delivery?: { date?: string };
    };
    expect(rawPayload.delivery?.date).toBe(PAST_DATE);

    // delivery_date_review ($15 → second-to-last param; last is is_anonymous) explains the correction.
    expect(params[params.length - 2]).toBe(
      "Delivery date automatically corrected from 01/07 to the order date 03/07",
    );
  });

  it("behaves identically on re-ingest (ON CONFLICT update path)", async () => {
    // Same request, but the DB reports an update (was_inserted=false). The
    // EXCLUDED values in the upsert are the same bound params, so the
    // corrected date and review flag are recomputed from the latest submission.
    stubClientQueries("order-dd-1", false);

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-dd-1",
        ordered_at: ORDERED_AT,
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery: { cityId: "beirut", address: "Main St", date: PAST_DATE },
      });

    // Re-ingest (ON CONFLICT DO UPDATE) responds 200, not 201.
    expect(res.status).toBe(200);
    const [sql, params] = getOrderInsertCall();

    // The upsert overwrites delivery_address and delivery_date_review from the
    // latest submission (EXCLUDED, not stale row state).
    expect(sql).toContain("delivery_address      = CASE");
    expect(sql).toContain("delivery_date_review  = EXCLUDED.delivery_date_review");

    const deliveryAddress = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(deliveryAddress.date).toBe("2026-07-03");
    expect(params[params.length - 2]).toBe(
      "Delivery date automatically corrected from 01/07 to the order date 03/07",
    );
  });

  it("leaves a future delivery date untouched with a null review flag", async () => {
    stubClientQueries("order-dd-2");

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-dd-2",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery: { cityId: "beirut", address: "Main St", date: "2099-05-20" },
      });

    expect(res.status).toBe(201);
    const [, params] = getOrderInsertCall();

    const deliveryAddress = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(deliveryAddress.date).toBe("2099-05-20");
    expect(params[params.length - 2]).toBeNull();
  });
});

describe("POST /api/orders — overnight delivery date normalization", () => {
  const ORDERED_AT = "2099-06-15T09:00:00.000Z";
  const SUBMITTED_DATE = "2099-06-16";

  it("stores the overnight start date while preserving the submitted date in raw_payload", async () => {
    stubClientQueries("order-overnight-1");

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-overnight-1",
        ordered_at: ORDERED_AT,
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery: {
          cityId: "beirut",
          address: "Main St",
          date: SUBMITTED_DATE,
          slot: "11:00 PM - 1:00 AM",
        },
      });

    expect(res.status).toBe(201);
    const [, params] = getOrderInsertCall();
    const deliveryAddress = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(deliveryAddress.date).toBe("2099-06-15");
    expect(deliveryAddress.slot).toBe("11:00 PM - 1:00 AM");

    const rawPayload = JSON.parse(params[7] as string) as {
      delivery?: { date?: string; slot?: string };
    };
    expect(rawPayload.delivery?.date).toBe(SUBMITTED_DATE);
    expect(rawPayload.delivery?.slot).toBe("11:00 PM - 1:00 AM");
    expect(params[params.length - 2]).toBeNull();
  });

  it("recomputes the same overnight metadata on re-ingest", async () => {
    stubClientQueries("order-overnight-1", false);

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-overnight-1",
        ordered_at: ORDERED_AT,
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery: {
          cityId: "beirut",
          address: "Main St",
          date: SUBMITTED_DATE,
          slot: "11:00 PM - 1:00 AM",
        },
      });

    expect(res.status).toBe(200);
    const [sql, params] = getOrderInsertCall();
    expect(sql).toContain("delivery_address      = CASE");

    const deliveryAddress = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(deliveryAddress.date).toBe("2099-06-15");
    const rawPayload = JSON.parse(params[7] as string) as { delivery?: { date?: string } };
    expect(rawPayload.delivery?.date).toBe(SUBMITTED_DATE);
  });
});

describe("POST /api/orders — delivery schedule compatibility aliases", () => {
  it("normalizes an LB-style top-level delivery date and slot", async () => {
    stubClientQueries("order-lb-2630");

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "LB-2630",
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        delivery_address: { cityId: "beirut", address: "Main St" },
        deliveryDate: "2099-09-12",
        deliverySlot: "2:00 PM - 5:00 PM",
      });

    expect(res.status).toBe(201);
    const [, params] = getOrderInsertCall();
    expect(JSON.parse(params[3] as string)).toMatchObject({
      date: "2099-09-12",
      slot: "2:00 PM - 5:00 PM",
    });
    expect(params[4]).toBe("standard");
  });

  it("accepts top-level timeSlot as a slot compatibility alias", async () => {
    stubClientQueries("order-top-level-timeslot");

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "top-level-timeslot",
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        delivery_date: "2099-09-12",
        timeSlot: "afternoon",
      });

    expect(res.status).toBe(201);
    const [, params] = getOrderInsertCall();
    expect(JSON.parse(params[3] as string)).toMatchObject({
      date: "2099-09-12",
      slot: "afternoon",
    });
  });

  it("prefers canonical nested values over mixed compatibility aliases", async () => {
    stubClientQueries("order-mixed-schedule");

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "mixed-schedule",
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        deliveryDate: "2099-09-10",
        delivery_slot: "morning",
        delivery: {
          date: "2099-09-12",
          slot: "2:00 PM - 5:00 PM",
          deliveryDate: "2099-09-11",
        },
      });

    expect(res.status).toBe(201);
    const [, params] = getOrderInsertCall();
    expect(JSON.parse(params[3] as string)).toMatchObject({
      date: "2099-09-12",
      slot: "2:00 PM - 5:00 PM",
    });
  });

  it("preserves stored non-empty schedule members when re-ingest omits them", async () => {
    stubClientQueries("order-lb-2630", false);

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "LB-2630",
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        delivery: { address: "Updated address" },
      });

    expect(res.status).toBe(200);
    const [sql] = getOrderInsertCall();
    expect(sql).toContain("orders.delivery_address->'date'");
    expect(sql).toContain("orders.delivery_address->'slot'");
    expect(sql).toContain("NULLIF(btrim(EXCLUDED.delivery_address->>'date'), '')");
    expect(sql).toContain("NULLIF(btrim(EXCLUDED.delivery_address->>'slot'), '')");
  });
});
