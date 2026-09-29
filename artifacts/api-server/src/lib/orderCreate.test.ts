import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockDbConnect = vi.fn();
const mockCreateAddressCollectionRequest = vi.fn().mockResolvedValue({ created: true, requestId: "request-1", token: "token" });

vi.mock("./orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendWhishPaymentInstructions: vi.fn().mockResolvedValue({ ok: false }),
}));

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("./addressCollector/service", () => ({
  createAddressCollectionRequest: (...args: unknown[]) => mockCreateAddressCollectionRequest(...args),
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockUpsertContact = vi.fn();
const mockRefreshPhonePlaceholderContactAfterFirstOrder = vi.fn().mockResolvedValue(false);
vi.mock("./contactUpsert", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
  refreshPhonePlaceholderContactAfterFirstOrder: (...args: unknown[]) =>
    mockRefreshPhonePlaceholderContactAfterFirstOrder(...args),
}));

const mockBroadcastEvent = vi.fn();
vi.mock("./autoTags", () => ({
  applyAutoTagsForContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./orderAlerts", () => ({
  notifyNewOrderAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./eventsSse", () => ({
  broadcastEvent: (...args: unknown[]) => mockBroadcastEvent(...args),
}));

const mockFireWebhookEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("./catalogWebhook", () => ({
  fireWebhookEvent: (...args: unknown[]) => mockFireWebhookEvent(...args),
}));

const mockNotifyNewUaeOrderToSlack = vi.fn().mockResolvedValue(undefined);
vi.mock("./slack", () => ({
  notifyNewUaeOrderToSlack: (...args: unknown[]) => mockNotifyNewUaeOrderToSlack(...args),
}));

const mockLinkOrderToAddressBook = vi.fn().mockResolvedValue(undefined);
vi.mock("./addressBookAutoLink", () => ({
  linkOrderToAddressBook: (...args: unknown[]) => mockLinkOrderToAddressBook(...args),
}));

const mockIsTookanEnabled = vi.fn();
const mockCreateTookanDeliveryTask = vi.fn();
const mockSyncApprovedFloristPhotoForOrder = vi.fn().mockResolvedValue(undefined);
vi.mock("./tookan", () => ({
  isTookanEnabled: (...args: unknown[]) => mockIsTookanEnabled(...args),
  createTookanDeliveryTask: (...args: unknown[]) => mockCreateTookanDeliveryTask(...args),
  extractTookanFailurePayload: (err: unknown) =>
    err && typeof err === "object" && "debugPayload" in err
      ? (err as { debugPayload?: unknown }).debugPayload ?? null
      : null,
}));
vi.mock("./floristTookanPhotoSync", () => ({
  syncApprovedFloristPhotoForOrderToTookan: (...args: unknown[]) =>
    mockSyncApprovedFloristPhotoForOrder(...args),
}));

import { createManualOrder, type CreateOrderData } from "./orderCreate";
import { normalizePersonName } from "./personName";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush pending microtasks so the fire-and-forget Tookan IIFE can settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function setupClient(nextNumber: string | number = "1001") {
  mockClientQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO orders/i.test(sql) && /RETURNING id/i.test(sql)) {
      return { rows: [{ id: "order-1" }] };
    }
    if (/next_number/i.test(sql)) {
      return { rows: [{ next_number: String(nextNumber) }] };
    }
    return { rows: [] };
  });
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: (...args: unknown[]) => mockClientRelease(...args),
  });
}

const baseData: CreateOrderData = {
  customer: { display_name: "Alice Sender", phone: "+9613000111", email: "alice@example.com" },
  recipient: { display_name: "Bob Recipient", phone: "+9613999888" },
  line_items: [{ name: "Red Roses", quantity: 2, unit_price: 50 }],
  delivery_address: { address: "12 Main St", district: "Achrafieh" },
  delivery_instructions: "Leave at door",
  card_message: "Happy Birthday!",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertContact.mockResolvedValue("contact-1");
  mockCreateAddressCollectionRequest.mockResolvedValue({ created: true, requestId: "request-1", token: "token" });
  setupClient();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createManualOrder order-number assignment", () => {
  /** Index-based helpers over the txn client's calls. */
  function clientSqlCalls(): string[] {
    return mockClientQuery.mock.calls.map((c) => String(c[0]));
  }

  it("assigns M-1001 for the first manual order in a workspace", async () => {
    setupClient("1001");
    const { orderId, displayOrderNumber } = await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: baseData,
    });
    expect(orderId).toBe("order-1");
    expect(displayOrderNumber).toBe("M-1001");

    // The number is stored atomically as the final order INSERT value.
    const insertCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO orders/i.test(String(call[0])),
    );
    expect(insertCall).toBeTruthy();
    expect(String(insertCall![0])).toContain("display_order_number");
    expect((insertCall![1] as unknown[]).at(-1)).toBe("M-1001");
  });

  it("continues the sequence after the workspace's current max", async () => {
    setupClient("1006");
    const { displayOrderNumber } = await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: baseData,
    });
    expect(displayOrderNumber).toBe("M-1006");
  });

  it("scopes the sequence query and advisory lock to the workspace", async () => {
    setupClient("1001");
    await createManualOrder({ workspaceOwnerId: "ws-isolated", data: baseData });

    const lockCall = mockClientQuery.mock.calls.find((c) =>
      /pg_advisory_xact_lock/i.test(String(c[0])),
    );
    expect(lockCall).toBeTruthy();
    expect(lockCall![1]).toEqual(["ws-isolated"]);

    const seqCall = mockClientQuery.mock.calls.find((c) =>
      /next_number/i.test(String(c[0])),
    );
    expect(seqCall).toBeTruthy();
    expect(String(seqCall![0])).toContain("workspace_owner_id = $1");
    expect(seqCall![1]).toEqual(["ws-isolated"]);
  });

  it("takes the advisory lock inside the transaction, before computing the number", async () => {
    setupClient("1001");
    await createManualOrder({ workspaceOwnerId: "ws-1", data: baseData });

    const sqls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const beginIdx = sqls.findIndex((s) => /^BEGIN$/i.test(s));
    const lockIdx = sqls.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
    const seqIdx = sqls.findIndex((s) => /next_number/i.test(s));
    const insertIdx = sqls.findIndex((s) => /INSERT INTO orders/i.test(s));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(seqIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(seqIdx);
  });

  it("rolls back and rejects when the number cannot be computed", async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/next_number/i.test(sql)) return { rows: [] };
      if (/INSERT INTO orders/i.test(sql) && /RETURNING id/i.test(sql)) {
        return { rows: [{ id: "order-1" }] };
      }
      return { rows: [] };
    });
    mockDbConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: (...args: unknown[]) => mockClientRelease(...args),
    });

    await expect(
      createManualOrder({ workspaceOwnerId: "ws-1", data: baseData }),
    ).rejects.toThrow(/manual order number/i);

  });
});

describe("createManualOrder city delivery pricing", () => {
  function cityRow(overrides: Partial<{
    country_code: string;
    delivery_fee: string;
    free_delivery_enabled: boolean;
    free_delivery_threshold: string | null;
  }> = {}) {
    return {
      country_code: "LB",
      delivery_fee: "7.50",
      free_delivery_enabled: false,
      free_delivery_threshold: null,
      ...overrides,
    };
  }

  function orderTotalsFromInsert(): Record<string, unknown> {
    const insert = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO orders/i.test(String(call[0])),
    );
    expect(insert).toBeTruthy();
    return JSON.parse(String((insert![1] as unknown[])[12])) as Record<string, unknown>;
  }

  async function createWithCity(
    subtotal: number,
    row: ReturnType<typeof cityRow> | null = cityRow(),
    address: Record<string, unknown> = { countryCode: "LB", cityId: "beirut" },
  ) {
    mockDbQuery.mockResolvedValueOnce({
      rows: row ? [row] : [],
      rowCount: row ? 1 : 0,
    });
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        line_items: [{ name: "Flowers", quantity: 1, unit_price: subtotal }],
        delivery_address: address,
        totals: { subtotal: 1, shipping: 999, total: 1000, currency: "USD" },
        payment: { method: "cash", status: "pending", currency: "USD" },
      },
    });
  }

  it("recomputes charged-city subtotal, shipping, and grand total", async () => {
    await createWithCity(40);
    expect(orderTotalsFromInsert()).toMatchObject({
      subtotal: 40,
      shipping: 7.5,
      delivery_fee: 7.5,
      total: 47.5,
      currency: "USD",
    });
    const paymentInsert = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO order_payment/i.test(String(call[0])),
    );
    expect(paymentInsert?.[1]).toEqual([
      "order-1",
      "cash",
      "pending",
      "USD",
      47.5,
      47.5,
    ]);
  });

  it.each([50, 75])("waives delivery at or beyond the threshold (%s)", async (subtotal) => {
    await createWithCity(
      subtotal,
      cityRow({ delivery_fee: "10", free_delivery_enabled: true, free_delivery_threshold: "50" }),
    );
    expect(orderTotalsFromInsert()).toMatchObject({ subtotal, shipping: 0, total: subtotal });
  });

  it("charges delivery below the free threshold", async () => {
    await createWithCity(
      49.99,
      cityRow({ delivery_fee: "10", free_delivery_enabled: true, free_delivery_threshold: "50" }),
    );
    expect(orderTotalsFromInsert()).toMatchObject({ subtotal: 49.99, shipping: 10, total: 59.99 });
  });

  it("rejects a missing or out-of-workspace city", async () => {
    await expect(createWithCity(40, null)).rejects.toThrow(/not found in this workspace/i);
  });

  it("rejects a city whose country does not match the address", async () => {
    await expect(
      createWithCity(40, cityRow({ country_code: "AE" })),
    ).rejects.toThrow(/does not belong to the selected country/i);
  });

  it("keeps orders without a city fee-free while normalizing totals", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        line_items: [{ name: "Flowers", quantity: 2, unit_price: 20 }],
        totals: { subtotal: 1, shipping: 999, total: 1000, currency: "USD" },
        payment: { method: "cash", status: "pending", currency: "USD" },
      },
    });
    expect(orderTotalsFromInsert()).toMatchObject({ subtotal: 40, shipping: 0, total: 40 });
  });

  it("uses workspace catalog prices instead of a client-supplied unit price", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, price_usd: "30", price_aed: "110" }],
      rowCount: 1,
    });
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        line_items: [{
          product_id: 42,
          name: "Flowers",
          quantity: 2,
          unit_price: 0.01,
        }],
        totals: { subtotal: 0.02, total: 0.02, currency: "USD" },
        payment: { method: "cash", status: "pending", currency: "USD" },
      },
    });
    expect(orderTotalsFromInsert()).toMatchObject({ subtotal: 60, shipping: 0, total: 60 });
  });
});

describe("createManualOrder Slack side effect", () => {
  it("notifies Slack once after a manual order is committed", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        country_code: "AE",
        delivery_fee: "25",
        free_delivery_enabled: false,
        free_delivery_threshold: null,
      }],
      rowCount: 1,
    });
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        delivery_address: {
          address: "1 Corniche Road",
          countryCode: "AE",
          cityId: "abu-dhabi",
          district: "Abu Dhabi",
        },
        totals: { currency: "AED" },
        payment: { currency: "AED" },
      },
    });

    expect(mockNotifyNewUaeOrderToSlack).toHaveBeenCalledTimes(1);
    expect(mockNotifyNewUaeOrderToSlack).toHaveBeenCalledWith({
      orderId: "order-1",
      workspaceOwnerId: "ws-1",
    });
  });
});

describe("createManualOrder Address Collector eligibility", () => {
  it("creates a collection request when the manual-order toggle is explicitly enabled", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, collect_address: true, preferred_language: "ar" },
    });
    await flush();

    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOwnerId: "ws-1",
        orderId: "order-1",
        recipientName: "Bob Recipient",
        recipientPhone: "+9613999888",
        preferredLanguage: "ar",
        source: "wizard",
      }),
    );
  });

  it("does not create a collection request when the manual-order toggle is absent", async () => {
    await createManualOrder({ workspaceOwnerId: "ws-1", data: baseData });
    await flush();

    expect(mockCreateAddressCollectionRequest).not.toHaveBeenCalled();
  });

  it("automatically creates a request when a manual order has no delivery address", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, status: "processing", delivery_address: null },
    });
    await flush();

    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        recipientName: "Bob Recipient",
        recipientPhone: "+9613999888",
        source: "wizard",
      }),
    );
  });

  it("automatically creates a request for placeholder manual addresses", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        status: "processing",
        delivery_address: { address: "To be confirmed / ask recipient", countryCode: "LB" },
      },
    });
    await flush();

    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryCountryCode: "LB" }),
    );
  });

  it("honors an explicit manual no-address marker", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        status: "processing",
        delivery_address: { address: "12 Main St", noAddress: true },
      },
    });
    await flush();

    expect(mockCreateAddressCollectionRequest).toHaveBeenCalledOnce();
  });

  it("does not automatically create a request for a pending missing-address order", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, delivery_address: null },
    });
    await flush();

    expect(mockCreateAddressCollectionRequest).not.toHaveBeenCalled();
  });
});

describe("createManualOrder Tookan side effect", () => {
  it("creates a Tookan task with mapped delivery details and persists success", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockResolvedValue({
      jobId: "job-1",
      taskId: "task-1",
      debugPayload: { order_id: "order-1" },
    });

    const { orderId } = await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: baseData,
    });
    expect(orderId).toBe("order-1");

    await flush();

    expect(mockCreateTookanDeliveryTask).toHaveBeenCalledTimes(1);
    const [orderArg, recipientArg, lineItemsArg] = mockCreateTookanDeliveryTask.mock.calls[0]!;
    expect(orderArg).toMatchObject({
      id: "order-1",
      delivery_address: { address: "12 Main St", district: "Achrafieh" },
      delivery_instructions: "Leave at door",
      card_message: "Happy Birthday!",
    });
    expect(recipientArg).toMatchObject({ display_name: "Bob Recipient", phone: "+9613999888" });
    expect(lineItemsArg).toEqual([{ name: "Red Roses", quantity: 2 }]);

    // The post-commit UPDATE goes through the top-level db.query (not the txn client).
    const updateCall = mockDbQuery.mock.calls.find((call) =>
      /UPDATE orders\s+SET tookan_job_id/i.test(String(call[0])),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toEqual([
      "job-1",
      "task-1",
      JSON.stringify({ order_id: "order-1" }),
      "order-1",
    ]);
    expect(mockSyncApprovedFloristPhotoForOrder).toHaveBeenCalledWith("order-1", "ws-1");
  });

  it("falls back to the customer as the delivery contact when no recipient is given", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockResolvedValue({
      jobId: "job-2",
      taskId: "task-2",
      debugPayload: {},
    });

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, recipient: null },
    });
    await flush();

    const [, recipientArg] = mockCreateTookanDeliveryTask.mock.calls[0]!;
    expect(recipientArg).toMatchObject({
      display_name: "Alice Sender",
      phone: "+9613000111",
      email: "alice@example.com",
    });
  });

  it("persists tookan_status='failed' when task creation throws and never rejects the order", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockRejectedValue(
      Object.assign(new Error("Tookan API error"), { debugPayload: { bad: true } }),
    );

    const { orderId } = await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: baseData,
    });
    expect(orderId).toBe("order-1");

    await flush();

    const failedCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && /tookan_status\s*=\s*'failed'/i.test(c[0] as string),
    );
    expect(failedCall).toBeTruthy();
    expect(failedCall![1]).toEqual([
      "Tookan API error",
      JSON.stringify({ bad: true }),
      "order-1",
    ]);
  });

  it("does not call Tookan when the integration is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);

    await createManualOrder({ workspaceOwnerId: "ws-1", data: baseData });
    await flush();

    expect(mockCreateTookanDeliveryTask).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("createManualOrder Whish payment gating", () => {
  it("skips Tookan task creation for an unpaid Whish order and persists awaiting_payment", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, payment: { method: "whish", status: "pending" } },
    });
    await flush();

    expect(mockCreateTookanDeliveryTask).not.toHaveBeenCalled();
    const awaitingCall = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        /tookan_status\s*=\s*'awaiting_payment'/i.test(c[0] as string),
    );
    expect(awaitingCall).toBeTruthy();
  });

  it("creates the Tookan task immediately for a non-Whish unpaid order", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockResolvedValue({
      jobId: "job-4",
      taskId: "task-4",
      debugPayload: {},
    });

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, payment: { method: "cash", status: "pending" } },
    });
    await flush();

    expect(mockCreateTookanDeliveryTask).toHaveBeenCalledTimes(1);
    const awaitingCall = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        /tookan_status\s*=\s*'awaiting_payment'/i.test(c[0] as string),
    );
    expect(awaitingCall).toBeUndefined();
  });

  it("creates the Tookan task immediately for a non-Whish unpaid order", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockCreateTookanDeliveryTask.mockResolvedValue({
      jobId: "job-4",
      taskId: "task-4",
      debugPayload: {},
    });

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, payment: { method: "cash", status: "pending" } },
    });
    await flush();

    expect(mockCreateTookanDeliveryTask).toHaveBeenCalledTimes(1);
    const awaitingCall = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        /tookan_status\s*=\s*'awaiting_payment'/i.test(c[0] as string),
    );
    expect(awaitingCall).toBeUndefined();
  });

  it("does not persist awaiting_payment for an unpaid Whish order when Tookan is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, payment: { method: "whish", status: "pending" } },
    });
    await flush();

    expect(mockCreateTookanDeliveryTask).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("createManualOrder CMC sales record", () => {
  function cmcSaleInsert() {
    return mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO cmc_sales/i.test(String(c[0])),
    );
  }

  const cmcData: CreateOrderData = {
    ...baseData,
    source: "cmc-pos",
    totals: { subtotal: 125.5, currency: "USD" },
    payment: { method: "cash", status: "pending", currency: "USD" },
  };

  it("writes a cmc_sales 'order' record dated by creation for a CMC order", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      actorUserId: "user-9",
      data: cmcData,
    });

    const call = cmcSaleInsert();

    expect(call).toBeTruthy();
    const sql = String(call![0]);
    // Distinct workflow, linked to the order, dated by CREATION (today) —
    // never by the delivery window.
    expect(sql).toContain("'order'");
    expect(sql).toContain("now()::date");
    expect(sql).not.toMatch(/window_start/i);
    const params = call![1] as unknown[];
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("user-9");
    expect(params[2]).toBe("pending"); // unpaid → excluded from paid-only audit totals
    expect(params[3]).toBe("order-1"); // order linkage
    expect(params[5]).toBe("100.0000"); // computed from authoritative line items
    expect(params[6]).toBe("0.0000");
    expect(params[7]).toBe("100.0000");
    expect(params[11]).toBe("cash");
    expect(params).toHaveLength(12);
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(...placeholders)).toBe(params.length);
    expect(sql).toContain("$12");
  });

  it("retains Whish in the payment and CMC sales records", async () => {
    // The contact-upsert helper uses the non-transactional DB client before
    // order creation. Keep this regression focused on the payment inserts.
    mockDbQuery.mockResolvedValue({ rows: [] });

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      actorUserId: "user-9",
      data: {
        ...cmcData,
        payment: { method: "whish", status: "pending", currency: "USD" },
      },
    });

    const paymentCall = mockClientQuery.mock.calls.find((c) =>
      /INSERT INTO order_payment/i.test(String(c[0])),
    );
    const saleCall = cmcSaleInsert();

    expect(paymentCall).toBeTruthy();
    expect((paymentCall![1] as unknown[]).slice(1, 4)).toEqual([
      "whish",
      "pending",
      "USD",
    ]);
    expect(saleCall).toBeTruthy();
    expect((saleCall![1] as unknown[])[11]).toBe("whish");
  });

  it("a future delivery date does not shift the sales date", async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      actorUserId: "user-9",
      data: { ...cmcData, window_start: future, window_end: future },
    });

    const call = cmcSaleInsert();

    expect(call).toBeTruthy();
    // The record is always dated with the creation date, regardless of the
    // scheduled delivery window.
    expect(String(call![0])).toContain("now()::date");
    expect((call![1] as unknown[]).some((p) => p === future)).toBe(false);
  });

  it("records the sale as paid when the order is created already paid", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      actorUserId: "user-9",
      data: { ...cmcData, payment: { method: "cash", status: "paid", currency: "USD" } },
    });

    const call = cmcSaleInsert();

    const sqls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const saleIdx = sqls.findIndex((s) => /INSERT INTO cmc_sales/i.test(s));
    const commitIdx = sqls.findIndex((s) => /^COMMIT$/i.test(s.trim()));
    expect(saleIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(saleIdx);
  });

  it("fails loudly: a cmc_sales insert error rolls back the whole order", async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO cmc_sales/i.test(sql)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      if (/INSERT INTO orders/i.test(sql) && /RETURNING id/i.test(sql)) {
        return { rows: [{ id: "order-1" }] };
      }
      if (/next_number/i.test(sql)) {
        return { rows: [{ next_number: "1001" }] };
      }
      return { rows: [] };
    });

    await expect(
      createManualOrder({ workspaceOwnerId: "ws-1", actorUserId: "user-9", data: cmcData }),
    ).rejects.toThrow("duplicate key");

    const sqls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /^ROLLBACK$/i.test(s.trim()))).toBe(true);
    expect(sqls.some((s) => /^COMMIT$/i.test(s.trim()))).toBe(false);
    // Nothing is broadcast for a rolled-back order.
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
  });
});

describe("createManualOrder contact_id resolution", () => {
  const contactRow = {
    id: "contact-42",
    first_name: "Rima",
    last_name: "K",
    display_name: "Rima K",
    email: "rima@example.com",
    phone: "+96170111222",
  };

  it("links an existing contact by id without calling upsertContact", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] }); // customer lookup

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, customer: { contact_id: "contact-42" }, recipient: null },
    });

    expect(mockUpsertContact).not.toHaveBeenCalled();
    const lookup = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(lookup[0]).toContain("FROM contacts");
    expect(lookup[1]).toEqual(["contact-42", "ws-1"]);

    const linkCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO order_contacts/i.test(String(call[0])),
    );
    expect(linkCall).toBeTruthy();
    expect((linkCall![1] as unknown[])[1]).toBe("contact-42");
  });

  it("merges the loaded contact's fields into the input for downstream side effects", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const customer: CreateOrderData["customer"] = { contact_id: "contact-42" };

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, customer, recipient: null },
    });

    expect(customer!.display_name).toBe("Rima K");
    expect(customer!.phone).toBe("+96170111222");
    expect(customer!.email).toBe("rima@example.com");
  });

  it("throws ContactNotFoundError for a contact_id outside the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      createManualOrder({
        workspaceOwnerId: "ws-1",
        data: { ...baseData, customer: { contact_id: "other-ws-contact" }, recipient: null },
      }),
    ).rejects.toMatchObject({ name: "ContactNotFoundError" });

    // Nothing was written — the failure happens before the transaction.
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("resolves customer by id and recipient by upsert in the same order", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] }); // customer by id
    mockUpsertContact.mockResolvedValueOnce("recip-7"); // recipient upsert

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, customer: { contact_id: "contact-42" } },
    });

    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
    const linkCalls = mockClientQuery.mock.calls
      .filter((c) => /INSERT INTO order_contacts/i.test(String(c[0])))
      .map((c) => c[1] as unknown[]);
    expect(linkCalls.map((p) => p[1])).toEqual(["contact-42", "recip-7"]);
  });

  it("normalizes a selected contact's stored name without changing its link or identity fields", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        ...contactRow,
        first_name: "rima",
        last_name: "k",
        display_name: "rima k",
      }],
    });
    const customer: CreateOrderData["customer"] = { contact_id: "contact-42" };

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: { ...baseData, customer, recipient: null },
    });

    expect(customer).toMatchObject({
      contact_id: "contact-42",
      first_name: "Rima",
      last_name: "K",
      display_name: "Rima K",
      email: "rima@example.com",
      phone: "+96170111222",
    });
    const updateCall = mockDbQuery.mock.calls.find((call) =>
      /UPDATE contacts\s+SET first_name/i.test(String(call[0])),
    );
    expect(updateCall?.[1]).toEqual(["Rima", "K", "Rima K", "contact-42", "ws-1"]);
    const linkCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO order_contacts/i.test(String(call[0])),
    );
    expect((linkCall?.[1] as unknown[])[1]).toBe("contact-42");
  });
});

describe("createManualOrder first-order phone placeholder repair", () => {
  it("triggers the guarded repair for the linked customer after commit", async () => {
    await createManualOrder({ workspaceOwnerId: "ws-1", data: baseData });

    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).toHaveBeenCalledWith({
      workspaceOwnerId: "ws-1",
      contactId: "contact-1",
      orderId: "order-1",
      buyer: {
        firstName: null,
        lastName: null,
        displayName: "Alice Sender",
      },
    });
  });

  it("uses the real submitted name when a selected contact supplies a phone placeholder", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: "contact-42",
        first_name: "+96170000001",
        last_name: null,
        display_name: "+96170000001",
        email: null,
        phone: "+96170000001",
      }],
    });

    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        customer: {
          contact_id: "contact-42",
          first_name: "Rana",
          last_name: "K",
          display_name: "Rana K",
        },
      },
    });

    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "contact-42",
        buyer: { firstName: "Rana", lastName: "K", displayName: "Rana K" },
      }),
    );
  });
});

describe("createManualOrder name normalization", () => {
  it("formats typed contact and gift-card names before upserting and storing them", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        customer: { display_name: "  janah   khadaj  ", phone: "+9613000111" },
        recipient: { first_name: "mary-jane", last_name: "o'connor", phone: "+9613999888" },
        card_from: "  janah  khadaj ",
        card_to: "mary-jane o'connor",
      },
    });

    expect(mockUpsertContact).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ displayName: "Janah Khadaj" }),
    );
    expect(mockUpsertContact).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ firstName: "Mary-Jane", lastName: "O'Connor" }),
    );
    const insertCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO orders/i.test(String(call[0])),
    );
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(["Janah Khadaj", "Mary-Jane O'Connor"]),
    );
  });

  it("uses the same formatter for CMC manual orders and keeps empty or non-Latin values safe", async () => {
    await createManualOrder({
      workspaceOwnerId: "ws-1",
      data: {
        ...baseData,
        source: "cmc-pos",
        customer: { display_name: "layla hassan", phone: "+9613000111" },
        recipient: { display_name: "محمد علي", phone: "+9613999888" },
        card_from: "   ",
        card_to: "محمد علي",
      },
    });

    expect(mockUpsertContact).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ displayName: "Layla Hassan" }),
    );
    expect(mockUpsertContact).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ displayName: "محمد علي" }),
    );
    const insertCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO orders/i.test(String(call[0])),
    );
    expect(insertCall?.[1]).toEqual(expect.arrayContaining([null, "محمد علي"]));
    expect(
      mockClientQuery.mock.calls.some((call) => /INSERT INTO cmc_sales/i.test(String(call[0]))),
    ).toBe(true);
    expect(normalizePersonName(null)).toBeNull();
    expect(normalizePersonName("   ")).toBeNull();
    expect(normalizePersonName("محمد علي")).toBe("محمد علي");
  });
});
