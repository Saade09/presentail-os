/**
 * Unit tests for createTookanReturnTask.
 *
 * Verifies that when a CMC return is submitted, the outgoing Tookan payload:
 *   (a) includes the return line items in job_description
 *   (b) uses the return-to location address as customer_address (delivery destination)
 *   (c) derives job_delivery_datetime from collection_date
 *
 * DB calls and the Tookan HTTP API are both mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports — vi.hoisted ensures the mock factories run
// before module evaluation so the modules see the mocked versions.
// ---------------------------------------------------------------------------

const { mockDb } = vi.hoisted(() => {
  const mockDb = { query: vi.fn() };
  return { mockDb };
});

vi.mock("../db", () => ({ db: mockDb }));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createTookanReturnTask } from "../tookan";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DbMockOptions {
  locationAddress?: string;
  locationLat?: number | null;
  locationLng?: number | null;
  collectionDate?: string | Date;
  lineItems?: Array<{ name_snapshot: string; quantity: number }>;
}

/**
 * Configure mockDb.query to return realistic values for the four DB calls
 * inside createTookanReturnTask:
 *   1. UPDATE cmc_returns … RETURNING (claim sentinel)
 *   2. SELECT name_snapshot, quantity FROM cmc_return_line_items
 *   3. SELECT name, address, latitude, longitude FROM locations
 *   4. UPDATE cmc_returns … (persist job/task IDs)
 */
function setupDbMocks(opts: DbMockOptions = {}) {
  const {
    locationAddress = "CMC Hospital, Gemayze, Beirut",
    locationLat = 33.8938,
    locationLng = 35.5018,
    collectionDate = "2026-09-01",
    lineItems = [
      { name_snapshot: "Red Rose Bouquet", quantity: 3 },
      { name_snapshot: "White Lily", quantity: 1 },
    ],
  } = opts;

  mockDb.query
    // 1) Claim sentinel — rowCount > 0 means we got the slot
    .mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "ret-001", collection_date: collectionDate, return_to_location_id: 42 }],
    })
    // 2) Line items
    .mockResolvedValueOnce({ rows: lineItems })
    // 3) Return-to location
    .mockResolvedValueOnce({
      rows: [{ name: "CMC HQ", address: locationAddress, latitude: locationLat, longitude: locationLng }],
    })
    // 4) Persist job / task IDs
    .mockResolvedValueOnce({ rowCount: 1, rows: [] });
}

/** Installs a fetch mock that captures the request body and returns success. */
function makeFetchCapture(): { body: Record<string, unknown> | null } {
  const capture: { body: Record<string, unknown> | null } = { body: null };
  global.fetch = vi.fn().mockImplementation(async (_url: unknown, opts: RequestInit) => {
    capture.body = JSON.parse(opts.body as string) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 77, task_id: 88 } }),
    } as Response;
  });
  return capture;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTookanReturnTask", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
    process.env.TOOKAN_API_KEY = "test-api-key-123";
    delete process.env.TOOKAN_BASE_URL;
    delete process.env.TOOKAN_TIMEZONE;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TOOKAN_API_KEY;
  });

  it("includes return line items in the Tookan job_description", async () => {
    setupDbMocks({
      lineItems: [
        { name_snapshot: "Red Rose Bouquet", quantity: 3 },
        { name_snapshot: "White Lily", quantity: 1 },
      ],
    });
    const capture = makeFetchCapture();

    await createTookanReturnTask("ret-001", "ws-owner");

    expect(capture.body).not.toBeNull();
    const desc = String(capture.body!.job_description);
    expect(desc).toContain("Red Rose Bouquet");
    expect(desc).toContain("White Lily");
    // The Items: prefix is added by createTookanDeliveryTask
    expect(desc).toContain("Items:");
  });

  it("uses the return-to location address as customer_address (delivery destination)", async () => {
    setupDbMocks({ locationAddress: "Gemayze Street, Beirut District" });
    const capture = makeFetchCapture();

    await createTookanReturnTask("ret-001", "ws-owner");

    expect(String(capture.body!.customer_address)).toContain("Gemayze Street, Beirut District");
  });

  it("derives job_delivery_datetime from collection_date", async () => {
    setupDbMocks({ collectionDate: "2026-09-15" });
    const capture = makeFetchCapture();

    await createTookanReturnTask("ret-001", "ws-owner");

    // Tookan datetime format is MM/DD/YYYY HH:mm:ss — date portion must match collection_date
    const dt = String(capture.body!.job_delivery_datetime);
    expect(dt).toMatch(/^09\/15\/2026/);
  });

  it("derives job_delivery_datetime when collection_date is a JS Date object (drizzle `date` driver type)", async () => {
    // node-postgres/drizzle can hand `date` columns back as a Date at local midnight
    setupDbMocks({ collectionDate: new Date(2026, 7, 13) }); // Aug 13, 2026 local
    const capture = makeFetchCapture();

    await createTookanReturnTask("ret-001", "ws-owner");

    const dt = String(capture.body!.job_delivery_datetime);
    expect(dt).toMatch(/^08\/13\/2026/);
  });

  it("derives job_delivery_datetime when collection_date is an ISO timestamp string", async () => {
    setupDbMocks({ collectionDate: "2026-08-13T00:00:00.000Z" });
    const capture = makeFetchCapture();

    await createTookanReturnTask("ret-001", "ws-owner");

    const dt = String(capture.body!.job_delivery_datetime);
    expect(dt).toMatch(/^08\/13\/2026/);
  });

  it("passes location coordinates to the Tookan payload when present", async () => {
    setupDbMocks({ locationLat: 33.8938, locationLng: 35.5018 });
    const capture = makeFetchCapture();

    await createTookanReturnTask("ret-001", "ws-owner");

    expect(capture.body!.latitude).toBe(33.8938);
    expect(capture.body!.longitude).toBe(35.5018);
  });

  it("persists the job_id and task_id returned by Tookan onto cmc_returns", async () => {
    setupDbMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, data: { job_id: 77, task_id: 88 } }),
    } as Response);

    await createTookanReturnTask("ret-001", "ws-owner");

    // Find the UPDATE that writes the job and task IDs back (4th call)
    const persistCall = mockDb.query.mock.calls.find(
      ([sql]: [string]) =>
        /UPDATE\s+cmc_returns/i.test(sql) &&
        /tookan_job_id\s*=\s*\$1/i.test(sql),
    );
    expect(persistCall).toBeDefined();
    const [, params] = persistCall as [string, unknown[]];
    expect(params[0]).toBe("77"); // job_id
    expect(params[1]).toBe("88"); // task_id
  });

  it("skips Tookan call when the return slot is already claimed (rowCount = 0)", async () => {
    // Claim query returns no rows → another caller already owns the slot
    mockDb.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    global.fetch = vi.fn();

    await createTookanReturnTask("ret-already-claimed", "ws-owner");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("releases the sentinel (sets tookan_job_id = NULL) on Tookan API failure", async () => {
    setupDbMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ status: 400, message: "Invalid address" }),
    } as Response);

    // createTookanReturnTask is fire-and-forget — it swallows the error
    await expect(createTookanReturnTask("ret-001", "ws-owner")).resolves.toBeUndefined();

    // The sentinel-release UPDATE (tookan_job_id = NULL) should have been called
    const releaseCall = mockDb.query.mock.calls.find(
      ([sql]: [string]) =>
        /UPDATE\s+cmc_returns/i.test(sql) &&
        /tookan_job_id\s*=\s*NULL/i.test(sql),
    );
    expect(releaseCall).toBeDefined();
  });
});
