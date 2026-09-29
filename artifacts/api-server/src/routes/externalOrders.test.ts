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
const mockCreateAddressCollectionRequest = vi.fn().mockResolvedValue({ created: true, requestId: "request-1", token: "token" });

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendWhishPaymentInstructions: vi.fn().mockResolvedValue({ ok: false }),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("../lib/addressCollector/service", () => ({
  createAddressCollectionRequest: (...args: unknown[]) => mockCreateAddressCollectionRequest(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/addressBookAutoLink", () => ({
  linkOrderToAddressBook: vi.fn().mockResolvedValue(undefined),
}));

const mockRequireApiKey = vi.fn(
  (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
);

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (...args: Parameters<express.RequestHandler>) => mockRequireApiKey(...args),
  resolveApiKeyWorkspace: vi.fn().mockResolvedValue(null),
}));

const mockUpsertContact = vi.fn();
const mockRefreshPhonePlaceholderContactAfterFirstOrder = vi.fn().mockResolvedValue(false);

vi.mock("../lib/contactUpsert", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
  refreshPhonePlaceholderContactAfterFirstOrder: (...args: unknown[]) =>
    mockRefreshPhonePlaceholderContactAfterFirstOrder(...args),
}));

const mockBroadcastEvent = vi.fn();

vi.mock("../lib/autoTags", () => ({
  applyAutoTagsForContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/orderAlerts", () => ({
  notifyNewOrderAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: (...args: unknown[]) => mockBroadcastEvent(...args),
}));

const mockFireWebhookEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: (...args: unknown[]) => mockFireWebhookEvent(...args),
}));

const mockSendOrderConfirmationEmail = vi.fn().mockResolvedValue(undefined);
const mockSendNewOrderStaffEmail = vi.fn().mockResolvedValue(undefined);
const mockSendOrderPaymentInstructionsEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/email", () => ({
  sendOrderConfirmationEmail: (...args: unknown[]) => mockSendOrderConfirmationEmail(...args),
  sendNewOrderStaffEmail: (...args: unknown[]) => mockSendNewOrderStaffEmail(...args),
  sendOrderPaymentInstructionsEmail: (...args: unknown[]) =>
    mockSendOrderPaymentInstructionsEmail(...args),
}));

const mockIsTookanEnabled = vi.fn();
const mockCreateTookanDeliveryTask = vi.fn();

vi.mock("../lib/tookan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tookan")>();
  return {
    ...actual,
    isTookanEnabled: (...args: unknown[]) => mockIsTookanEnabled(...args),
    createTookanDeliveryTask: (...args: unknown[]) => mockCreateTookanDeliveryTask(...args),
  };
});

const mockSyncApprovedFloristPhotoForOrder = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/floristTookanPhotoSync", () => ({
  syncApprovedFloristPhotoForOrderToTookan: (...args: unknown[]) =>
    mockSyncApprovedFloristPhotoForOrder(...args),
}));

const mockNotifyNewUaeOrderToSlack = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/slack", () => ({
  notifyNewUaeOrderToSlack: (...args: unknown[]) => mockNotifyNewUaeOrderToSlack(...args),
}));

// Stripe amount verification is mocked so no test ever hits the network.
// Default: "error" (Stripe unreachable) → the ingest fails open and uses the
// payload values, which keeps all pre-existing tests behaving unchanged.
const mockVerifyStripeAmount = vi.fn();

vi.mock("../lib/stripeAmountVerification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripeAmountVerification")>();
  return {
    ...actual,
    verifyStripePaymentIntentAmount: (...args: unknown[]) => mockVerifyStripeAmount(...args),
  };
});

import router from "./externalOrders";

// ---------------------------------------------------------------------------
// Test app
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

const OWNER_ID = "owner_123";

// ---------------------------------------------------------------------------
// Transaction stub helpers
//
// The order creation route runs inside a DB transaction:
//   client.query("BEGIN")        ← call index 0
//   client.query(ORDER INSERT)   ← call index 1
//   client.query(side effects…)  ← call indices 2…N
//   client.query("COMMIT")       ← last call
//
// Validation failures (400) happen before any DB call, so no stubs needed.
// ---------------------------------------------------------------------------

function stubTxBegin() {
  mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}
function stubTxCommit() {
  mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}
function stubTxRollback() {
  mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}
function stubOrderInsert(orderId = "order-uuid-1", wasInserted = true) {
  mockClientQuery.mockResolvedValueOnce({
    rows: [{ id: orderId, was_inserted: wasInserted }],
    rowCount: 1,
  });
}
function stubSideEffects(count = 3) {
  for (let i = 0; i < count; i++) {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpsertContact.mockResolvedValue(null);
  mockCreateAddressCollectionRequest.mockResolvedValue({ created: true, requestId: "request-1", token: "token" });
  // Default: Stripe unreachable → ingest fails open on payload values.
  mockVerifyStripeAmount.mockResolvedValue({ status: "error" });
  // Default db.query (used for product resolution): resolve nothing.
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  // Default requireApiKey: passes through (sets userId on req as middleware stub above does)
  mockRequireApiKey.mockImplementation(
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  );
  // Default db.connect: returns a client whose query/release are mocked
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: mockClientRelease,
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("POST /api/orders — validation", () => {
  it("returns 400 when neither line_items nor items are provided", async () => {
    const res = await request(makeApp())
      .post("/api/orders")
      .send({ external_order_id: "x" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when items array is empty", async () => {
    const res = await request(makeApp())
      .post("/api/orders")
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when item name is missing", async () => {
    const res = await request(makeApp())
      .post("/api/orders")
      .send({ items: [{ productId: "p1", quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when contact email is invalid", async () => {
    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        billing: { email: "not-an-email" },
      });
    expect(res.status).toBe(400);
  });

  it("400 body lists every offending field (path: message), not just the first", async () => {
    const res = await request(makeApp())
      .post("/api/orders")
      .send({ items: [], billing: { email: "not-an-email" } });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Both the email error and the empty-order error must be present.
    expect(res.body.error).toMatch(/billing\.email/);
    expect(res.body.error).toMatch(/items, line_items, or feeItems/);
  });

  it("accepts a fee-only order (empty items but non-empty feeItems) and returns 201", async () => {
    stubTxBegin();
    stubOrderInsert("order-feeonly-1", true);
    stubSideEffects(2); // 1 fee item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "feeonly-1",
        items: [],
        feeItems: [{ name: "Delivery Fee", quantity: 1, priceUsd: 10 }],
        delivery: { cityId: "beirut", feeUsd: 7 },
        payment: { method: "whish", totalUsd: 17 },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.order_id).toBe("order-feeonly-1");
    // The fee item must have been inserted into order_line_items.
    const feeInsert = mockClientQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("order_line_items") &&
        Array.isArray(c[1]) &&
        c[1].includes("Delivery Fee"),
    );
    expect(feeInsert).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Simple legacy format
// ---------------------------------------------------------------------------

describe("POST /api/orders — legacy line_items format", () => {
  it("notifies Slack once after a first-time external order is committed", async () => {
    stubTxBegin();
    stubOrderInsert("order-slack-new", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-slack-new",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery_address: {
          cityId: "abu-dhabi",
          cityName: "Abu Dhabi",
        },
        delivery: {
          countryCode: "AE",
          district: "Abu Dhabi",
        },
      });

    expect(res.status).toBe(201);
    const orderInsert = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && /INSERT INTO orders/i.test(sql),
    );
    expect(JSON.parse(orderInsert?.[1]?.[3] as string)).toMatchObject({
      countryCode: "AE",
      cityId: "abu-dhabi",
      cityName: "Abu Dhabi",
      district: "Abu Dhabi",
    });
    expect(mockNotifyNewUaeOrderToSlack).toHaveBeenCalledTimes(1);
    expect(mockNotifyNewUaeOrderToSlack).toHaveBeenCalledWith({
      orderId: "order-slack-new",
      workspaceOwnerId: OWNER_ID,
    });
  });

  it("does not notify Slack again for a duplicate external ingest", async () => {
    stubTxBegin();
    stubOrderInsert("order-slack-existing", false);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-slack-existing",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        delivery: {
          countryCode: "AE",
          cityId: "abu-dhabi",
          district: "Abu Dhabi",
        },
      });

    expect(res.status).toBe(200);
    expect(mockNotifyNewUaeOrderToSlack).not.toHaveBeenCalled();
  });

  it("triggers the guarded placeholder repair only for a newly inserted customer order", async () => {
    mockUpsertContact.mockResolvedValue("contact-1");
    stubTxBegin();
    stubOrderInsert("order-first-1", true);
    stubSideEffects(3); // line item + customer link + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "first-contact-order",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        contact: { first_name: "Rana", last_name: "K", phone: "+96170000001" },
      });

    expect(res.status).toBe(201);
    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).toHaveBeenCalledWith({
      workspaceOwnerId: OWNER_ID,
      contactId: "contact-1",
      orderId: "order-first-1",
      buyer: { firstName: "Rana", lastName: "K", displayName: "Rana K" },
    });
  });

  it("does not trigger the placeholder repair for a duplicate external order", async () => {
    mockUpsertContact.mockResolvedValue("contact-1");
    stubTxBegin();
    stubOrderInsert("order-first-1", false);
    stubSideEffects(2); // customer link + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "first-contact-order",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        contact: { first_name: "Rana", last_name: "K", phone: "+96170000001" },
      });

    expect(res.status).toBe(200);
    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).not.toHaveBeenCalled();
  });

  it("creates order with line_items and returns 201", async () => {
    stubTxBegin();
    stubOrderInsert("order-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-001",
        line_items: [{ name: "Roses", quantity: 2, unit_price: 50 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.order_id).toBe("order-1");
    expect(mockBroadcastEvent).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ event: "order.created" }),
    );
  });

  it("persists couponCode into the stored raw_payload", async () => {
    stubTxBegin();
    stubOrderInsert("order-coupon-1", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-coupon-1",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        couponCode: "SAVE10",
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const rawPayload = JSON.parse(orderInsertCall?.[1]?.[7] as string);
    expect(rawPayload.couponCode).toBe("SAVE10");
  });

  it("accepts coupon_code (snake_case) alias for the coupon", async () => {
    stubTxBegin();
    stubOrderInsert("order-coupon-2", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-coupon-2",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        coupon_code: "WELCOME",
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const rawPayload = JSON.parse(orderInsertCall?.[1]?.[7] as string);
    expect(rawPayload.couponCode).toBe("WELCOME");
  });

  it("records an idempotent coupon redemption when couponId is provided", async () => {
    stubTxBegin();
    stubOrderInsert("order-coupon-3", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-coupon-3",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        couponId: "11111111-1111-1111-1111-111111111111",
        couponDiscountUsd: 5,
      });

    expect(res.status).toBe(201);
    const redemptionCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO coupon_redemptions"),
    );
    expect(redemptionCall).toBeTruthy();
    // Idempotency on re-ingest is enforced by the partial unique index.
    expect(redemptionCall?.[0]).toContain("ON CONFLICT (coupon_id, order_id)");
    expect(redemptionCall?.[0]).toContain("DO NOTHING");
    const params = redemptionCall?.[1] as unknown[];
    expect(params?.[0]).toBe("11111111-1111-1111-1111-111111111111"); // coupon id
    expect(params?.[1]).toBe("order-coupon-3"); // order id
    expect(params?.[3]).toBe("5"); // discount amount usd
  });

  it("normalizes qty alias on line items", async () => {
    stubTxBegin();
    stubOrderInsert("order-2", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({ line_items: [{ name: "Flowers", qty: 3 }] });

    expect(res.status).toBe(201);
    // line item insert params: [order_id, product_id, sku, name, quantity, ...]
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    expect(lineItemCall?.[1]?.[4]).toBe(3);
  });

  it("stores the charged paid-currency price (paidUnitPrice) on rich items", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-1", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Rose Bouquet", quantity: 2, priceUsd: 14.44, paidUnitPrice: 55 }],
        payment: { totalUsd: 30, totalAmount: 115, currencyCode: "AED" },
      });

    expect(res.status).toBe(201);
    // Insert params: [order_id, product_id, sku, name, quantity, unit_price,
    // line_total, paid_unit_price, paid_line_total, custom_input, image_url]
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[0]).toContain("paid_unit_price");
    expect(lineItemCall?.[0]).toContain("paid_line_total");
    expect(lineItemCall?.[1]?.[7]).toBe("55"); // paid unit price
    expect(lineItemCall?.[1]?.[8]).toBe("110.00"); // paid line total = 55 × 2 (AED is 2-decimal)
  });

  it("accepts the legacy snake_case paid_unit_price alias on line_items", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-2", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({ line_items: [{ name: "Roses", quantity: 1, unit_price: 20, paid_unit_price: 75 }] });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[1]?.[7]).toBe("75");
    // paid_line_total: 75 × 1 = "75.00" (integer arithmetic, USD fallback 2-decimal)
    expect(lineItemCall?.[1]?.[8]).toBe("75.00");
  });

  it("stores charged order-level subtotal/delivery fee (payment.subtotalAmount/deliveryFeeAmount) in totals", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-4", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Rose Bouquet", quantity: 1, priceUsd: 63, paidUnitPrice: 250 }],
        delivery: { feeUsd: 43 },
        payment: {
          totalUsd: 106,
          totalAmount: 425,
          currencyCode: "AED",
          subtotalAmount: 250,
          deliveryFeeAmount: 175,
        },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totals.paid_total).toBe(425);
    expect(totals.paid_currency).toBe("AED");
    expect(totals.paid_subtotal).toBe(250);
    expect(totals.paid_shipping).toBe(175);
  });

  it("accepts legacy totals.paid_subtotal / paid_delivery_fee aliases", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-5", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 63 }],
        totals: {
          subtotal: 63,
          shipping: 43,
          total: 106,
          currency: "USD",
          paid_subtotal: 250,
          paid_delivery_fee: 0,
        },
        payment: { totalUsd: 106, totalAmount: 425, currencyCode: "AED" },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totals.paid_subtotal).toBe(250);
    expect(totals.paid_shipping).toBe(0);
  });

  it("does not store charged order-level amounts for USD-paid orders", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-6", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 63 }],
        totals: { subtotal: 63, shipping: 11, total: 74, currency: "USD" },
        payment: {
          totalUsd: 74,
          totalAmount: 74,
          currencyCode: "USD",
          subtotalAmount: 63,
          deliveryFeeAmount: 11,
        },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totals.paid_subtotal).toBeUndefined();
    expect(totals.paid_shipping).toBeUndefined();
  });

  it("stores null paid prices when the field is absent (legacy payloads)", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-3", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({ line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }] });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[1]?.[7]).toBeNull();
    expect(lineItemCall?.[1]?.[8]).toBeNull();
  });

  it("normalizes customer.name into first_name/last_name", async () => {
    mockUpsertContact.mockResolvedValue("contact-1");
    stubTxBegin();
    stubOrderInsert("order-3", true);
    stubSideEffects(3); // line item + contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Flowers", quantity: 1 }],
        customer: { name: "Sarah Khalil", email: "sarah@test.com" },
      });

    expect(res.status).toBe(201);
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Sarah", lastName: "Khalil", email: "sarah@test.com" }),
    );
  });

  it("returns 200 (not 201) on duplicate external_order_id", async () => {
    stubTxBegin();
    stubOrderInsert("order-4", false); // was_inserted = false
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "dup-001",
        line_items: [{ name: "Flowers", quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.order_id).toBe("order-4");
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rich checkout payload
// ---------------------------------------------------------------------------

describe("POST /api/orders — rich checkout payload", () => {
  it("creates order from rich payload (items, billing, recipient, delivery, payment)", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-billing");
    mockUpsertContact.mockResolvedValueOnce("contact-recipient");
    // client calls: BEGIN + ORDER + 1 item + billing_contact + recipient_contact + payment + COMMIT
    // (card message text/from/to are stored as dedicated columns on the order INSERT, not a side effect)
    stubTxBegin();
    stubOrderInsert("order-rich-1", true);
    stubSideEffects(4); // 1 item + billing contact + recipient contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "web-checkout-001",
        items: [{ productId: "p1", productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
        feeItems: [],
        billing: { firstName: "Sarah", lastName: "Khalil", email: "sarah@test.com", phone: "+96170000001" },
        recipient: { firstName: "Ahmad", lastName: "Mansour", phone: "+96170000002" },
        delivery: {
          district: "Hamra",
          cityId: "beirut",
          date: "2026-06-10",
          slot: "afternoon",
          isExpress: false,
          feeUsd: 5.0,
        },
        payment: { method: "stripe", ref: "pi_test_001", verified: true, totalUsd: 84.99 },
        cardMessage: "Happy Birthday!",
        cardFrom: "The Team",
        cardTo: "Ahmad",
        orderNotes: "Ring doorbell twice",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.order_id).toBe("order-rich-1");

    // Billing and recipient contacts were upserted
    expect(mockUpsertContact).toHaveBeenCalledTimes(2);
    expect(mockUpsertContact).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ firstName: "Sarah", email: "sarah@test.com" }),
    );
    expect(mockUpsertContact).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ firstName: "Ahmad", phone: "+96170000002" }),
    );

    // SSE event fired
    expect(mockBroadcastEvent).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ event: "order.created", data: expect.objectContaining({ source: "external" }) }),
    );

    // Customer confirmation email fired to the billing email on a new order
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "sarah@test.com",
        orderNumber: "web-checkout-001",
        customerName: "Sarah Khalil",
      }),
    );
  });

  it("notifies workspace owner/admin staff when a new order is inserted", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-billing");
    mockUpsertContact.mockResolvedValueOnce("contact-recipient");
    // The notification receives data from the persisted order lookup, rather
    // than the incoming request body. Return a rich saved-order snapshot here.
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("workspace_members") && sql.includes("member_email")) {
        return Promise.resolve({
          rows: [{ member_email: "owner@shop.com" }, { member_email: "admin@shop.com" }],
          rowCount: 2,
        });
      }
      if (typeof sql === "string" && sql.includes("FROM orders o")) {
        return Promise.resolve({
          rows: [{
            totals: { subtotal: 79.99, shipping: 5, total: 84.99, currency: "USD" },
            window_start: null,
            requested_delivery_date: "2026-06-10",
            delivery_address: "17 Bliss Street",
            delivery_district: "Hamra",
            delivery_city: "Beirut",
            delivery_country: "Lebanon",
            delivery_instructions: "Ring the doorbell twice",
            delivery_time_slot: "2:00 PM – 5:00 PM",
            card_message: "Happy birthday, Ahmad!",
            card_from: "Sarah",
            card_to: "Ahmad",
            customer_name: "Sarah Khalil",
            customer_email: "sarah@test.com",
            customer_phone: "+96170000001",
            recipient_name: "Ahmad Mansour",
            recipient_phone: "+96170000002",
            payment_method: "stripe",
            payment_currency: null,
            payment_amount: null,
            coupon_discount_usd: null,
            coupon_code: null,
          }],
          rowCount: 1,
        });
      }
      if (typeof sql === "string" && sql.includes("FROM order_line_items")) {
        return Promise.resolve({
          rows: [{
            name: "White Roses",
            quantity: "1",
            line_total: "79.99",
            unit_price: "79.99",
            paid_line_total: null,
            image_url: null,
            product_id: null,
            sku: null,
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    stubTxBegin();
    stubOrderInsert("order-staff-1", true);
    stubSideEffects(4); // 1 item + billing contact + recipient contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "web-staff-001",
        items: [{ productId: "p1", productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
        billing: { firstName: "Sarah", lastName: "Khalil", email: "sarah@test.com", phone: "+96170000001" },
        recipient: { firstName: "Ahmad", lastName: "Mansour", phone: "+96170000002" },
        delivery: {
          address: "17 Bliss Street",
          district: "Hamra",
          cityId: "beirut",
          countryCode: "LB",
          date: "2026-06-10",
          slot: "2:00 PM – 5:00 PM",
        },
        orderNotes: "Ring the doorbell twice",
        cardMessage: "Happy birthday, Ahmad!",
        cardFrom: "Sarah",
        cardTo: "Ahmad",
        payment: { method: "stripe", ref: "pi_test_001", verified: true, totalUsd: 79.99 },
      });

    expect(res.status).toBe(201);

    // Staff notification email fired to all resolved owner/admin emails.
    await vi.waitFor(() => expect(mockSendNewOrderStaffEmail).toHaveBeenCalled());
    expect(mockSendNewOrderStaffEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmails: ["owner@shop.com", "admin@shop.com"],
        orderNumber: "web-staff-001",
        customerName: "Sarah Khalil",
        customerEmail: "sarah@test.com",
        customerPhone: "+96170000001",
        recipientName: "Ahmad Mansour",
        recipientPhone: "+96170000002",
        deliveryAddress: "17 Bliss Street",
        deliveryDistrict: "Hamra",
        deliveryCity: "Beirut",
        deliveryCountry: "Lebanon",
        deliveryInstructions: "Ring the doorbell twice",
        deliveryDateText: "10 June 2026",
        deliveryTimeSlot: "2:00 PM – 5:00 PM",
        cardMessage: "Happy birthday, Ahmad!",
        cardFrom: "Sarah",
        cardTo: "Ahmad",
        items: [expect.objectContaining({ name: "White Roses", priceText: "$79.99" })],
      }),
    );
  });

  it("emails only Whish payment instructions when an order arrives awaiting payment", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-billing");
    stubTxBegin();
    stubOrderInsert("order-await-pay-1", true);
    stubSideEffects(2); // 1 item + payment record
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "web-await-001",
        items: [{ productId: "p1", productName: "Red Roses", quantity: 1, priceUsd: 55.0 }],
        billing: { firstName: "Saade", lastName: "Saade", email: "saade@test.com", phone: "+96170000003" },
        // Unverified payment → order is awaiting payment.
        payment: { method: "whish", verified: false, totalUsd: 62.0 },
      });

    expect(res.status).toBe(201);

    // Whish payment instructions are the only customer email for an unpaid
    // order, and retain the existing order/customer details.
    await vi.waitFor(() =>
      expect(mockSendOrderPaymentInstructionsEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          toEmail: "saade@test.com",
          orderNumber: "web-await-001",
          customerName: "Saade Saade",
        }),
      ),
    );
    expect(mockSendOrderPaymentInstructionsEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it("emails only the order confirmation (no payment instructions) for an already-paid order", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-billing");
    stubTxBegin();
    stubOrderInsert("order-paid-conf-1", true);
    stubSideEffects(2); // 1 item + payment record
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "web-paid-001",
        items: [{ productId: "p1", productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
        billing: { firstName: "Layla", lastName: "Hassan", email: "layla@test.com", phone: "+96170000004" },
        payment: { method: "stripe", ref: "pi_test_002", verified: true, totalUsd: 79.99 },
      });

    expect(res.status).toBe(201);

    await vi.waitFor(() =>
      expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          toEmail: "layla@test.com",
          orderNumber: "web-paid-001",
          customerName: "Layla Hassan",
        }),
      ),
    );
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderPaymentInstructionsEmail).not.toHaveBeenCalled();
  });

  it("does not notify staff when an existing order is re-ingested (not inserted)", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-billing");
    stubTxBegin();
    stubOrderInsert("order-reingest-1", false); // was_inserted = false
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "web-staff-002",
        items: [{ productId: "p1", productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
        billing: { firstName: "Sarah", lastName: "Khalil", email: "sarah@test.com", phone: "+96170000001" },
        payment: { method: "stripe", ref: "pi_test_001", verified: true, totalUsd: 79.99 },
      });

    expect(res.status).toBe(200);
    expect(mockSendNewOrderStaffEmail).not.toHaveBeenCalled();
  });

  it("resolves a digit-string productId to product_id without 500", async () => {
    // Product 519 exists with sku "519". Match on the SQL instead of using a
    // once-queue stub: fire-and-forget email lookups from a previous test's
    // request can still hit db.query after that test finishes, and under full-
    // suite load they would consume a queued mockResolvedValueOnce meant for
    // this test's product-resolution query (observed as a flake in CI).
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("FROM products")) {
        return Promise.resolve({ rows: [{ id: 519, sku: "519" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    stubTxBegin();
    stubOrderInsert("order-sku-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productId: "519", productName: "Roses", quantity: 1, priceUsd: 50 }],
        payment: { method: "cash", verified: false, totalUsd: 50 },
      });

    expect(res.status).toBe(201);
    // line item insert params: [order_id, product_id, sku, name, quantity, ...]
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    expect(lineItemCall?.[1]?.[1]).toBe(519);
    expect(lineItemCall?.[1]?.[2]).toBe("519");
  });

  it("stores an unresolved digit-string identifier as sku with null product_id", async () => {
    // db.query resolves nothing (default empty rows from beforeEach).
    stubTxBegin();
    stubOrderInsert("order-sku-2", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productId: "999999", productName: "Mystery", quantity: 1, priceUsd: 10 }],
        payment: { method: "cash", verified: false, totalUsd: 10 },
      });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    expect(lineItemCall?.[1]?.[1]).toBeNull();
    expect(lineItemCall?.[1]?.[2]).toBe("999999");
  });

  it("stores the resolved product's main image on the line item", async () => {
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("FROM products")) {
        return Promise.resolve({
          rows: [
            { id: 519, sku: "519", name: "Roses", main_image_url: "/objects/x/roses.jpg" },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    stubTxBegin();
    stubOrderInsert("order-img-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productId: "519", productName: "Roses", quantity: 1, priceUsd: 50 }],
        payment: { method: "cash", verified: false, totalUsd: 50 },
      });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    // params: [order_id, product_id, sku, name, quantity, unit_price, line_total, custom_input, image_url]
    expect(lineItemCall?.[0]).toContain("image_url");
    expect(lineItemCall?.[1]?.[1]).toBe(519);
    expect(lineItemCall?.[1]?.[10]).toBe("/objects/x/roses.jpg");
  });

  it("prefers the storefront-supplied imageUrl over the product's main image", async () => {
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("FROM products")) {
        return Promise.resolve({
          rows: [
            { id: 519, sku: "519", name: "Roses", main_image_url: "/objects/x/roses.jpg" },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    stubTxBegin();
    stubOrderInsert("order-img-2", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [
          {
            productId: "519",
            productName: "Roses",
            quantity: 1,
            priceUsd: 50,
            imageUrl: "https://cdn.example.com/roses.png",
          },
        ],
        payment: { method: "cash", verified: false, totalUsd: 50 },
      });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    expect(lineItemCall?.[1]?.[10]).toBe("https://cdn.example.com/roses.png");
  });

  it("resolves a product by exact name when the sku doesn't match", async () => {
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("FROM products")) {
        return Promise.resolve({
          rows: [
            {
              id: 88,
              sku: "ROSE-BOX",
              name: "Rose Box",
              main_image_url: "/objects/x/rose-box.jpg",
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    stubTxBegin();
    stubOrderInsert("order-name-1", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        // productId doesn't resolve; name "rose box" matches case-insensitively.
        items: [{ productId: "unknown-sku", productName: "rose box", quantity: 1, priceUsd: 40 }],
        payment: { method: "cash", verified: false, totalUsd: 40 },
      });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    expect(lineItemCall?.[1]?.[1]).toBe(88);
    expect(lineItemCall?.[1]?.[10]).toBe("/objects/x/rose-box.jpg");
  });

  it("stores null image and product for a fully unresolved item", async () => {
    // db.query resolves nothing (default empty rows from beforeEach).
    stubTxBegin();
    stubOrderInsert("order-noimg-1", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productId: "nope", productName: "Mystery Item", quantity: 1, priceUsd: 10 }],
        payment: { method: "cash", verified: false, totalUsd: 10 },
      });

    expect(res.status).toBe(201);
    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("order_line_items"),
    );
    expect(lineItemCall?.[1]?.[1]).toBeNull();
    expect(lineItemCall?.[1]?.[10]).toBeNull();
  });

  it("uses appOrderId as external_order_id for idempotency", async () => {
    stubTxBegin();
    stubOrderInsert("order-idem-1", false);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "app-123",
        items: [{ productName: "Flowers", quantity: 1 }],
      });

    expect(res.status).toBe(200);
    // client.query call[0]=BEGIN, call[1]=ORDER INSERT
    // external_order_id is param index 1 (0-based) in the order INSERT
    const orderInsertCall = mockClientQuery.mock.calls[1];
    expect(orderInsertCall?.[1]?.[1]).toBe("app-123");
  });

  it("builds delivery_type=express when isExpress=true", async () => {
    stubTxBegin();
    stubOrderInsert("order-exp-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1 }],
        delivery: { isExpress: true, feeUsd: 5, expressSurchargeUsd: 15 },
      });

    // delivery_type is param index 4 (0-based) in the order INSERT
    // client.query: [0]=BEGIN, [1]=ORDER INSERT
    const orderInsertCall = mockClientQuery.mock.calls[1];
    expect(orderInsertCall?.[1]?.[4]).toBe("express");
  });

  it("infers express delivery from a dated Express slot when the boolean is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-exp-slot", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1 }],
        delivery: { date: "2099-09-10", slot: "Express" },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls[1];
    expect(orderInsertCall?.[1]?.[4]).toBe("express");
    expect(JSON.parse(orderInsertCall?.[1]?.[3] as string)).toMatchObject({
      date: "2099-09-10",
      slot: "Express",
      isExpress: true,
    });
  });

  it("preserves an explicit non-express flag even when the named slot is Express", async () => {
    stubTxBegin();
    stubOrderInsert("order-explicit-standard", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1 }],
        delivery: { date: "2099-09-10", slot: "Express", isExpress: false },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls[1];
    expect(orderInsertCall?.[1]?.[4]).toBe("standard");
    expect(JSON.parse(orderInsertCall?.[1]?.[3] as string)).toMatchObject({
      date: "2099-09-10",
      slot: "Express",
      isExpress: false,
    });
  });

  it("stores order_notes as delivery_instructions", async () => {
    stubTxBegin();
    stubOrderInsert("order-notes-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1 }],
        orderNotes: "Leave at door",
      });

    // delivery_instructions is param index 5 in the order INSERT
    const orderInsertCall = mockClientQuery.mock.calls[1];
    expect(orderInsertCall?.[1]?.[5]).toBe("Leave at door");
  });

  it("derives totals from payment.totalUsd when no totals provided", async () => {
    stubTxBegin();
    stubOrderInsert("order-totals-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 50 }],
        payment: { totalUsd: 55.0, method: "card" },
      });

    const orderInsertCall = mockClientQuery.mock.calls[1];
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.total).toBe(55.0);
  });

  it("includes the delivery fee in the stored total when totals omit shipping", async () => {
    // LB-1081 shape: website totals exclude delivery; the delivery block carries
    // the fee. The stored total must equal what the provider actually charged.
    stubTxBegin();
    stubOrderInsert("order-totals-2", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 94 }],
        totals: { subtotal: 94, total: 94, currency: "USD" },
        delivery: { cityId: "beirut", isExpress: true, feeUsd: 6, expressSurchargeUsd: 5 },
        payment: { method: "stripe", totalUsd: 105, verified: true },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.total).toBe(105);
    expect(totalsJson.shipping).toBe(11);
    expect(totalsJson.subtotal).toBe(94);
  });

  it("reconstructs the total from subtotal + shipping − discount when payment.totalUsd is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-totals-3", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 100 }],
        totals: { subtotal: 100, discount: 10, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 7 },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.total).toBe(97);
    expect(totalsJson.shipping).toBe(7);
  });

  it("persists the charged amount on the order_payment record", async () => {
    stubTxBegin();
    stubOrderInsert("order-totals-4", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 94 }],
        totals: { subtotal: 94, total: 94, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 11 },
        payment: { method: "stripe", totalUsd: 105, verified: true },
      });

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd]
    expect(paymentCall?.[1]?.[6]).toBe(105);
  });

  it("refreshes the charged amount when an existing order is re-ingested", async () => {
    // On re-ingest (was_inserted = false) the first-INSERT side effects are
    // skipped, but the payment record must still run so amount_usd self-corrects
    // via ON CONFLICT DO UPDATE.
    stubTxBegin();
    stubOrderInsert("order-reingest-amt", false); // was_inserted = false
    stubSideEffects(1); // only the payment_record side effect runs on re-ingest
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 94 }],
        totals: { subtotal: 94, total: 94, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 11 },
        payment: { method: "stripe", totalUsd: 105, verified: true },
      });

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall).toBeTruthy();
    // The upsert uses ON CONFLICT DO UPDATE so the row's amount_usd is refreshed.
    expect(paymentCall?.[0]).toContain("ON CONFLICT (order_id) DO UPDATE");
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd]
    expect(paymentCall?.[1]?.[6]).toBe(105);
  });

  it("stores the paid-currency pair for a non-USD charge (totals JSON + payment record)", async () => {
    stubTxBegin();
    stubOrderInsert("order-chf-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 60 }],
        totals: { subtotal: 60, total: 60, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 12 },
        payment: {
          method: "stripe",
          verified: true,
          totalUsd: 72,
          totalAmount: 70,
          currencyCode: "CHF",
        },
      });

    // totals JSON keeps the USD figures AND carries the paid pair.
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.total).toBe(72);
    expect(totalsJson.currency).toBe("USD");
    expect(totalsJson.paid_total).toBe(70);
    expect(totalsJson.paid_currency).toBe("CHF");

    // payment record pairs the paid-currency amount with the currency code,
    // keeping the USD equivalent in the explicitly-USD column.
    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd, amount]
    expect(paymentCall?.[1]?.[5]).toBe("CHF");
    expect(paymentCall?.[1]?.[6]).toBe(72);
    expect(paymentCall?.[1]?.[7]).toBe(70);
  });

  it("uses totals.paid_currency as authoritative even when payment.currencyCode conflicts", async () => {
    // Regression: storefront sends SAR amount in totals.paid_total but AED in
    // payment.currencyCode. The pre-converted pair must win; paidCurrency must
    // be SAR (matching the amount), not AED (from payment).
    stubTxBegin();
    stubOrderInsert("order-sar-aed-conflict", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Gift box", quantity: 1, priceUsd: 200 }],
        totals: {
          subtotal: 200,
          total: 200,
          currency: "USD",
          paid_total: 785,
          paid_currency: "SAR",
        },
        delivery: { cityId: "riyadh", feeUsd: 0 },
        payment: {
          method: "stripe",
          verified: true,
          totalUsd: 200,
          // Conflicting currency code — must NOT override totals.paid_currency
          currencyCode: "AED",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // paid_total + paid_currency must stay as the SAR pair from totals
    expect(totalsJson.paid_total).toBe(785);
    expect(totalsJson.paid_currency).toBe("SAR");

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // currency column must be SAR — not AED from the conflicting payment field
    expect(paymentCall?.[1]?.[5]).toBe("SAR");
  });

  it("uses totals.paid_currency=USD as authoritative even when payment.currencyCode is a foreign currency", async () => {
    // Regression: storefront sends totals.paid_currency="USD" with a USD amount
    // but payment.currencyCode="AED". Without the fix, paymentCurrency would be
    // AED, mismatching the USD amount.
    stubTxBegin();
    stubOrderInsert("order-usd-aed-conflict", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Gift box", quantity: 1, priceUsd: 100 }],
        totals: {
          subtotal: 100,
          total: 100,
          currency: "USD",
          paid_total: 100,
          paid_currency: "USD",   // authoritative: USD amount was charged
        },
        delivery: { cityId: "dubai", feeUsd: 0 },
        payment: {
          method: "stripe",
          verified: true,
          totalUsd: 100,
          currencyCode: "AED",   // conflicting code — must NOT win
        },
      });

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // currency column must be USD (from the authoritative totals pair),
    // not AED from the conflicting payment.currencyCode field.
    // Note: the totals JSON does NOT store a paid_currency entry for USD
    // orders (USD is the default/redundant), so only the payment record is checked.
    expect(paymentCall?.[1]?.[5]).toBe("USD");
  });

  it("never pairs a foreign currency with the USD amount when totalAmount is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-chf-2", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 60 }],
        totals: { subtotal: 60, total: 60, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 12 },
        payment: { method: "stripe", verified: true, totalUsd: 72, currencyCode: "CHF" },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // No paid pair is stored without the actual paid amount.
    expect(totalsJson.paid_total).toBeUndefined();
    expect(totalsJson.paid_currency).toBeUndefined();

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // amount stays NULL rather than pairing CHF with the 72 USD figure.
    expect(paymentCall?.[1]?.[5]).toBe("CHF");
    expect(paymentCall?.[1]?.[6]).toBe(72);
    expect(paymentCall?.[1]?.[7]).toBeNull();
  });

  it("derives paid_total from subtotalAmount + deliveryFeeAmount when totalAmount is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-aed-derive-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 60 }],
        totals: { subtotal: 60, total: 60, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 12 },
        payment: {
          method: "stripe",
          verified: true,
          totalUsd: 72,
          currencyCode: "AED",
          subtotalAmount: 250,
          deliveryFeeAmount: 15,
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBe(265);
    expect(totalsJson.paid_currency).toBe("AED");
    expect(totalsJson.paid_subtotal).toBe(250);
    expect(totalsJson.paid_shipping).toBe(15);

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("AED");
    expect(paymentCall?.[1]?.[7]).toBe(265);
  });

  it("derives paid_total from per-line paidUnitPrice when no order-level paid amounts exist", async () => {
    stubTxBegin();
    stubOrderInsert("order-aed-derive-2", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [
          { productName: "Flowers", quantity: 2, priceUsd: 15, paidUnitPrice: 55 },
        ],
        totals: { subtotal: 30, total: 30, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 12 },
        payment: {
          method: "stripe",
          verified: true,
          totalUsd: 42,
          currencyCode: "AED",
          deliveryFeeAmount: 15,
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // 55 × 2 + 15 delivery = 125 AED.
    expect(totalsJson.paid_total).toBe(125);
    expect(totalsJson.paid_currency).toBe("AED");
  });

  it("does not derive a paid_total when only some line items carry a paid price", async () => {
    stubTxBegin();
    stubOrderInsert("order-aed-derive-3", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [
          { productName: "Flowers", quantity: 1, priceUsd: 15, paidUnitPrice: 55 },
          { productName: "Balloons", quantity: 1, priceUsd: 10 },
        ],
        totals: { subtotal: 25, total: 25, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 12 },
        payment: { method: "stripe", verified: true, totalUsd: 37, currencyCode: "AED" },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // A partial sum would understate the paid total — better no pair at all.
    expect(totalsJson.paid_total).toBeUndefined();
    expect(totalsJson.paid_currency).toBeUndefined();
  });

  it("keeps the USD path unchanged and pairs amount with USD for USD charges", async () => {
    stubTxBegin();
    stubOrderInsert("order-usd-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 94 }],
        totals: { subtotal: 94, total: 94, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 11 },
        payment: { method: "stripe", verified: true, totalUsd: 105, totalAmount: 105, currencyCode: "USD" },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // USD orders keep the totals JSON exactly as before — no paid pair.
    expect(totalsJson.paid_total).toBeUndefined();
    expect(totalsJson.paid_currency).toBeUndefined();
    expect(totalsJson.total).toBe(105);

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("USD");
    expect(paymentCall?.[1]?.[6]).toBe(105);
    expect(paymentCall?.[1]?.[7]).toBe(105);
  });

  it("persists a three-decimal KWD paid amount without truncation", async () => {
    // KWD (Kuwaiti Dinar) uses 3 decimal places. The order_payment.amount column
    // must be numeric(14,4) — not numeric(10,2) — so 18.500 is stored exactly.
    // This test verifies the INSERT call passes the raw fractional value through
    // rather than rounding to 2 decimal places.
    stubTxBegin();
    stubOrderInsert("order-kwd-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Gift box", quantity: 1, priceUsd: 20 }],
        totals: { subtotal: 20, total: 20, currency: "USD" },
        delivery: { cityId: "kuwait_city", feeUsd: 5 },
        payment: {
          method: "card",
          totalUsd: 25,
          totalAmount: 7.750,
          currencyCode: "KWD",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // Three-decimal KWD amount stored in paid_total without rounding.
    expect(totalsJson.paid_total).toBe(7.75);
    expect(totalsJson.paid_currency).toBe("KWD");

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd, amount]
    // amount must pass the exact three-decimal value (7.75 = 7.750 KWD)
    expect(paymentCall?.[1]?.[5]).toBe("KWD");
    expect(paymentCall?.[1]?.[6]).toBe(25);   // amount_usd = totalUsd
    expect(paymentCall?.[1]?.[7]).toBe(7.75); // amount = KWD amount (3 dp)
  });
});

describe("POST /api/orders — Address Collector eligibility", () => {
  const addressCollectionPayload = {
    appOrderId: "collect-address-001",
    // Keep the received timestamp explicit: delivery dates before receipt are
    // canonically corrected to the receipt day before Address Collector sees
    // them, so this eligibility fixture must not depend on the runtime clock.
    ordered_at: "2026-06-09T12:00:00.000Z",
    items: [{ productId: "p1", productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
    billing: { firstName: "Sarah", lastName: "Khalil", phone: "+96170000001" },
    recipient: { firstName: "Ahmad", lastName: "Mansour", phone: "+96170000002" },
    delivery: {
      date: "2026-06-10",
      slot: "4–7 PM",
      countryCode: "LB",
      collectAddress: true,
    },
    payment: { method: "cash", totalUsd: 79.99 },
  };

  it("creates a visible request only for a newly inserted external order with collectAddress enabled", async () => {
    stubTxBegin();
    stubOrderInsert("order-collect-1", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp()).post("/api/orders").send(addressCollectionPayload);

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOwnerId: OWNER_ID,
        orderId: "order-collect-1",
        recipientName: "Ahmad Mansour",
        recipientPhone: "+96170000002",
        deliveryDate: "2026-06-10",
        deliverySlot: "4–7 PM",
        deliveryCountryCode: "LB",
        explicitRequest: true,
        source: "external",
      }),
    );
  });

  it("does not recreate a request when an external order is re-ingested", async () => {
    stubTxBegin();
    stubOrderInsert("order-collect-1", false);
    stubTxCommit();

    const res = await request(makeApp()).post("/api/orders").send(addressCollectionPayload);

    expect(res.status).toBe(200);
    expect(mockCreateAddressCollectionRequest).not.toHaveBeenCalled();
  });

  it("automatically creates a request for an order-2450-style payload with no address flag", async () => {
    stubTxBegin();
    stubOrderInsert("order-missing-address", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        ...addressCollectionPayload,
        appOrderId: "missing-address-no-flag",
        delivery: {
          date: "2026-06-10",
          slot: "4–7 PM",
          countryCode: "LB",
        },
        payment: { method: "cash", totalUsd: 79.99, verified: true },
      });

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-missing-address",
        recipientName: "Ahmad Mansour",
        recipientPhone: "+96170000002",
        deliveryCountryCode: "LB",
        source: "external",
      }),
    );
  });

  it("honors an explicit external no-address marker", async () => {
    stubTxBegin();
    stubOrderInsert("order-no-address-marker", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        ...addressCollectionPayload,
        appOrderId: "no-address-marker",
        delivery: {
          ...addressCollectionPayload.delivery,
          collectAddress: false,
          noAddress: true,
          address: "12 Main Street",
        },
        payment: { method: "cash", totalUsd: 79.99, verified: true },
      });

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitRequest: false,
        orderId: "order-no-address-marker",
      }),
    );
  });

  it("cannot suppress collection with a placeholder external address", async () => {
    stubTxBegin();
    stubOrderInsert("order-placeholder-address", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        ...addressCollectionPayload,
        appOrderId: "placeholder-address",
        delivery: {
          ...addressCollectionPayload.delivery,
          collectAddress: false,
          address: "To be confirmed / ask recipient",
        },
        payment: { method: "cash", totalUsd: 79.99, verified: true },
      });

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledOnce();
  });

  it("does not automatically collect a missing address before payment", async () => {
    stubTxBegin();
    stubOrderInsert("order-pending-missing-address", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        ...addressCollectionPayload,
        appOrderId: "pending-missing-address",
        delivery: {
          ...addressCollectionPayload.delivery,
          collectAddress: false,
          noAddress: true,
        },
        payment: { method: "cash", totalUsd: 79.99, verified: false },
      });

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).not.toHaveBeenCalled();
  });

  it("does not collect a real external address without an explicit request", async () => {
    stubTxBegin();
    stubOrderInsert("order-real-address", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        ...addressCollectionPayload,
        appOrderId: "real-address",
        delivery: {
          ...addressCollectionPayload.delivery,
          collectAddress: false,
          address: "12 Main Street",
        },
      });

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).not.toHaveBeenCalled();
  });

  it("recognizes a real legacy delivery_address string without an explicit request", async () => {
    stubTxBegin();
    stubOrderInsert("order-real-legacy-address", true);
    stubSideEffects(4);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        ...addressCollectionPayload,
        appOrderId: "real-legacy-address",
        delivery: undefined,
        delivery_address: "17 Bliss Street",
      });

    expect(res.status).toBe(201);
    expect(mockCreateAddressCollectionRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stripe amount verification at ingest
// ---------------------------------------------------------------------------

describe("POST /api/orders — Stripe amount verification", () => {
  it("uses the Stripe-verified amount over a wrong payload totalAmount", async () => {
    // Storefront claims SAR 210 (the USD figure), Stripe actually charged 785 SAR.
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 785, currency: "SAR" });
    stubTxBegin();
    stubOrderInsert("order-sar-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 199 }],
        totals: { subtotal: 199, total: 209, currency: "USD" },
        delivery: { cityId: "riyadh", feeUsd: 10 },
        payment: {
          method: "stripe",
          ref: "pi_3Sample123",
          verified: true,
          totalUsd: 209,
          totalAmount: 210,
          currencyCode: "SAR",
        },
      });

    expect(mockVerifyStripeAmount).toHaveBeenCalledWith("pi_3Sample123");

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.total).toBe(209);
    expect(totalsJson.paid_total).toBe(785);
    expect(totalsJson.paid_currency).toBe("SAR");
    expect(totalsJson.stripe_verified).toBe(true);

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd, amount]
    expect(paymentCall?.[1]?.[5]).toBe("SAR");
    expect(paymentCall?.[1]?.[6]).toBe(209);
    expect(paymentCall?.[1]?.[7]).toBe(785);
  });

  it("falls back to payload values when Stripe is unreachable (fail-open)", async () => {
    mockVerifyStripeAmount.mockResolvedValue({ status: "error" });
    stubTxBegin();
    stubOrderInsert("order-sar-2", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 199 }],
        totals: { subtotal: 199, total: 209, currency: "USD" },
        payment: {
          method: "stripe",
          ref: "pi_3Sample456",
          verified: true,
          totalUsd: 209,
          totalAmount: 785,
          currencyCode: "SAR",
        },
      });

    // Order is still created with the (untrusted) payload values.
    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBe(785);
    expect(totalsJson.paid_currency).toBe("SAR");
    // No verified marker → the startup repair pass will re-check this order.
    expect(totalsJson.stripe_verified).toBeUndefined();
  });

  it("preserves a non-Stripe paid pair numerically close to the USD total (no 1:1 guard)", async () => {
    // AED 170 on a USD 168 order — within 2% of 1:1. A previous sanity guard
    // dropped this pair as "mislabeled USD", making emails show USD while the
    // dashboard showed AED. The payload pair must be stored verbatim.
    stubTxBegin();
    stubOrderInsert("order-aed-close-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 150 }],
        totals: { subtotal: 150, total: 168, currency: "USD" },
        delivery: { cityId: "dubai", feeUsd: 18 },
        payment: {
          method: "cash_on_delivery",
          verified: false,
          totalUsd: 168,
          totalAmount: 170,
          currencyCode: "AED",
          subtotalAmount: 152,
          deliveryFeeAmount: 18,
        },
      });

    expect(mockVerifyStripeAmount).not.toHaveBeenCalled();

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBe(170);
    expect(totalsJson.paid_currency).toBe("AED");
    expect(totalsJson.paid_subtotal).toBe(152);
    expect(totalsJson.paid_shipping).toBe(18);

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd, amount]
    expect(paymentCall?.[1]?.[5]).toBe("AED");
    expect(paymentCall?.[1]?.[6]).toBe(168);
    expect(paymentCall?.[1]?.[7]).toBe(170);
  });

  it("keeps a USD order untouched when Stripe confirms a USD charge", async () => {
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 105, currency: "USD" });
    stubTxBegin();
    stubOrderInsert("order-usd-2", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 94 }],
        totals: { subtotal: 94, total: 94, currency: "USD" },
        delivery: { cityId: "beirut", feeUsd: 11 },
        payment: {
          method: "stripe",
          ref: "pi_3Sample789",
          verified: true,
          totalUsd: 105,
          totalAmount: 105,
          currencyCode: "USD",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // No paid pair for USD, but the verified marker is recorded.
    expect(totalsJson.paid_total).toBeUndefined();
    expect(totalsJson.paid_currency).toBeUndefined();
    expect(totalsJson.stripe_verified).toBe(true);

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("USD");
    expect(paymentCall?.[1]?.[7]).toBe(105);
  });

  it("overrides even the currency when the payload pairs a foreign code with the USD figure", async () => {
    // Payload says AED, Stripe says the charge was actually in USD.
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 72, currency: "USD" });
    stubTxBegin();
    stubOrderInsert("order-mixed-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 60 }],
        totals: { subtotal: 60, total: 72, currency: "USD" },
        payment: {
          method: "stripe",
          ref: "pi_3SampleABC",
          verified: true,
          totalUsd: 72,
          totalAmount: 72,
          currencyCode: "AED",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBeUndefined();
    expect(totalsJson.paid_currency).toBeUndefined();

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // Currency corrected to what Stripe actually charged.
    expect(paymentCall?.[1]?.[5]).toBe("USD");
    expect(paymentCall?.[1]?.[7]).toBe(72);
  });

  it("does not call Stripe for non-Stripe payments or non-intent refs", async () => {
    stubTxBegin();
    stubOrderInsert("order-cod-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 60 }],
        totals: { subtotal: 60, total: 60, currency: "USD" },
        payment: { method: "cod", ref: "pi_3ShouldNotMatter", verified: false },
      });

    stubTxBegin();
    stubOrderInsert("order-sess-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 60 }],
        totals: { subtotal: 60, total: 60, currency: "USD" },
        payment: { method: "stripe", ref: "cs_test_notAnIntent", verified: true },
      });

    expect(mockVerifyStripeAmount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DB error handling
// ---------------------------------------------------------------------------

describe("POST /api/orders — error handling", () => {
  it("returns 500 when order INSERT fails", async () => {
    // BEGIN succeeds; ORDER INSERT rejects; ROLLBACK is called in catch
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockClientQuery.mockRejectedValueOnce(new Error("DB error")); // ORDER INSERT fails
    stubTxRollback(); // ROLLBACK in catch block

    const res = await request(makeApp())
      .post("/api/orders")
      .send({ line_items: [{ name: "Flowers", quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Failed to create order/);
  });

  it("still creates the order (201) when a non-critical child insert fails", async () => {
    // Order insert succeeds; the line-item child insert fails (e.g. schema
    // mismatch). The order must still be committed — only payment failure may
    // block creation.
    mockClientQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("INSERT INTO orders")) {
        return Promise.resolve({
          rows: [{ id: "order-resilient-1", was_inserted: true }],
          rowCount: 1,
        });
      }
      if (typeof sql === "string" && sql.includes("INSERT INTO order_line_items")) {
        return Promise.reject(new Error("column mismatch on child table"));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp())
      .post("/api/orders")
      .send({ line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.order_id).toBe("order-resilient-1");
    // The transaction committed despite the failed child write.
    expect(mockClientQuery.mock.calls.some((c) => c[0] === "COMMIT")).toBe(true);
    // The failed child write was rolled back to its savepoint, not the whole txn.
    expect(
      mockClientQuery.mock.calls.some((c) => c[0] === "ROLLBACK TO SAVEPOINT side_effect"),
    ).toBe(true);
    expect(mockClientQuery.mock.calls.some((c) => c[0] === "ROLLBACK")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extended field mapping (currency, delivery country/no-address, billing country)
// ---------------------------------------------------------------------------

describe("POST /api/orders — extended field mapping", () => {
  it("sets order_payment.currency from payment.currencyCode", async () => {
    stubTxBegin();
    stubOrderInsert("order-cur-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        payment: { method: "stripe", verified: true, currencyCode: "AED" },
      });

    expect(res.status).toBe(201);
    // order_payment insert params: [order_id, method, provider, provider_ref, status, currency]
    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("AED");
  });

  it("falls back to totals.currency for payment currency when payment.currencyCode is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-cur-2", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
        totals: { currency: "EUR", total: 50 },
      });

    expect(res.status).toBe(201);
    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("EUR");
  });

  it("defaults payment currency to USD when neither payment.currencyCode nor totals.currency is provided", async () => {
    stubTxBegin();
    stubOrderInsert("order-cur-3", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 50 }],
      });

    expect(res.status).toBe(201);
    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("USD");
  });

  it("stores delivery.countryCode and delivery.noAddress in the delivery_address JSON", async () => {
    stubTxBegin();
    stubOrderInsert("order-del-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        delivery: { cityId: "beirut", countryCode: "LB", noAddress: true },
      });

    expect(res.status).toBe(201);
    // delivery_address is param index 3 in the order INSERT.
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const deliveryJson = JSON.parse(orderInsertCall?.[1]?.[3] as string);
    expect(deliveryJson.countryCode).toBe("LB");
    expect(deliveryJson.noAddress).toBe(true);
  });

  it("stores delivery.phone in the delivery_address JSON", async () => {
    stubTxBegin();
    stubOrderInsert("order-phone-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        delivery: { cityId: "beirut", phone: "+96170123456" },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const deliveryJson = JSON.parse(orderInsertCall?.[1]?.[3] as string);
    expect(deliveryJson.phone).toBe("+96170123456");
  });

  it("falls back to recipient.phone for delivery_address.phone when delivery.phone is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-phone-2", true);
    stubSideEffects(3); // line item + recipient contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        recipient: { firstName: "Lina", phone: "+96171987654" },
        delivery: { cityId: "beirut" },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const deliveryJson = JSON.parse(orderInsertCall?.[1]?.[3] as string);
    expect(deliveryJson.phone).toBe("+96171987654");
  });

  it("persists billing.countryCode onto the billing contact metadata", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-billing");
    stubTxBegin();
    stubOrderInsert("order-bill-1", true);
    stubSideEffects(3); // line item + billing contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        billing: { firstName: "Sarah", email: "sarah@test.com", countryCode: "LB" },
      });

    expect(res.status).toBe(201);
    // The billing country code is merged into the contact's metadata via db.query.
    const countryUpdate = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE contacts"),
    );
    expect(countryUpdate).toBeDefined();
    expect(countryUpdate?.[1]?.[0]).toBe("contact-billing");
    expect(countryUpdate?.[1]?.[1]).toBe("LB");
  });

  it("passes whatsappConsent: true to upsertContact when whatsapp_opt_in is true", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-optin");
    stubTxBegin();
    stubOrderInsert("order-optin-1", true);
    stubSideEffects(3); // line item + billing contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        billing: { firstName: "Sarah", email: "sarah@test.com", phone: "+9613000000" },
        whatsapp_opt_in: true,
      });

    expect(res.status).toBe(201);
    // Consent is now folded atomically into the upsertContact call rather than
    // a separate UPDATE — verify the flag reaches the upsert.
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappConsent: true }),
    );
  });

  it("does not pass whatsappConsent: true when whatsapp_opt_in is false", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-noopt");
    stubTxBegin();
    stubOrderInsert("order-noopt-1", true);
    stubSideEffects(3); // line item + billing contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        billing: { firstName: "Sarah", email: "sarah@test.com", phone: "+9613000000" },
        whatsapp_opt_in: false,
      });

    expect(res.status).toBe(201);
    expect(mockUpsertContact).not.toHaveBeenCalledWith(
      expect.objectContaining({ whatsappConsent: true }),
    );
  });

  it("does not pass whatsappConsent: true when whatsapp_opt_in is absent", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-legacy");
    stubTxBegin();
    stubOrderInsert("order-legacy-1", true);
    stubSideEffects(3); // line item + billing contact + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Roses", quantity: 1, priceUsd: 50 }],
        billing: { firstName: "Sarah", email: "sarah@test.com", phone: "+9613000000" },
      });

    expect(res.status).toBe(201);
    expect(mockUpsertContact).not.toHaveBeenCalledWith(
      expect.objectContaining({ whatsappConsent: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Initial order status derived from payment
// ---------------------------------------------------------------------------

describe("POST /api/orders — initial status from payment", () => {
  // The order INSERT binds status as the last parameter ($9 → params index 8).
  const statusOf = () => {
    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    return orderInsertCall?.[1]?.[8];
  };

  it("creates a verified-paid order with status 'processing'", async () => {
    stubTxBegin();
    stubOrderInsert("order-paid-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
        payment: { method: "stripe", verified: true },
      });

    expect(res.status).toBe(201);
    expect(statusOf()).toBe("processing");
  });

  it("creates an unpaid order with status 'pending'", async () => {
    stubTxBegin();
    stubOrderInsert("order-unpaid-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
        payment: { method: "stripe", verified: false },
      });

    expect(res.status).toBe(201);
    expect(statusOf()).toBe("pending");
  });

  it("defaults to 'pending' when no payment block is provided", async () => {
    stubTxBegin();
    stubOrderInsert("order-nopay-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
      });

    expect(res.status).toBe(201);
    expect(statusOf()).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Whish payment → Tookan gating
// ---------------------------------------------------------------------------

describe("POST /api/orders — Whish payment Tookan gating", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const findAwaitingPaymentUpdate = () =>
    mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        /tookan_status\s*=\s*'awaiting_payment'/i.test(c[0] as string),
    );

  it("skips Tookan task creation for an unpaid Whish order and sets awaiting_payment", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    stubTxBegin();
    stubOrderInsert("order-whish-1", true);
    stubSideEffects(2); // line item + payment
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-whish-1",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
        payment: { method: "whish", verified: false },
      });
    await flush();

    expect(res.status).toBe(201);
    expect(mockCreateTookanDeliveryTask).not.toHaveBeenCalled();
    const awaitingCall = findAwaitingPaymentUpdate();
    expect(awaitingCall).toBeTruthy();
    expect(awaitingCall![1]).toEqual(["order-whish-1"]);
  });

  it("creates the Tookan task at ingest for a verified-paid Whish order", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockResolvedValue({
      jobId: "job-1",
      taskId: "task-1",
      debugPayload: {},
    });
    stubTxBegin();
    stubOrderInsert("order-whish-2", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-whish-2",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
        payment: { method: "whish", verified: true },
      });
    await flush();

    expect(res.status).toBe(201);
    expect(mockCreateTookanDeliveryTask).toHaveBeenCalledTimes(1);
    expect(mockSyncApprovedFloristPhotoForOrder).toHaveBeenCalledWith(
      "order-whish-2",
      OWNER_ID,
    );
    expect(findAwaitingPaymentUpdate()).toBeUndefined();
  });

  it("creates the Tookan task at ingest for a non-Whish unpaid order", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockResolvedValue({
      jobId: "job-2",
      taskId: "task-2",
      debugPayload: {},
    });
    stubTxBegin();
    stubOrderInsert("order-cod-1", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-cod-1",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
        payment: { method: "cash_on_delivery", verified: false },
      });
    await flush();

    expect(res.status).toBe(201);
    expect(mockCreateTookanDeliveryTask).toHaveBeenCalledTimes(1);
    expect(findAwaitingPaymentUpdate()).toBeUndefined();
  });

  it("does not set awaiting_payment for an unpaid Whish order when Tookan is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);
    stubTxBegin();
    stubOrderInsert("order-whish-3", true);
    stubSideEffects(2);
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        external_order_id: "ext-whish-3",
        line_items: [{ name: "Roses", quantity: 1, unit_price: 8 }],
        payment: { method: "whish", verified: false },
      });
    await flush();

    expect(res.status).toBe(201);
    expect(mockCreateTookanDeliveryTask).not.toHaveBeenCalled();
    expect(findAwaitingPaymentUpdate()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Double-conversion guard (totals.paid_total + totals.paid_currency)
// ---------------------------------------------------------------------------

describe("POST /api/orders — double-conversion guard", () => {
  it("uses pre-converted totals.paid_total as authoritative when present", async () => {
    // The storefront already computed SAR 785; payment.totalAmount absent.
    // The guard must use 785 directly, not re-multiply by any rate.
    stubTxBegin();
    stubOrderInsert("order-preconv-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 209 }],
        totals: {
          subtotal: 209,
          total: 209,
          currency: "USD",
          paid_total: 785,
          paid_currency: "SAR",
        },
        payment: { method: "cash", verified: false, totalUsd: 209, currencyCode: "SAR" },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const storedTotals = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(storedTotals.paid_total).toBe(785);
    expect(storedTotals.paid_currency).toBe("SAR");
    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[7]).toBe(785);
  });

  it("logs a warning when payment.totalAmount disagrees with totals.paid_total", async () => {
    const { logger } = await import("../lib/logger");
    const warnSpy = vi.spyOn(logger, "warn");

    stubTxBegin();
    stubOrderInsert("order-preconv-warn-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 209 }],
        totals: { total: 209, paid_total: 785, paid_currency: "SAR" },
        payment: {
          method: "cash",
          verified: false,
          totalUsd: 209,
          // payment.totalAmount disagrees with totals.paid_total
          totalAmount: 780,
          currencyCode: "SAR",
        },
      });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ preConvertedPaidTotal: 785, payloadTotalAmount: 780 }),
      expect.stringContaining("disagree"),
    );
    warnSpy.mockRestore();
  });

  it("Stripe-verified amount still wins over pre-converted totals.paid_total", async () => {
    // Stripe says 800 SAR was charged; totals carries 785 SAR; Stripe wins.
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 800, currency: "SAR" });
    stubTxBegin();
    stubOrderInsert("order-stripe-wins-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 209 }],
        totals: { total: 209, paid_total: 785, paid_currency: "SAR" },
        payment: {
          method: "stripe",
          ref: "pi_3StripeWins001",
          verified: true,
          totalUsd: 209,
          currencyCode: "SAR",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const storedTotals = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    // Stripe's authoritative 800 overrides the pre-converted 785 in totals.
    expect(storedTotals.paid_total).toBe(800);
    expect(storedTotals.paid_currency).toBe("SAR");
  });

  it("falls back to payment.totalAmount when totals.paid_total is absent", async () => {
    stubTxBegin();
    stubOrderInsert("order-fallback-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 100 }],
        totals: { total: 100 },
        payment: {
          method: "cash",
          verified: false,
          totalUsd: 100,
          totalAmount: 370,
          currencyCode: "AED",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const storedTotals = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(storedTotals.paid_total).toBe(370);
    expect(storedTotals.paid_currency).toBe("AED");
  });
});

// ---------------------------------------------------------------------------
// Integer minor-unit arithmetic (zero-decimal and three-decimal currencies)
// ---------------------------------------------------------------------------

describe("POST /api/orders — paid_line_total integer arithmetic for unusual currencies", () => {
  it("stores JPY paid_line_total with no decimal places (zero-decimal currency)", async () => {
    stubTxBegin();
    stubOrderInsert("order-jpy-ext-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Gift Set", quantity: 3, priceUsd: 40, paidUnitPrice: 5500 }],
        payment: {
          method: "cash",
          verified: false,
          totalUsd: 120,
          totalAmount: 16500,
          currencyCode: "JPY",
        },
      });

    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[1]?.[7]).toBe("5500"); // paid_unit_price
    // paid_line_total: 5500 × 3 = 16500 — no decimal point for JPY
    expect(lineItemCall?.[1]?.[8]).toBe("16500");
    expect(lineItemCall?.[1]?.[8]).not.toContain(".");
  });

  it("stores KWD paid_line_total with three decimal places", async () => {
    stubTxBegin();
    stubOrderInsert("order-kwd-ext-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Orchid", quantity: 2, priceUsd: 60, paidUnitPrice: 18.5 }],
        payment: {
          method: "cash",
          verified: false,
          totalUsd: 120,
          totalAmount: 37,
          currencyCode: "KWD",
        },
      });

    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[1]?.[7]).toBe("18.5");
    // paid_line_total: 18.5 × 2 = 37.000 (three decimal places for KWD)
    expect(lineItemCall?.[1]?.[8]).toBe("37.000");
  });

  it("avoids floating-point drift for SAR: 55.1 × 2 = 110.20 (not 110.20000000000001)", async () => {
    stubTxBegin();
    stubOrderInsert("order-fp-ext-1", true);
    stubSideEffects(2);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Item", quantity: 2, priceUsd: 14.8, paidUnitPrice: 55.1 }],
        payment: {
          method: "cash",
          verified: false,
          totalUsd: 29.6,
          totalAmount: 110.2,
          currencyCode: "SAR",
        },
      });

    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    // Direct float multiply: 55.1 * 2 = 110.20000000000001 — integer arithmetic fixes it.
    expect(lineItemCall?.[1]?.[8]).toBe("110.20");
  });

  it("stores multiple quantities with discount and tax reconciling to paid_total", async () => {
    stubTxBegin();
    stubOrderInsert("order-multi-ext-1", true);
    stubSideEffects(3); // line item + payment + upsertContact side effects
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [
          { productName: "Rose Bouquet", quantity: 2, priceUsd: 35, paidUnitPrice: 130 },
          { productName: "Box", quantity: 1, priceUsd: 10, paidUnitPrice: 37 },
        ],
        payment: {
          method: "cash",
          verified: false,
          totalUsd: 80,
          totalAmount: 297,
          currencyCode: "SAR",
          subtotalAmount: 297,
          deliveryFeeAmount: 0,
        },
      });

    const lineItemCalls = mockClientQuery.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCalls).toHaveLength(2);
    // Rose: 130 × 2 = 260.00
    expect(lineItemCalls[0]?.[1]?.[8]).toBe("260.00");
    // Box: 37 × 1 = 37.00
    expect(lineItemCalls[1]?.[1]?.[8]).toBe("37.00");
  });
});

// ---------------------------------------------------------------------------
// Mislabeled paid-pair plausibility guard (rate-based)
// ---------------------------------------------------------------------------

describe("POST /api/orders — mislabeled paid-pair guard", () => {
  it("rejects a bare non-USD totalAmount that echoes the USD figure (QAR bug shape)", async () => {
    // The observed production failure: payment.totalAmount = 168 (the USD
    // figure) labeled QAR, no breakdown, no Stripe intent ref. The pair must
    // NOT be stored anywhere; all records fall back to USD-labeled USD.
    stubTxBegin();
    stubOrderInsert("order-qar-mislabel", true);
    stubSideEffects(3);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 150 }],
        totals: { subtotal: 150, total: 168, currency: "USD" },
        delivery: { cityId: "doha", feeUsd: 18 },
        payment: {
          method: "cash_on_delivery",
          verified: false,
          totalUsd: 168,
          totalAmount: 168,
          currencyCode: "QAR",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBeUndefined();
    expect(totalsJson.paid_currency).toBeUndefined();

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    // params: [order_id, method, provider, provider_ref, status, currency, amount_usd, amount]
    // The (currency, amount) pair must be USD-consistent, never QAR + 168.
    expect(paymentCall?.[1]?.[5]).toBe("USD");
    expect(paymentCall?.[1]?.[6]).toBe(168);
    expect(paymentCall?.[1]?.[7]).toBe(168);
  });

  it("stores a bare non-USD totalAmount that is rate-plausible (genuine QAR charge)", async () => {
    // QAR 630 on a USD 168 charge (~the 3.64 peg) — genuine, must be kept
    // even without a breakdown or Stripe ref.
    stubTxBegin();
    stubOrderInsert("order-qar-genuine", true);
    stubSideEffects(3);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 150 }],
        totals: { subtotal: 150, total: 168, currency: "USD" },
        delivery: { cityId: "doha", feeUsd: 18 },
        payment: {
          method: "cash_on_delivery",
          verified: false,
          totalUsd: 168,
          totalAmount: 630,
          currencyCode: "QAR",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBe(630);
    expect(totalsJson.paid_currency).toBe("QAR");

    const paymentCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[5]).toBe("QAR");
    expect(paymentCall?.[1]?.[7]).toBe(630);
  });

  it("drops line-item paid prices along with a rejected pair so records agree", async () => {
    stubTxBegin();
    stubOrderInsert("order-qar-mislabel-lines", true);
    stubSideEffects(3);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        line_items: [
          { name: "Flowers", quantity: 1, unit_price: 150 },
        ],
        totals: { subtotal: 150, total: 168, currency: "USD" },
        payment: {
          method: "cash_on_delivery",
          verified: false,
          totalUsd: 168,
          totalAmount: 168,
          currencyCode: "QAR",
        },
      });

    const lineItemCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    // params: [..., unit_price(6), line_total(7), paid_unit_price(8), paid_line_total(9), ...]
    expect(lineItemCall?.[1]?.[7]).toBeNull();
    expect(lineItemCall?.[1]?.[8]).toBeNull();
  });

  it("stores card_to and card_from as NULL when cardMessage is absent", async () => {
    // The storefront sends cardTo regardless of whether the sender wrote a
    // message. Without the guard, card_to ends up with a recipient name while
    // card_message is NULL, causing the PDF and dashboard to show a stray
    // "To:" line the sender never intended.
    stubTxBegin();
    stubOrderInsert("order-no-msg-1", true);
    stubSideEffects(2); // INSERT item + payment record
    stubTxCommit();

    const res = await request(makeApp())
      .post("/api/orders")
      .send({
        appOrderId: "web-no-msg-001",
        items: [{ productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
        // cardTo is present but cardMessage is absent — should be suppressed.
        cardTo: "Ahmad",
        cardFrom: "Sarah",
        payment: { method: "stripe", verified: true, totalUsd: 79.99 },
      });

    expect(res.status).toBe(201);

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    // Parameters: $10 = card_message, $11 = card_from, $12 = card_to
    expect(orderInsertCall?.[1]?.[9]).toBeNull();  // $10 card_message
    expect(orderInsertCall?.[1]?.[10]).toBeNull(); // $11 card_from
    expect(orderInsertCall?.[1]?.[11]).toBeNull(); // $12 card_to
  });

  it("does not run the guard when the pair was Stripe-verified", async () => {
    // Stripe's answer is authoritative even if it looks rate-odd.
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 168, currency: "QAR" });
    stubTxBegin();
    stubOrderInsert("order-stripe-odd", true);
    stubSideEffects(3);
    stubTxCommit();

    await request(makeApp())
      .post("/api/orders")
      .send({
        items: [{ productName: "Flowers", quantity: 1, priceUsd: 150 }],
        totals: { subtotal: 150, total: 168, currency: "USD" },
        delivery: { cityId: "doha", feeUsd: 18 },
        payment: {
          method: "stripe",
          ref: "pi_3OddButVerified",
          verified: true,
          totalUsd: 168,
          totalAmount: 168,
          currencyCode: "QAR",
        },
      });

    const orderInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totalsJson = JSON.parse(orderInsertCall?.[1]?.[6] as string);
    expect(totalsJson.paid_total).toBe(168);
    expect(totalsJson.paid_currency).toBe("QAR");
  });
});
