import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
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

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import taxRulesRouter from "./taxRules";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use(taxRulesRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const TAX_RULE_ROW = {
  id: "uuid-001",
  workspace_owner_id: "owner_123",
  country_code: "AE",
  location_id: null,
  location_name: null,
  tax_category: "standard_taxable",
  rate_percent: "5.00",
  effective_from: "2024-01-01",
  effective_to: null,
  is_active: true,
  description: "UAE VAT",
  created_at: "2024-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// GET /tax-rules — list
// ---------------------------------------------------------------------------

describe("GET /tax-rules — list", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller is not an owner", async () => {
    stubActualRole = "member";

    const res = await request(app).get("/tax-rules");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner access/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 200 with empty tax_rules array when none exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/tax-rules");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tax_rules");
    expect(Array.isArray(res.body.tax_rules)).toBe(true);
    expect(res.body.tax_rules).toHaveLength(0);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with tax rule rows", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 });

    const res = await request(app).get("/tax-rules");

    expect(res.status).toBe(200);
    expect(res.body.tax_rules).toHaveLength(1);
    expect(res.body.tax_rules[0]).toMatchObject({
      id: "uuid-001",
      country_code: "AE",
      tax_category: "standard_taxable",
      rate_percent: "5.00",
    });
  });

  it("scopes the query to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("owner_xyz");
  });

  it("passes country_code filter as an uppercase SQL param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules?country_code=ae");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/country_code\s*=\s*\$\d+/i);
    expect(params).toContain("AE");
  });

  it("passes tax_category filter as a SQL param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules?tax_category=zero_rated");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/tax_category\s*=\s*\$\d+/i);
    expect(params).toContain("zero_rated");
  });

  it("adds active_only conditions when ?active_only=true is passed", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules?active_only=true");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/is_active\s*=\s*true/i);
    expect(sql).toMatch(/effective_from\s*<=\s*CURRENT_DATE/i);
  });

  it("passes location_id as an integer SQL param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules?location_id=7");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/location_id\s*=\s*\$\d+/i);
    expect(params).toContain(7);
  });

  it("returns 400 when tax_category query param has an invalid value", async () => {
    const res = await request(app).get("/tax-rules?tax_category=bad_value");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category must be one of/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when location_id query param is not a valid integer", async () => {
    const res = await request(app).get("/tax-rules?location_id=abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location_id must be a valid integer/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /tax-rules — create
// ---------------------------------------------------------------------------

describe("POST /tax-rules — create", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller is not an owner", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner access/i);
  });

  it("returns 400 when country_code is missing", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ tax_category: "standard_taxable", rate_percent: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country_code is required/i);
  });

  it("returns 400 when country_code is an empty string", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "   ", tax_category: "standard_taxable", rate_percent: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country_code is required/i);
  });

  it("returns 400 when tax_category is invalid", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "bad_value", rate_percent: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category must be one of/i);
  });

  it("returns 400 when rate_percent is not a number", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rate_percent must be a number/i);
  });

  it("returns 400 when rate_percent is negative", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rate_percent must be a number/i);
  });

  it("returns 400 when rate_percent exceeds 100", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: 101 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rate_percent must be a number/i);
  });

  it("returns 400 when location_id is provided but invalid", async () => {
    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: 5, location_id: "abc" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location_id must be a valid integer/i);
  });

  it("returns 404 when location_id does not belong to the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // location check fails

    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: 5, location_id: 99 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/location not found/i);
  });

  it("returns 201 with the created tax rule on a valid request (no location)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 }); // INSERT

    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "ae", tax_category: "standard_taxable", rate_percent: 5, description: "UAE VAT" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("tax_rule");
    expect(res.body.tax_rule).toMatchObject({
      country_code: "AE",
      tax_category: "standard_taxable",
      rate_percent: "5.00",
    });
    expect(mockDbQuery).toHaveBeenCalledTimes(1); // INSERT only
  });

  it("uppercases country_code before inserting", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 });

    await request(app)
      .post("/tax-rules")
      .send({ country_code: "ae", tax_category: "standard_taxable", rate_percent: 5 });

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe("AE");
  });

  it("returns 201 with location check when location_id is valid (2 DB calls)", async () => {
    const ruleWithLocation = { ...TAX_RULE_ROW, location_id: 3, location_name: "Dubai Store" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 }) // location check
      .mockResolvedValueOnce({ rows: [ruleWithLocation], rowCount: 1 }); // INSERT

    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: 5, location_id: 3 });

    expect(res.status).toBe(201);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(res.body.tax_rule.location_id).toBe(3);
  });

  it("returns 409 when a duplicate tax rule already exists", async () => {
    const pgUniqueError = Object.assign(new Error("unique violation"), { code: "23505" });
    mockDbQuery.mockRejectedValueOnce(pgUniqueError);

    const res = await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "standard_taxable", rate_percent: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("scopes the INSERT to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ ...TAX_RULE_ROW, workspace_owner_id: "owner_xyz" }], rowCount: 1 });

    await request(app)
      .post("/tax-rules")
      .send({ country_code: "AE", tax_category: "zero_rated", rate_percent: 0 });

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// PATCH /tax-rules/:id — update
// ---------------------------------------------------------------------------

describe("PATCH /tax-rules/:id — update", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller is not an owner", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ rate_percent: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner access/i);
  });

  it("returns 404 when the tax rule does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT existing

    const res = await request(app)
      .patch("/tax-rules/non-existent-id")
      .send({ rate_percent: 10 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tax rule not found/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when an invalid tax_category is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 }); // SELECT existing

    const res = await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ tax_category: "bad_value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category must be one of/i);
  });

  it("returns 400 when rate_percent is out of range", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 }); // SELECT existing

    const res = await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ rate_percent: 150 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rate_percent must be a number/i);
  });

  it("returns 200 with the updated tax rule on a valid request (2 DB calls)", async () => {
    const updatedRule = { ...TAX_RULE_ROW, rate_percent: "10.00", is_active: false };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 }) // SELECT existing
      .mockResolvedValueOnce({ rows: [updatedRule], rowCount: 1 }); // UPDATE

    const res = await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ rate_percent: 10, is_active: false });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tax_rule");
    expect(res.body.tax_rule.rate_percent).toBe("10.00");
    expect(res.body.tax_rule.is_active).toBe(false);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("preserves previous values when fields are not included in the PATCH body", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 });

    await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ description: "Updated description" });

    const [updateSql, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE tax_rules/i);
    // country_code ($1) should carry the previous value
    expect(updateParams[0]).toBe("AE");
    // tax_category ($3) should carry the previous value
    expect(updateParams[2]).toBe("standard_taxable");
  });

  it("uppercases country_code when provided in the PATCH body", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 });

    await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ country_code: "sa" });

    const [, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateParams[0]).toBe("SA");
  });

  it("returns 409 when the UPDATE causes a unique constraint violation", async () => {
    const pgUniqueError = Object.assign(new Error("unique violation"), { code: "23505" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 })
      .mockRejectedValueOnce(pgUniqueError);

    const res = await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ effective_from: "2024-06-01" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("scopes SELECT and UPDATE to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ ...TAX_RULE_ROW, workspace_owner_id: "owner_xyz" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [TAX_RULE_ROW], rowCount: 1 });

    await request(app)
      .patch("/tax-rules/uuid-001")
      .send({ description: "Test" });

    const [, selectParams] = mockDbQuery.mock.calls[0];
    expect(selectParams).toContain("owner_xyz");
    const [, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateParams).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// DELETE /tax-rules/:id
// ---------------------------------------------------------------------------

describe("DELETE /tax-rules/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller is not an owner", async () => {
    stubActualRole = "member";

    const res = await request(app).delete("/tax-rules/uuid-001");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner access/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the tax rule does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/tax-rules/non-existent-id");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tax rule not found/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with { ok: true } when deletion succeeds", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE

    const res = await request(app).delete("/tax-rules/uuid-001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("scopes the DELETE to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).delete("/tax-rules/uuid-001");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("owner_xyz");
  });

  it("passes the rule id as the first DELETE param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).delete("/tax-rules/uuid-abc-123");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("uuid-abc-123");
  });
});

// ---------------------------------------------------------------------------
// GET /tax-rules/resolve — resolve effective rate
// ---------------------------------------------------------------------------

describe("GET /tax-rules/resolve — resolve effective rate", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 400 when tax_category is missing", async () => {
    const res = await request(app).get("/tax-rules/resolve?country_code=AE");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category and country_code are required/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when country_code is missing", async () => {
    const res = await request(app).get("/tax-rules/resolve?tax_category=standard_taxable");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category and country_code are required/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns { rate_percent: null, resolved: false } when no matching rule exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/tax-rules/resolve?tax_category=standard_taxable&country_code=AE");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate_percent: null, resolved: false });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns rate_percent and resolved: true when a matching rule is found", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ rate_percent: "5.00", location_id: null }],
      rowCount: 1,
    });

    const res = await request(app).get("/tax-rules/resolve?tax_category=standard_taxable&country_code=AE");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rate_percent: "5.00",
      resolved: true,
      location_id: null,
    });
  });

  it("returns location_id when a location-specific rule is matched", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ rate_percent: "4.00", location_id: 7 }],
      rowCount: 1,
    });

    const res = await request(app).get(
      "/tax-rules/resolve?tax_category=standard_taxable&country_code=AE&location_id=7",
    );

    expect(res.status).toBe(200);
    expect(res.body.location_id).toBe(7);
    expect(res.body.rate_percent).toBe("4.00");
    expect(res.body.resolved).toBe(true);
  });

  it("scopes the query to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules/resolve?tax_category=standard_taxable&country_code=AE");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("owner_xyz");
  });

  it("uppercases country_code before querying", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/tax-rules/resolve?tax_category=standard_taxable&country_code=ae");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe("AE");
  });

  it("accepts the ?date= param and passes it to the query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get(
      "/tax-rules/resolve?tax_category=standard_taxable&country_code=AE&date=2023-06-15",
    );

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/effective_from\s*<=\s*\$4::date/i);
    expect(params[3]).toBe("2023-06-15");
  });

  it("is accessible to non-owner members (resolve does not require owner role)", async () => {
    stubActualRole = "member";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(
      "/tax-rules/resolve?tax_category=standard_taxable&country_code=AE",
    );

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(false);
  });

  it("returns 400 when tax_category query param has an invalid value", async () => {
    const res = await request(app).get(
      "/tax-rules/resolve?tax_category=bad_value&country_code=AE",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category must be one of/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when location_id query param is not a valid integer", async () => {
    const res = await request(app).get(
      "/tax-rules/resolve?tax_category=standard_taxable&country_code=AE&location_id=abc",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location_id must be a valid integer/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when date query param is not in YYYY-MM-DD format", async () => {
    const res = await request(app).get(
      "/tax-rules/resolve?tax_category=standard_taxable&country_code=AE&date=not-a-date",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date must be in YYYY-MM-DD format/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when date query param passes the regex but is a semantically impossible calendar date", async () => {
    const res = await request(app).get(
      "/tax-rules/resolve?tax_category=standard_taxable&country_code=AE&date=2026-99-99",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid calendar date/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
