import express from "express";
import { createHash, createHmac } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbQuery,
  clientQuery,
  release,
  resolveRescheduleContextMock,
  countRescheduleSlotUsageMock,
  getAddressEligibilityMock,
  assessPlaceValidityMock,
  geocodeAddressMock,
  cancelAddressCollectionForOrderMock,
} = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  resolveRescheduleContextMock: vi.fn(),
  countRescheduleSlotUsageMock: vi.fn(),
  getAddressEligibilityMock: vi.fn(),
  assessPlaceValidityMock: vi.fn(),
  geocodeAddressMock: vi.fn(),
  cancelAddressCollectionForOrderMock: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => dbQuery(...args),
    connect: vi.fn(async () => ({
      query: (...args: unknown[]) => clientQuery(...args),
      release,
    })),
  },
  withTransaction: async (_client: unknown, callback: () => Promise<unknown>) => callback(),
}));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/addressBookAutoLink", () => ({
  getAddressEligibility: (...args: unknown[]) => getAddressEligibilityMock(...args),
  linkOrderToAddressBook: vi.fn(),
}));
vi.mock("../lib/placeAiAssessor.js", () => ({
  assessPlaceValidity: (...args: unknown[]) => assessPlaceValidityMock(...args),
  geocodeAddress: (...args: unknown[]) => geocodeAddressMock(...args),
}));
vi.mock("../lib/tookan", () => ({
  editTookanDeliveryTask: vi.fn(),
  isTookanEnabled: vi.fn(() => false),
  retryTookanDeliveryTask: vi.fn(),
  TOOKAN_MISSING_ADDRESS_ERROR: "missing",
}));
vi.mock("../lib/genderInference", () => ({ queueGenderInference: vi.fn() }));
vi.mock("../lib/contactUpsert", () => ({
  syncContactToRespondIo: vi.fn(async () => ({ status: "disabled" })),
}));
vi.mock("../lib/addressCollector/service", () => ({
  cancelAddressCollectionForOrder: (...args: unknown[]) =>
    cancelAddressCollectionForOrderMock(...args),
}));
vi.mock("../lib/orderDestinationLock", () => ({
  lockOrderDestinationInTransaction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./orders", async (original) => {
  const actual = await original<typeof import("./orders")>();
  return {
    ...actual,
    processPendingOrderRescheduleJobs: vi.fn(async () => undefined),
    resolveRescheduleContext: resolveRescheduleContextMock,
    countRescheduleSlotUsage: countRescheduleSlotUsageMock,
  };
});

import router from "./respondioAiOrders";

function app() {
  const instance = express();
  instance.use((req, res, next) => {
    if (req.path === "/api/respondio/workflows/order-address-change") {
      express.raw({ type: "application/json" })(req, res, (error) => {
        if (error) return next(error);
        (req as express.Request & { rawBody?: Buffer }).rawBody =
          req.body as Buffer;
        next();
      });
      return;
    }
    express.json()(req, res, next);
  });
  instance.use("/api", router);
  return instance;
}

const order = {
  id: "11111111-1111-1111-1111-111111111111",
  status: "processing",
  external_order_id: "WEB-42",
  external_order_number: null,
  display_order_number: null,
  ordered_at: "2026-08-30T10:00:00.000Z",
  created_at: "2026-08-30T10:00:00.000Z",
  delivery_type: "standard",
  delivery_address: { address: "Old Address", cityId: 7, date: "2026-09-10", slot: "09:00–12:00" },
  delivery_instructions: null,
  window_start: "2026-09-10T06:00:00.000Z",
  window_end: "2026-09-10T09:00:00.000Z",
  card_message: "Old message",
  card_from: "Maya",
  card_to: "Rami",
  tookan_job_id: null,
  tookan_status: null,
  tookan_error: null,
  customer_phone: "+96170111222",
  recipient_contact_id: "22222222-2222-2222-2222-222222222222",
  recipient_name: "Rami",
  recipient_phone: "+96171111222",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createHashForTest(address: string): string {
  const normalized = address.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256")
    .update(`{"address":${JSON.stringify(normalized)}}`)
    .digest("hex");
}

function expectNoUuid(value: unknown): void {
  if (typeof value === "string") {
    expect(value).not.toMatch(UUID_PATTERN);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectNoUuid);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(expectNoUuid);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  dbQuery.mockReset();
  clientQuery.mockReset();
  vi.stubEnv("RESPONDIO_AI_AGENT_SECRET", "ai-secret");
  vi.stubEnv("RESPONDIO_INCOMING_WEBHOOK_SECRET", "incoming-secret");
  getAddressEligibilityMock.mockImplementation((value: Record<string, unknown>) => ({
    eligible: true,
    reason: "eligible",
    addressText: String(value.address ?? "12 Cedar Street, Beirut"),
  }));
  assessPlaceValidityMock.mockResolvedValue({ valid: true, reason: "confirmed" });
  geocodeAddressMock.mockResolvedValue({
    lat: 33.89,
    lng: 35.50,
    matchType: "exact",
    precision: "exact",
    method: "exact_match",
    matchedLocation: "12 Cedar Street",
    query: "12 Cedar Street",
    provider: "nominatim",
    placeIdentity: null,
    evidenceScore: 1,
  });
  cancelAddressCollectionForOrderMock.mockResolvedValue(undefined);
  dbQuery.mockResolvedValue({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  countRescheduleSlotUsageMock.mockResolvedValue(0);
});

describe("Respond.io AI order API", () => {
  it("rejects missing or invalid bearer credentials before database mapping", async () => {
    const missing = await request(app())
      .post("/api/respondio/ai/orders/find")
      .send({ customer_phone: "+96170111222" });
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("UNAUTHORIZED");
    expect(dbQuery).not.toHaveBeenCalled();

    const invalid = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer wrong")
      .send({ customer_phone: "+96170111222" });
    expect(invalid.status).toBe(401);
  });

  it("fails closed when workspace mapping is missing or ambiguous", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "a" }, { workspace_owner_id: "b" }],
      rowCount: 2,
    });
    const response = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("WORKSPACE_MAPPING_UNAVAILABLE");
  });

  it("returns one or several safe customer-owned matches", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order, { ...order, id: "33333333-3333-3333-3333-333333333333" }], rowCount: 2 });
    const response = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+961 70 111 222" });
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect(response.body.orders[0]).toEqual(expect.objectContaining({
      order_id: "42",
      order_number: "WEB-42",
      recipient_name: "Rami",
      card_message: "Old message",
    }));
    expect(response.body.orders[0]).not.toHaveProperty("id");
    expect(response.body.orders[0]).not.toHaveProperty("order_identifier");
    expect(response.body.orders[0]).not.toHaveProperty("totals");
    expectNoUuid(response.body);
    expect(String(dbQuery.mock.calls[1][0])).toContain("customer_link.role = 'customer'");
  });

  it("returns Express as the delivery slot for express orders without a scheduled slot", async () => {
    const expressOrder = {
      ...order,
      delivery_type: "express",
      delivery_address: {
        address: "Express Address",
        cityId: 7,
        date: "2026-09-10",
        isExpress: true,
      },
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [expressOrder], rowCount: 1 });

    const response = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+961 70 111 222" });

    expect(response.status).toBe(200);
    expect(response.body.orders[0]).toEqual(expect.objectContaining({
      order_id: "42",
      delivery_slot: "Express",
    }));
    expectNoUuid(response.body);
  });

  it("trusts a unique workspace-scoped order identifier without requiring a phone", async () => {
    for (const body of [
      { order_id: "WEB-42" },
      { customer_phone: "", order_id: "42" },
    ]) {
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [order], rowCount: 1 });

      const response = await request(app())
        .post("/api/respondio/ai/orders/find")
        .set("authorization", "Bearer ai-secret")
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        found: true,
        order: { orderId: "42", orderNumber: "WEB-42", status: "processing" },
        verified: true,
        verification_required: false,
        count: 1,
        orders: [expect.objectContaining({
          order_id: "42",
          order_number: "WEB-42",
          card_message: "Old message",
        })],
      });
      expect(response.body).not.toHaveProperty("customer_phone");
      expect(response.body.orders[0].status).toBe("processing");
      expect(response.body.orders[0].recipient_phone).toBe("+96171111222");
      expect(String(dbQuery.mock.calls.at(-1)?.[0])).toContain("customer_link.role = 'customer'");
      expect(String(dbQuery.mock.calls.at(-1)?.[0])).toContain(
        "WHERE o.workspace_owner_id = $1",
      );
      expect(dbQuery.mock.calls.at(-1)?.[1]?.[0]).toBe("owner-1");
      expect(String(dbQuery.mock.calls.at(-1)?.[0])).not.toContain(
        "regexp_replace(COALESCE(customer.phone",
      );
      expectNoUuid(response.body);
    }
  });

  it("accepts customer_phone as optional compatibility metadata", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });

    const response = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", order_id: "WEB-42" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      verified: true,
      verification_required: false,
      customer_phone: "+96170111222",
      order: {
        orderId: "42",
        orderNumber: "WEB-42",
        status: "processing",
      },
    }));
    expect(response.body.orders[0]).toEqual(expect.objectContaining({
      order_id: "42",
      order_number: "WEB-42",
      status: "processing",
      recipient_phone: "+96171111222",
    }));
    expect(String(dbQuery.mock.calls[1][0])).not.toContain(
      "regexp_replace(COALESCE(customer.phone",
    );
    expectNoUuid(response.body);
  });

  it("does not let a mismatched Respond.io contactPhone block an order-number match", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });

    const response = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "WEB-42", contactPhone: "+96170999999" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      found: true,
      verified: true,
      verification_required: false,
      customer_phone: "+96170999999",
      order: expect.objectContaining({
        orderId: "42",
        orderNumber: "WEB-42",
      }),
    }));
    const lookupSql = String(dbQuery.mock.calls[1][0]);
    expect(lookupSql).not.toContain("now() - INTERVAL '90 days'");
    expect(lookupSql).not.toContain("NOT IN ('completed', 'cancelled', 'refunded')");
  });

  it("requires an order identifier or phone for find but not a phone for PATCH", async () => {
    const noFactors = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "" });
    expect(noFactors.status).toBe(400);
    expect(noFactors.body.code).toBe("INVALID_REQUEST");

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    const trustedPatch = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({ changes: { card_message: "Old message" } });
    expect(trustedPatch.status).toBe(200);
    expect(trustedPatch.body.changed).toBe(false);
  });

  it("fails safely for ambiguous and UUID-shaped unverified order_id lookups", async () => {
    const sameSuffix = {
      ...order,
      id: "33333333-3333-3333-3333-333333333333",
      external_order_id: "OTHER-42",
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order, sameSuffix], rowCount: 2 });
    const ambiguous = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ order_id: "42" });
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.body).toEqual({
      success: true,
      found: false,
      verified: false,
      verification_required: false,
      count: 0,
      orders: [],
    });

    dbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "owner-1" }],
      rowCount: 1,
    });
    const uuid = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ order_id: order.id });
    expect(uuid.status).toBe(400);
    expect(uuid.body.code).toBe("INVALID_REQUEST");
    expectNoUuid([ambiguous.body, uuid.body]);
  });

  it("resolves full and prefix-free customer order identifiers without exposing UUIDs", async () => {
    const prefixedOrders = [
      { ...order, external_order_id: "STORE-X9-73104" },
      {
        ...order,
        id: "33333333-3333-3333-3333-333333333333",
        external_order_id: null,
        external_order_number: "DXB_8807",
      },
    ];

    for (const [candidate, input, expectedId] of [
      [prefixedOrders[0], "STORE-X9-73104", "73104"],
      [prefixedOrders[0], "73104", "73104"],
      [prefixedOrders[1], "DXB_8807", "8807"],
      [prefixedOrders[1], "8807", "8807"],
    ] as const) {
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [candidate], rowCount: 1 });
      const response = await request(app())
        .post("/api/respondio/ai/orders/find")
        .set("authorization", "Bearer ai-secret")
        .send({ customer_phone: "+96170111222", order_identifier: input });

      expect(response.status).toBe(200);
      expect(response.body.orders).toEqual([
        expect.objectContaining({
          order_id: expectedId,
          order_number: candidate.external_order_number ?? candidate.external_order_id,
        }),
      ]);
      expectNoUuid(response.body);
    }
  });

  it("uses a numeric fallback reference and lets an exact full number win a suffix collision", async () => {
    const fallbackOrder = {
      ...order,
      display_order_number: "INTERNAL-LABEL",
      external_order_number: "MARKET-A7-501",
      external_order_id: "SOURCE-501",
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fallbackOrder], rowCount: 1 });
    const fallback = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", order_identifier: "501" });
    expect(fallback.status).toBe(200);
    expect(fallback.body.orders[0]).toEqual(expect.objectContaining({
      order_id: "501",
      order_number: "MARKET-A7-501",
    }));

    const collision = {
      ...order,
      id: "33333333-3333-3333-3333-333333333333",
      external_order_id: "OTHER-42",
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order, collision], rowCount: 2 });
    const exact = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", order_identifier: "WEB-42" });
    expect(exact.status).toBe(200);
    expect(exact.body.orders).toHaveLength(1);
    expect(exact.body.orders[0].order_number).toBe("WEB-42");
    expectNoUuid([fallback.body, exact.body]);
  });

  it("fails safely for missing, ambiguous, and UUID-only customer references", async () => {
    const sameSuffix = {
      ...order,
      id: "33333333-3333-3333-3333-333333333333",
      external_order_id: "OTHER-42",
    };
    for (const [identifier, rows] of [
      ["999999", []],
      ["42", [order, sameSuffix]],
    ] as const) {
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows, rowCount: rows.length });
      const response = await request(app())
        .post("/api/respondio/ai/orders/find")
        .set("authorization", "Bearer ai-secret")
        .send({
          customer_phone: "+96170111222",
          order_identifier: identifier,
        });

      expect(response.status).toBe(200);
      expect(response.body.orders).toEqual([]);
      expectNoUuid(response.body);
    }

    const unusable = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", order_identifier: "MISSING" });
    expect(unusable.status).toBe(400);
    expect(unusable.body.code).toBe("INVALID_REQUEST");

    dbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "owner-1" }],
      rowCount: 1,
    });
    const uuidResponse = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", order_identifier: order.id });
    expect(uuidResponse.status).toBe(400);
    expect(uuidResponse.body.code).toBe("INVALID_REQUEST");
    expectNoUuid(uuidResponse.body);
  });

  it("accepts the canonical production action payload with numeric and decorated order numbers", async () => {
    for (const orderNumber of [2465, "2465", "#2465", "Order 2465"]) {
      const productionOrder = {
        ...order,
        external_order_id: "LB-2465",
        customer_phone: "+971562015111",
        status: "preparing",
      };
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [productionOrder], rowCount: 1 });

      const response = await request(app())
        .post("/api/respondio/ai/orders/find")
        .set("authorization", "Bearer ai-secret")
        .send({ orderNumber, phone: "+971562015111" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        success: true,
        found: true,
        order: {
          orderId: "2465",
          orderNumber: "LB-2465",
          status: "preparing",
        },
      }));
      expect(dbQuery.mock.calls.at(-1)?.[1]?.[2]).toBe("2465");
      expectNoUuid(response.body);
    }
  });

  it("accepts confirmed provider aliases and equivalent UAE phone representations", async () => {
    for (const [field, phone] of [
      ["phone", "+971562015111"],
      ["phone_number", "971562015111"],
      ["customer_phone", "0562015111"],
    ] as const) {
      const productionOrder = {
        ...order,
        external_order_id: "LB-2465",
        customer_phone: "+971562015111",
        status: "preparing",
      };
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [productionOrder], rowCount: 1 });

      const response = await request(app())
        .post("/api/respondio/ai/orders/find")
        .set("authorization", "Bearer ai-secret")
        .send({ order_id: "2465", [field]: phone });

      expect(response.status).toBe(200);
      expect(response.body.found).toBe(true);
      expect(dbQuery.mock.calls.at(-1)?.[1]).toEqual([
        "owner-1",
        "2465",
        "2465",
      ]);
      expect(String(dbQuery.mock.calls.at(-1)?.[0])).not.toContain("phone_link.role = 'recipient'");
      expect(String(dbQuery.mock.calls.at(-1)?.[0])).toContain("o.workspace_owner_id = $1");
    }
  });

  it("supports canonical order-only and phone-only requests without contact metadata", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    const orderOnly = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "42" });
    expect(orderOnly.status).toBe(200);
    expect(orderOnly.body).toEqual(expect.objectContaining({
      success: true,
      found: true,
      order: { orderId: "42", orderNumber: "WEB-42", status: "processing" },
    }));

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    const phoneOnly = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ phone: "+96170111222" });
    expect(phoneOnly.status).toBe(200);
    expect(phoneOnly.body.found).toBe(true);
    expect(phoneOnly.body.order.status).toBe("processing");
  });

  it("carries the canonical order id into a multiline card-message edit without phone verification", async () => {
    const reportedOrder = {
      ...order,
      external_order_id: "LB-2567",
      customer_phone: "+97455563517",
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [reportedOrder], rowCount: 1 });

    const found = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "2567" });

    expect(found.status).toBe(200);
    expect(found.body).toEqual(expect.objectContaining({
      found: true,
      verified: true,
      verification_required: false,
      order: {
        orderId: "2567",
        orderNumber: "LB-2567",
        status: "processing",
      },
    }));

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [reportedOrder], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [reportedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-reported-flow" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...reportedOrder, card_message: "Happy birthday Nivine!\n\nFrom Alhusseini" }],
        rowCount: 1,
      });

    const edited = await request(app())
      .patch(`/api/respondio/ai/orders/${found.body.order.orderId}`)
      .set("authorization", "Bearer ai-secret")
      .send({
        change_type: "card_message",
        new_value: "Happy birthday Nivine!\n\nFrom Alhusseini",
      });

    expect(edited.status).toBe(200);
    expect(edited.body).toEqual(expect.objectContaining({
      success: true,
      changed: true,
      order_id: "2567",
      order_number: "LB-2567",
      change_type: "card_message",
      new_value: "Happy birthday Nivine!\n\nFrom Alhusseini",
    }));
    expectNoUuid([found.body, edited.body]);
  });

  it("normalizes the same Respond.io phone variants for lookup and edit", async () => {
    for (const rawPhone of ["+971562015111", "971562015111", "0562015111"]) {
      const productionOrder = {
        ...order,
        external_order_id: "LB-2465",
        customer_phone: "+971562015111",
      };
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [productionOrder], rowCount: 1 });
      clientQuery.mockResolvedValueOnce({ rows: [productionOrder], rowCount: 1 });

      const response = await request(app())
        .patch("/api/respondio/ai/orders/2465")
        .set("authorization", "Bearer ai-secret")
        .send({
          phoneNumber: rawPhone,
          changes: { card_message: "Old message" },
        });

      expect(response.status).toBe(200);
      expect(response.body.changed).toBe(false);
      expect(dbQuery.mock.calls.at(-1)?.[1]).toEqual([
        "owner-1",
        "2465",
        "2465",
      ]);
    }
  });

  it("returns 200 for no match, 400 for malformed or conflicting identifiers, and 500 for database failure", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const noMatch = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "999999" });
    expect(noMatch.status).toBe(200);
    expect(noMatch.body).toEqual(expect.objectContaining({
      success: true,
      found: false,
      verified: false,
      verification_required: false,
    }));
    expect(noMatch.body).not.toHaveProperty("order");
    expect(noMatch.body).not.toHaveProperty("customer_phone");

    const malformed = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "Order unknown" });
    expect(malformed.status).toBe(400);

    const conflicting = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "42", order_id: "43" });
    expect(conflicting.status).toBe(400);
    expect(conflicting.body.code).toBe("CONFLICTING_IDENTIFIERS");

    const decimal = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: 42.3 });
    expect(decimal.status).toBe(400);

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const failure = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "42" });
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({
      success: false,
      saved: false,
      processing: false,
      status: "rejected",
      code: "TEMPORARILY_UNAVAILABLE",
      error: "The request could not be completed",
    });
  });

  it("treats full and prefix-free aliases as the same public order reference", async () => {
    for (const body of [
      { orderNumber: "LB-2465", order_id: "#2465" },
      { orderNumber: "#2465", order_id: "LB-2465" },
    ]) {
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ ...order, external_order_id: "LB-2465" }], rowCount: 1 });
      const response = await request(app())
        .post("/api/respondio/ai/orders/find")
        .set("authorization", "Bearer ai-secret")
        .send(body);
      expect(response.status).toBe(200);
      expect(response.body.found).toBe(true);
      expect(dbQuery.mock.calls.at(-1)?.[1]?.[1]).toBe("LB-2465");
    }

    const conflicting = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ orderNumber: "LB-2465", order_id: "DXB-2465" });
    expect(conflicting.status).toBe(400);
    expect(conflicting.body.code).toBe("CONFLICTING_IDENTIFIERS");
  });

  it("fails closed for a phone-only lookup that matches several orders", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [order, { ...order, id: "33333333-3333-3333-3333-333333333333", external_order_id: "WEB-43" }],
        rowCount: 2,
      });
    const response = await request(app())
      .post("/api/respondio/ai/orders/find")
      .set("authorization", "Bearer ai-secret")
      .send({ phone: "+96170111222" });
    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body).not.toHaveProperty("order");
    expect(response.body.count).toBe(2);
  });

  it("does not reveal whether an order belongs to another customer", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", changes: { card_message: "New" } });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ORDER_ACCESS_DENIED");
  });

  it("accepts a prefix-free PATCH identifier and keeps UUID use internal", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [order], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/42")
      .set("authorization", "Bearer ai-secret")
      .send({
        contact_phone: "+96170111222",
        changes: { card_message: "Old message" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      order_id: "42",
      order_number: "WEB-42",
      changed: false,
    }));
    expect(clientQuery.mock.calls[0]?.[1]?.[1]).toBe(order.id);
    expectNoUuid(response.body);
  });

  it("denies ambiguous prefix-free and raw UUID PATCH identifiers", async () => {
    const sameSuffix = {
      ...order,
      id: "33333333-3333-3333-3333-333333333333",
      external_order_id: "OTHER-42",
    };
    for (const [identifier, rows] of [
      ["42", [order, sameSuffix]],
      [order.id, [order]],
    ] as const) {
      dbQuery.mockResolvedValueOnce({
        rows: [{ workspace_owner_id: "owner-1" }],
        rowCount: 1,
      });
      if (!UUID_PATTERN.test(identifier)) {
        dbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
      }
      const response = await request(app())
        .patch(`/api/respondio/ai/orders/${identifier}`)
        .set("authorization", "Bearer ai-secret")
        .send({ customer_phone: "+96170111222", changes: { card_message: "New" } });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ORDER_ACCESS_DENIED");
      expectNoUuid(response.body);
    }
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("denies orders without a safe reference before and under the mutation lock", async () => {
    const unsafeOrder = {
      ...order,
      display_order_number: "INTERNAL-LABEL",
      external_order_number: null,
      external_order_id: null,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [unsafeOrder], rowCount: 1 });
    const preflightDenied = await request(app())
      .patch("/api/respondio/ai/orders/INTERNAL-LABEL")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", changes: { card_message: "New" } });
    expect(preflightDenied.status).toBe(403);
    expect(clientQuery).not.toHaveBeenCalled();

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [unsafeOrder], rowCount: 1 });
    const lockDenied = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", changes: { card_message: "New" } });
    expect(lockDenied.status).toBe(403);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE orders"))).toBe(false);
    expectNoUuid([preflightDenied.body, lockDenied.body]);
  });

  it("rejects forbidden fields and fulfillment-started edits", async () => {
    const forbidden = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", changes: { status: "cancelled" } });
    expect(forbidden.status).toBe(400);

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...order, status: "preparing" }], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [{ ...order, status: "preparing" }], rowCount: 1 });
    const gated = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", changes: { card_message: "New" } });
    expect(gated.status).toBe(409);
    expect(gated.body.code).toBe("MANUAL_APPROVAL_REQUIRED");
  });

  it("blocks delivered orders", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...order, status: "out_for_delivery" }], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({
      rows: [{ ...order, status: "out_for_delivery" }],
      rowCount: 1,
    });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({ customer_phone: "+96170111222", changes: { card_message: "New" } });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ORDER_NOT_EDITABLE");
  });

  it("returns stable past-date and unavailable-slot scheduling errors", async () => {
    for (const code of ["DELIVERY_DATE_IN_PAST", "DELIVERY_SLOT_UNAVAILABLE"]) {
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
      clientQuery.mockResolvedValueOnce({ rows: [order], rowCount: 1 });
      resolveRescheduleContextMock.mockRejectedValueOnce(
        Object.assign(new Error("Requested delivery choice is unavailable"), {
          status: 409,
          code,
        }),
      );
      const response = await request(app())
        .patch("/api/respondio/ai/orders/WEB-42")
        .set("authorization", "Bearer ai-secret")
        .send({
          customer_phone: "+96170111222",
          changes: {
            delivery_date: "2026-09-11",
            delivery_slot: { start_time: "09:00", end_time: "12:00" },
          },
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe(code);
    }
  });

  it("retains a display-formatted 12-hour slot for a date-only change and queues OS reschedule effects", async () => {
    const orderWithDisplaySlot = {
      ...order,
      delivery_address: {
        ...order.delivery_address,
        slot: "6:00 PM–10:00 PM",
      },
      window_start: "2026-09-10T18:00:00.000Z",
      window_end: "2026-09-10T22:00:00.000Z",
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [orderWithDisplaySlot], rowCount: 1 });
    resolveRescheduleContextMock.mockResolvedValueOnce({
      timezone: "UTC",
      cityId: 7,
      slots: [{
        id: "slot-1",
        start_time: "18:00",
        end_time: "22:00",
        capacity: 10,
      }],
    });
    clientQuery
      .mockResolvedValueOnce({ rows: [orderWithDisplaySlot], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-schedule" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          ...orderWithDisplaySlot,
          window_start: "2026-09-11T18:00:00.000Z",
          window_end: "2026-09-11T22:00:00.000Z",
          delivery_address: { ...order.delivery_address, date: "2026-09-11", slot: "18:00–22:00" },
        }],
        rowCount: 1,
      });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "delivery_date",
        new_value: "2026-09-11",
      });
    expect(response.status).toBe(200);
    expect(response.body.changed_fields).toEqual(["delivery_date", "delivery_slot"]);
    expect(resolveRescheduleContextMock).toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE fleet_driver_order_assignments[\s\S]*WHERE order_id = \$2 AND workspace_owner_id = \$3/,
      ),
      [
        "2026-09-11T18:00:00.000Z",
        order.id,
        "owner-1",
      ],
    );
    const jobCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO order_reschedule_jobs"));
    expect(jobCall?.[1]?.[8]).toBe(true);
  });

  it("applies allowed card/contact changes and writes one source-attributed event", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...order, card_message: "New message", recipient_name: "New Rami" }],
        rowCount: 1,
      });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { card_message: "New message", recipient_name: "New Rami" },
      });
    expect(response.status).toBe(200);
    expect(response.body.changed_fields).toEqual(["card_message", "recipient_name"]);
    const eventCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO order_events"));
    expect(eventCall).toBeTruthy();
    expect(String(eventCall?.[1]?.[2])).toContain("respondio_ai_agent");
    expect(String(eventCall?.[1]?.[2])).toContain("+96170111222");
  });

  it("accepts the Respond.io change_type/new_value format and returns before/after values", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-single" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...order, card_message: "Happy Birthday Sarah" }],
        rowCount: 1,
      });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "card_message",
        new_value: "Happy Birthday Sarah",
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      order_id: "42",
      order_number: "WEB-42",
      change_type: "card_message",
      previous_value: "Old message",
      new_value: "Happy Birthday Sarah",
    }));
    expect(response.body.order).toEqual(expect.objectContaining({
      order_id: "42",
      order_number: "WEB-42",
    }));
    expectNoUuid(response.body);
  });

  it("updates only card_to without changing card content, recipient, delivery, or address collection", async () => {
    const updatedOrder = { ...order, card_to: "Sarah" };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-card-to" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedOrder], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "card_to",
        new_value: "Sarah",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      change_type: "card_to",
      previous_value: "Rami",
      new_value: "Sarah",
      changed_fields: ["card_to"],
    }));

    const updateCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE orders"));
    expect(updateCall).toBeTruthy();
    expect(String(updateCall?.[0])).toContain(
      "card_to = CASE WHEN $12::boolean THEN $13 ELSE card_to END",
    );
    expect(updateCall?.[1]).toEqual([
      order.id,
      "owner-1",
      false,
      null,
      false,
      JSON.stringify(order.delivery_address),
      false,
      null,
      false,
      order.window_start,
      order.window_end,
      true,
      "Sarah",
      false,
      null,
    ]);
    expect(updatedOrder).toMatchObject({
      card_to: "Sarah",
      card_message: order.card_message,
      card_from: order.card_from,
      recipient_name: order.recipient_name,
      recipient_phone: order.recipient_phone,
      delivery_address: order.delivery_address,
      window_start: order.window_start,
      window_end: order.window_end,
    });
    expect(resolveRescheduleContextMock).not.toHaveBeenCalled();
    expect(cancelAddressCollectionForOrderMock).not.toHaveBeenCalled();
  });

  it("updates only card_from without changing card content, recipient, delivery, or address collection", async () => {
    const updatedOrder = { ...order, card_from: "Nadine" };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-card-from" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedOrder], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "card_from",
        new_value: "Nadine",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      change_type: "card_from",
      previous_value: "Maya",
      new_value: "Nadine",
      changed_fields: ["card_from"],
    }));

    const updateCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE orders"));
    expect(updateCall).toBeTruthy();
    expect(String(updateCall?.[0])).toContain(
      "card_from = CASE WHEN $14::boolean THEN $15 ELSE card_from END",
    );
    expect(updateCall?.[1]).toEqual([
      order.id,
      "owner-1",
      false,
      null,
      false,
      JSON.stringify(order.delivery_address),
      false,
      null,
      false,
      order.window_start,
      order.window_end,
      false,
      null,
      true,
      "Nadine",
    ]);
    expect(updatedOrder).toMatchObject({
      card_to: order.card_to,
      card_from: "Nadine",
      card_message: order.card_message,
      recipient_name: order.recipient_name,
      recipient_phone: order.recipient_phone,
      delivery_address: order.delivery_address,
      window_start: order.window_start,
      window_end: order.window_end,
      status: order.status,
    });
    expect(resolveRescheduleContextMock).not.toHaveBeenCalled();
    expect(cancelAddressCollectionForOrderMock).not.toHaveBeenCalled();
  });

  it("rejects every unsupported change_type", async () => {
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "status",
        new_value: "cancelled",
      });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_REQUEST");
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(String(dbQuery.mock.calls[0][0])).toContain("omni_channel_accounts");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("returns a stable validation error for an invalid new_value", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "delivery_date",
        new_value: "tomorrow",
      });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_DELIVERY_SCHEDULE");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("keeps accepting a stored 24-hour slot for a date-only change", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    resolveRescheduleContextMock.mockRejectedValueOnce(
      Object.assign(new Error("Requested delivery choice is unavailable"), {
        status: 409,
        code: "DELIVERY_SLOT_UNAVAILABLE",
      }),
    );

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "delivery_date",
        new_value: "2026-09-11",
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("DELIVERY_SLOT_UNAVAILABLE");
    expect(resolveRescheduleContextMock).toHaveBeenCalled();
  });

  it("returns INVALID_DELIVERY_SCHEDULE for a malformed stored slot", async () => {
    const orderWithMalformedSlot = {
      ...order,
      delivery_address: { ...order.delivery_address, slot: "Evening" },
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [orderWithMalformedSlot], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "delivery_date",
        new_value: "2026-09-11",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_DELIVERY_SCHEDULE");
    expect(clientQuery).not.toHaveBeenCalled();
    expect(resolveRescheduleContextMock).not.toHaveBeenCalled();
  });

  it("treats an identical retry as a no-op with no audit event", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { card_message: "Old message", recipient_name: "Rami" },
      });
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO order_events"))).toBe(false);
  });

  it("keeps an identical retry idempotent after fulfillment has started", async () => {
    const preparingOrder = { ...order, status: "preparing" };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [preparingOrder], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [preparingOrder], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        contactPhone: "+96170111222",
        change_type: "card_message",
        new_value: "Old message",
      });

    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO order_events"))).toBe(false);
  });

  it("keeps identical schedule and address retries idempotent when fulfillment dependencies changed", async () => {
    const preparingOrder = { ...order, status: "preparing" };
    resolveRescheduleContextMock.mockRejectedValue(new Error("slot was disabled"));
    assessPlaceValidityMock.mockRejectedValue(new Error("geocoder unavailable"));

    for (const [changes, expectedStatus] of [
      [
        {
          delivery_date: "2026-09-10",
          delivery_slot: { start_time: "09:00", end_time: "12:00" },
        },
        200,
      ],
      [{ delivery_address: "Old Address" }, 409],
    ] as const) {
      dbQuery
        .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [preparingOrder], rowCount: 1 });
      clientQuery.mockResolvedValueOnce({ rows: [preparingOrder], rowCount: 1 });

      const response = await request(app())
        .patch("/api/respondio/ai/orders/WEB-42")
        .set("authorization", "Bearer ai-secret")
        .send({ contactPhone: "+96170111222", changes });

      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(response.body.changed).toBe(false);
      } else {
        expect(response.body.code).toBe("MANUAL_APPROVAL_REQUIRED");
        expect(response.body.saved).toBe(false);
      }
    }

    expect(resolveRescheduleContextMock).not.toHaveBeenCalled();
    expect(assessPlaceValidityMock).not.toHaveBeenCalled();
  });

  it("rechecks address equality against the locked order before treating a retry as a no-op", async () => {
    const concurrentlyChanged = {
      ...order,
      delivery_address: { ...order.delivery_address, address: "Concurrent Address" },
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [concurrentlyChanged], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-address-race" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        contactPhone: "+96170111222",
        changes: { delivery_address: "Old Address" },
      });

    expect(response.status).toBe(200);
    expect(response.body.changed_fields).toEqual(["delivery_address"]);
    expect(assessPlaceValidityMock).toHaveBeenCalled();
  });

  it("does not discard a partial structured address update as an unchanged address", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-structured-address" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        contactPhone: "+96170111222",
        changes: { delivery_address: { address: "Old Address" } },
      });

    expect(response.status).toBe(200);
    expect(assessPlaceValidityMock).toHaveBeenCalled();
  });

  it("copy-on-writes a shared recipient so the customer and other orders are untouched", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ shared: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "new-recipient" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...order, recipient_contact_id: "new-recipient", recipient_phone: "+96171111999" }],
        rowCount: 1,
      });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { recipient_phone: "+96171111999" },
      });
    expect(response.status).toBe(200);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE order_contacts"))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE contacts"))).toBe(false);
  });

  it("relinks only this order when the new recipient phone belongs to an existing contact", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: "existing-recipient", display_name: "Rami" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-existing-phone" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          ...order,
          recipient_contact_id: "existing-recipient",
          recipient_phone: "+96171111999",
        }],
        rowCount: 1,
      });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { recipient_phone: "+96171111999" },
      });

    expect(response.status).toBe(200);
    const relinkCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE order_contacts"));
    expect(relinkCall?.[1]).toEqual(["existing-recipient", order.id]);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO contacts"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE contacts"))).toBe(false);
    const eventCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO order_events"));
    expect(String(eventCall?.[1]?.[2])).toContain(order.recipient_phone);
    expect(String(eventCall?.[1]?.[2])).toContain("+96171111999");
  });

  it("updates an unshared recipient contact when the phone is brand new", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ shared: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-new-phone" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...order, recipient_phone: "+96171111998" }],
        rowCount: 1,
      });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { recipient_phone: "+96171111998" },
      });

    expect(response.status).toBe(200);
    const updateContactCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE contacts"));
    expect(updateContactCall?.[1]?.[0]).toBe(order.recipient_contact_id);
    expect(updateContactCall?.[1]?.[5]).toBe("+96171111998");
  });

  it("queues a durable address fulfillment update in the same transaction", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-address" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...order, delivery_address: { address: "12 Cedar Street, Beirut" } }],
        rowCount: 1,
      });
    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { delivery_address: "12 Cedar Street, Beirut" },
      });
    expect(response.status).toBe(200);
    const jobCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO order_reschedule_jobs"));
    expect(jobCall).toBeTruthy();
    expect(String(jobCall?.[1]?.[7])).toContain("12 Cedar Street");
  });

  it("supersedes a completed needs_review result through the signed canonical order update", async () => {
    const body = {
      order_id: "42",
      delivery_address: "12 Cedar Street, Beirut",
      channel_id: "channel-1",
      request_id: "respondio-workflow-delivery-1",
    };
    const signature = createHmac("sha256", "incoming-secret")
      .update(JSON.stringify(body))
      .digest("base64");
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-workflow-address" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          ...order,
          delivery_address: { address: "12 Cedar Street, Beirut", latitude: 33.89, longitude: 35.5 },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(app())
      .post("/api/respondio/workflows/order-address-change")
      .set("x-webhook-signature", signature)
      .set("x-respondio-channel-id", "channel-1")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      saved: true,
      processing: false,
      status: "saved",
      changed: true,
      order_id: "42",
      order_number: "WEB-42",
      delivery_address: expect.objectContaining({ address: "12 Cedar Street, Beirut" }),
    }));
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO order_reschedule_jobs"))).toBe(true);
    expect(cancelAddressCollectionForOrderMock).toHaveBeenCalledWith(
      order.id,
      expect.stringContaining("Respond.io AI"),
    );
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("resolution_outcome = 'support_correction'"))).toBe(true);
  });

  it("rejects unsigned workflow corrections before workspace or order lookup", async () => {
    const response = await request(app())
      .post("/api/respondio/workflows/order-address-change")
      .set("x-respondio-channel-id", "channel-1")
      .send({
        order_id: "42",
        delivery_address: "12 Cedar Street, Beirut",
        channel_id: "channel-1",
        request_id: "unsigned-workflow-request",
      });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      saved: false,
      status: "rejected",
      code: "UNAUTHORIZED",
    }));
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("rejects a signed workflow body that was altered after signing", async () => {
    const signed = {
      order_id: "42",
      delivery_address: "12 Cedar Street, Beirut",
      channel_id: "channel-1",
      request_id: "respondio-workflow-delivery-2",
    };
    const signature = createHmac("sha256", "incoming-secret")
      .update(JSON.stringify(signed))
      .digest("base64");

    const response = await request(app())
      .post("/api/respondio/workflows/order-address-change")
      .set("x-webhook-signature", signature)
      .set("x-respondio-channel-id", "channel-1")
      .send({ ...signed, delivery_address: "99 Altered Street, Beirut" });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("rejects moving a valid signed correction to another channel", async () => {
    const body = {
      order_id: "42",
      delivery_address: "12 Cedar Street, Beirut",
      channel_id: "channel-1",
      request_id: "respondio-workflow-channel-binding",
    };
    const signature = createHmac("sha256", "incoming-secret")
      .update(JSON.stringify(body))
      .digest("base64");

    const response = await request(app())
      .post("/api/respondio/workflows/order-address-change")
      .set("x-webhook-signature", signature)
      .set("x-respondio-channel-id", "channel-2")
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("RESPONDIO_CHANNEL_MISMATCH");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns the original saved address for a duplicate signed workflow delivery", async () => {
    const body = {
      order_id: "42",
      delivery_address: "12 Cedar Street, Beirut",
      channel_id: "channel-1",
      request_id: "respondio-workflow-delivery-retry",
    };
    const signature = createHmac("sha256", "incoming-secret")
      .update(JSON.stringify(body))
      .digest("base64");
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          order_id: order.id,
          payload: {
            source: "respondio_workflow_address_correction",
            payload_fingerprint: createHashForTest(body.delivery_address),
            after: {
              delivery_address: {
                address: "12 Cedar Street, Beirut",
                latitude: 33.89,
                longitude: 35.5,
              },
            },
          },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          ...order,
          delivery_address: { address: "Later corrected address, Beirut" },
        }],
        rowCount: 1,
      });

    const response = await request(app())
      .post("/api/respondio/workflows/order-address-change")
      .set("x-webhook-signature", signature)
      .set("x-respondio-channel-id", "channel-1")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      saved: true,
      changed: false,
      idempotent: true,
      delivery_address: expect.objectContaining({
        address: "12 Cedar Street, Beirut",
      }),
    }));
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE orders"))).toBe(false);
  });

  it("replaces stale no-address and address_1 metadata with a canonical address", async () => {
    const noAddressOrder = {
      ...order,
      delivery_address: {
        noAddress: true,
        no_address: true,
        address_1: "Ask recipient",
        address: "Unknown",
        city: "Beirut",
        countryCode: "LB",
        date: "2026-09-10",
        slot: "09:00–12:00",
      },
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [noAddressOrder], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [noAddressOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-clean-address" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          ...noAddressOrder,
          delivery_address: { address: "Al Bayada 5th Street Jamil Building" },
        }],
        rowCount: 1,
      });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        change_type: "delivery_address",
        new_value: "Al Bayada 5th Street Jamil Building",
      });

    expect(response.status).toBe(200);
    const eligibilityValue = getAddressEligibilityMock.mock.calls[0]?.[0];
    expect(eligibilityValue).toEqual(expect.objectContaining({
      address: "Al Bayada 5th Street Jamil Building",
      city: "Beirut",
      countryCode: "LB",
    }));
    expect(eligibilityValue).not.toHaveProperty("noAddress");
    expect(eligibilityValue).not.toHaveProperty("no_address");
    expect(eligibilityValue).not.toHaveProperty("address_1");
    expect(cancelAddressCollectionForOrderMock).toHaveBeenCalledWith(
      order.id,
      expect.stringContaining("Respond.io AI"),
    );
  });

  it("accepts a usable full address when geocoding resolves only its locality", async () => {
    geocodeAddressMock.mockResolvedValue({
      lat: 33.902,
      lng: 35.59,
      matchType: "approximate",
      precision: "locality",
      method: "locality_fallback",
      matchedLocation: "Al Bayada, Lebanon",
      query: "Al Bayada, Lebanon",
      provider: "nominatim",
      placeIdentity: "nominatim:123",
      evidenceScore: 12,
    });
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "event-locality-address" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          ...order,
          delivery_address: { address: "Al Bayada 5th Street Jamil Building" },
        }],
        rowCount: 1,
      });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { delivery_address: "Al Bayada 5th Street Jamil Building" },
      });

    expect(response.status).toBe(200);
    const updateCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE orders"));
    const stored = JSON.parse(String(updateCall?.[1]?.[5]));
    expect(stored).toEqual(expect.objectContaining({
      address: "Al Bayada 5th Street Jamil Building",
      geocodeMatchType: "approximate",
      geocodePrecision: "locality",
      geocodeMethod: "locality_fallback",
    }));
  });

  it("still requires clarification for a genuinely invalid address", async () => {
    assessPlaceValidityMock.mockResolvedValue({
      valid: false,
      reason: "No identifiable delivery location",
    });
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 });
    clientQuery.mockResolvedValueOnce({ rows: [order], rowCount: 1 });

    const response = await request(app())
      .patch("/api/respondio/ai/orders/WEB-42")
      .set("authorization", "Bearer ai-secret")
      .send({
        customer_phone: "+96170111222",
        changes: { delivery_address: "Leave it somewhere nearby" },
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("ADDRESS_REQUIRES_CLARIFICATION");
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });
});

describe("Respond.io Address Collector Support fallback", () => {
  const newestRequest = {
    ...order,
    delivery_address: {
      ...order.delivery_address,
      address: "To be confirmed",
    },
    request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    request_status: "whatsapp_sent",
    request_created_at: "2026-09-02T12:00:00.000Z",
    request_closed_at: null as string | null,
    request_token_expires_at: "2099-09-05T12:00:00.000Z",
    request_recipient_phone: order.recipient_phone,
    request_respondio_contact_id: "contact-recipient",
    request_respondio_channel_id: "channel-543704" as string | null,
  };
  const olderRequest = {
    ...newestRequest,
    id: "33333333-3333-3333-3333-333333333333",
    external_order_id: "WEB-41",
    request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    request_created_at: "2026-09-01T12:00:00.000Z",
  };

  function installFallbackQueries(
    candidates: typeof newestRequest[],
    locked = candidates[0],
  ): void {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: candidates, rowCount: candidates.length });
    clientQuery.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("INSERT INTO address_collection_inbound_messages")) {
        return { rows: [{ id: "inbound-1" }], rowCount: 1 };
      }
      if (sql.includes("SELECT r.id AS request_id")) {
        return { rows: locked ? [locked] : [], rowCount: locked ? 1 : 0 };
      }
      if (sql.includes("UPDATE address_collection_requests")) {
        return { rows: [{ id: locked?.request_id }], rowCount: 1 };
      }
      if (sql.includes("UPDATE orders")) {
        return { rows: [{ id: locked?.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
  }

  function installFallbackQueriesWithoutMessageId(
    candidates: typeof newestRequest[],
    locked = candidates[0],
  ): void {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: candidates, rowCount: candidates.length });
    clientQuery.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("INSERT INTO address_collection_inbound_messages")) {
        return { rows: [{ id: "inbound-1" }], rowCount: 1 };
      }
      if (sql.includes("SELECT r.id AS request_id")) {
        return { rows: locked ? [locked] : [], rowCount: locked ? 1 : 0 };
      }
      if (sql.includes("UPDATE address_collection_requests")) {
        return { rows: [{ id: locked?.request_id }], rowCount: 1 };
      }
      if (sql.includes("UPDATE orders")) {
        return { rows: [{ id: locked?.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
  }

  function fallbackRequest(body: Record<string, unknown> = {}) {
    return request(app())
      .post("/api/respondio/ai/address-collection/fallback")
      .set("authorization", "Bearer ai-secret")
      .set("x-respondio-channel-id", "channel-543704")
      .send({
        contact_phone: order.recipient_phone,
        address: "12 Cedar Street, Beirut",
        message_id: "wamid.inbound-address-reply",
        ...body,
      });
  }

  it("requires an explicit Respond.io channel for this privileged fallback", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "owner-1" }],
      rowCount: 1,
    });
    const response = await request(app())
      .post("/api/respondio/ai/address-collection/fallback")
      .set("authorization", "Bearer ai-secret")
      .send({
        contact_phone: order.recipient_phone,
        address: "12 Cedar Street, Beirut",
        message_id: "wamid.no-channel",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("RESPONDIO_CHANNEL_REQUIRED");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("accepts no phone when one address request is unambiguous", async () => {
    installFallbackQueries([newestRequest]);

    const response = await fallbackRequest({ contact_phone: undefined });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: true,
      address_collection_ref: newestRequest.request_id,
    }));
    const candidateSql = String(dbQuery.mock.calls[2]?.[0]);
    expect(candidateSql).toContain("r.workspace_owner_id = $1");
    expect(candidateSql).not.toContain("recipient_contact.phone");
  });

  it("fails closed when a supplied phone does not match the correlated request", async () => {
    installFallbackQueries([newestRequest]);

    const response = await fallbackRequest({ contact_phone: "+96170111111" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("returns the persisted result when Respond.io retries a resolved message", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          outcome: "resolved",
          request_id: newestRequest.request_id,
          request_status: "resolved",
          request_closed_at: "2026-09-04T08:08:22.063Z",
          submitted_address: { address: "12 Cedar Street, Beirut" },
          display_order_number: null,
          external_order_number: null,
          external_order_id: "WEB-42",
          delivery_address: { address: "12 Cedar Street, Beirut" },
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: false,
      idempotent: true,
      order_number: "WEB-42",
      address_collection_ref: newestRequest.request_id,
    }));
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("treats a resolved native location pin as authoritative when the action fields differ", async () => {
    const persistedPin = {
      source: "respondio_recipient_reply",
      reply_type: "location",
      location: {
        latitude: 33.8938,
        longitude: 35.5018,
      },
      latitude: 33.8938,
      longitude: 35.5018,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          provider_message_id: "wamid.inbound-address-reply",
          reply_type: "location",
          reply_text: null,
          processed_at: "2026-09-14T08:08:22.063Z",
          processing_started_at: null,
          claim_token: null,
          claim_active: false,
          outcome: "resolved",
          request_id: newestRequest.request_id,
          order_id: newestRequest.id,
          request_status: "resolved",
          request_closed_at: "2026-09-14T08:08:22.063Z",
          closure_source: "incoming_reply",
          resolution_outcome: "automatic_collection",
          inbound_outcome: "resolved",
          submitted_address: persistedPin,
          delivery_address: persistedPin,
          display_order_number: null,
          external_order_number: null,
          external_order_id: "LB-2786",
          reply_reference_matches: true,
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest({
      address: { lat: 33.8938, lng: 35.5018 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: false,
      processing: false,
      saved: true,
      status: "saved",
      idempotent: true,
      order_number: "LB-2786",
      address_collection_ref: newestRequest.request_id,
      delivery_address: persistedPin,
    }));
    expect(geocodeAddressMock).not.toHaveBeenCalled();
    expect(assessPlaceValidityMock).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("returns processing for an exact native pin before validating missing action fields", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          provider_message_id: "wamid.inbound-address-reply",
          reply_type: "location",
          reply_text: null,
          processed_at: null,
          processing_started_at: "2026-09-14T08:08:09.521Z",
          claim_token: "11111111-1111-4111-8111-111111111111",
          claim_active: true,
          outcome: null,
          request_id: newestRequest.request_id,
          order_id: newestRequest.id,
          request_status: "processing",
          request_closed_at: null,
          closure_source: null,
          resolution_outcome: null,
          inbound_outcome: null,
          submitted_address: null,
          delivery_address: newestRequest.delivery_address,
          display_order_number: null,
          external_order_number: null,
          external_order_id: "LB-2786",
          reply_reference_matches: true,
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest({ address: undefined });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: false,
      processing: true,
      saved: false,
      status: "processing",
      idempotent: true,
      order_number: "LB-2786",
      address_collection_ref: newestRequest.request_id,
      delivery_address: null,
    }));
    expect(geocodeAddressMock).not.toHaveBeenCalled();
    expect(assessPlaceValidityMock).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("treats the exact production reply as idempotent when its request-level channel is null", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          outcome: "resolved",
          request_id: "3ac81445-820b-4dc8-a0f1-46a664b01bdf",
          request_status: "resolved",
          request_closed_at: "2026-09-03T13:14:43.697Z",
          submitted_address: { address: "beirut ras el nabeh chaar pharmacy" },
          display_order_number: null,
          external_order_number: null,
          external_order_id: "LB-2542",
          delivery_address: { address: "beirut ras el nabeh chaar pharmacy" },
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest({
      contact_phone: order.recipient_phone,
      contact_id: "513998309",
      message_id: "1788441276000000",
      address: "beirut ras el nabeh chaar pharmacy",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      changed: false,
      idempotent: true,
      address_collection_ref: "3ac81445-820b-4dc8-a0f1-46a664b01bdf",
    }));
    const idempotencySql = String(dbQuery.mock.calls[1]?.[0]);
    expect(idempotencySql).toContain("r.respondio_channel_id IS NULL AND m.channel_id = $3");
  });

  it("rejects an exact native message retry when a later correction stored a different address", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          provider_message_id: "wamid.original-address",
          reply_type: "text",
          reply_text: "Original Address, Beirut",
          processed_at: "2026-09-04T08:08:22.063Z",
          processing_started_at: null,
          claim_token: null,
          claim_active: false,
          outcome: "superseded_by_support_fallback",
          request_id: newestRequest.request_id,
          order_id: newestRequest.id,
          request_status: "resolved",
          request_closed_at: "2026-09-04T08:09:00.000Z",
          submitted_address: { address: "Corrected Address, Beirut" },
          delivery_address: { address: "Corrected Address, Beirut" },
          display_order_number: null,
          external_order_number: null,
          external_order_id: "LB-2561",
          reply_reference_matches: true,
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest({
      message_id: "wamid.original-address",
      address: "Original Address, Beirut",
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ADDRESS_COLLECTION_ADDRESS_MISMATCH");
    expect(response.body.saved).toBe(false);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("treats the production native-resolution race as idempotent without a message ID", async () => {
    const resolvedAddress = { address: "beirut ras el nabeh chaar pharmacy" };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          provider_message_id: "1788441276000000",
          request_id: "3ac81445-820b-4dc8-a0f1-46a664b01bdf",
          order_id: "235f1f56-a5df-4f2e-9ebc-0a0e7c6a3de8",
          reply_type: "text",
          reply_text: "Beirut   Ras El Nabeh Chaar Pharmacy",
          received_at: "2026-09-03T13:14:31.000Z",
          processed_at: "2026-09-03T13:14:43.697Z",
          outcome: "resolved",
          request_status: "resolved",
          request_closed_at: "2026-09-03T13:14:43.697Z",
          closure_source: "incoming_reply",
          resolution_outcome: "automatic_collection",
          inbound_outcome: "resolved",
          submitted_address: resolvedAddress,
          display_order_number: null,
          external_order_number: null,
          external_order_id: "LB-2542",
          delivery_address: resolvedAddress,
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest({
      contact_phone: order.recipient_phone,
      address: "beirut ras el nabeh chaar pharmacy",
      message_id: undefined,
      contact_id: undefined,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: false,
      processing: false,
      saved: true,
      status: "saved",
      idempotent: true,
      order_number: "LB-2542",
      address_collection_ref: "3ac81445-820b-4dc8-a0f1-46a664b01bdf",
      delivery_address: resolvedAddress,
    }));
    const lookupSql = String(dbQuery.mock.calls[2]?.[0]);
    expect(lookupSql).toContain("m.received_at >= now()");
    expect(lookupSql).toContain("m.normalized_phone = $7");
    expect(lookupSql).toContain("m.contact_id = $8");
    expect(dbQuery.mock.calls[2]?.[1]?.[2]).toBe(10);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("immediately acknowledges the exact LB-2561 native reply while it is processing", async () => {
    const processing = {
      provider_message_id: "1788509285000000",
      request_id: "c68afc22-56c4-4df3-ae22-d6d52c3be16f",
      order_id: "bb61a897-c593-4c55-8970-a37db032e4f3",
      reply_type: "text",
      reply_text: "beirut ras el nabeh chaar pharmacy",
      received_at: "2026-09-04T08:08:09.521Z",
      processed_at: null,
      processing_started_at: "2026-09-04T08:08:09.521Z",
      claim_token: "11111111-1111-4111-8111-111111111111",
      claim_active: true,
      outcome: null,
      request_status: "processing",
      request_closed_at: null,
      closure_source: null,
      resolution_outcome: null,
      inbound_outcome: null,
      submitted_address: null,
      display_order_number: null,
      external_order_number: null,
      external_order_id: "LB-2561",
      delivery_address: { address: "To be confirmed" },
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [processing], rowCount: 1 });

    const startedAt = performance.now();
    const response = await fallbackRequest({
      contact_phone: "96176725830",
      contact_id: "513998309",
      address: processing.reply_text,
      message_id: undefined,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: false,
      processing: true,
      saved: false,
      status: "processing",
      idempotent: true,
      order_number: "LB-2561",
      address_collection_ref: processing.request_id,
      delivery_address: null,
    }));
    expect(response.body.message).toContain("not yet confirmed saved");
    expect(elapsedMs).toBeLessThan(1_000);
    expect(dbQuery).toHaveBeenCalledTimes(3);
    expect(dbQuery.mock.calls[2]?.[1]?.[6]).toBe("+96176725830");
    expect(dbQuery.mock.calls[2]?.[1]?.[7]).toBe("513998309");
    expect(clientQuery).not.toHaveBeenCalled();
    expect(geocodeAddressMock).not.toHaveBeenCalled();
  });

  it("does not return native idempotent success when processing persisted a different address", async () => {
    const row = {
      provider_message_id: "1788509285000000",
      request_id: newestRequest.request_id,
      order_id: newestRequest.id,
      reply_type: "text",
      reply_text: "beirut ras el nabeh chaar pharmacy",
      received_at: "2026-09-04T08:08:09.521Z",
      processed_at: "2026-09-04T08:08:22.063Z",
      outcome: "resolved",
      request_status: "resolved",
      request_closed_at: "2026-09-04T08:08:22.063Z",
      closure_source: "incoming_reply",
      resolution_outcome: "automatic_collection",
      inbound_outcome: "resolved",
      submitted_address: { address: "Different persisted address, Beirut" },
      display_order_number: null,
      external_order_number: null,
      external_order_id: "LB-2561",
      delivery_address: { address: "Different persisted address, Beirut" },
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await fallbackRequest({
      address: row.reply_text,
      message_id: undefined,
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("lets the authenticated agent save an explicit correction after native processing ended in needs_review", async () => {
    const needsReview = {
      provider_message_id: "1788509285000000",
      request_id: newestRequest.request_id,
      order_id: newestRequest.id,
      reply_type: "text",
      reply_text: "beirut ras el nabeh chaar pharmacy",
      received_at: "2026-09-04T08:08:09.521Z",
      processed_at: "2026-09-04T08:08:22.063Z",
      outcome: "not_geocoded",
      request_status: "needs_review",
      request_closed_at: null,
      closure_source: null,
      resolution_outcome: null,
      inbound_outcome: "not_geocoded",
      submitted_address: null,
      display_order_number: null,
      external_order_number: null,
      external_order_id: "LB-2561",
      delivery_address: newestRequest.delivery_address,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [needsReview], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [newestRequest], rowCount: 1 });
    clientQuery.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("INSERT INTO address_collection_inbound_messages")) {
        return { rows: [{ id: "inbound-1" }], rowCount: 1 };
      }
      if (sql.includes("SELECT r.id AS request_id")) {
        return { rows: [newestRequest], rowCount: 1 };
      }
      if (sql.includes("UPDATE address_collection_requests")) {
        return { rows: [{ id: newestRequest.request_id }], rowCount: 1 };
      }
      if (sql.includes("UPDATE orders")) {
        return { rows: [{ id: newestRequest.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await fallbackRequest({
      contact_phone: order.recipient_phone,
      address: needsReview.reply_text,
      message_id: undefined,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: true,
      processing: false,
      saved: true,
      status: "saved",
      address_collection_ref: newestRequest.request_id,
      delivery_address: expect.objectContaining({
        address: expect.any(String),
      }),
    }));
    expect(clientQuery).toHaveBeenCalled();
    expect(geocodeAddressMock).toHaveBeenCalled();
  });

  it("does not poll or duplicate mutations when the exact native reply remains processing", async () => {
    const processing = {
      provider_message_id: "1788509285000000",
      request_id: newestRequest.request_id,
      order_id: newestRequest.id,
      reply_type: "text",
      reply_text: "beirut ras el nabeh chaar pharmacy",
      received_at: "2026-09-04T08:08:09.521Z",
      processed_at: null,
      processing_started_at: "2026-09-04T08:08:09.521Z",
      claim_token: "11111111-1111-4111-8111-111111111111",
      claim_active: true,
      outcome: null,
      request_status: "processing",
      request_closed_at: null,
      closure_source: null,
      resolution_outcome: null,
      inbound_outcome: null,
      submitted_address: null,
      display_order_number: null,
      external_order_number: null,
      external_order_id: "LB-2561",
      delivery_address: newestRequest.delivery_address,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [processing], rowCount: 1 });

    const response = await fallbackRequest({
      address: processing.reply_text,
      message_id: undefined,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      processing: true,
      saved: false,
      changed: false,
      idempotent: true,
    }));
    expect(dbQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(geocodeAddressMock).not.toHaveBeenCalled();
    expect(dbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("NOT EXISTS") && String(sql).includes("linked_order"))).toBe(false);
  });

  it("does not treat a different address as the same native resolution", async () => {
    const resolvedAddress = { address: "beirut ras el nabeh chaar pharmacy" };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          provider_message_id: "1788441276000000",
          request_id: newestRequest.request_id,
          order_id: newestRequest.id,
          reply_type: "text",
          reply_text: resolvedAddress.address,
          submitted_address: resolvedAddress,
          display_order_number: null,
          external_order_number: null,
          external_order_id: "LB-2542",
          delivery_address: resolvedAddress,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [newestRequest], rowCount: 1 });
    clientQuery.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("INSERT INTO address_collection_inbound_messages")) {
        return { rows: [{ id: "inbound-1" }], rowCount: 1 };
      }
      if (sql.includes("SELECT r.id AS request_id")) {
        return { rows: [newestRequest], rowCount: 1 };
      }
      if (sql.includes("UPDATE address_collection_requests")) {
        return { rows: [{ id: newestRequest.request_id }], rowCount: 1 };
      }
      if (sql.includes("UPDATE orders")) {
        return { rows: [{ id: newestRequest.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await fallbackRequest({
      address: "Hamra, Beirut",
      message_id: undefined,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      changed: true,
      idempotent: false,
    }));
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE orders"))).toBe(true);
  });

  it.each([
    {
      label: "phone",
      body: { contact_phone: "+96170111111", contact_id: undefined },
    },
    {
      label: "contact",
      body: { contact_phone: order.recipient_phone, contact_id: "wrong-contact" },
    },
  ])("rejects a native-resolution match with the wrong $label", async ({ body }) => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await fallbackRequest({
      ...body,
      message_id: undefined,
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("does not treat a native resolution outside the bounded window as a duplicate", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(String(dbQuery.mock.calls[2]?.[0])).toContain("m.received_at >= now()");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("fails closed when multiple recent native resolutions match the same payload", async () => {
    const resolvedAddress = { address: "12 Cedar Street, Beirut" };
    const nativeResolution = {
      provider_message_id: "wamid.native-1",
      request_id: newestRequest.request_id,
      order_id: newestRequest.id,
      reply_type: "text",
      reply_text: resolvedAddress.address,
      submitted_address: resolvedAddress,
      display_order_number: newestRequest.display_order_number,
      external_order_number: newestRequest.external_order_number,
      external_order_id: newestRequest.external_order_id,
      delivery_address: resolvedAddress,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          nativeResolution,
          {
            ...nativeResolution,
            provider_message_id: "wamid.native-2",
            request_id: olderRequest.request_id,
            order_id: olderRequest.id,
          },
        ],
        rowCount: 2,
      });

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("AMBIGUOUS_ADDRESS_COLLECTION_REQUEST");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("finds a matching native resolution after more than ten newer nonmatches", async () => {
    const matchingAddress = { address: "12 Cedar Street, Beirut" };
    const nonmatches = Array.from({ length: 10 }, (_, index) => ({
      provider_message_id: `wamid.newer-${index}`,
      request_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      order_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      reply_type: "text",
      reply_text: `Different address ${index}, Beirut`,
      submitted_address: { address: `Different address ${index}, Beirut` },
      display_order_number: null,
      external_order_number: null,
      external_order_id: `LB-${3000 + index}`,
      delivery_address: { address: `Different address ${index}, Beirut` },
    }));
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          ...nonmatches,
          {
            provider_message_id: "wamid.matching-native",
            request_id: newestRequest.request_id,
            order_id: newestRequest.id,
            reply_type: "text",
            reply_text: matchingAddress.address,
            received_at: "2026-09-03T13:14:31.000Z",
            processed_at: "2026-09-03T13:14:43.697Z",
            outcome: "resolved",
            request_status: "resolved",
            request_closed_at: "2026-09-03T13:14:43.697Z",
            closure_source: "incoming_reply",
            resolution_outcome: "automatic_collection",
            inbound_outcome: "resolved",
            submitted_address: matchingAddress,
            display_order_number: newestRequest.display_order_number,
            external_order_number: newestRequest.external_order_number,
            external_order_id: newestRequest.external_order_id,
            delivery_address: matchingAddress,
          },
        ],
        rowCount: 11,
      });

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      changed: false,
      idempotent: true,
      address_collection_ref: newestRequest.request_id,
    }));
    expect(String(dbQuery.mock.calls[2]?.[0])).not.toContain("LIMIT 10");
    expect(dbQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("accepts the minimal phone and text-address body without a provider message ID", async () => {
    installFallbackQueriesWithoutMessageId([newestRequest]);

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: true,
      idempotent: false,
      address_collection_ref: newestRequest.request_id,
    }));
    const inboundInsert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_inbound_messages"));
    expect(inboundInsert?.[1]?.[0]).toMatch(/^support-fallback:v1:[0-9a-f]{64}$/);
  });

  it("accepts the production Respond.io digits-only contact phone as metadata", async () => {
    const productionRequest = {
      ...newestRequest,
      external_order_id: "LB-2541",
      recipient_phone: "+96170154912",
      request_recipient_phone: "+96170154912",
    };
    installFallbackQueriesWithoutMessageId([productionRequest], productionRequest);

    const response = await fallbackRequest({
      contact_phone: "96170154912",
      address: "beirut achrafieh sourok garden",
      message_id: undefined,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: true,
      order_number: "LB-2541",
      address_collection_ref: productionRequest.request_id,
    }));
    const candidateParams = dbQuery.mock.calls[3]?.[1];
    expect(candidateParams).not.toContain("96170154912");
    expect(candidateParams).not.toContain("70154912");
    expect(candidateParams).not.toContain("070154912");
    const inboundInsert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_inbound_messages"));
    expect(inboundInsert?.[1]?.[6]).toBe("+96170154912");
  });

  it("recovers an open needs-review request after prior automated validation failed", async () => {
    const needsReviewRequest = {
      ...newestRequest,
      id: "a98c66d1-c860-4c13-8a3d-1da84b0dd667",
      request_id: "14d41693-bf41-4718-8cfe-070f129b0719",
      request_status: "needs_review",
      request_recipient_phone: "+96170154912",
      request_respondio_contact_id: "513997495",
      request_respondio_channel_id: null,
    };
    installFallbackQueriesWithoutMessageId([needsReviewRequest], needsReviewRequest);

    const response = await fallbackRequest({
      contact_phone: "96170154912",
      contact_id: "513997495",
      address: "beirut ras el nabeh chaar pharmacy",
      message_id: undefined,
      address_collection_ref: needsReviewRequest.request_id,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      changed: true,
      address_collection_ref: needsReviewRequest.request_id,
    }));
    const candidateSql = String(dbQuery.mock.calls[3]?.[0]);
    const candidateParams = dbQuery.mock.calls[3]?.[1];
    expect(candidateSql).toContain("r.closed_at IS NULL");
    expect(candidateSql).toContain("r.token_expires_at > now()");
    expect(candidateSql).toContain("address_collection_inbound_messages channel_evidence");
    expect(candidateParams?.[2]).toBe(needsReviewRequest.request_id);
    expect(candidateParams?.[1]).toContain("needs_review");
    const requestUpdate = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE address_collection_requests"));
    expect(String(requestUpdate?.[0])).toContain("status = ANY($9::text[])");
    expect(String(requestUpdate?.[0])).toContain("closed_at = now()");
    expect(String(requestUpdate?.[0])).toContain("respondio_channel_id = COALESCE(respondio_channel_id, $10)");
    expect(requestUpdate?.[1]?.[8]).toContain("needs_review");
    expect(requestUpdate?.[1]?.[9]).toBe("channel-543704");
  });

  it("still rejects local contact phones without an explicit country calling code", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "owner-1" }],
      rowCount: 1,
    });

    const response = await fallbackRequest({
      contact_phone: "70 154 912",
      address: "beirut achrafieh sourok garden",
      message_id: undefined,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_CONTACT_PHONE");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("returns success idempotently when the same no-message-ID payload is retried", async () => {
    installFallbackQueriesWithoutMessageId([newestRequest]);
    const first = await fallbackRequest({ message_id: undefined });
    expect(first.status).toBe(200);

    const inboundInsert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_inbound_messages"));
    const syntheticMessageId = inboundInsert?.[1]?.[0];
    expect(syntheticMessageId).toMatch(/^support-fallback:v1:[0-9a-f]{64}$/);

    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          provider_message_id: syntheticMessageId,
          outcome: "resolved",
          request_id: newestRequest.request_id,
          order_id: newestRequest.id,
          display_order_number: newestRequest.display_order_number,
          external_order_number: newestRequest.external_order_number,
          external_order_id: newestRequest.external_order_id,
          submitted_address: { address: "12 Cedar Street, Beirut" },
          delivery_address: { address: "12 Cedar Street, Beirut" },
        }],
        rowCount: 1,
      });

    const retry = await fallbackRequest({ message_id: undefined });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(expect.objectContaining({
      success: true,
      changed: false,
      idempotent: true,
      address_collection_ref: newestRequest.request_id,
    }));
  });

  it("fails closed when a different valid phone has no recipient match", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await fallbackRequest({
      contact_phone: "+96170111111",
      message_id: undefined,
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("fails safely when no active eligible Address Collector request exists", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("reports the production needs-review request as orphaned when its linked order is missing", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          request_id: "14d41693-bf41-4718-8cfe-070f129b0719",
          order_id: "a98c66d1-c860-4c13-8a3d-1da84b0dd667",
        }],
        rowCount: 1,
      });

    const response = await fallbackRequest({
      contact_phone: "96170154912",
      contact_id: "513997495",
      address_collection_ref: "14d41693-bf41-4718-8cfe-070f129b0719",
      message_id: undefined,
      address: "beirut achrafieh sourok garden",
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ORPHANED_ADDRESS_COLLECTION_REQUEST");
    const orphanSql = String(dbQuery.mock.calls[5]?.[0]);
    expect(orphanSql).toContain("NOT EXISTS");
    expect(orphanSql).toContain("linked_order.id = r.order_id");
    expect(orphanSql).toContain("address_collection_inbound_messages channel_evidence");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("does not mutate an order that already has a usable delivery address", async () => {
    installFallbackQueriesWithoutMessageId([{
      ...newestRequest,
      delivery_address: {
        ...newestRequest.delivery_address,
        address: "Existing real address, Beirut",
      },
    }]);
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("ignores blank or unresolved optional correlation fields", async () => {
    installFallbackQueriesWithoutMessageId([newestRequest]);

    const response = await fallbackRequest({
      message_id: "",
      reply_to_provider_ref: " ",
      address_collection_ref: "{{ contact.address_collection_ref }}",
      contact_id: "$contact.unavailable_id",
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const candidateParams = dbQuery.mock.calls[3][1];
    expect(candidateParams[2]).toBeNull();
    expect(candidateParams[3]).toBeNull();
    expect(candidateParams[4]).toBe(newestRequest.request_respondio_channel_id);
  });

  it("does not require recipient-phone ownership for a trusted Respond.io fallback", async () => {
    installFallbackQueries([newestRequest]);
    const response = await fallbackRequest();

    expect(response.status).toBe(200);
    const candidateSql = String(dbQuery.mock.calls[2][0]);
    expect(candidateSql).not.toContain("recipient_link.role = 'recipient'");
    expect(candidateSql).not.toContain("recipient_contact.phone");
    expect(candidateSql).not.toContain("COALESCE(customer.phone");
  });

  it("selects only through workspace, channel, and request correlation", async () => {
    installFallbackQueries([newestRequest]);
    const response = await fallbackRequest();

    expect(response.status).toBe(200);
    const candidateSql = String(dbQuery.mock.calls[2][0]);
    expect(candidateSql).toContain("r.workspace_owner_id = $1");
    expect(candidateSql).toContain("r.respondio_channel_id = $5");
    expect(candidateSql).not.toContain("recipient_link.order_id = o.id");
    expect(response.body.order_number).toBe("WEB-42");
  });

  it("selects the only active Address Collector request when the recipient has several orders", async () => {
    installFallbackQueries([newestRequest]);
    const response = await fallbackRequest();

    expect(response.status).toBe(200);
    expect(response.body.address_collection_ref).toBe(newestRequest.request_id);
    expect(response.body.order_number).toBe("WEB-42");
  });

  it("rejects multiple unresolved matches without mutating either order", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [newestRequest, olderRequest], rowCount: 2 });
    const response = await fallbackRequest();

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("AMBIGUOUS_ADDRESS_COLLECTION_REQUEST");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("fails closed when the newest active requests have the same creation time", async () => {
    const tied = {
      ...olderRequest,
      request_created_at: newestRequest.request_created_at,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [newestRequest, tied], rowCount: 2 });

    const response = await fallbackRequest();
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("AMBIGUOUS_ADDRESS_COLLECTION_REQUEST");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("gives an exact reply-to provider reference precedence over request recency", async () => {
    installFallbackQueries([olderRequest], olderRequest);
    const response = await fallbackRequest({
      reply_to_provider_ref: "wamid.exact-outbound-message",
      address_collection_ref: olderRequest.request_id,
    });

    expect(response.status).toBe(200);
    expect(response.body.order_number).toBe("WEB-41");
    expect(dbQuery.mock.calls[2][1][2]).toBeNull();
    expect(dbQuery.mock.calls[2][1][3]).toBe("wamid.exact-outbound-message");
  });

  it("requires no recipient-supplied phone or order number when Respond.io injects message context", async () => {
    installFallbackQueries([newestRequest]);
    const response = await fallbackRequest();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.changed).toBe(true);
  });

  it.each(["resolved", "address_received", "verified"])(
    "rejects a %s request without mutating its order",
    async (requestStatus) => {
      installFallbackQueriesWithoutMessageId([{
        ...newestRequest,
        request_status: requestStatus,
        request_closed_at: "2026-09-03T12:40:00.000Z",
      }]);

      const response = await fallbackRequest({ message_id: undefined });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
      expect(clientQuery).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "expired"])(
    "rejects a %s request without mutating its order",
    async (requestStatus) => {
      installFallbackQueriesWithoutMessageId([{
        ...newestRequest,
        request_status: requestStatus,
        request_closed_at: "2026-09-03T12:40:00.000Z",
      }]);

      const response = await fallbackRequest({ message_id: undefined });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe("ACTIVE_ADDRESS_COLLECTION_NOT_FOUND");
      expect(clientQuery).not.toHaveBeenCalled();
    },
  );

  it("rejects an unresolved request when its linked order is completed", async () => {
    installFallbackQueriesWithoutMessageId([{
      ...newestRequest,
      status: "completed",
    }]);

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ORDER_NOT_EDITABLE");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("enforces an address-only request contract", async () => {
    const rejected = await fallbackRequest({ card_message: "Reveal the surprise" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("INVALID_REQUEST");

    installFallbackQueries([newestRequest]);
    const accepted = await fallbackRequest();
    expect(accepted.status).toBe(200);
    const orderUpdate = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE orders"));
    expect(String(orderUpdate?.[0])).toContain("SET delivery_address = $3::jsonb");
    expect(String(orderUpdate?.[0])).not.toContain("card_message");
    expect(String(orderUpdate?.[0])).not.toContain("window_start");
    expect(String(orderUpdate?.[0])).not.toContain("recipient_phone");
  });

  it("asks for clarification when the address itself is invalid", async () => {
    installFallbackQueries([newestRequest]);
    assessPlaceValidityMock.mockResolvedValue({
      valid: false,
      reason: "No identifiable delivery location",
    });

    const response = await fallbackRequest({ address: "Leave it nearby" });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("ADDRESS_REQUIRES_CLARIFICATION");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("updates only the selected order and leaves unrelated orders untouched", async () => {
    installFallbackQueries([newestRequest], newestRequest);
    const response = await fallbackRequest();

    expect(response.status).toBe(200);
    const orderUpdate = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE orders"));
    expect(orderUpdate?.[1]?.[0]).toBe(newestRequest.id);
    expect(orderUpdate?.[1]?.[0]).not.toBe(olderRequest.id);
    expect(String(orderUpdate?.[0])).toContain("workspace_owner_id = $2");
  });

  it("fails closed if the request is relinked to a different order before locking", async () => {
    const relinked = {
      ...newestRequest,
      id: olderRequest.id,
      external_order_id: olderRequest.external_order_id,
    };
    installFallbackQueriesWithoutMessageId([newestRequest], relinked);

    const response = await fallbackRequest({ message_id: undefined });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ADDRESS_COLLECTION_REQUEST_CHANGED");
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE address_collection_requests"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE orders"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_events"))).toBe(false);
  });
});