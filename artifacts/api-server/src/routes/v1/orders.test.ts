/**
 * Unit tests for the v1 orders ingest route — paid-currency fields, integer
 * arithmetic, and exchange-rate-based derivation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockUpsertContact = vi.fn();
const mockRefreshPhonePlaceholderContactAfterFirstOrder = vi.fn().mockResolvedValue(false);

vi.mock("../../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../../lib/contactUpsert", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
  refreshPhonePlaceholderContactAfterFirstOrder: (...args: unknown[]) =>
    mockRefreshPhonePlaceholderContactAfterFirstOrder(...args),
}));

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import router from "./orders";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", router);
  return app;
}

// Parameter indices in the orders INSERT (0-based):
// $1=workspace_owner_id $2=source $3=external_order_id $4=external_order_number
// $5=idempotency_key $6=order_number $7=display_order_number $8=status
// $9=ordered_at $10=delivery_type $11=delivery_date $12=window_start
// $13=window_end $14=delivery_address_status $15=delivery_address
// $16=delivery_instructions $17=card_message $18=totals $19=raw_payload
const TOTALS_IDX = 17; // 0-based index of `totals` in query params

// Parameter indices in the order_line_items INSERT (0-based):
// $1=order_id $2=product_id $3=external_id $4=sku $5=name $6=quantity
// $7=unit_price $8=line_total $9=image_url $10=options $11=metadata
// $12=paid_unit_price $13=paid_line_total
const LI_EXTERNAL_ID_IDX = 2;
const LI_TOTAL_IDX = 7;
const LI_PAID_PRICE_IDX = 11;
const LI_PAID_TOTAL_IDX = 12;

// Parameter indices in the order_payment INSERT (0-based):
// $1=order_id $2=status $3=method $4=provider $5=provider_ref $6=paid_at
// $7=currency $8=amount
const PAY_CURRENCY_IDX = 6;
const PAY_AMOUNT_IDX = 7;

/**
 * Stub the first db.query call (the ORDER INSERT) to return the given orderId,
 * then let all subsequent calls (delete/insert side effects) resolve to empty.
 */
function stubOrderInsert(orderId = "order-uuid-1", wasInserted = true) {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: orderId, was_inserted: wasInserted }],
    rowCount: 1,
  });
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpsertContact.mockResolvedValue(null);
  mockRefreshPhonePlaceholderContactAfterFirstOrder.mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// Paid-currency totals JSON
// ---------------------------------------------------------------------------

describe("v1 POST /orders — paid-currency in totals", () => {
  it("stores paid_total and paid_currency when payment.currency is non-USD with explicit paid_total", async () => {
    stubOrderInsert("order-sar-v1-1");

    const res = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Roses", quantity: 2, unit_price: "80.00" }],
        totals: { subtotal: 160, total: 160, currency: "USD" },
        payment: { status: "paid", currency: "SAR", paid_total: 600 },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[TOTALS_IDX] as string);
    expect(totals.paid_total).toBe(600);
    expect(totals.paid_currency).toBe("SAR");
  });

  it("derives paid_total from exchange_rate × USD total when no explicit paid_total", async () => {
    stubOrderInsert("order-eur-v1-1");

    const res = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Bouquet", quantity: 1, unit_price: "100.00" }],
        totals: { subtotal: 100, total: 100, currency: "USD" },
        payment: { status: "paid", currency: "EUR", exchange_rate: 0.92 },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[TOTALS_IDX] as string);
    expect(totals.paid_currency).toBe("EUR");
    // 100 × 0.92 = 92.00 EUR (rounded to 2 decimal places)
    expect(totals.paid_total).toBeCloseTo(92, 5);
    expect(totals.exchange_rate).toBe(0.92);
  });

  it("derives paid_total from paid_subtotal breakdown when paid_total is absent", async () => {
    stubOrderInsert("order-aed-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Flowers", quantity: 1 }],
        payment: {
          status: "paid",
          currency: "AED",
          paid_subtotal: 250,
          paid_delivery_fee: 25,
          paid_discount: 5,
        },
      });

    const orderInsertCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[TOTALS_IDX] as string);
    // paid_total derived: 250 + 25 - 5 = 270
    expect(totals.paid_total).toBeCloseTo(270, 5);
    expect(totals.paid_currency).toBe("AED");
    expect(totals.paid_subtotal).toBe(250);
    expect(totals.paid_shipping).toBe(25);
    expect(totals.paid_discount).toBe(5);
  });

  it("does not store a paid pair for USD orders", async () => {
    stubOrderInsert("order-usd-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Roses", quantity: 1, unit_price: "50.00" }],
        totals: { subtotal: 50, total: 50, currency: "USD" },
        payment: { status: "paid", currency: "USD" },
      });

    const orderInsertCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    const totals = JSON.parse(orderInsertCall?.[1]?.[TOTALS_IDX] as string);
    expect(totals.paid_total).toBeUndefined();
    expect(totals.paid_currency).toBeUndefined();
  });

  it("re-ingest with the same payload produces idempotent ON CONFLICT behavior", async () => {
    stubOrderInsert("order-idem-v1-1");

    const res = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        external_order_id: "ext-001",
        line_items: [{ name: "Flowers", quantity: 1 }],
        payment: { status: "paid", currency: "SAR", paid_total: 375 },
      });

    expect(res.status).toBe(201);
    const orderInsertCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO orders"),
    );
    // ON CONFLICT clause is present in the SQL
    expect(orderInsertCall?.[0]).toContain("ON CONFLICT");
    expect(orderInsertCall?.[0]).toContain("DO UPDATE SET");
  });
});

// ---------------------------------------------------------------------------
// Paid-currency line items
// ---------------------------------------------------------------------------

describe("v1 POST /orders — paid_unit_price and paid_line_total on line items", () => {
  it("maps legacy external_product_id and total request fields to production columns", async () => {
    stubOrderInsert("order-legacy-fields-v1-1");

    const res = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{
          external_product_id: "legacy-product-123",
          name: "Legacy bouquet",
          quantity: 2,
          total: "150.00",
        }],
      });

    expect(res.status).toBe(201);
    const lineItemCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[0]).toContain("external_id");
    expect(lineItemCall?.[0]).toContain("line_total");
    expect(lineItemCall?.[0]).not.toContain("external_product_id");
    expect(lineItemCall?.[1]?.[LI_EXTERNAL_ID_IDX]).toBe("legacy-product-123");
    expect(lineItemCall?.[1]?.[LI_TOTAL_IDX]).toBe("150.00");
  });

  it("stores paid_unit_price and computes paid_line_total using integer arithmetic", async () => {
    stubOrderInsert("order-li-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Roses", quantity: 2, paid_unit_price: 160 }],
        payment: { status: "paid", currency: "SAR", paid_total: 320 },
      });

    const lineItemCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[0]).toContain("paid_unit_price");
    expect(lineItemCall?.[0]).toContain("paid_line_total");
    expect(lineItemCall?.[1]?.[LI_PAID_PRICE_IDX]).toBe("160");
    // 160 × 2 = 320.00 (SAR is 2-decimal)
    expect(lineItemCall?.[1]?.[LI_PAID_TOTAL_IDX]).toBe("320.00");
  });

  it("avoids floating-point drift: 55.1 × 2 stores as 110.20, not 110.20000000000001", async () => {
    stubOrderInsert("order-fp-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Item", quantity: 2, paid_unit_price: 55.1 }],
        payment: { status: "paid", currency: "SAR", paid_total: 110.2 },
      });

    const lineItemCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[1]?.[LI_PAID_TOTAL_IDX]).toBe("110.20");
  });

  it("stores JPY paid_line_total with no decimal places (zero-decimal currency)", async () => {
    stubOrderInsert("order-jpy-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Gift", quantity: 3, paid_unit_price: 5500 }],
        payment: { status: "paid", currency: "JPY", paid_total: 16500 },
      });

    const lineItemCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    // JPY is zero-decimal: 5500 × 3 = 16500 (integer string, no decimal point)
    expect(lineItemCall?.[1]?.[LI_PAID_TOTAL_IDX]).toBe("16500");
    expect(lineItemCall?.[1]?.[LI_PAID_TOTAL_IDX]).not.toContain(".");
  });

  it("stores KWD paid_line_total with three decimal places", async () => {
    stubOrderInsert("order-kwd-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Orchid", quantity: 2, paid_unit_price: 18.5 }],
        payment: { status: "paid", currency: "KWD", paid_total: 37 },
      });

    const lineItemCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    // KWD is three-decimal: 18.5 × 2 = 37.000
    expect(lineItemCall?.[1]?.[LI_PAID_TOTAL_IDX]).toBe("37.000");
  });

  it("stores null paid prices when paid_unit_price is absent (legacy/USD payloads)", async () => {
    stubOrderInsert("order-no-paid-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Roses", quantity: 1, unit_price: "50" }],
      });

    const lineItemCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_line_items"),
    );
    expect(lineItemCall?.[1]?.[LI_PAID_PRICE_IDX]).toBeNull();
    expect(lineItemCall?.[1]?.[LI_PAID_TOTAL_IDX]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// order_payment.amount
// ---------------------------------------------------------------------------

describe("v1 POST /orders — order_payment.amount for non-USD orders", () => {
  it("sets order_payment.amount to the paid-currency amount", async () => {
    stubOrderInsert("order-amt-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Flowers", quantity: 1 }],
        payment: { status: "paid", currency: "AED", paid_total: 185 },
      });

    const paymentCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[0]).toContain("amount");
    expect(paymentCall?.[1]?.[PAY_CURRENCY_IDX]).toBe("AED");
    expect(paymentCall?.[1]?.[PAY_AMOUNT_IDX]).toBe(185);
  });

  it("leaves order_payment.amount null for USD orders (no foreign pair)", async () => {
    stubOrderInsert("order-amt-usd-v1-1");

    await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Flowers", quantity: 1 }],
        payment: { status: "paid", currency: "USD" },
      });

    const paymentCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO order_payment"),
    );
    expect(paymentCall?.[1]?.[PAY_CURRENCY_IDX]).toBe("USD");
    expect(paymentCall?.[1]?.[PAY_AMOUNT_IDX]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("v1 POST /orders — first-order phone placeholder repair", () => {
  it("runs the guarded repair for a newly inserted customer order, not a retry", async () => {
    mockUpsertContact.mockResolvedValue("contact-1");
    stubOrderInsert("order-first-v1-1", true);

    const first = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        external_order_id: "external-first-1",
        contacts: [{
          role: "customer",
          first_name: "Rana",
          last_name: "K",
          phone: "+96170000001",
        }],
      });

    expect(first.status).toBe(201);
    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).toHaveBeenCalledWith({
      workspaceOwnerId: "owner-1",
      contactId: "contact-1",
      orderId: "order-first-v1-1",
      buyer: { firstName: "Rana", lastName: "K", displayName: null },
    });

    vi.clearAllMocks();
    mockUpsertContact.mockResolvedValue("contact-1");
    stubOrderInsert("order-first-v1-1", false);

    const retry = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        external_order_id: "external-first-1",
        contacts: [{
          role: "customer",
          first_name: "Rana",
          last_name: "K",
          phone: "+96170000001",
        }],
      });

    expect(retry.status).toBe(201);
    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).not.toHaveBeenCalled();
  });
});

describe("v1 POST /orders — validation", () => {
  it("returns 400 when workspace_owner_id is missing", async () => {
    const res = await request(makeApp())
      .post("/api/v1/orders")
      .send({ line_items: [{ name: "Flowers", quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it("returns 201 with success and id on a minimal valid payload", async () => {
    stubOrderInsert("order-min-v1-1");

    const res = await request(makeApp())
      .post("/api/v1/orders")
      .send({
        workspace_owner_id: "owner-1",
        line_items: [{ name: "Flowers", quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBe("order-min-v1-1");
  });
});
