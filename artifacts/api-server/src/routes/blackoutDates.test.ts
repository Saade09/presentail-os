import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

let stubWorkspaceOwnerId = "owner_111";
let stubWorkspaceRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.userEmail = "owner@example.com";
    wreq.userId = "user_111";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import blackoutDatesRouter from "./blackoutDates";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(blackoutDatesRouter);
  return app;
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_111",
    name: "Year-End Freeze",
    description: null,
    start_date: "2026-12-20",
    end_date: "2026-12-31",
    restriction_type: "blocking",
    affected_location_ids: null,
    affected_department_ids: null,
    affected_employee_ids: null,
    affected_leave_type_ids: null,
    employee_message: null,
    allow_exceptions: false,
    exception_approver_type: null,
    status: "upcoming",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  stubWorkspaceOwnerId = "owner_111";
  stubWorkspaceRole = "owner";
});

// ---------------------------------------------------------------------------
// GET /blackout-dates
// ---------------------------------------------------------------------------

describe("GET /blackout-dates", () => {
  it("returns list of blackout dates for the workspace", async () => {
    const row = makeRow();
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(makeApp()).get("/blackout-dates");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blackout_dates).toHaveLength(1);
    expect(res.body.blackout_dates[0].name).toBe("Year-End Freeze");
  });

  it("returns empty list when no blackout dates exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).get("/blackout-dates");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blackout_dates).toHaveLength(0);
  });

  it("passes date_from and date_to query filters to the query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(makeApp())
      .get("/blackout-dates?date_from=2026-12-01&date_to=2026-12-31");

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("end_date >= $2");
    expect(sql).toContain("start_date <= $3");
    expect(params).toContain("2026-12-01");
    expect(params).toContain("2026-12-31");
  });

  it("passes status filter to the query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get("/blackout-dates?status=active");

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = $");
    expect(params).toContain("active");
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp()).get("/blackout-dates");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout dates/i);
  });
});

// ---------------------------------------------------------------------------
// GET /blackout-dates/active
// ---------------------------------------------------------------------------

describe("GET /blackout-dates/active", () => {
  it("returns currently active blackout dates", async () => {
    const row = makeRow({ status: "active" });
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(makeApp()).get("/blackout-dates/active");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blackout_dates).toHaveLength(1);
  });

  it("excludes cancelled dates from the query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get("/blackout-dates/active");

    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status != 'cancelled'");
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp()).get("/blackout-dates/active");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout dates/i);
  });
});

// ---------------------------------------------------------------------------
// GET /blackout-dates/check
// ---------------------------------------------------------------------------

describe("GET /blackout-dates/check", () => {
  it("returns 400 when start_date is missing", async () => {
    const res = await request(makeApp()).get("/blackout-dates/check?end_date=2026-12-31");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start_date.*end_date/i);
  });

  it("returns 400 when end_date is missing", async () => {
    const res = await request(makeApp()).get("/blackout-dates/check?start_date=2026-12-01");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start_date.*end_date/i);
  });

  it("returns 400 when both dates are missing", async () => {
    const res = await request(makeApp()).get("/blackout-dates/check");

    expect(res.status).toBe(400);
  });

  it("reports overlap=true when blackout dates overlap the given range", async () => {
    const row = makeRow({ start_date: "2026-12-20", end_date: "2026-12-25" });
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(makeApp()).get(
      "/blackout-dates/check?start_date=2026-12-18&end_date=2026-12-22",
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.has_overlap).toBe(true);
    expect(res.body.overlapping).toHaveLength(1);
  });

  it("reports overlap=false when no blackout dates overlap the given range", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).get(
      "/blackout-dates/check?start_date=2026-11-01&end_date=2026-11-10",
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.has_overlap).toBe(false);
    expect(res.body.overlapping).toHaveLength(0);
  });

  it("excludes cancelled dates when checking overlap", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get(
      "/blackout-dates/check?start_date=2026-12-01&end_date=2026-12-31",
    );

    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status != 'cancelled'");
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp()).get(
      "/blackout-dates/check?start_date=2026-12-01&end_date=2026-12-31",
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout dates/i);
  });
});

// ---------------------------------------------------------------------------
// GET /blackout-dates/:id
// ---------------------------------------------------------------------------

describe("GET /blackout-dates/:id", () => {
  it("returns the blackout date when found", async () => {
    const row = makeRow();
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(makeApp()).get("/blackout-dates/1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blackout_date.id).toBe(1);
  });

  it("returns 404 when the blackout date is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).get("/blackout-dates/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp()).get("/blackout-dates/1");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout date/i);
  });
});

// ---------------------------------------------------------------------------
// POST /blackout-dates
// ---------------------------------------------------------------------------

describe("POST /blackout-dates", () => {
  const validPayload = {
    name: "Summer Freeze",
    start_date: "2026-07-01",
    end_date: "2026-07-14",
    restriction_type: "blocking",
  };

  it("creates a blackout date and returns 201", async () => {
    const row = makeRow({ name: "Summer Freeze", start_date: "2026-07-01", end_date: "2026-07-14" });
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(makeApp())
      .post("/blackout-dates")
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.blackout_date.name).toBe("Summer Freeze");
  });

  it("returns 403 when caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .post("/blackout-dates")
      .send(validPayload);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(makeApp())
      .post("/blackout-dates")
      .send({ start_date: "2026-07-01", end_date: "2026-07-14" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name.*start_date.*end_date/i);
  });

  it("returns 400 when start_date is missing", async () => {
    const res = await request(makeApp())
      .post("/blackout-dates")
      .send({ name: "Test", end_date: "2026-07-14" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name.*start_date.*end_date/i);
  });

  it("returns 400 when end_date is missing", async () => {
    const res = await request(makeApp())
      .post("/blackout-dates")
      .send({ name: "Test", start_date: "2026-07-01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name.*start_date.*end_date/i);
  });

  it("returns 400 when start_date is after end_date", async () => {
    const res = await request(makeApp())
      .post("/blackout-dates")
      .send({ name: "Test", start_date: "2026-07-14", end_date: "2026-07-01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start_date.*end_date/i);
  });

  it("returns 400 when restriction_type is invalid", async () => {
    const res = await request(makeApp())
      .post("/blackout-dates")
      .send({ ...validPayload, restriction_type: "invalid_type" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/restriction_type/i);
  });

  it("accepts all valid restriction_type values", async () => {
    const row = makeRow();
    for (const rt of ["warning_only", "blocking", "manager_approval"]) {
      mockDbQuery.mockResolvedValueOnce({ rows: [row] });
      const res = await request(makeApp())
        .post("/blackout-dates")
        .send({ ...validPayload, restriction_type: rt });
      expect(res.status).toBe(201);
    }
  });

  it("defaults restriction_type to warning_only when omitted", async () => {
    const row = makeRow({ restriction_type: "warning_only" });
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const { restriction_type: _, ...payloadWithoutType } = validPayload;
    const res = await request(makeApp())
      .post("/blackout-dates")
      .send(payloadWithoutType);

    expect(res.status).toBe(201);
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain("warning_only");
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp())
      .post("/blackout-dates")
      .send(validPayload);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout date/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /blackout-dates/:id
// ---------------------------------------------------------------------------

describe("PATCH /blackout-dates/:id", () => {
  it("updates a blackout date and returns it", async () => {
    const row = makeRow({ name: "Updated Name" });
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(makeApp())
      .patch("/blackout-dates/1")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blackout_date.name).toBe("Updated Name");
  });

  it("returns 403 when caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .patch("/blackout-dates/1")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await request(makeApp())
      .patch("/blackout-dates/1")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when only unknown fields are provided", async () => {
    const res = await request(makeApp())
      .patch("/blackout-dates/1")
      .send({ unknown_field: "value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields/i);
  });

  it("returns 404 when the blackout date does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .patch("/blackout-dates/999")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp())
      .patch("/blackout-dates/1")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout date/i);
  });

  it("converts empty string values to null", async () => {
    const row = makeRow({ description: null });
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    await request(makeApp())
      .patch("/blackout-dates/1")
      .send({ description: "" });

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /blackout-dates/:id
// ---------------------------------------------------------------------------

describe("DELETE /blackout-dates/:id", () => {
  it("deletes a blackout date and returns success", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const res = await request(makeApp()).delete("/blackout-dates/1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 403 when caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).delete("/blackout-dates/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the blackout date does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).delete("/blackout-dates/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 500 on db error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db error"));

    const res = await request(makeApp()).delete("/blackout-dates/1");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/blackout date/i);
  });
});
