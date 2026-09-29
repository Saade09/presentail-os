import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAssignedLocationIds: number[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.assignedLocationIds = stubAssignedLocationIds;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import locationsRouter from "./locations";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(locationsRouter);
  return app;
}

describe("GET /locations — response validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        // name should be string but null here triggers Zod failure
        {
          id: 1,
          name: null,
          country: "Lebanon",
          location_type: "Point of Sale",
          device_count: 0,
          job_count: 0,
          page_sum: 0,
        },
      ],
    });

    const res = await request(app).get("/locations");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /locations", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});

// ---------------------------------------------------------------------------
// POST /locations — country validation
// ---------------------------------------------------------------------------

describe("POST /locations – country validation against workspace settings", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("rejects a country that is not in the workspace available_countries list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "France",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of/i);
    expect(res.body.error).toContain("Lebanon");
    expect(res.body.error).toContain("United Arab Emirates");
  });

  it("accepts a country that is in the workspace available_countries list", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "Beirut Office",
            country: "Lebanon",
            location_type: "Point of Sale",
            annual_rent: null,
            rent_currency: null,
            payments_per_year: null,
            created_at: "2024-01-01",
          },
        ],
      });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
    });

    expect(res.status).toBe(200);
    expect(res.body.location.country).toBe("Lebanon");
  });

  it("uses the default countries (Lebanon, UAE) when no settings row exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/locations").send({
      name: "Paris Branch",
      country: "France",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of/i);
    expect(res.body.error).toContain("Lebanon");
    expect(res.body.error).toContain("United Arab Emirates");
  });

  it("uses default countries when workspace settings has an empty available_countries array", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: [] }],
      rowCount: 1,
    });

    const res = await request(app).post("/locations").send({
      name: "Berlin Hub",
      country: "Germany",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of/i);
    expect(res.body.error).toContain("Lebanon");
  });

  it("accepts a custom country when the workspace has configured custom available_countries", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ available_countries: ["France", "Germany"] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 2,
            name: "Paris Branch",
            country: "France",
            location_type: "Point of Sale",
            annual_rent: null,
            rent_currency: null,
            payments_per_year: null,
            created_at: "2024-06-01",
          },
        ],
      });

    const res = await request(app).post("/locations").send({
      name: "Paris Branch",
      country: "France",
    });

    expect(res.status).toBe(200);
    expect(res.body.location.country).toBe("France");
  });

  it("rejects Lebanon when the workspace has configured a custom countries list that excludes it", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["France", "Germany"] }],
      rowCount: 1,
    });

    const res = await request(app).post("/locations").send({
      name: "Beirut HQ",
      country: "Lebanon",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of/i);
    expect(res.body.error).toContain("France");
    expect(res.body.error).toContain("Germany");
  });
});

// ---------------------------------------------------------------------------
// PATCH /locations/:id — country validation
// ---------------------------------------------------------------------------

describe("PATCH /locations/:id – country validation against workspace settings", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("rejects a country not in the workspace list on update", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    });

    const res = await request(app).patch("/locations/1").send({
      name: "Updated Location",
      country: "Japan",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of/i);
  });

  it("accepts a valid country on update when it matches workspace settings", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "Updated Location",
            country: "United Arab Emirates",
            location_type: "Point of Sale",
            annual_rent: null,
            rent_currency: null,
            payments_per_year: null,
            created_at: "2024-01-01",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).patch("/locations/1").send({
      name: "Updated Location",
      country: "United Arab Emirates",
    });

    expect(res.status).toBe(200);
    expect(res.body.location.country).toBe("United Arab Emirates");
  });
});

// ---------------------------------------------------------------------------
// Israel exclusion
// ---------------------------------------------------------------------------

describe("Locations – Israel exclusion", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("rejects creating a location with country 'Israel' even when the saved settings include Israel", async () => {
    // Even if a stale workspace_settings row contains Israel, the route must
    // refuse it without consulting the allowlist.
    const res = await request(app).post("/locations").send({
      name: "Some Office",
      country: "Israel",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    // No allowlist lookup should be needed before rejection.
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects updating a location with country 'IL' regardless of saved allowlist", async () => {
    const res = await request(app).patch("/locations/1").send({
      name: "Updated",
      country: "IL",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("filters Israel out of the workspace allowlist when validating a different country", async () => {
    // Workspace settings stored Israel from before the exclusion was added.
    // A request for Lebanon (also in the saved list) should still pass without
    // ever exposing Israel as a valid choice.
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ available_countries: ["Lebanon", "Israel"] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: "Beirut Office",
            country: "Lebanon",
            location_type: "Point of Sale",
            annual_rent: null,
            rent_currency: null,
            payments_per_year: null,
            created_at: "2024-01-01",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
    });

    expect(res.status).toBe(200);
    expect(res.body.location.country).toBe("Lebanon");
  });

  it("returns the 'must be one of' error excluding Israel when an unsupported country is requested against a saved [Lebanon, Israel] allowlist", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "Israel"] }],
      rowCount: 1,
    });

    const res = await request(app).post("/locations").send({
      name: "Office",
      country: "France",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of/i);
    expect(res.body.error).toContain("Lebanon");
    expect(res.body.error).not.toContain("Israel");
  });
});

// ---------------------------------------------------------------------------
// GET /locations/:id/activity — activity feed
// ---------------------------------------------------------------------------

describe("GET /locations/:id/activity", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 403 when a member is restricted to other locations and tries to access this one", async () => {
    stubWorkspaceRole = "member";
    stubAssignedLocationIds = [99, 100];

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/do not have access/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the location does not belong to the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/locations/42/activity");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns an empty events array when no activity exists for the location", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it("returns device_heartbeat events with the device name as subject_name", async () => {
    const now = new Date().toISOString();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            event_type: "device_heartbeat",
            occurred_at: now,
            subject_name: "Front Desk Mac",
            subject_id: "7",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].event_type).toBe("device_heartbeat");
    expect(res.body.events[0].subject_name).toBe("Front Desk Mac");
    expect(res.body.events[0].subject_id).toBe("7");
  });

  it("returns brand_linked events with the brand name as subject_name", async () => {
    const now = new Date().toISOString();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            event_type: "brand_linked",
            occurred_at: now,
            subject_name: "Nike",
            subject_id: "3",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    expect(res.body.events[0].event_type).toBe("brand_linked");
    expect(res.body.events[0].subject_name).toBe("Nike");
    expect(res.body.events[0].subject_id).toBe("3");
  });

  it("returns member_added events with the member email as subject_name", async () => {
    const now = new Date().toISOString();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            event_type: "member_added",
            occurred_at: now,
            subject_name: "alice@example.com",
            subject_id: "5",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    expect(res.body.events[0].event_type).toBe("member_added");
    expect(res.body.events[0].subject_name).toBe("alice@example.com");
    expect(res.body.events[0].subject_id).toBe("5");
  });

  it("returns job_completed events with the filename as subject_name", async () => {
    const now = new Date().toISOString();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            event_type: "job_completed",
            occurred_at: now,
            subject_name: "invoice-2024.pdf",
            subject_id: "11",
          },
        ],
        rowCount: 1,
      });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    expect(res.body.events[0].event_type).toBe("job_completed");
    expect(res.body.events[0].subject_name).toBe("invoice-2024.pdf");
    expect(res.body.events[0].subject_id).toBe("11");
  });

  it("returns all four event types together and preserves descending order by occurred_at", async () => {
    const t1 = "2024-06-10T12:00:00.000Z";
    const t2 = "2024-06-10T10:00:00.000Z";
    const t3 = "2024-06-10T08:00:00.000Z";
    const t4 = "2024-06-09T22:00:00.000Z";

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { event_type: "device_heartbeat", occurred_at: t1, subject_name: "Printer A", subject_id: "1" },
          { event_type: "brand_linked",     occurred_at: t2, subject_name: "Adidas",    subject_id: "2" },
          { event_type: "member_added",     occurred_at: t3, subject_name: "bob@x.com", subject_id: "3" },
          { event_type: "job_completed",    occurred_at: t4, subject_name: "doc.pdf",   subject_id: "4" },
        ],
        rowCount: 4,
      });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    const events = res.body.events as Array<{ event_type: string; occurred_at: string }>;
    expect(events).toHaveLength(4);

    const types = events.map((e) => e.event_type);
    expect(types).toContain("device_heartbeat");
    expect(types).toContain("brand_linked");
    expect(types).toContain("member_added");
    expect(types).toContain("job_completed");

    // Verify descending order
    for (let i = 0; i < events.length - 1; i++) {
      expect(new Date(events[i].occurred_at).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i + 1].occurred_at).getTime(),
      );
    }
  });

  it("passes the correct locationId and ownerId to the activity query", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/5/activity");

    const activityCall = mockDbQuery.mock.calls[1];
    const params = activityCall[1] as unknown[];
    expect(params[0]).toBe(5);
    expect(params[1]).toBe("owner_123");
  });

  it("allows access when the member is assigned to the requested location", async () => {
    stubWorkspaceRole = "member";
    stubAssignedLocationIds = [1, 2];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it("allows access when assignedLocationIds is null (no location restriction)", async () => {
    stubWorkspaceRole = "member";
    stubAssignedLocationIds = null;

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
  });

  it("allows access when assignedLocationIds is an empty array (treated as no restriction)", async () => {
    stubWorkspaceRole = "member";
    stubAssignedLocationIds = [];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/locations/1/activity");

    expect(res.status).toBe(200);
  });

  // ── SQL predicate assertions ──────────────────────────────────────────────

  it("activity query enforces 7-day window for device_heartbeat events", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/1/activity");

    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/INTERVAL\s+'7 days'/i);
  });

  it("activity query enforces 30-day window for brand_linked events", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/1/activity");

    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/INTERVAL\s+'30 days'/i);
  });

  it("activity query enforces 24-hour window for job_completed events", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/1/activity");

    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/INTERVAL\s+'24 hours'/i);
  });

  it("activity query filters print_jobs to status='done' and excludes soft-deleted rows", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/1/activity");

    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toContain("'done'");
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it("activity query orders results by occurred_at DESC", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/1/activity");

    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/ORDER BY\s+occurred_at\s+DESC/i);
  });

  it("activity query includes all four event-type source tables", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations/1/activity");

    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toContain("device_heartbeat");
    expect(sql).toContain("brand_linked");
    expect(sql).toContain("member_added");
    expect(sql).toContain("job_completed");
    expect(sql).toContain("devices");
    expect(sql).toContain("location_brands");
    expect(sql).toContain("member_locations");
    expect(sql).toContain("print_jobs");
  });
});

// ---------------------------------------------------------------------------
// GET /locations — has_operating_hours field
// ---------------------------------------------------------------------------

function makeValidLocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Test Location",
    country: "Lebanon",
    location_type: "Point of Sale",
    annual_rent: null,
    rent_currency: null,
    payments_per_year: null,
    created_at: "2024-01-01",
    status: "active",
    paused_at: null,
    daily_capacity: null,
    address: null,
    device_count: 0,
    devices_online: 0,
    devices_offline: 0,
    job_count: 0,
    page_sum: 0,
    brands_count: 0,
    products_count: 0,
    orders_today: 0,
    pending_prep: 0,
    has_operating_hours: false,
    has_routing: false,
    has_capacity: false,
    ...overrides,
  };
}

describe("GET /locations — has_operating_hours SQL expression", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("SQL query requires operating_hours IS NOT NULL to compute has_operating_hours", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations");

    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/operating_hours\s+IS\s+NOT\s+NULL/i);
  });

  it("SQL query rejects an empty JSONB object so that '{}' yields has_operating_hours false", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations");

    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("'{}'::jsonb");
  });

  it("SQL query checks that at least one day is not closed (closed IS DISTINCT FROM 'true')", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations");

    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/IS DISTINCT FROM\s+'true'/i);
  });

  it("SQL query requires non-empty open and close times on an active day", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/locations");

    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/val->>'open'\s+IS NOT NULL/i);
    expect(sql).toMatch(/val->>'open'\s+!=\s+''/i);
    expect(sql).toMatch(/val->>'close'\s+IS NOT NULL/i);
    expect(sql).toMatch(/val->>'close'\s+!=\s+''/i);
  });
});

describe("GET /locations — has_operating_hours passthrough cases", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("returns has_operating_hours: false when the DB computes false (NULL operating_hours)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeValidLocationRow({ has_operating_hours: false })],
      rowCount: 1,
    });

    const res = await request(app).get("/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations[0].has_operating_hours).toBe(false);
  });

  it("returns has_operating_hours: false when the DB computes false (empty operating_hours object)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeValidLocationRow({ has_operating_hours: false })],
      rowCount: 1,
    });

    const res = await request(app).get("/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations[0].has_operating_hours).toBe(false);
  });

  it("returns has_operating_hours: false when the DB computes false (all days closed)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeValidLocationRow({ has_operating_hours: false })],
      rowCount: 1,
    });

    const res = await request(app).get("/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations[0].has_operating_hours).toBe(false);
  });

  it("returns has_operating_hours: true when the DB computes true (at least one active day with valid open/close)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeValidLocationRow({ has_operating_hours: true })],
      rowCount: 1,
    });

    const res = await request(app).get("/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations[0].has_operating_hours).toBe(true);
  });

  it("returns has_operating_hours: false alongside has_operating_hours: true when multiple locations exist", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        makeValidLocationRow({ id: 1, name: "No Hours", has_operating_hours: false }),
        makeValidLocationRow({ id: 2, name: "Has Hours", has_operating_hours: true }),
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(2);
    const noHours = res.body.locations.find((l: { id: number }) => l.id === 1);
    const hasHours = res.body.locations.find((l: { id: number }) => l.id === 2);
    expect(noHours.has_operating_hours).toBe(false);
    expect(hasHours.has_operating_hours).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /locations — florist_member_ids validation & assignment
// ---------------------------------------------------------------------------

describe("POST /locations – florist_member_ids", () => {
  const app = makeApp();

  const settingsRow = {
    rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
    rowCount: 1,
  };
  const insertedRow = {
    rows: [
      {
        id: 42,
        name: "Beirut Office",
        country: "Lebanon",
        location_type: "Point of Sale",
        annual_rent: null,
        rent_currency: null,
        payments_per_year: null,
        created_at: "2024-01-01",
      },
    ],
    rowCount: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("returns 400 when florist_member_ids is not an array", async () => {
    mockDbQuery.mockResolvedValueOnce(settingsRow);

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: "7",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/florist_member_ids must be an array/i);
  });

  it("returns 400 when florist_member_ids contains a non-integer value", async () => {
    mockDbQuery.mockResolvedValueOnce(settingsRow);

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: [1, "abc"],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/florist_member_ids must be an array/i);
  });

  it("returns 400 when florist_member_ids contains a partially-numeric string like '5abc'", async () => {
    mockDbQuery.mockResolvedValueOnce(settingsRow);

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: ["5abc"],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/florist_member_ids must be an array/i);
  });

  it("returns 400 when an id does not reference a member with the florist_orders page", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      // florist validation: only member 5 is a valid florist, 6 is not
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: [5, 6],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/florist orders page/i);
    // No INSERT should have happened (settings + validation queries only)
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("creates the location and applies assignments when ids are valid", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      // florist validation — both ids valid
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 6 }], rowCount: 2 })
      // INSERT location
      .mockResolvedValueOnce(insertedRow)
      // UPDATE set florist_location_id for selected
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      // UPDATE clear deselected
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: [5, 6],
    });

    expect(res.status).toBe(200);
    expect(res.body.location.id).toBe(42);

    const setCall = mockDbQuery.mock.calls[3];
    expect(String(setCall[0])).toMatch(/SET florist_location_id = \$1/);
    expect(setCall[1]).toEqual([42, "owner_123", [5, 6]]);

    const clearCall = mockDbQuery.mock.calls[4];
    expect(String(clearCall[0])).toMatch(/SET florist_location_id = NULL/);
    expect(clearCall[1]).toEqual(["owner_123", 42, [5, 6]]);
  });

  it("clears all florists from the location when an empty array is sent", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      // INSERT location (no validation query for empty ids)
      .mockResolvedValueOnce(insertedRow)
      // UPDATE clear deselected only
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: [],
    });

    expect(res.status).toBe(200);
    const clearCall = mockDbQuery.mock.calls[2];
    expect(String(clearCall[0])).toMatch(/SET florist_location_id = NULL/);
    expect(clearCall[1]).toEqual(["owner_123", 42, []]);
  });

  it("does not touch florist assignments when the field is omitted", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      .mockResolvedValueOnce(insertedRow);

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
    });

    expect(res.status).toBe(200);
    // settings + INSERT only — no assignment queries
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated ids before validating and assigning", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce(insertedRow)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      florist_member_ids: [5, 5, 5],
    });

    expect(res.status).toBe(200);
    const validationCall = mockDbQuery.mock.calls[1];
    expect(validationCall[1]).toEqual([[5], "owner_123"]);
  });
});

// ---------------------------------------------------------------------------
// POST /locations — grace_period_minutes validation
// ---------------------------------------------------------------------------

describe("POST /locations – grace_period_minutes", () => {
  const app = makeApp();

  const settingsRow = {
    rows: [{ available_countries: ["Lebanon"] }],
    rowCount: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("returns 400 when grace_period_minutes is not a valid integer", async () => {
    mockDbQuery.mockResolvedValueOnce(settingsRow);

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      grace_period_minutes: "not-a-number",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/grace_period_minutes must be a valid integer/i);
  });

  it("passes grace_period_minutes to the INSERT query when provided", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      .mockResolvedValueOnce({
        rows: [{ id: 10, name: "Beirut Office", country: "Lebanon", location_type: "Point of Sale",
                 annual_rent: null, rent_currency: null, payments_per_year: null,
                 grace_period_minutes: 45, created_at: "2026-01-01" }],
        rowCount: 1,
      });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
      grace_period_minutes: 45,
    });

    expect(res.status).toBe(200);
    // Verify grace_period_minutes was passed to the INSERT
    const insertCall = mockDbQuery.mock.calls[1];
    expect(String(insertCall[0])).toMatch(/grace_period_minutes/);
    expect(insertCall[1]).toContain(45);
  });

  it("uses null grace_period_minutes when the field is omitted", async () => {
    mockDbQuery
      .mockResolvedValueOnce(settingsRow)
      .mockResolvedValueOnce({
        rows: [{ id: 10, name: "Beirut Office", country: "Lebanon", location_type: "Point of Sale",
                 annual_rent: null, rent_currency: null, payments_per_year: null,
                 grace_period_minutes: null, created_at: "2026-01-01" }],
        rowCount: 1,
      });

    const res = await request(app).post("/locations").send({
      name: "Beirut Office",
      country: "Lebanon",
    });

    expect(res.status).toBe(200);
    const insertCall = mockDbQuery.mock.calls[1];
    // null is passed when field is omitted
    expect(insertCall[1]).toContain(null);
  });
});

// ---------------------------------------------------------------------------
// PATCH /locations/:id (partial) — grace_period_minutes
// ---------------------------------------------------------------------------

describe("PATCH /locations/:id (partial) – grace_period_minutes", () => {
  const app = makeApp();

  const updatedLocationRow = {
    rows: [{
      id: 7, name: "CMC Beirut Hospital", country: "Lebanon",
      location_type: "Point of Sale", status: "active",
      same_day_cutoff_time: "18:30", timezone: "Asia/Beirut",
      grace_period_minutes: 30,
      annual_rent: null, rent_currency: null, payments_per_year: null,
      daily_capacity: null, express_cutoff_time: null, operating_hours: null,
      backup_location_id: null, auto_routing_enabled: false, served_area_ids: null,
      paused_at: null, paused_by: null, pause_reason: null, internal_notes: null,
      address: null, created_at: "2026-01-01", latitude: null, longitude: null,
      geofence_radius_meters: null, attendance_enabled: false,
    }],
    rowCount: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("persists grace_period_minutes via the partial PATCH path (no name field)", async () => {
    mockDbQuery.mockResolvedValueOnce(updatedLocationRow);

    const res = await request(app)
      .patch("/locations/7")
      .send({ grace_period_minutes: 30 });

    expect(res.status).toBe(200);
    expect(res.body.location.grace_period_minutes).toBe(30);

    // Verify the UPDATE query includes grace_period_minutes
    const updateCall = mockDbQuery.mock.calls[0];
    expect(String(updateCall[0])).toMatch(/grace_period_minutes/);
  });

  it("returns 400 when grace_period_minutes is not a valid integer in partial PATCH", async () => {
    const res = await request(app)
      .patch("/locations/7")
      .send({ grace_period_minutes: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/grace_period_minutes must be a valid integer/i);
  });

  it("does not modify grace_period_minutes when only attendance_enabled is sent", async () => {
    mockDbQuery.mockResolvedValueOnce(updatedLocationRow);

    const res = await request(app)
      .patch("/locations/7")
      .send({ attendance_enabled: true });

    expect(res.status).toBe(200);

    // grace_period_minutes not in body → CASE WHEN false THEN ... keeps existing value
    const updateCall = mockDbQuery.mock.calls[0];
    // The boolean flag for grace_period_minutes should be false
    expect(updateCall[1][2]).toBe(false); // $3 = req.body?.grace_period_minutes !== undefined
  });
});
