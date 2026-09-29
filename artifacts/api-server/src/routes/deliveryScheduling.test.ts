import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbConnect = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockFireDeliveryWebhookAsync = vi.fn();
const mockFireDeliveryConfigUpdated = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/deliveryWebhook", () => ({
  fireDeliveryWebhookAsync: (...args: unknown[]) => mockFireDeliveryWebhookAsync(...args),
  fireDeliveryConfigUpdated: (...args: unknown[]) => mockFireDeliveryConfigUpdated(...args),
}));

import router, {
  dedupeWeeklySlots,
  weeklySlotNaturalKey,
} from "./deliveryScheduling";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(router);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Shared slot fixture
// ---------------------------------------------------------------------------

const SLOT_ROW = {
  id: 1,
  city_id: 10,
  day_of_week: 1,
  label: "Morning",
  start_time: "09:00",
  end_time: "12:00",
  is_enabled: true,
  fee_override: null,
  cutoff_time: null,
  capacity: null,
  internal_note: null,
  sort_order: 0,
  delivery_type: "standard",
  same_day_available: false,
  next_day_available: true,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: null,
};

// ---------------------------------------------------------------------------
// SQL-keyed mock helper
//
// Matches each db.query() call against the first snippet in the provided
// entries whose string appears in the SQL text, and returns its result.
// This makes tests resilient to extra DB calls being inserted before or after
// the calls under test — unlike purely positional mockResolvedValueOnce.
// ---------------------------------------------------------------------------

type MockResult = { rows: unknown[]; rowCount: number };

function buildSqlMock(
  entries: Array<[snippet: string, result: MockResult]>,
): (sql: string, _params?: unknown[]) => Promise<MockResult> {
  return (sql: string) => {
    for (const [snippet, result] of entries) {
      if (sql.includes(snippet)) {
        return Promise.resolve(result);
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
});

// ---------------------------------------------------------------------------
// POST /cities/:id/weekly-slots — create
// ---------------------------------------------------------------------------

describe("POST /cities/:id/weekly-slots", () => {
  it("fires the delivery webhook after creating a slot", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // City ownership check (getCityOwner)
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      // Next sort_order SELECT
      ["COALESCE(MAX(sort_order)", { rows: [{ next: 0 }], rowCount: 1 }],
      // INSERT RETURNING
      ["INSERT INTO district_weekly_delivery_slots", { rows: [SLOT_ROW], rowCount: 1 }],
    ]));

    const res = await request(app)
      .post("/cities/10/weekly-slots")
      .send({ day_of_week: 1, start_time: "09:00", end_time: "12:00" });

    expect(res.status).toBe(201);
    expect(res.body.slot).toBeDefined();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });

  it("returns a conflict when the database rejects a concurrent duplicate", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      ["COALESCE(MAX(sort_order)", { rows: [{ next: 0 }], rowCount: 1 }],
    ]));
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("delivery_cities")) return { rows: [{ id: 10 }], rowCount: 1 };
      if (sql.includes("COALESCE(MAX(sort_order)")) return { rows: [{ next: 0 }], rowCount: 1 };
      if (sql.includes("INSERT INTO district_weekly_delivery_slots")) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .post("/cities/10/weekly-slots")
      .send({ day_of_week: 1, start_time: "9:00", end_time: "12:00" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(mockFireDeliveryWebhookAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /cities/:id/weekly-slots/:slotId — update
// ---------------------------------------------------------------------------

describe("PATCH /cities/:id/weekly-slots/:slotId", () => {
  it("fires the delivery webhook after updating a slot", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // City ownership check (getCityOwner) — only query hitting delivery_cities
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      // Existing slot SELECT — the route uses SLOT_COLS which starts with "id, city_id, day_of_week"
      ["id, city_id, day_of_week", { rows: [SLOT_ROW], rowCount: 1 }],
      // UPDATE RETURNING
      ["UPDATE district_weekly_delivery_slots", { rows: [{ ...SLOT_ROW, label: "Updated" }], rowCount: 1 }],
    ]));

    const res = await request(app)
      .patch("/cities/10/weekly-slots/1")
      .send({ label: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.slot).toBeDefined();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });
});

// ---------------------------------------------------------------------------
// DELETE /cities/:id/weekly-slots/:slotId — delete
// ---------------------------------------------------------------------------

describe("DELETE /cities/:id/weekly-slots/:slotId", () => {
  it("fires the delivery webhook after deleting a slot", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // City ownership check (getCityOwner)
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      // Existence check — SELECT id FROM district_weekly_delivery_slots
      ["SELECT id FROM district_weekly_delivery_slots", { rows: [{ id: 1 }], rowCount: 1 }],
      // DELETE
      ["DELETE FROM district_weekly_delivery_slots", { rows: [], rowCount: 1 }],
    ]));

    const res = await request(app).delete("/cities/10/weekly-slots/1");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });
});

// ---------------------------------------------------------------------------
// POST /cities/:id/weekly-slots/copy — bulk replace (day-to-days)
// ---------------------------------------------------------------------------

describe("POST /cities/:id/weekly-slots/copy (day-to-days)", () => {
  it("fires the delivery webhook after a day-to-days copy", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // City ownership check (getCityOwner)
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      // Source slots SELECT — identified by the day_of_week = $2 filter used in the day-to-days branch
      ["day_of_week = $2", { rows: [SLOT_ROW], rowCount: 1 }],
    ]));

    // Transactional client mock — returns success for all in-transaction queries
    const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const mockRelease = vi.fn();
    mockDbConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: mockRelease,
    });

    const res = await request(app)
      .post("/cities/10/weekly-slots/copy")
      .send({ from_day: 1, to_days: [2, 3] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });

  it("copies the source day's slots to other cities", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // Target city ownership validation (id = ANY) — must precede the broader
      // "delivery_cities" snippet since both match this query.
      ["id = ANY($1::int[])", { rows: [{ id: 11 }], rowCount: 1 }],
      // City ownership check (getCityOwner)
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      // Source slots SELECT — day-to-days branch
      ["day_of_week = $2", { rows: [SLOT_ROW], rowCount: 1 }],
    ]));

    const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const mockRelease = vi.fn();
    mockDbConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: mockRelease,
    });

    const res = await request(app)
      .post("/cities/10/weekly-slots/copy")
      .send({ from_day: 1, to_days: [], to_city_ids: [11] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // One INSERT into the target city for the single source slot
    expect(res.body.inserted).toBe(1);
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });

  it("copies to other days and other cities together (mixed mode)", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // Target city ownership validation (id = ANY) — must precede the broader
      // "delivery_cities" snippet since both match this query.
      ["id = ANY($1::int[])", { rows: [{ id: 11 }], rowCount: 1 }],
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      ["day_of_week = $2", { rows: [SLOT_ROW], rowCount: 1 }],
    ]));

    const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: vi.fn(),
    });

    const res = await request(app)
      .post("/cities/10/weekly-slots/copy")
      .send({ from_day: 1, to_days: [2, 3], to_city_ids: [11] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 1 slot copied to each of 2 days + 1 slot copied to 1 city = 3 inserts
    expect(res.body.inserted).toBe(3);
  });

  it("refuses to copy an empty source day and does not wipe targets", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // City ownership check (getCityOwner)
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      // Source slots SELECT returns nothing — the source day is empty
      ["day_of_week = $2", { rows: [], rowCount: 0 }],
    ]));

    const res = await request(app)
      .post("/cities/10/weekly-slots/copy")
      .send({ from_day: 1, to_days: [2, 3], to_city_ids: [11] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no slots to copy/i);
    // No transactional client should have been opened — nothing was deleted.
    expect(mockDbConnect).not.toHaveBeenCalled();
    expect(mockFireDeliveryWebhookAsync).not.toHaveBeenCalled();
  });

  it("returns 404 when a target city is not owned by the workspace", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // Target city ownership validation returns nothing — must precede the
      // broader "delivery_cities" snippet since both match this query.
      ["id = ANY($1::int[])", { rows: [], rowCount: 0 }],
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      ["day_of_week = $2", { rows: [SLOT_ROW], rowCount: 1 }],
    ]));

    const res = await request(app)
      .post("/cities/10/weekly-slots/copy")
      .send({ from_day: 1, to_days: [], to_city_ids: [999] });

    expect(res.status).toBe(404);
  });

  it("copies each natural slot identity only once from a polluted source", async () => {
    const duplicate = {
      ...SLOT_ROW,
      id: 2,
      start_time: "9:00",
      is_enabled: false,
      updated_at: "2024-02-01T00:00:00.000Z",
    };
    mockDbQuery.mockImplementation(buildSqlMock([
      ["delivery_cities", { rows: [{ id: 10 }], rowCount: 1 }],
      ["day_of_week = $2", { rows: [duplicate, SLOT_ROW], rowCount: 2 }],
    ]));
    const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: vi.fn(),
    });

    const res = await request(app)
      .post("/cities/10/weekly-slots/copy")
      .send({ from_day: 1, to_days: [2] });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    const inserts = mockClientQuery.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO district_weekly_delivery_slots"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]?.[4]).toBe("09:00");
    expect(inserts[0]?.[1]?.[6]).toBe(true);
  });
});

describe("weekly slot natural identity", () => {
  it("normalizes equivalent clock/type text without collapsing distinct schedules", () => {
    const duplicate = {
      ...SLOT_ROW,
      id: 2,
      start_time: "9:00",
      delivery_type: " Standard ",
    };
    const differentDay = { ...SLOT_ROW, id: 3, day_of_week: 2 };
    const differentEnd = { ...SLOT_ROW, id: 4, end_time: "13:00" };
    const express = { ...SLOT_ROW, id: 5, delivery_type: "express" };

    expect(weeklySlotNaturalKey(duplicate)).toBe(weeklySlotNaturalKey(SLOT_ROW));
    expect(dedupeWeeklySlots([duplicate, SLOT_ROW, differentDay, differentEnd, express])).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Override-slot fixture
// ---------------------------------------------------------------------------

const OVERRIDE_SLOT_ROW = {
  id: 5,
  override_id: 20,
  label: "Evening",
  start_time: "18:00",
  end_time: "21:00",
  is_enabled: true,
  fee_override: null,
  cutoff_time: null,
  capacity: null,
  internal_note: null,
  sort_order: 0,
  delivery_type: "standard",
  same_day_available: false,
  next_day_available: true,
  created_at: "2024-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// POST /delivery-overrides/:overrideId/slots — create
// ---------------------------------------------------------------------------

describe("POST /delivery-overrides/:overrideId/slots", () => {
  it("fires the delivery webhook after creating an override slot", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // Override ownership check
      ["district_special_date_overrides", { rows: [{ id: 20 }], rowCount: 1 }],
      // Next sort_order SELECT
      ["COALESCE(MAX(sort_order)", { rows: [{ next: 0 }], rowCount: 1 }],
      // INSERT RETURNING
      ["INSERT INTO district_special_date_override_slots", { rows: [OVERRIDE_SLOT_ROW], rowCount: 1 }],
    ]));

    const res = await request(app)
      .post("/delivery-overrides/20/slots")
      .send({ start_time: "18:00", end_time: "21:00" });

    expect(res.status).toBe(201);
    expect(res.body.slot).toBeDefined();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });
});

// ---------------------------------------------------------------------------
// PATCH /delivery-overrides/:overrideId/slots/:slotId — update
// ---------------------------------------------------------------------------

describe("PATCH /delivery-overrides/:overrideId/slots/:slotId", () => {
  it("fires the delivery webhook after updating an override slot", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // Override ownership check
      ["district_special_date_overrides", { rows: [{ id: 20 }], rowCount: 1 }],
      // Existing slot SELECT
      ["FROM district_special_date_override_slots", { rows: [OVERRIDE_SLOT_ROW], rowCount: 1 }],
      // UPDATE RETURNING
      ["UPDATE district_special_date_override_slots", { rows: [{ ...OVERRIDE_SLOT_ROW, label: "Updated" }], rowCount: 1 }],
    ]));

    const res = await request(app)
      .patch("/delivery-overrides/20/slots/5")
      .send({ label: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.slot).toBeDefined();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });
});

// ---------------------------------------------------------------------------
// DELETE /delivery-overrides/:overrideId/slots/:slotId — delete
// ---------------------------------------------------------------------------

describe("DELETE /delivery-overrides/:overrideId/slots/:slotId", () => {
  it("fires the delivery webhook after deleting an override slot", async () => {
    mockDbQuery.mockImplementation(buildSqlMock([
      // Override ownership check
      ["district_special_date_overrides", { rows: [{ id: 20 }], rowCount: 1 }],
      // Slot existence check
      ["SELECT id FROM district_special_date_override_slots", { rows: [{ id: 5 }], rowCount: 1 }],
      // DELETE
      ["DELETE FROM district_special_date_override_slots", { rows: [], rowCount: 1 }],
    ]));

    const res = await request(app).delete("/delivery-overrides/20/slots/5");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledOnce();
    expect(mockFireDeliveryWebhookAsync).toHaveBeenCalledWith("owner_123");
  });
});
