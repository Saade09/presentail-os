import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({
  db: { query: vi.fn() },
}));

const mockSyncApprovedFloristPhotoForOrder = vi.fn().mockResolvedValue(undefined);
vi.mock("../floristTookanPhotoSync", () => ({
  syncApprovedFloristPhotoForOrderToTookan: (...args: unknown[]) =>
    mockSyncApprovedFloristPhotoForOrder(...args),
}));

import {
  formatTookanDatetime,
  createTookanDeliveryTask,
  editTookanDeliveryTask,
  isTookanEnabled,
  getTookanTimezoneOffsetMinutes,
  extractTookanFailurePayload,
  parseDeliveryWindow,
  isOvernightDeliverySlot,
  tookanStatusLabel,
  TOOKAN_OUT_FOR_DELIVERY_STATUSES,
  TOOKAN_STATUS_SUCCESSFUL,
  createTookanStockRequestTask,
  syncTookanBranchRequestStatus,
  retryTookanDeliveryTask,
  TOOKAN_MISSING_ADDRESS_ERROR,
  buildTookanAddressUpdate,
  tookanDestinationsEqual,
  syncTookanDestinationWithClient,
} from "../tookan";
import type { OrderForTookan, RecipientForTookan, LineItemForTookan } from "../tookan";
import { db } from "../db";

const mockDbQuery = vi.mocked(db.query);

const mockOrder: OrderForTookan = {
  id: "test-order-id",
  display_order_number: "LB-1062",
  external_order_id: "EXT-001",
  delivery_address: { address: "123 Main St", district: "Downtown", phone: "+1234567890" },
  window_start: "2025-01-15T10:00:00Z",
  window_end: "2025-01-15T12:00:00Z",
  delivery_instructions: "Leave at door",
  card_message: "Happy Birthday!",
};

const mockRecipient: RecipientForTookan = {
  display_name: "Jane Doe",
  phone: "+9876543210",
  email: "jane@example.com",
};

const mockLineItems: LineItemForTookan[] = [
  { name: "Red Roses Bouquet", quantity: 1 },
  { name: "Chocolate Box", quantity: 2 },
];

describe("isTookanEnabled", () => {
  beforeEach(() => {
    delete process.env.TOOKAN_API_KEY;
    delete process.env.TOOKAN_ENABLED;
  });

  it("returns false when TOOKAN_API_KEY is not set", () => {
    expect(isTookanEnabled()).toBe(false);
  });

  it("returns true when TOOKAN_API_KEY is set", () => {
    process.env.TOOKAN_API_KEY = "test-key";
    expect(isTookanEnabled()).toBe(true);
  });

  it("returns false when TOOKAN_ENABLED=false even with a key", () => {
    process.env.TOOKAN_API_KEY = "test-key";
    process.env.TOOKAN_ENABLED = "false";
    expect(isTookanEnabled()).toBe(false);
  });

  afterEach(() => {
    delete process.env.TOOKAN_API_KEY;
    delete process.env.TOOKAN_ENABLED;
  });
});

describe("formatTookanDatetime", () => {
  it("returns null for null input", () => {
    expect(formatTookanDatetime(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(formatTookanDatetime("")).toBeNull();
  });

  it("returns null for invalid date", () => {
    expect(formatTookanDatetime("not-a-date")).toBeNull();
  });

  it("formats a valid ISO datetime as MM/DD/YYYY HH:mm:ss in UTC by default", () => {
    delete process.env.TOOKAN_TIMEZONE;
    const result = formatTookanDatetime("2025-01-15T10:30:00Z");
    expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
    expect(result).toBe("01/15/2025 10:30:00");
  });
});

describe("createTookanDeliveryTask", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.TOOKAN_API_KEY = "test-api-key-123";
    delete process.env.TOOKAN_BASE_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOOKAN_API_KEY;
    delete process.env.TOOKAN_BASE_URL;
  });

  it("throws when TOOKAN_API_KEY is not configured", async () => {
    delete process.env.TOOKAN_API_KEY;
    await expect(createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems)).rejects.toThrow(
      "TOOKAN_API_KEY is not configured",
    );
  });

  it("calls Tookan API with correct payload and returns jobId + taskId", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        message: "The task has been created",
        data: { job_id: 42, task_id: 99 },
      }),
      status: 200,
    } as Response);

    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          status: 200,
          message: "The task has been created",
          data: { job_id: 42, task_id: 99 },
        }),
        status: 200,
      } as Response;
    });

    const result = await createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems);

    expect(result.jobId).toBe("42");
    expect(result.taskId).toBe("99");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.api_key).toBe("test-api-key-123");
    expect(capturedBody!.order_id).toBe("LB-1062");
    expect(capturedBody!.customer_username).toBe("Jane Doe");
    // Tookan's v2 create_task expects the address under `customer_address`,
    // not `address`.
    expect(capturedBody!.customer_address).toContain("123 Main St");
    expect(capturedBody!.address).toBeUndefined();
    // The required `timezone` field must always be present (numeric minutes).
    expect(typeof capturedBody!.timezone).toBe("number");

    expect(result.debugPayload.api_key).toBeUndefined();
    expect(result.debugPayload.order_id).toBe("LB-1062");
  });

  it("omits latitude/longitude when the order has no coordinates", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ status: 200, data: { job_id: 1, task_id: 2 } }),
        status: 200,
      } as Response;
    });

    await createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems);

    expect(capturedBody!.latitude).toBeUndefined();
    expect(capturedBody!.longitude).toBeUndefined();
  });

  it("includes latitude/longitude only when the order carries coordinates", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ status: 200, data: { job_id: 1, task_id: 2 } }),
        status: 200,
      } as Response;
    });

    const orderWithCoords: OrderForTookan = {
      ...mockOrder,
      delivery_address: { address: "123 Main St", lat: 33.8938, lng: 35.5018 },
    };
    await createTookanDeliveryTask(orderWithCoords, mockRecipient, mockLineItems);

    expect(capturedBody!.latitude).toBe(33.8938);
    expect(capturedBody!.longitude).toBe(35.5018);
  });

  it("falls back to external_order_id then id when display_order_number is missing", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ status: 200, data: { job_id: 1, task_id: 2 } }),
        status: 200,
      } as Response;
    });

    // No display number → use external_order_id
    await createTookanDeliveryTask(
      { ...mockOrder, display_order_number: null },
      mockRecipient,
      mockLineItems,
    );
    expect(capturedBody!.order_id).toBe("EXT-001");

    // No display number and no external_order_id → fall back to internal id
    await createTookanDeliveryTask(
      { ...mockOrder, display_order_number: null, external_order_id: null },
      mockRecipient,
      mockLineItems,
    );
    expect(capturedBody!.order_id).toBe("test-order-id");
  });

  it("attaches the api_key-stripped payload to a thrown error on rejection", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 400,
        message: "Insufficient information was supplied. Please check and try again.",
      }),
    } as Response);

    let caught: unknown;
    try {
      await createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems);
    } catch (err) {
      caught = err;
    }

    const payload = extractTookanFailurePayload(caught);
    expect(payload).not.toBeNull();
    expect(payload!.api_key).toBeUndefined();
    expect(payload!.order_id).toBe("LB-1062");
    expect(payload!.customer_address).toContain("123 Main St");
  });

  it("throws when Tookan API returns a non-200 status code", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ status: 401, message: "Invalid API key" }),
    } as Response);

    await expect(createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems)).rejects.toThrow(
      "Invalid API key",
    );
  });

  it("throws when Tookan API returns status != 200 in body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 400, message: "Invalid address" }),
    } as Response);

    await expect(createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems)).rejects.toThrow(
      "Invalid address",
    );
  });

  it("throws when Tookan returns no job_id", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: {} }),
    } as Response);

    await expect(createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems)).rejects.toThrow(
      "Tookan returned no job_id",
    );
  });

  it("throws on network error with descriptive message", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems)).rejects.toThrow(
      "Tookan network error: ECONNREFUSED",
    );
  });

  it("builds job_description that includes items and the delivery address only", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ status: 200, data: { job_id: 1, task_id: 2 } }),
        status: 200,
      } as Response;
    });

    await createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems);

    const desc = String(capturedBody!.job_description);
    // Items line
    expect(desc).toContain("Red Roses Bouquet");
    expect(desc).toContain("Chocolate Box");
    // Address line (matches the customer_address text sent to Tookan)
    expect(desc).toContain("Address: 123 Main St, Downtown");
    // Instructions line is kept
    expect(desc).toContain("Leave at door");
    // Recipient, slot/time window, and gift/card message must NOT appear
    expect(desc).not.toContain("Jane Doe");
    expect(desc).not.toContain("Recipient:");
    expect(desc).not.toContain("Slot:");
    expect(desc).not.toContain("Happy Birthday!");
    expect(desc).not.toContain("Gift message:");
  });

  it("omits the Address line when the order has no address text", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ status: 200, data: { job_id: 1, task_id: 2 } }),
        status: 200,
      } as Response;
    });

    // Coordinates keep the task past the missing-address guard while the
    // free-text address stays empty.
    const orderNoAddress: OrderForTookan = {
      ...mockOrder,
      delivery_address: { phone: "+1234567890", lat: 33.9, lng: 35.5 },
    };
    await createTookanDeliveryTask(orderNoAddress, mockRecipient, mockLineItems);

    const desc = String(capturedBody!.job_description);
    expect(desc).not.toContain("Address:");
    expect(desc).toContain("Red Roses Bouquet");
  });

  it("works with null recipient", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 200, data: { job_id: 10, task_id: 20 } }),
      status: 200,
    } as Response);

    const result = await createTookanDeliveryTask(mockOrder, null, mockLineItems);
    expect(result.jobId).toBe("10");
  });

  it("uses TOOKAN_BASE_URL env var if set", async () => {
    process.env.TOOKAN_BASE_URL = "https://custom.tookan.io";
    let capturedUrl = "";

    global.fetch = vi.fn().mockImplementation(async (url: unknown) => {
      capturedUrl = String(url);
      return {
        ok: true,
        json: async () => ({ status: 200, data: { job_id: 5, task_id: 6 } }),
        status: 200,
      } as Response;
    });

    await createTookanDeliveryTask(mockOrder, null, []);
    expect(capturedUrl).toContain("custom.tookan.io");
    delete process.env.TOOKAN_BASE_URL;
  });
});

describe("createTookanDeliveryTask missing-address guard", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.TOOKAN_API_KEY = "test-api-key-123";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOOKAN_API_KEY;
  });

  it("skips the Tookan call and throws the actionable error when the order has no address or coordinates", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const noAddressOrder: OrderForTookan = { ...mockOrder, delivery_address: null };
    await expect(
      createTookanDeliveryTask(noAddressOrder, mockRecipient, mockLineItems),
    ).rejects.toThrow(TOOKAN_MISSING_ADDRESS_ERROR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an address object with no address text and no coords as missing", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const emptyAddrOrder: OrderForTookan = {
      ...mockOrder,
      delivery_address: { phone: "+96170123456", date: "2026-08-15", slot: "9am - 12pm" },
    };
    await expect(
      createTookanDeliveryTask(emptyAddrOrder, mockRecipient, mockLineItems),
    ).rejects.toThrow(TOOKAN_MISSING_ADDRESS_ERROR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still calls Tookan when only coordinates (no address text) are present", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 7, task_id: 8 } }),
    } as Response);
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const coordsOnlyOrder: OrderForTookan = {
      ...mockOrder,
      delivery_address: { lat: 33.9, lng: 35.5 },
    };
    const result = await createTookanDeliveryTask(coordsOnlyOrder, mockRecipient, mockLineItems);
    expect(result.jobId).toBe("7");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("creates pickup-carrying tasks when both legs have addresses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 9, task_id: 10 } }),
    } as Response);
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const pickupOrder: OrderForTookan = {
      ...mockOrder,
      pickup: { address: "Main Branch, Beirut", name: "Main Branch" },
    };
    const result = await createTookanDeliveryTask(pickupOrder, mockRecipient, mockLineItems);
    expect(result.jobId).toBe("9");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws an actionable source-branch error when the pickup leg has no address or coordinates", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const pickupOrder: OrderForTookan = {
      ...mockOrder,
      pickup: { address: "", name: "Warehouse" },
    };
    await expect(
      createTookanDeliveryTask(pickupOrder, mockRecipient, mockLineItems),
    ).rejects.toThrow("Source branch 'Warehouse' has no address — add one in Locations and retry");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws an actionable destination-branch error when a pickup-carrying task has no delivery address", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const pickupOrder: OrderForTookan = {
      ...mockOrder,
      delivery_address: null,
      pickup: { address: "Main Branch, Beirut", name: "Main Branch" },
    };
    await expect(
      createTookanDeliveryTask(pickupOrder, { display_name: "Branch B", phone: null, email: null }, mockLineItems),
    ).rejects.toThrow("Destination branch 'Branch B' has no address — add one in Locations and retry");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a pickup leg that carries only coordinates (no address text)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 13, task_id: 14 } }),
    } as Response);
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const pickupOrder: OrderForTookan = {
      ...mockOrder,
      pickup: { address: "", name: "Warehouse", latitude: 33.8, longitude: 35.4 },
    };
    const result = await createTookanDeliveryTask(pickupOrder, mockRecipient, mockLineItems);
    expect(result.jobId).toBe("13");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("marks pickup-leg validation errors with the MISSING_ADDRESS code (retryable)", async () => {
    global.fetch = vi.fn() as unknown as typeof global.fetch;
    const pickupOrder: OrderForTookan = {
      ...mockOrder,
      pickup: { address: "", name: "Warehouse", latitude: 0, longitude: 0 },
    };
    await expect(
      createTookanDeliveryTask(pickupOrder, mockRecipient, mockLineItems),
    ).rejects.toMatchObject({ code: "MISSING_ADDRESS" });
  });

  it("accepts a street line stored under the legacy dashboard key address_1", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, data: { job_id: 21, task_id: 22 } }),
      } as Response;
    });

    const dashboardOrder: OrderForTookan = {
      ...mockOrder,
      delivery_address: { address_1: "45 Bliss Street", city: "Beirut", country: "Lebanon" },
    };
    const result = await createTookanDeliveryTask(dashboardOrder, mockRecipient, mockLineItems);
    expect(result.jobId).toBe("21");
    expect(capturedBody!.customer_address).toContain("45 Bliss Street");
  });

  it("prefers the canonical address key when both address and address_1 exist", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, data: { job_id: 23, task_id: 24 } }),
      } as Response;
    });

    const dualKeyOrder: OrderForTookan = {
      ...mockOrder,
      delivery_address: { address: "Canonical St", address_1: "Legacy St", district: "Achrafieh" },
    };
    await createTookanDeliveryTask(dualKeyOrder, mockRecipient, mockLineItems);
    expect(capturedBody!.customer_address).toBe("Canonical St, Achrafieh");
  });

  it("still treats city/country-only addresses as missing", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const cityOnlyOrder: OrderForTookan = {
      ...mockOrder,
      delivery_address: { city: "Beirut", country: "Lebanon", phone: "+96170123456" },
    };
    await expect(
      createTookanDeliveryTask(cityOnlyOrder, mockRecipient, mockLineItems),
    ).rejects.toThrow(TOOKAN_MISSING_ADDRESS_ERROR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("syncs normally when both address and window are present (unchanged behavior)", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, data: { job_id: 11, task_id: 12 } }),
      } as Response;
    });

    const result = await createTookanDeliveryTask(mockOrder, mockRecipient, mockLineItems);
    expect(result.jobId).toBe("11");
    expect(capturedBody!.customer_address).toContain("123 Main St");
    expect(capturedBody!.job_delivery_datetime).toBeTruthy();
  });
});

describe("Tookan destination synchronization", () => {
  beforeEach(() => {
    process.env.TOOKAN_API_KEY = "test-api-key-123";
    delete process.env.TOOKAN_BASE_URL;
  });

  afterEach(() => {
    delete process.env.TOOKAN_API_KEY;
    delete process.env.TOOKAN_BASE_URL;
  });

  it("normalizes legacy address and coordinate aliases", () => {
    expect(buildTookanAddressUpdate({
      address_1: "45 Bliss Street",
      district: "Hamra",
      lat: "33.8938",
      lng: "35.5018",
    })).toEqual({
      address: "45 Bliss Street, Hamra",
      latitude: 33.8938,
      longitude: 35.5018,
    });
    expect(tookanDestinationsEqual(
      { address: "45 Bliss Street", latitude: 33.8938, longitude: 35.5018 },
      { address_1: "45 Bliss Street", lat: "33.8938", lng: "35.5018" },
    )).toBe(true);
  });

  it("reloads the canonical destination and preserves its current delivery window", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200 }),
      } as Response;
    });
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          tookan_job_id: "job-42",
          window_start: "2026-08-15T09:00:00Z",
          delivery_address: {
            address_1: "45 Bliss Street",
            district: "Hamra",
            latitude: 33.8938,
            longitude: 35.5018,
          },
        }],
      }),
    };

    await expect(
      syncTookanDestinationWithClient(client, "order-42", "workspace-42"),
    ).resolves.toBe("updated");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("workspace_owner_id = $2"),
      ["order-42", "workspace-42"],
    );
    expect(capturedBody).toMatchObject({
      job_id: "job-42",
      customer_address: "45 Bliss Street, Hamra",
      latitude: 33.8938,
      longitude: 35.5018,
      job_delivery_datetime: "08/15/2026 09:00:00",
    });
  });

  it("does not call Tookan when the order has no existing task or usable destination", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ tookan_job_id: null, window_start: null, delivery_address: { address: "A" } }] })
        .mockResolvedValueOnce({ rows: [{ tookan_job_id: "job-1", window_start: null, delivery_address: { city: "Beirut" } }] }),
    };

    await expect(syncTookanDestinationWithClient(client, "order-1", "workspace-1"))
      .resolves.toBe("skipped");
    await expect(syncTookanDestinationWithClient(client, "order-1", "workspace-1"))
      .resolves.toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("retryTookanDeliveryTask address recovery", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    originalFetch = global.fetch;
    process.env.TOOKAN_API_KEY = "test-api-key-123";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOOKAN_API_KEY;
  });

  function stubOrderRows(deliveryAddress: Record<string, unknown> | null) {
    // SQL-keyed implementation (not index-based) so best-effort queries like
    // recordTookanInvitationComm can't shift call counts.
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM orders WHERE id")) {
        return {
          rows: [
            {
              id: "order-1",
              display_order_number: "M-1057",
              external_order_id: null,
              delivery_address: deliveryAddress,
              window_start: "2026-08-15T09:00:00Z",
              window_end: "2026-08-15T12:00:00Z",
              delivery_instructions: null,
              card_message: null,
              tookan_job_id: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("order_contacts")) {
        return {
          rows: [{ display_name: "Jane Doe", phone: "+96170000000", email: null }],
          rowCount: 1,
        };
      }
      if (sql.includes("order_line_items")) {
        return { rows: [{ name: "Roses", quantity: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it("persists the actionable missing-address error without calling Tookan", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    stubOrderRows(null);

    await expect(retryTookanDeliveryTask("order-1", "owner-1")).rejects.toThrow(
      TOOKAN_MISSING_ADDRESS_ERROR,
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    const failUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("tookan_status = 'failed'"),
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate![1][0]).toBe(TOOKAN_MISSING_ADDRESS_ERROR);
  });

  it("succeeds once the order carries an address", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 42, task_id: 43 } }),
    } as Response);
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    stubOrderRows({ address: "Hamra Street, Beirut" });

    await expect(retryTookanDeliveryTask("order-1", "owner-1")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const successUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("tookan_status    = 'created'"),
    );
    expect(successUpdate).toBeDefined();
    expect(successUpdate![1][0]).toBe("42");
    await vi.waitFor(() => {
      expect(mockSyncApprovedFloristPhotoForOrder).toHaveBeenCalledWith("order-1", "owner-1");
    });
  });

  it("succeeds on retry for legacy rows whose street line is stored under address_1", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 44, task_id: 45 } }),
    } as Response);
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    stubOrderRows({ address_1: "45 Bliss Street", city: "Beirut", country: "Lebanon" });

    await expect(retryTookanDeliveryTask("order-1", "owner-1")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const legacySuccessUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("tookan_status    = 'created'"),
    );
    expect(legacySuccessUpdate).toBeDefined();
  });
});

describe("editTookanDeliveryTask", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.TOOKAN_API_KEY = "test-api-key-123";
    delete process.env.TOOKAN_BASE_URL;
    delete process.env.TOOKAN_TIMEZONE;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOOKAN_API_KEY;
    delete process.env.TOOKAN_BASE_URL;
  });

  it("throws when TOOKAN_API_KEY is not configured", async () => {
    delete process.env.TOOKAN_API_KEY;
    await expect(
      editTookanDeliveryTask("42", "2025-01-15T10:00:00Z"),
    ).rejects.toThrow("TOOKAN_API_KEY is not configured");
  });

  it("throws when window_start is null/invalid", async () => {
    await expect(editTookanDeliveryTask("42", null)).rejects.toThrow(
      /invalid or missing window_start/i,
    );
  });

  it("POSTs edit_task with job_id and reformatted job_delivery_datetime", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (url: unknown, opts: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, message: "Task updated" }),
      } as Response;
    });

    await editTookanDeliveryTask("42", "2025-01-15T14:30:00Z");

    expect(capturedUrl).toContain("/v2/edit_task");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.api_key).toBe("test-api-key-123");
    expect(capturedBody!.job_id).toBe("42");
    expect(capturedBody!.job_delivery_datetime).toBe("01/15/2025 14:30:00");
  });

  it("sends public reference images without requiring a delivery datetime", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, message: "Task updated" }),
      } as Response;
    });

    const imageUrl =
      "https://os.presentail.com/api/storage/public-objects/florist-orders/owner/order/prepared-order-rev-4.jpg";
    await editTookanDeliveryTask("42", null, { referenceImages: [imageUrl] });

    expect(capturedBody).toEqual({
      api_key: "test-api-key-123",
      job_id: "42",
      ref_images: [imageUrl],
    });
  });

  it("surfaces Tookan errors when updating reference images", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 400, message: "Reference image is invalid" }),
    } as Response);

    await expect(
      editTookanDeliveryTask("42", null, {
        referenceImages: ["https://example.com/prepared.jpg"],
      }),
    ).rejects.toThrow("Reference image is invalid");
  });

  it("throws when Tookan returns a non-200 body status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 404, message: "Job not found" }),
    } as Response);

    await expect(
      editTookanDeliveryTask("999", "2025-01-15T10:00:00Z"),
    ).rejects.toThrow("Job not found");
  });

  it("throws on network error with a descriptive message", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      editTookanDeliveryTask("42", "2025-01-15T10:00:00Z"),
    ).rejects.toThrow("Tookan network error: ECONNREFUSED");
  });

  it("includes customer_address, latitude, longitude when addressOpts are provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, message: "Task updated" }),
      } as Response;
    });

    await editTookanDeliveryTask("77", "2025-01-15T14:00:00Z", {
      address: "Hamra Street, Beirut",
      latitude: 33.8938,
      longitude: 35.5018,
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.job_id).toBe("77");
    expect(capturedBody!.job_delivery_datetime).toBe("01/15/2025 14:00:00");
    expect(capturedBody!.customer_address).toBe("Hamra Street, Beirut");
    expect(capturedBody!.latitude).toBe(33.8938);
    expect(capturedBody!.longitude).toBe(35.5018);
  });

  it("omits job_delivery_datetime when windowStart is null but addressOpts are provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, message: "Task updated" }),
      } as Response;
    });

    await editTookanDeliveryTask("99", null, {
      address: "Achrafieh, Beirut",
      latitude: 33.883,
      longitude: 35.513,
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.job_id).toBe("99");
    expect(capturedBody!.job_delivery_datetime).toBeUndefined();
    expect(capturedBody!.customer_address).toBe("Achrafieh, Beirut");
    expect(capturedBody!.latitude).toBe(33.883);
    expect(capturedBody!.longitude).toBe(35.513);
  });

  it("still throws when windowStart is null and no addressOpts are provided", async () => {
    await expect(editTookanDeliveryTask("42", null)).rejects.toThrow(
      /invalid or missing window_start/i,
    );
  });
});

describe("getTookanTimezoneOffsetMinutes", () => {
  afterEach(() => {
    delete process.env.TOOKAN_TIMEZONE;
  });

  it("returns 0 for UTC (the default)", () => {
    delete process.env.TOOKAN_TIMEZONE;
    expect(getTookanTimezoneOffsetMinutes(new Date("2026-06-30T12:00:00Z"))).toBe(0);
  });

  it("returns the getTimezoneOffset-style negative offset for a zone ahead of UTC", () => {
    // Asia/Beirut is GMT+3 in summer → JS getTimezoneOffset convention is -180.
    process.env.TOOKAN_TIMEZONE = "Asia/Beirut";
    expect(getTookanTimezoneOffsetMinutes(new Date("2026-06-30T12:00:00Z"))).toBe(-180);
  });

  it("falls back to 0 for an unrecognized zone", () => {
    process.env.TOOKAN_TIMEZONE = "Not/AZone";
    expect(getTookanTimezoneOffsetMinutes(new Date("2026-06-30T12:00:00Z"))).toBe(0);
  });
});

describe("extractTookanFailurePayload", () => {
  it("returns null when the error carries no payload", () => {
    expect(extractTookanFailurePayload(new Error("boom"))).toBeNull();
    expect(extractTookanFailurePayload(null)).toBeNull();
    expect(extractTookanFailurePayload("just a string")).toBeNull();
  });

  it("returns the attached debugPayload object", () => {
    const err = Object.assign(new Error("boom"), { debugPayload: { order_id: "x" } });
    expect(extractTookanFailurePayload(err)).toEqual({ order_id: "x" });
  });
});

describe("parseDeliveryWindow (retry/backfill window derivation)", () => {
  it("returns null window when no date is provided", () => {
    expect(parseDeliveryWindow(null, "9:00 AM–2:00 PM")).toEqual({
      window_start: null,
      window_end: null,
    });
  });

  it("derives a non-empty job_delivery_datetime from a stored date + slot", () => {
    // Mirrors affected orders: date/slot live in delivery_address JSON.
    const { window_start, window_end } = parseDeliveryWindow("2026-06-29", "9:00 AM–2:00 PM");
    expect(window_start).not.toBeNull();
    expect(window_end).not.toBeNull();
    expect(formatTookanDatetime(window_start)).toBe("06/29/2026 09:00:00");
    expect(formatTookanDatetime(window_end)).toBe("06/29/2026 14:00:00");
  });

  it("derives a start time even when only a date (no slot) is present", () => {
    const { window_start } = parseDeliveryWindow("2026-06-29", null);
    expect(window_start).not.toBeNull();
    expect(formatTookanDatetime(window_start)).not.toBeNull();
  });

  it("places the end of an overnight slot on the following calendar day", () => {
    const { window_start, window_end } = parseDeliveryWindow(
      "2026-06-29",
      "11:00 PM - 1:00 AM",
    );
    expect(window_start).toBe("2026-06-29T23:00:00.000Z");
    expect(window_end).toBe("2026-06-30T01:00:00.000Z");
    expect(isOvernightDeliverySlot("11:00 PM - 1:00 AM")).toBe(true);
    expect(isOvernightDeliverySlot("23:00–01:00")).toBe(true);
  });

  it("does not move the end date for daytime slots", () => {
    const { window_start, window_end } = parseDeliveryWindow("2026-06-29", "9:00 AM–2:00 PM");
    expect(window_start).toBe("2026-06-29T09:00:00.000Z");
    expect(window_end).toBe("2026-06-29T14:00:00.000Z");
    expect(isOvernightDeliverySlot("9:00 AM–2:00 PM")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTookanStockRequestTask
// ─────────────────────────────────────────────────────────────────────────────

describe("createTookanStockRequestTask", () => {
  let originalFetch: typeof global.fetch;

  const BASE_CLAIM_ROW = {
    id: "req-abc",
    needed_by: "2025-06-15T14:30:00Z",
    destination_location_id: 10,
    source_location_id: 20,
  };

  const DEST_ROW = { name: "Branch A", address: "456 Branch Rd", latitude: 33.9, longitude: 35.5 };
  const SRC_ROW = { name: "Warehouse", address: "1 Warehouse Ave", latitude: 33.8, longitude: 35.4 };

  function mockFetchSuccess(jobId = 77, taskId = 88) {
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, data: { job_id: jobId, task_id: taskId }, _capturedBody: body }),
      } as unknown as Response;
    });
  }

  /** Set up db.query to return the four standard calls in order. */
  function mockDbHappyPath(claimRow = BASE_CLAIM_ROW) {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [claimRow], rowCount: 1 } as never) // claim UPDATE
      .mockResolvedValueOnce({ rows: [{ name: "Roses", requested_qty: 3 }], rowCount: 1 } as never) // line items
      .mockResolvedValueOnce({ rows: [DEST_ROW], rowCount: 1 } as never) // dest location
      .mockResolvedValueOnce({ rows: [SRC_ROW], rowCount: 1 } as never) // src location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // final UPDATE tookan_job_id
  }

  beforeEach(() => {
    originalFetch = global.fetch;
    mockDbQuery.mockReset();
    process.env.TOOKAN_API_KEY = "test-key";
    delete process.env.TOOKAN_TIMEZONE;
    delete process.env.TOOKAN_BASE_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOOKAN_API_KEY;
    delete process.env.TOOKAN_TIMEZONE;
  });

  it("sends job_delivery_datetime in MM/DD/YYYY HH:mm:ss format derived from needed_by (UTC)", async () => {
    mockDbHappyPath();
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true, status: 200,
        json: async () => ({ status: 200, data: { job_id: 77, task_id: 88 } }),
      } as Response;
    });

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(true);
    // needed_by is 2025-06-15T14:30:00Z → UTC → "06/15/2025 14:30:00"
    expect(capturedBody!.job_delivery_datetime).toBe("06/15/2025 14:30:00");
  });

  it("applies TOOKAN_TIMEZONE when formatting needed_by", async () => {
    // Asia/Beirut in summer is UTC+3 → 14:30 UTC = 17:30 local
    process.env.TOOKAN_TIMEZONE = "Asia/Beirut";
    mockDbHappyPath();
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true, status: 200,
        json: async () => ({ status: 200, data: { job_id: 77, task_id: 88 } }),
      } as Response;
    });

    await createTookanStockRequestTask("req-abc", "ws-1");

    // 14:30 UTC should become 17:30 in Asia/Beirut (UTC+3 in summer)
    expect(capturedBody!.job_delivery_datetime).toBe("06/15/2025 17:30:00");
  });

  it("sends job_pickup_* fields (Tookan field names) when a source location is present", async () => {
    process.env.TOOKAN_DEFAULT_PHONE = "+96170000000";
    mockDbHappyPath();
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true, status: 200,
        json: async () => ({ status: 200, data: { job_id: 77, task_id: 88 } }),
      } as Response;
    });

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(true);
    expect(capturedBody!.has_pickup).toBe(1);
    expect(capturedBody!.job_pickup_address).toBe("1 Warehouse Ave");
    expect(capturedBody!.job_pickup_name).toBe("Warehouse");
    expect(capturedBody!.job_pickup_phone).toBe("+96170000000");
    expect(capturedBody!.job_pickup_datetime).toBe("06/15/2025 14:30:00");
    expect(capturedBody!.job_pickup_latitude).toBe(33.8);
    expect(capturedBody!.job_pickup_longitude).toBe(35.4);
    // Legacy (ignored-by-Tookan) field names must NOT be sent
    expect(capturedBody!.pickup_address).toBeUndefined();
    expect(capturedBody!.pickup_name).toBeUndefined();
    expect(capturedBody!.pickup_datetime).toBeUndefined();
    delete process.env.TOOKAN_DEFAULT_PHONE;
  });

  it("falls back to a near-future non-empty datetime when needed_by is null and a pickup exists", async () => {
    const claimRow = { ...BASE_CLAIM_ROW, needed_by: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [claimRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ name: "Roses", requested_qty: 2 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [DEST_ROW], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [SRC_ROW], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true, status: 200,
        json: async () => ({ status: 200, data: { job_id: 77, task_id: 88 } }),
      } as Response;
    });

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(true);
    // has_pickup tasks are rejected by Tookan with empty datetimes, so a
    // near-future fallback is applied — both datetimes must be non-empty and
    // in Tookan's MM/DD/YYYY HH:mm:ss format.
    const DT_RE = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/;
    expect(capturedBody!.job_delivery_datetime).toMatch(DT_RE);
    expect(capturedBody!.job_pickup_datetime).toMatch(DT_RE);
  });

  it("returns the actionable source-branch error (and releases the sentinel) when the source location has no address or coordinates", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [BASE_CLAIM_ROW], rowCount: 1 } as never) // claim
      .mockResolvedValueOnce({ rows: [{ name: "Roses", requested_qty: 1 }], rowCount: 1 } as never) // line items
      .mockResolvedValueOnce({ rows: [DEST_ROW], rowCount: 1 } as never) // dest
      .mockResolvedValueOnce({ rows: [{ name: "Warehouse", address: null, latitude: null, longitude: null }], rowCount: 1 } as never) // src (no address)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // sentinel release
    global.fetch = vi.fn();

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Source branch 'Warehouse' has no address — add one in Locations and retry",
    );
    expect(global.fetch).not.toHaveBeenCalled();
    // Sentinel-release UPDATE must run so the request remains retryable
    const releaseCall = mockDbQuery.mock.calls[4];
    expect(String(releaseCall[0])).toMatch(/tookan_job_id = NULL/);
  });

  it("returns the actionable destination-branch error when the destination location has no address or coordinates", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [BASE_CLAIM_ROW], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ name: "Roses", requested_qty: 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ name: "Branch A", address: "", latitude: null, longitude: null }], rowCount: 1 } as never) // dest (no address)
      .mockResolvedValueOnce({ rows: [SRC_ROW], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // sentinel release
    global.fetch = vi.fn();

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Destination branch 'Branch A' has no address — add one in Locations and retry",
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns { ok: false } without calling fetch when slot is already claimed (rowCount = 0)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    global.fetch = vi.fn();

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/slot already claimed/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("releases the sentinel and returns { ok: false } when Tookan API returns a validation error", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [BASE_CLAIM_ROW], rowCount: 1 } as never) // claim
      .mockResolvedValueOnce({ rows: [{ name: "Roses", requested_qty: 1 }], rowCount: 1 } as never) // line items
      .mockResolvedValueOnce({ rows: [DEST_ROW], rowCount: 1 } as never) // dest
      .mockResolvedValueOnce({ rows: [SRC_ROW], rowCount: 1 } as never) // src
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // sentinel release

    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: 400, message: "Incorrect date format. Please use as (MM/DD/YYYY) mm:ss" }),
    } as Response);

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(false);
    // Sentinel-release UPDATE should be called (5th db.query call)
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
    const releaseCall = mockDbQuery.mock.calls[4];
    expect(String(releaseCall[0])).toMatch(/tookan_job_id = NULL/);
  });

  it("sets has_pickup = 0 and omits pickup fields when source_location_id is null", async () => {
    const claimRow = { ...BASE_CLAIM_ROW, source_location_id: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [claimRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ name: "Candles", requested_qty: 5 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [DEST_ROW], rowCount: 1 } as never)
      // no 4th query for src location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // final UPDATE

    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true, status: 200,
        json: async () => ({ status: 200, data: { job_id: 99, task_id: 100 } }),
      } as Response;
    });

    const result = await createTookanStockRequestTask("req-abc", "ws-1");

    expect(result.ok).toBe(true);
    expect(capturedBody!.has_pickup).toBe(0);
    expect(capturedBody!.job_pickup_address).toBeUndefined();
    expect(capturedBody!.job_pickup_name).toBeUndefined();
    expect(capturedBody!.job_pickup_datetime).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// syncTookanBranchRequestStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("syncTookanBranchRequestStatus", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("transitions submitted → dispatched for Tookan status 0 (assigned) and writes audit event", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "req-1", status: "submitted", workspace_owner_id: "ws-1" }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT event

    const result = await syncTookanBranchRequestStatus("job-111", 0);

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("dispatched");
    expect(result.previousStatus).toBe("submitted");
    expect(result.requestId).toBe("req-1");
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    // Second call should be the UPDATE
    const updateCall = mockDbQuery.mock.calls[1];
    expect(String(updateCall[0])).toMatch(/UPDATE cmc_requests/);
    expect(updateCall[1]).toContain("dispatched");
    // Third call should be the INSERT audit event
    const insertCall = mockDbQuery.mock.calls[2];
    expect(String(insertCall[0])).toMatch(/INSERT INTO cmc_request_events/);
  });

  it("transitions accepted → dispatched for Tookan status 7 (accepted)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "req-2", status: "accepted", workspace_owner_id: "ws-1" }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await syncTookanBranchRequestStatus("job-222", 7);

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("dispatched");
  });

  it("transitions dispatched → received for Tookan status 2 (successful)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "req-3", status: "dispatched", workspace_owner_id: "ws-1" }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await syncTookanBranchRequestStatus("job-333", 2);

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBe("received");
  });

  it("returns matched:true, newStatus:null for a terminal (received) request without issuing an UPDATE", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "req-4", status: "received", workspace_owner_id: "ws-1" }], rowCount: 1 } as never);

    const result = await syncTookanBranchRequestStatus("job-444", 2);

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBeNull();
    // Only the SELECT — no UPDATE or INSERT
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns matched:false when no request matches the tookan_job_id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await syncTookanBranchRequestStatus("job-nope", 0);

    expect(result.matched).toBe(false);
    expect(result.newStatus).toBeNull();
    expect(result.requestId).toBeNull();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("ignores out-of-order status 0 when request is already dispatched (newStatus null, no UPDATE)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "req-5", status: "dispatched", workspace_owner_id: "ws-1" }], rowCount: 1 } as never);

    const result = await syncTookanBranchRequestStatus("job-555", 0);

    expect(result.matched).toBe(true);
    expect(result.newStatus).toBeNull();
    // No UPDATE or INSERT issued
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });
});

describe("Tookan status → order status mapping", () => {
  it("treats the full assignment family (assigned/started/in_progress/accepted) as out_for_delivery", () => {
    // assigned (0), started (1), in_progress (4), accepted (7)
    expect([...TOOKAN_OUT_FOR_DELIVERY_STATUSES].sort((a, b) => a - b)).toEqual([0, 1, 4, 7]);
    for (const code of [0, 1, 4, 7]) {
      expect(TOOKAN_OUT_FOR_DELIVERY_STATUSES.has(code)).toBe(true);
    }
  });

  it("does not fold the successful code into the out_for_delivery family", () => {
    expect(TOOKAN_STATUS_SUCCESSFUL).toBe(2);
    expect(TOOKAN_OUT_FOR_DELIVERY_STATUSES.has(TOOKAN_STATUS_SUCCESSFUL)).toBe(false);
  });

  it("maps each assignment-family code to a stable human-readable label", () => {
    expect(tookanStatusLabel(0)).toBe("assigned");
    expect(tookanStatusLabel(1)).toBe("started");
    expect(tookanStatusLabel(4)).toBe("in_progress");
    expect(tookanStatusLabel(7)).toBe("accepted");
    expect(tookanStatusLabel(2)).toBe("successful");
  });
});
