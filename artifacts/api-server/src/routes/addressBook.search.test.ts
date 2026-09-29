import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const { mockDbQuery } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "workspace_1";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/driverTokenAuth", () => ({
  requireDriverToken: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  driverAuthed: () => ({ workspaceOwnerId: "workspace_1" }),
}));

vi.mock("../jobs/addressBookBackfill", () => ({
  runBackfill: vi.fn(),
}));

vi.mock("../lib/addressBookAutoLink", () => ({
  assessAndGeocode: vi.fn(),
  qualifySharedAlias: (alias: string) => ({
    accepted: true,
    normalizedAlias: alias.toLowerCase().trim(),
    reason: "accepted",
    requiresOwnerApproval: false,
  }),
}));

import addressBookRouter from "./addressBook";

const PLACE_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  canonical_name: "Golden Gate Residence",
  place_type: "residence",
  area: "Jumeirah",
  city_id: null,
  city_name: null,
  canonical_address: null,
  latitude: null,
  longitude: null,
  entrance_notes: null,
  verification_state: "unverified",
  ai_invalid: false,
  delivery_count: "0",
  alias_count: "1",
  contact_count: "1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", addressBookRouter);
  return app;
}

function configureListQueries(): void {
  mockDbQuery.mockImplementation((sql: string) => {
    const normalizedSql = sql.trimStart();
    if (normalizedSql.includes("LIMIT")) {
      return Promise.resolve({ rows: [PLACE_ROW], rowCount: 1 });
    }
    if (
      normalizedSql.startsWith("SELECT COUNT(*)::text AS total FROM places p")
    ) {
      return Promise.resolve({ rows: [{ total: "1" }], rowCount: 1 });
    }
    if (normalizedSql.includes("COUNT(*) FILTER")) {
      return Promise.resolve({
        rows: [{ total: "1", unverified: "1", recently_delivered: "0" }],
        rowCount: 1,
      });
    }
    throw new Error(`Unexpected query in Address Book list test: ${sql}`);
  });
}

function rowsQueryCall(): [string, unknown[]] {
  const call = mockDbQuery.mock.calls.find(([sql]) =>
    String(sql).includes("LIMIT"),
  );
  expect(call).toBeDefined();
  return call as [string, unknown[]];
}

describe("GET /api/address-book/places search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    configureListQueries();
  });

  it.each([
    ["q", "the dashboard query parameter"],
    ["search", "the documented API query parameter"],
  ])("filters by %s (%s)", async (queryKey) => {
    const response = await request(makeApp())
      .get("/api/address-book/places")
      .query({ [queryKey]: "Golden Gate" });

    expect(response.status).toBe(200);
    expect(response.body.places).toHaveLength(1);

    const [sql, params] = rowsQueryCall();
    expect(params).toEqual(["workspace_1", "%Golden Gate%", 50, 0]);
    expect(sql).toContain("p.workspace_owner_id = $1");
    expect(sql).toContain("p.archived_at IS NULL");
    expect(sql).toContain("p.canonical_name ILIKE $2 ESCAPE '\\'");
    expect(sql).toContain("p.area ILIKE $2 ESCAPE '\\'");
    expect(sql).toContain("pa.alias_text ILIKE $2 ESCAPE '\\'");
    expect(sql).toContain("c.display_name ILIKE $2 ESCAPE '\\'");
    expect(sql).toContain("c.first_name ILIKE $2 ESCAPE '\\'");
    expect(sql).toContain("c.last_name ILIKE $2 ESCAPE '\\'");
    expect(sql).toContain("c.phone ILIKE $2 ESCAPE '\\'");
  });

  it("uses the dashboard query when both query parameter names are supplied", async () => {
    const response = await request(makeApp())
      .get("/api/address-book/places")
      .query({ q: "Golden Gate", search: "ignored" });

    expect(response.status).toBe(200);
    expect(rowsQueryCall()[1]).toEqual(["workspace_1", "%Golden Gate%", 50, 0]);
  });

  it("keeps blank searches as the normal unfiltered paginated list", async () => {
    const response = await request(makeApp())
      .get("/api/address-book/places")
      .query({ q: "   " });

    expect(response.status).toBe(200);
    const [sql, params] = rowsQueryCall();
    expect(sql).not.toContain("ILIKE");
    expect(params).toEqual(["workspace_1", 50, 0]);

    const countCall = mockDbQuery.mock.calls.find(([query]) =>
      String(query)
        .trimStart()
        .startsWith("SELECT COUNT(*)::text AS total FROM places p"),
    );
    expect(countCall?.[1]).toEqual(["workspace_1"]);
  });

  it("escapes wildcard characters before passing the search to SQL", async () => {
    const response = await request(makeApp())
      .get("/api/address-book/places")
      .query({ q: "100%_\\escape" });

    expect(response.status).toBe(200);
    expect(rowsQueryCall()[1]).toEqual([
      "workspace_1",
      "%100\\%\\_\\\\escape%",
      50,
      0,
    ]);
  });
});