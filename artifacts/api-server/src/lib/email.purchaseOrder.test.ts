import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Resend mock — must be declared before any email module imports
// ---------------------------------------------------------------------------

const mockSend = vi.fn();
vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: (...args: unknown[]) => mockSend(...args) };
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildPurchaseOrderEmailHtml, sendPurchaseOrderEmail } from "./email";

// ---------------------------------------------------------------------------
// Shared base options for buildPurchaseOrderEmailHtml
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  poNumberLabel: "PO-0001",
  status: "draft",
  currency: "AED",
  totalAmount: null,
  effectiveTotal: null,
  expectedDeliveryDate: null,
  notes: null,
  supplierName: "ACME Supplies",
  dashboardUrl: "https://os.presentail.com",
};

// ---------------------------------------------------------------------------
// buildPurchaseOrderEmailHtml — no line items
// ---------------------------------------------------------------------------

describe("buildPurchaseOrderEmailHtml — no line items", () => {
  it("does not include a Line Items section when lineItems is omitted", () => {
    const html = buildPurchaseOrderEmailHtml(BASE_OPTS);

    expect(html).not.toContain("Line Items");
    expect(html).not.toContain("<thead>");
    expect(html).not.toContain("Description");
  });

  it("does not include a Line Items section when lineItems is an empty array", () => {
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems: [] });

    expect(html).not.toContain("Line Items");
    expect(html).not.toContain("<thead>");
  });

  it("renders the PO number in the title", () => {
    const html = buildPurchaseOrderEmailHtml(BASE_OPTS);

    expect(html).toContain("PO-0001");
  });

  it("renders the supplier name in the body", () => {
    const html = buildPurchaseOrderEmailHtml(BASE_OPTS);

    expect(html).toContain("ACME Supplies");
  });
});

// ---------------------------------------------------------------------------
// buildPurchaseOrderEmailHtml — with line items
// ---------------------------------------------------------------------------

describe("buildPurchaseOrderEmailHtml — with line items", () => {
  const lineItems = [
    { description: "Widget A", quantity: "2", unit_price: "10.00", currency: "AED" },
    { description: "Gadget B", quantity: "5", unit_price: "4.00", currency: "AED" },
  ];

  it("includes the Line Items section header", () => {
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems });

    expect(html).toContain("Line Items");
  });

  it("includes a table with Description, Qty, Unit Price, Line Total headers", () => {
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems });

    expect(html).toContain("Description");
    expect(html).toContain("Qty");
    expect(html).toContain("Unit Price");
    expect(html).toContain("Line Total");
  });

  it("renders each line item description in a table row", () => {
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems });

    expect(html).toContain("Widget A");
    expect(html).toContain("Gadget B");
  });

  it("renders correct line totals (qty × unit_price)", () => {
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems });

    expect(html).toContain("20.00");
  });

  it("renders a totals row at the bottom of the table", () => {
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems });

    expect(html).toContain("Total");
  });

  it("includes the effective total in the totals row when effectiveTotal is provided", () => {
    const html = buildPurchaseOrderEmailHtml({
      ...BASE_OPTS,
      effectiveTotal: "40.0000",
      lineItems,
    });

    expect(html).toContain("40.00");
  });

  it("escapes HTML-special characters in description", () => {
    const dangerous = [
      { description: "<script>alert(1)</script>", quantity: "1", unit_price: "1.00", currency: "AED" },
    ];
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, lineItems: dangerous });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// buildPurchaseOrderEmailHtml — single line item
// ---------------------------------------------------------------------------

describe("buildPurchaseOrderEmailHtml — single line item", () => {
  it("renders one table row for a single line item", () => {
    const lineItems = [
      { description: "Ribbon Roll", quantity: "10", unit_price: "3.50", currency: "USD" },
    ];
    const html = buildPurchaseOrderEmailHtml({ ...BASE_OPTS, currency: "USD", lineItems });

    expect(html).toContain("Ribbon Roll");
    expect(html).toContain("35.00");
  });
});

// ---------------------------------------------------------------------------
// sendPurchaseOrderEmail — plain-text body includes line items
// ---------------------------------------------------------------------------

describe("sendPurchaseOrderEmail — plain-text body includes line items", () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test_key";
    mockSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = ORIGINAL_KEY;
    }
  });

  it("includes a Line Items section in the plain-text body when line items are provided", async () => {
    const lineItems = [
      { description: "Sticker Pack", quantity: "3", unit_price: "5.00", currency: "AED" },
    ];

    await sendPurchaseOrderEmail({
      toEmail: "supplier@example.com",
      poNumberLabel: "PO-0042",
      status: "sent",
      currency: "AED",
      totalAmount: null,
      effectiveTotal: "15.0000",
      expectedDeliveryDate: null,
      notes: null,
      supplierName: "Sticker Co",
      lineItems,
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const callArg = mockSend.mock.calls[0][0] as { text: string };
    expect(callArg.text).toContain("Line Items:");
    expect(callArg.text).toContain("Sticker Pack");
    expect(callArg.text).toContain("qty 3");
    expect(callArg.text).toContain("AED 5.00");
    expect(callArg.text).toContain("AED 15.00");
  });

  it("does not include a Line Items section in plain text when no line items are provided", async () => {
    await sendPurchaseOrderEmail({
      toEmail: "supplier@example.com",
      poNumberLabel: "PO-0099",
      status: "draft",
      currency: "AED",
      totalAmount: "100.00",
      effectiveTotal: "100.00",
      expectedDeliveryDate: null,
      notes: null,
      supplierName: "Generic Supplier",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const callArg = mockSend.mock.calls[0][0] as { text: string };
    expect(callArg.text).not.toContain("Line Items:");
  });

  it("includes the acceptance link in the plain-text body when acceptanceLink is provided", async () => {
    await sendPurchaseOrderEmail({
      toEmail: "supplier@example.com",
      poNumberLabel: "PO-0055",
      status: "sent",
      currency: "USD",
      totalAmount: "200.00",
      effectiveTotal: "200.00",
      expectedDeliveryDate: null,
      notes: null,
      supplierName: "Digital Vendor",
      acceptanceLink: "https://os.presentail.com/po-accept/abc123token",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const callArg = mockSend.mock.calls[0][0] as { text: string };
    expect(callArg.text).toContain("Review & Accept Order: https://os.presentail.com/po-accept/abc123token");
  });

  it("does not include an acceptance link line in the plain-text body when acceptanceLink is omitted", async () => {
    await sendPurchaseOrderEmail({
      toEmail: "supplier@example.com",
      poNumberLabel: "PO-0056",
      status: "draft",
      currency: "USD",
      totalAmount: "50.00",
      effectiveTotal: "50.00",
      expectedDeliveryDate: null,
      notes: null,
      supplierName: "No-Link Vendor",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const callArg = mockSend.mock.calls[0][0] as { text: string };
    expect(callArg.text).not.toContain("Review & Accept Order:");
  });

  it("includes multiple line items in the plain-text body", async () => {
    const lineItems = [
      { description: "Item Alpha", quantity: "2", unit_price: "10.00", currency: "USD" },
      { description: "Item Beta", quantity: "4", unit_price: "7.50", currency: "USD" },
    ];

    await sendPurchaseOrderEmail({
      toEmail: "vendor@example.com",
      poNumberLabel: "PO-0007",
      status: "sent",
      currency: "USD",
      totalAmount: null,
      effectiveTotal: "50.0000",
      expectedDeliveryDate: null,
      notes: null,
      supplierName: "Multi-Item Vendor",
      lineItems,
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const callArg = mockSend.mock.calls[0][0] as { text: string };
    expect(callArg.text).toContain("Item Alpha");
    expect(callArg.text).toContain("Item Beta");
    expect(callArg.text).toContain("qty 2 x USD 10.00 = USD 20.00");
    expect(callArg.text).toContain("qty 4 x USD 7.50 = USD 30.00");
  });
});
