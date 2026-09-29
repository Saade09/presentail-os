import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
let workspaceRole: "owner" | "member" = "owner";
let allowedPages: string[] | null = null;
vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
  withTransaction: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "ws-1";
    wreq.workspaceRole = workspaceRole;
    wreq.workspaceActualRole = workspaceRole;
    wreq.allowedPages = allowedPages;
    wreq.userId = "user-1";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, page: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(page),
}));

vi.mock("../lib/defaults", () => ({
  findCountryByCode: () => null,
  findCountryByName: () => null,
  phoneCountrySql: () => "NULL",
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/genderInference", () => ({
  queueGenderInference: vi.fn(),
}));

vi.mock("../lib/respondio", () => ({
  isRespondIoEnabled: vi.fn(() => false),
  findOrCreateContactByPhone: vi.fn(),
  getRespondIoContactUrl: vi.fn(() => null),
}));

import contactsDashboardRouter from "./contactsDashboard";

const app = express();
app.use(express.json());
app.use("/api", contactsDashboardRouter);

const contactRow = {
  id: "c-1",
  first_name: "Ahmad",
  last_name: "Khalil",
  display_name: "Ahmad Khalil",
  email: "ahmad@example.com",
  phone: "+9613257533",
  tags: [],
  created_at: "2026-07-01T10:00:00.000Z",
  is_customer: true,
  is_recipient: false,
  orders_placed: 2,
  last_order_at: "2026-07-01T10:00:00.000Z",
  customer_id: null,
  total_spent_usd: "100",
  country_raw: "lb",
  is_vip: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  workspaceRole = "owner";
  allowedPages = null;
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe("contacts page permission", () => {
  it("rejects members without customers access before reading contact data", async () => {
    workspaceRole = "member";
    allowedPages = ["orders"];

    const res = await request(app).get("/api/contacts");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("allows owners and members with customers access", async () => {
    workspaceRole = "member";
    allowedPages = ["customers"];
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await request(app).get("/api/contacts");

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Phone search: token-based matching
// ---------------------------------------------------------------------------

describe("GET /api/contacts — phone search", () => {
  it("uses phone_search_tokens unnest for a local-format query (≥4 digits)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [contactRow] });

    const res = await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("03257"),
    );
    expect(res.status).toBe(200);

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const searchSql = allSqls.find((s) => s.includes("unnest(c.phone_search_tokens)"));
    expect(searchSql).toBeTruthy();
  });

  it("includes the IS NULL fallback for un-backfilled contacts in phone search", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [contactRow] });

    await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("03257"),
    );

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const searchSql = allSqls.find((s) => s.includes("phone_search_tokens IS NULL"));
    expect(searchSql).toBeTruthy();
    const regexpSql = allSqls.find((s) => s.includes("regexp_replace"));
    expect(regexpSql).toBeTruthy();
  });

  it("passes a prefix LIKE param for the token match and a substring param for the legacy fallback", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("03257"),
    );

    const allParams: unknown[][] = mockDbQuery.mock.calls.map(([, p]: [string, unknown[]]) => p);
    const searchParams = allParams.find((ps) =>
      ps.some((p) => typeof p === "string" && p.includes("03257")),
    );
    expect(searchParams).toBeTruthy();
    const hasPrefix = searchParams!.some(
      (p) => typeof p === "string" && /03257%$/.test(p),
    );
    const hasSubstring = searchParams!.some(
      (p) => typeof p === "string" && /^%.*03257.*%$/.test(p),
    );
    expect(hasPrefix).toBe(true);
    expect(hasSubstring).toBe(true);
  });

  it("matches an international E.164 format query via token search", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [contactRow] });

    await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("+9613257533"),
    );

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const searchSql = allSqls.find((s) => s.includes("unnest(c.phone_search_tokens)"));
    expect(searchSql).toBeTruthy();
  });

  it("strips spaces and hyphens from phone query before matching", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("+961 03-257"),
    );

    const allParams: unknown[][] = mockDbQuery.mock.calls.map(([, p]: [string, unknown[]]) => p);
    const searchParams = allParams.find((ps) =>
      ps.some((p) => typeof p === "string" && p.includes("96103257")),
    );
    expect(searchParams).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Name and email searches: should NOT use token matching
// ---------------------------------------------------------------------------

describe("GET /api/contacts — name search", () => {
  it("uses ILIKE on name fields for a letter query", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [contactRow] });

    await request(app).get("/api/contacts?search=Ahmad");

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const nameSql = allSqls.find((s) => s.includes("ILIKE"));
    expect(nameSql).toBeTruthy();
    const tokenSql = allSqls.find((s) => s.includes("unnest(c.phone_search_tokens)"));
    expect(tokenSql).toBeUndefined();
  });

  it("does not confuse a name query with a phone query", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get("/api/contacts?search=" + encodeURIComponent("Jane Doe"));

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const tokenSql = allSqls.find((s) => s.includes("unnest(c.phone_search_tokens)"));
    expect(tokenSql).toBeUndefined();
  });
});

describe("GET /api/contacts — email search", () => {
  it("uses lower LIKE on email for an @-containing query", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [contactRow] });

    await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("ahmad@example.com"),
    );

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const emailSql = allSqls.find((s) => s.includes("lower(COALESCE(c.email"));
    expect(emailSql).toBeTruthy();
    const tokenSql = allSqls.find((s) => s.includes("unnest(c.phone_search_tokens)"));
    expect(tokenSql).toBeUndefined();
  });

  it("lowercases the email query param", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get(
      "/api/contacts?search=" + encodeURIComponent("Ahmad@Example.COM"),
    );

    const allParams: unknown[][] = mockDbQuery.mock.calls.map(([, p]: [string, unknown[]]) => p);
    const searchParams = allParams.find((ps) =>
      ps.some((p) => typeof p === "string" && p.includes("ahmad@example.com")),
    );
    expect(searchParams).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Short/ambiguous queries: use plain ILIKE fallback
// ---------------------------------------------------------------------------

describe("GET /api/contacts — short/fallback search", () => {
  it("falls back to plain ILIKE for a query with fewer than 4 digits and no letters", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get("/api/contacts?search=032");

    const allSqls: string[] = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    const tokenSql = allSqls.find((s) => s.includes("unnest(c.phone_search_tokens)"));
    expect(tokenSql).toBeUndefined();
    const ilikeSql = allSqls.find((s) => s.includes("ILIKE"));
    expect(ilikeSql).toBeTruthy();
  });
});
