import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbClientQuery = vi.fn();
const mockDbClientRelease = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockDbClientQuery(...args),
      release: mockDbClientRelease,
    }),
  },
  withTransaction: async (client: { query: (...a: unknown[]) => unknown }, fn: () => Promise<unknown>) => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      throw err;
    }
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

// resolveWorkspace injects workspace props; workspace() casts the request.
// We replace resolveWorkspace with a configurable stub that sets the context.
let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogDataWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("image-size", () => ({
  imageSize: vi.fn(() => ({ width: 300, height: 300 })),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import brandsRouter from "./brands";

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
  app.use(brandsRouter);
  return app;
}

// Minimal 1×1 PNG binary (valid image, but imageSize mock controls dimensions)
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
  "hex",
);

describe("GET /brands/:id/analytics — tenant isolation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "analytics_owner";
  });

  it("scopes every matched order to the resolved workspace", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ name: "Acme" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ total_revenue: "0", total_orders: "0", total_units: "0" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ total_products: "1", active_products: "1" }],
      });

    const res = await request(app).get("/brands/7/analytics");

    expect(res.status).toBe(200);
    const analyticsCalls = mockDbQuery.mock.calls.slice(1, 6);
    expect(analyticsCalls).toHaveLength(5);
    for (const [sql, params] of analyticsCalls) {
      expect(String(sql)).toMatch(/o\.workspace_owner_id\s*=\s*\$1/i);
      expect(params[0]).toBe("analytics_owner");
    }
  });
});

// ---------------------------------------------------------------------------
// GET /brands
// ---------------------------------------------------------------------------

describe("GET /brands — list brands", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 200 with brands array on success", async () => {
    // GET /brands fires two queries in parallel via Promise.all:
    //   1. the brands SELECT (with sticker counts)
    //   2. a workspace-level completed job count
    // Both must be mocked or the second resolves to undefined, crashing the route with a 500.
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Acme", created_at: "2024-01-01", sticker_count: "3", has_logo: true },
      ],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "5" }] }); // job count query

    const res = await request(app).get("/brands");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brands");
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].name).toBe("Acme");
  });

  it("returns 200 with an empty array when no brands exist", async () => {
    // Same two-query pattern — brands first, job count second.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] }); // job count query

    const res = await request(app).get("/brands");

    expect(res.status).toBe(200);
    expect(res.body.brands).toEqual([]);
  });

  it("queries using the workspace owner id from context", async () => {
    stubWorkspaceOwnerId = "ws_abc";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] }); // job count query

    await request(app).get("/brands");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_abc");
    expect(sql).toMatch(/workspace_owner_id/i);
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        // name is required string but null here triggers Zod failure
        { id: 1, name: null, created_at: "2024-01-01", sticker_count: "3", has_logo: true },
      ],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const res = await request(app).get("/brands");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /brands", err: expect.any(Array) }),
      "Response validation failed",
    );
  });

  it("returns 200 with brands and workspaceJobCount=0 when the job count query fails", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, name: "Acme", created_at: "2024-01-01", sticker_count: "2", has_logo: true }],
    });
    mockDbQuery.mockRejectedValueOnce(new Error("DB connection lost")); // job count query fails

    const res = await request(app).get("/brands");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brands");
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].name).toBe("Acme");
    expect(res.body.workspaceJobCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id
// ---------------------------------------------------------------------------

describe("GET /brands/:id — single brand", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 200 with brand details when found", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 7, name: "Beta", created_at: "2024-01-02", sticker_count: "0", has_logo: false }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/7");

    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe("Beta");
  });

  it("returns 404 when brand does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/brands/999");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });
});

// ---------------------------------------------------------------------------
// POST /brands — create
// ---------------------------------------------------------------------------

describe("POST /brands — create a brand", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app)
      .post("/brands")
      .field("name", "NewBrand")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to create brands/i);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/brands")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it("returns 400 when logo file is missing", async () => {
    const res = await request(app).post("/brands").field("name", "NewBrand");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logo image is required/i);
  });

  it("returns 400 when logo mime type is not allowed", async () => {
    const res = await request(app)
      .post("/brands")
      .field("name", "NewBrand")
      .attach("logo", TINY_PNG, { filename: "logo.gif", contentType: "image/gif" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg, png, or webp/i);
  });

  it("returns 400 when logo is not square", async () => {
    const { imageSize } = await import("image-size");
    vi.mocked(imageSize).mockReturnValueOnce({ width: 400, height: 300 } as ReturnType<typeof imageSize>);

    const res = await request(app)
      .post("/brands")
      .field("name", "NewBrand")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/square/i);
  });

  it("returns 400 when logo is smaller than 200×200", async () => {
    const { imageSize } = await import("image-size");
    vi.mocked(imageSize).mockReturnValueOnce({ width: 100, height: 100 } as ReturnType<typeof imageSize>);

    const res = await request(app)
      .post("/brands")
      .field("name", "NewBrand")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it("returns 409 when a brand with the same name already exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .post("/brands")
      .field("name", "Existing")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns 201 with brand data on successful creation", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // name uniqueness check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                         // BEGIN
      .mockResolvedValueOnce({                                     // INSERT brands
        rows: [{ id: 42, name: "NewBrand", created_at: "2024-06-01" }],
      })
      .mockResolvedValueOnce({ rows: [] })                         // INSERT brand_logos
      .mockResolvedValueOnce({ rows: [] });                        // COMMIT

    const res = await request(app)
      .post("/brands")
      .field("name", "NewBrand")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.brand.name).toBe("NewBrand");
    expect(res.body.brand.has_logo).toBe(true);
    expect(res.body.brand.sticker_count).toBe("0");
  });

  it("allows designers to create brands", async () => {
    stubActualRole = "designer";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // name uniqueness check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                         // BEGIN
      .mockResolvedValueOnce({                                     // INSERT brands
        rows: [{ id: 10, name: "DesignerBrand", created_at: "2024-06-01" }],
      })
      .mockResolvedValueOnce({ rows: [] })                         // INSERT brand_logos
      .mockResolvedValueOnce({ rows: [] });                        // COMMIT

    const res = await request(app)
      .post("/brands")
      .field("name", "DesignerBrand")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// PATCH /brands/:id — rename
// ---------------------------------------------------------------------------

describe("PATCH /brands/:id — rename a brand", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app).patch("/brands/1").send({ name: "Renamed" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to edit brands/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).patch("/brands/abc").send({ name: "Renamed" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 400 when name is missing or empty", async () => {
    const res = await request(app).patch("/brands/1").send({ name: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it("returns 409 when the new name conflicts with another brand", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 });

    const res = await request(app).patch("/brands/1").send({ name: "Taken" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // name check — no conflict
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE returns nothing

    const res = await request(app).patch("/brands/999").send({ name: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/brand not found/i);
  });

  it("returns 200 with updated brand on success", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // name check — no conflict
      .mockResolvedValueOnce({                           // UPDATE
        rows: [{ id: 1, name: "Renamed", created_at: "2024-01-01" }],
        rowCount: 1,
      });

    const res = await request(app).patch("/brands/1").send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe("Renamed");
  });

  it("allows a designer to rename a brand", async () => {
    stubActualRole = "designer";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // name check — no conflict
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: "DesignerRename", created_at: "2024-01-01" }],
        rowCount: 1,
      });

    const res = await request(app).patch("/brands/1").send({ name: "DesignerRename" });

    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe("DesignerRename");
  });
});

// ---------------------------------------------------------------------------
// DELETE /brands/:id — delete
// ---------------------------------------------------------------------------

describe("DELETE /brands/:id — delete a brand", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to delete brands/i);
  });

  it("returns 200 when a member has the brands.delete allowedPage", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.delete"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 403 with the correct message when a member lacks brands.delete in allowedPages", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.view"];

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to delete brands/i);
  });

  it("returns 403 when a member has an empty allowedPages array", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to delete brands/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).delete("/brands/bad-id");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 409 with a descriptive message when the brand has stickers (sticker-blocking guard)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] }); // sticker check

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/3 sticker/i);
    expect(res.body.error).toMatch(/reassign or delete/i);
  });

  it("uses singular 'sticker' in the 409 message when exactly one sticker is assigned", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(409);
    // message should say "1 sticker" not "1 stickers"
    expect(res.body.error).toMatch(/1 sticker[^s]/);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // sticker check — none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // DELETE returns nothing

    const res = await request(app).delete("/brands/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/brand not found/i);
  });

  it("returns 200 ok on successful deletion", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // sticker check — none
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // DELETE succeeds

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("issues a DELETE SQL containing workspace_owner_id for isolation", async () => {
    stubWorkspaceOwnerId = "ws_isolated";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).delete("/brands/5");

    const deleteSql: string = mockDbQuery.mock.calls[1][0];
    const deleteParams: unknown[] = mockDbQuery.mock.calls[1][1];
    expect(deleteSql.toUpperCase()).toContain("DELETE");
    expect(deleteParams).toContain("ws_isolated");
  });

  it("allows a designer to delete a brand", async () => {
    stubActualRole = "designer";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // sticker check — none
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // DELETE succeeds

    const res = await request(app).delete("/brands/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/cover-photos — list cover photos
// ---------------------------------------------------------------------------

describe("GET /brands/:id/cover-photos — list cover photos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/not-a-number/cover-photos");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // brand check

    const res = await request(app).get("/brands/99/cover-photos");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/brand not found/i);
  });

  it("returns 200 with an empty coverPhotos array when none exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [] });                        // cover photos query

    const res = await request(app).get("/brands/1/cover-photos");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("coverPhotos");
    expect(res.body.coverPhotos).toEqual([]);
  });

  it("returns 200 with coverPhotos metadata rows on success", async () => {
    const photo = { id: 5, brand_id: 1, label: "Christmas", photo_mime: "image/png", created_at: "2024-12-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [photo] });

    const res = await request(app).get("/brands/1/cover-photos");

    expect(res.status).toBe(200);
    expect(res.body.coverPhotos).toHaveLength(1);
    expect(res.body.coverPhotos[0].label).toBe("Christmas");
  });

  it("passes the workspace owner id to the cover-photos query", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get("/brands/1/cover-photos");

    const [, params] = mockDbQuery.mock.calls[1];
    expect(params).toContain("ws_scoped");
  });
});

// ---------------------------------------------------------------------------
// POST /brands/:id/cover-photos — upload a cover photo
// ---------------------------------------------------------------------------

describe("POST /brands/:id/cover-photos — upload a cover photo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app)
      .post("/brands/bad-id/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // brand check

    const res = await request(app)
      .post("/brands/99/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/brand not found/i);
  });

  it("returns 400 when label is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/label must be one of/i);
  });

  it("returns 400 when label is not in the allowed list", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Halloween")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/label must be one of/i);
  });

  it("returns 400 when photo file is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photo image is required/i);
  });

  it("returns 400 when photo MIME type is not allowed", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.gif", contentType: "image/gif" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg, png, or webp/i);
  });

  it("returns 201 with the new cover photo metadata on success", async () => {
    const inserted = { id: 10, brand_id: 1, label: "Christmas", photo_mime: "image/png", created_at: "2024-12-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [inserted] });               // INSERT

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("coverPhoto");
    expect(res.body.coverPhoto.label).toBe("Christmas");
    expect(res.body.coverPhoto.id).toBe(10);
  });

  it("allows a designer to upload a cover photo", async () => {
    stubActualRole = "designer";
    const inserted = { id: 11, brand_id: 1, label: "Easter", photo_mime: "image/png", created_at: "2024-04-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [inserted] });

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Easter")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(201);
  });

  it("accepts a WebP photo", async () => {
    const inserted = { id: 12, brand_id: 1, label: "All Year", photo_mime: "image/webp", created_at: "2024-01-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [inserted] });

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "All Year")
      .attach("photo", TINY_PNG, { filename: "cover.webp", contentType: "image/webp" });

    expect(res.status).toBe(201);
    expect(res.body.coverPhoto.photo_mime).toBe("image/webp");
  });
});

// ---------------------------------------------------------------------------
// DELETE /brands/:id/cover-photos/:photoId — remove a cover photo
// ---------------------------------------------------------------------------

describe("DELETE /brands/:id/cover-photos/:photoId — remove a cover photo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).delete("/brands/bad/cover-photos/5");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 400 for a non-numeric photo id", async () => {
    const res = await request(app).delete("/brands/1/cover-photos/bad");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 when the cover photo does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE finds nothing

    const res = await request(app).delete("/brands/1/cover-photos/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/cover photo not found/i);
  });

  it("returns 200 ok on successful deletion", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE succeeds

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("scopes the DELETE to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).delete("/brands/1/cover-photos/5");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_scoped");
  });

  it("allows a designer to delete a cover photo", async () => {
    stubActualRole = "designer";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/cover-photos/:photoId/image — serve binary image
// ---------------------------------------------------------------------------

describe("GET /brands/:id/cover-photos/:photoId/image — serve binary image", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/bad/cover-photos/5/image");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 400 for a non-numeric photo id", async () => {
    const res = await request(app).get("/brands/1/cover-photos/bad/image");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 when the cover photo does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/brands/1/cover-photos/999/image");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/cover photo not found/i);
  });

  it("returns 200 with the correct Content-Type header and binary body", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ photo_data: TINY_PNG, photo_mime: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/cover-photos/5/image");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.compare(res.body as Buffer, TINY_PNG)).toBe(0);
  });

  it("sets the Cache-Control header on a successful response", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ photo_data: TINY_PNG, photo_mime: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/cover-photos/5/image");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).toMatch(/max-age/);
  });

  it("serves the correct MIME type for a WebP image", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ photo_data: TINY_PNG, photo_mime: "image/webp" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/cover-photos/7/image");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/webp/);
  });

  it("scopes the query to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ photo_data: TINY_PNG, photo_mime: "image/png" }],
      rowCount: 1,
    });

    await request(app).get("/brands/1/cover-photos/5/image");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_scoped");
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/logos — list logos
// ---------------------------------------------------------------------------

describe("GET /brands/:id/logos — list logos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/bad/logos");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // brand check
    const res = await request(app).get("/brands/99/logos");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/brand not found/i);
  });

  it("returns 200 with an empty logos array when none exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [] });                        // logos query
    const res = await request(app).get("/brands/1/logos");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("logos");
    expect(res.body.logos).toEqual([]);
  });

  it("returns 200 with logo metadata rows on success", async () => {
    const logo = { id: 3, brand_id: 1, label: "Primary", logo_mime: "image/png", sort_order: 0, created_at: "2024-01-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [logo] });
    const res = await request(app).get("/brands/1/logos");
    expect(res.status).toBe(200);
    expect(res.body.logos).toHaveLength(1);
    expect(res.body.logos[0].label).toBe("Primary");
  });

  it("scopes the query to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get("/brands/1/logos");
    const [, params] = mockDbQuery.mock.calls[1];
    expect(params).toContain("ws_scoped");
  });
});

// ---------------------------------------------------------------------------
// POST /brands/:id/logos — upload a logo
// ---------------------------------------------------------------------------

describe("POST /brands/:id/logos — upload a logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app)
      .post("/brands/bad/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // brand check
    const res = await request(app)
      .post("/brands/99/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/brand not found/i);
  });

  it("returns 400 when the logo file is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    const res = await request(app).post("/brands/1/logos").field("label", "Primary");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logo image is required/i);
  });

  it("returns 400 when the MIME type is not allowed", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.gif", contentType: "image/gif" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg, png, or webp/i);
  });

  it("returns 400 when the logo is not square", async () => {
    const { imageSize } = await import("image-size");
    vi.mocked(imageSize).mockReturnValueOnce({ width: 400, height: 300 } as ReturnType<typeof imageSize>);
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/square/i);
  });

  it("returns 400 when the logo is smaller than 200×200", async () => {
    const { imageSize } = await import("image-size");
    vi.mocked(imageSize).mockReturnValueOnce({ width: 100, height: 100 } as ReturnType<typeof imageSize>);
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it("returns 201 with logo metadata on successful upload", async () => {
    const inserted = { id: 10, brand_id: 1, label: "Dark mode", logo_mime: "image/png", sort_order: 1, created_at: "2024-01-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [{ max: 0 }] })              // max sort_order
      .mockResolvedValueOnce({ rows: [inserted] });               // INSERT
    const res = await request(app)
      .post("/brands/1/logos")
      .field("label", "Dark mode")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("logo");
    expect(res.body.logo.label).toBe("Dark mode");
  });

  it("allows a designer to upload a logo", async () => {
    stubActualRole = "designer";
    const inserted = { id: 11, brand_id: 1, label: null, logo_mime: "image/png", sort_order: 0, created_at: "2024-01-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ max: null }] })
      .mockResolvedValueOnce({ rows: [inserted] });
    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/logos/:logoId/image — serve binary logo image
// ---------------------------------------------------------------------------

describe("GET /brands/:id/logos/:logoId/image — serve binary logo image", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/bad/logos/5/image");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 400 for a non-numeric logo id", async () => {
    const res = await request(app).get("/brands/1/logos/bad/image");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 when the logo does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/brands/1/logos/999/image");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/logo not found/i);
  });

  it("returns 200 with correct Content-Type and binary body", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });
    const res = await request(app).get("/brands/1/logos/5/image");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.compare(res.body as Buffer, TINY_PNG)).toBe(0);
  });

  it("sets the Cache-Control header", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });
    const res = await request(app).get("/brands/1/logos/5/image");
    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).toMatch(/max-age/);
  });
});

// ---------------------------------------------------------------------------
// PATCH /brands/:id/logos/:logoId — update label
// ---------------------------------------------------------------------------

describe("PATCH /brands/:id/logos/:logoId — update label", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app).patch("/brands/1/logos/5").send({ label: "New" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).patch("/brands/bad/logos/5").send({ label: "New" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 400 for a non-numeric logo id", async () => {
    const res = await request(app).patch("/brands/1/logos/bad").send({ label: "New" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 when the logo does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).patch("/brands/1/logos/999").send({ label: "Ghost" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/logo not found/i);
  });

  it("returns 200 with updated logo metadata on success", async () => {
    const updated = { id: 5, brand_id: 1, label: "Dark mode", logo_mime: "image/png", sort_order: 1, created_at: "2024-01-01" };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    const res = await request(app).patch("/brands/1/logos/5").send({ label: "Dark mode" });
    expect(res.status).toBe(200);
    expect(res.body.logo.label).toBe("Dark mode");
  });

  it("allows a designer to update a logo label", async () => {
    stubActualRole = "designer";
    const updated = { id: 5, brand_id: 1, label: "Updated", logo_mime: "image/png", sort_order: 1, created_at: "2024-01-01" };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    const res = await request(app).patch("/brands/1/logos/5").send({ label: "Updated" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PUT /brands/:id/logos/reorder — reorder logos
// ---------------------------------------------------------------------------

describe("PUT /brands/:id/logos/reorder — reorder logos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 2] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).put("/brands/bad/logos/reorder").send({ ids: [1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand id/i);
  });

  it("returns 400 when ids is not an array", async () => {
    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/i);
  });

  it("returns 400 when ids contains duplicates", async () => {
    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 1, 2] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicates/i);
  });

  it("returns 400 when ids do not match existing logos", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] }); // existing
    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 99] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must match all existing logos/i);
  });

  it("returns 200 ok on successful reorder", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] }) // existing logos
      .mockResolvedValueOnce({ rows: [] });                      // atomic UPDATE via unnest
    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [2, 1] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows a designer to reorder logos", async () => {
    stubActualRole = "designer";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [2, 1] });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /brands/:id/logos/:logoId — soft-delete a logo
// ---------------------------------------------------------------------------

describe("DELETE /brands/:id/logos/:logoId — soft-delete a logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    // Default: client queries succeed (BEGIN / ROLLBACK / COMMIT)
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app).delete("/brands/1/logos/5");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).delete("/brands/bad/logos/5");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 400 for a non-numeric logo id", async () => {
    const res = await request(app).delete("/brands/1/logos/bad");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 when the logo does not exist (even if brand has only one logo)", async () => {
    // The FOR UPDATE query returns id=5 (the only active logo); requested id=999 is absent.
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })           // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [] });           // ROLLBACK
    const res = await request(app).delete("/brands/1/logos/999");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/logo not found/i);
  });

  it("returns 409 when trying to delete the only remaining logo", async () => {
    // Only id=5 is active → is_last=true.
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })           // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [] });           // ROLLBACK
    const res = await request(app).delete("/brands/1/logos/5");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/at least one logo/i);
  });

  it("returns 200 ok on successful soft-delete", async () => {
    // Two active logos → logo_exists=true, is_last=false.
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                          // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 10 }] })  // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })            // UPDATE brand_logos
      .mockResolvedValueOnce({ rows: [] });                          // COMMIT
    const res = await request(app).delete("/brands/1/logos/5");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows a designer to delete a logo", async () => {
    stubActualRole = "designer";
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 10 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete("/brands/1/logos/5");
    expect(res.status).toBe(200);
  });

  it("rolls back the transaction when the UPDATE fails after a successful check", async () => {
    const dbError = new Error("DB write error");
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                         // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 10 }] }) // SELECT ... FOR UPDATE
      .mockRejectedValueOnce(dbError)                              // UPDATE brand_logos fails
      .mockResolvedValueOnce({ rows: [] });                         // ROLLBACK
    const res = await request(app).delete("/brands/1/logos/5");
    expect(res.status).toBe(500);
    const rollbackCall = mockDbClientQuery.mock.calls.find(([sql]) =>
      /^ROLLBACK$/i.test(String(sql)),
    );
    expect(rollbackCall).toBeDefined();
    expect(mockDbClientRelease).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /brands/:id/logos/:logoId/restore — restore a soft-deleted logo
// ---------------------------------------------------------------------------

describe("POST /brands/:id/logos/:logoId/restore — restore a logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app).post("/brands/1/logos/5/restore");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 404 when the logo is not found or not deleted", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/brands/1/logos/999/restore");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/logo not found or not deleted/i);
  });

  it("returns 200 ok on successful restore", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).post("/brands/1/logos/5/restore");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows a designer to restore a logo", async () => {
    stubActualRole = "designer";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).post("/brands/1/logos/5/restore");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /brands/:id/logos/:logoId/permanent — hard-delete a logo
// ---------------------------------------------------------------------------

describe("DELETE /brands/:id/logos/:logoId/permanent — hard-delete a logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app).delete("/brands/1/logos/5/permanent");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 404 when the logo does not exist or is not soft-deleted", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).delete("/brands/1/logos/999/permanent");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/logo not found or not soft-deleted/i);
  });

  it("returns 200 ok on successful permanent deletion of a soft-deleted logo", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/brands/1/logos/5/permanent");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("only deletes soft-deleted logos (deleted_at IS NOT NULL in query)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).delete("/brands/1/logos/5/permanent");
    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/deleted_at IS NOT NULL/i);
  });

  it("scopes the DELETE to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_isolated";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).delete("/brands/1/logos/5/permanent");
    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_isolated");
  });

  it("allows a designer to permanently delete a logo", async () => {
    stubActualRole = "designer";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/brands/1/logos/5/permanent");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /brands/:id/logo — legacy primary logo upload (transaction)
// ---------------------------------------------------------------------------

describe("PATCH /brands/:id/logo — legacy primary logo upload", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("returns 403 when caller lacks the required permission", async () => {
    stubActualRole = "customer_service_agent";
    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("returns 404 when the brand does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // brand check
    const res = await request(app)
      .patch("/brands/99/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(404);
  });

  it("returns 200 when an existing primary logo is updated (UPDATE path)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                             // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })     // SELECT primary logo
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE brand_logos
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE brands (legacy)
      .mockResolvedValueOnce({ rows: [] });                            // COMMIT
    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 200 when no primary logo exists (INSERT path)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })              // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT primary logo (none)
      .mockResolvedValueOnce({ rows: [] })              // INSERT brand_logos
      .mockResolvedValueOnce({ rows: [] })              // UPDATE brands (legacy)
      .mockResolvedValueOnce({ rows: [] });             // COMMIT
    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rolls back when the legacy brands UPDATE fails after the brand_logos UPDATE", async () => {
    const dbError = new Error("DB write error");
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                         // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 }) // SELECT primary logo
      .mockResolvedValueOnce({ rows: [] })                         // UPDATE brand_logos (succeeds)
      .mockRejectedValueOnce(dbError)                              // UPDATE brands (fails)
      .mockResolvedValueOnce({ rows: [] });                        // ROLLBACK
    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(500);
    const rollbackCall = mockDbClientQuery.mock.calls.find(([sql]) =>
      /^ROLLBACK$/i.test(String(sql)),
    );
    expect(rollbackCall).toBeDefined();
    expect(mockDbClientRelease).toHaveBeenCalled();
  });

  it("scopes the primary logo SELECT to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    const selectCall = mockDbClientQuery.mock.calls.find(([sql]) =>
      /SELECT.*brand_logos/i.test(String(sql)),
    );
    expect(selectCall).toBeDefined();
    const [, params] = selectCall as [string, unknown[]];
    expect(params).toContain("ws_scoped");
  });

  it("allows a designer to update the primary logo", async () => {
    stubActualRole = "designer";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/logo (backward-compat) — primary logo reflects sort_order
// ---------------------------------------------------------------------------

describe("GET /brands/:id/logo (backward-compat) — primary logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 404 when no active logos exist for the brand", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/brands/1/logo");
    expect(res.status).toBe(404);
  });

  it("returns the primary logo (lowest sort_order) as binary image", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });
    const res = await request(app).get("/brands/1/logo");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.compare(res.body as Buffer, TINY_PNG)).toBe(0);
  });

  it("queries by sort_order so primary logo changes after reorder", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });
    await request(app).get("/brands/1/logo");
    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/sort_order/i);
    expect(sql).toMatch(/deleted_at IS NULL/i);
  });

  it("scopes the query to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_primary";
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });
    await request(app).get("/brands/1/logo");
    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_primary");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — PATCH /brands/:id and POST /brands/:id/logos
// ---------------------------------------------------------------------------

describe("brands.manage permission — PATCH /brands/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to rename a brand (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // name uniqueness check — no conflict
      .mockResolvedValueOnce({
        rows: [{ id: 5, name: "Renamed", created_at: "2024-01-01" }],
        rowCount: 1,
      });

    const res = await request(app).patch("/brands/5").send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe("Renamed");
  });

  it("rejects a member without brands.manage when renaming a brand (403)", async () => {
    stubAllowedPages = ["brands", "brands.create"];

    const res = await request(app).patch("/brands/5").send({ name: "Renamed" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when renaming a brand (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app).patch("/brands/5").send({ name: "Renamed" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with undefined allowedPages when renaming a brand (403)", async () => {
    stubAllowedPages = null;

    const res = await request(app).patch("/brands/5").send({ name: "Renamed" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

describe("brands.manage permission — POST /brands/:id/logos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to upload a logo (201)", async () => {
    stubAllowedPages = ["brands.manage"];
    const inserted = {
      id: 20,
      brand_id: 1,
      label: null,
      logo_mime: "image/png",
      sort_order: 0,
      created_at: "2024-01-01",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [{ max: null }] })            // max sort_order
      .mockResolvedValueOnce({ rows: [inserted] });                // INSERT

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("logo");
    expect(res.body.logo.id).toBe(20);
  });

  it("rejects a member without brands.manage when uploading a logo (403)", async () => {
    stubAllowedPages = ["brands", "brands.edit"];

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when uploading a logo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — PATCH /brands/:id/logo (legacy primary logo)
// ---------------------------------------------------------------------------

describe("brands.manage permission — PATCH /brands/:id/logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to replace the primary logo (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    // brand check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    // transaction: BEGIN, SELECT primary logo, UPDATE brand_logos, UPDATE brands, COMMIT
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 }) // SELECT primary logo
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE brand_logos
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE brands (legacy)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("rejects a member without brands.manage when replacing the primary logo (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when replacing the primary logo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — PATCH /brands/:id/logos/:logoId (update label)
// ---------------------------------------------------------------------------

describe("brands.manage permission — PATCH /brands/:id/logos/:logoId", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to update a logo label (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 10, brand_id: 1, label: "Primary", logo_mime: "image/png", sort_order: 0, created_at: "2024-01-01" }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/brands/1/logos/10")
      .send({ label: "Primary" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("logo");
    expect(res.body.logo.label).toBe("Primary");
  });

  it("rejects a member without brands.manage when updating a logo label (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app)
      .patch("/brands/1/logos/10")
      .send({ label: "Primary" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when updating a logo label (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app)
      .patch("/brands/1/logos/10")
      .send({ label: "Primary" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — PUT /brands/:id/logos/reorder
// ---------------------------------------------------------------------------

describe("brands.manage permission — PUT /brands/:id/logos/reorder", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to reorder logos (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    // SELECT existing logos
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 })
      // UPDATE sort_order
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const res = await request(app)
      .put("/brands/1/logos/reorder")
      .send({ ids: [10, 20] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("rejects a member without brands.manage when reordering logos (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app)
      .put("/brands/1/logos/reorder")
      .send({ ids: [10, 20] });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when reordering logos (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app)
      .put("/brands/1/logos/reorder")
      .send({ ids: [10, 20] });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — DELETE /brands/:id/logos/:logoId (soft-delete)
// ---------------------------------------------------------------------------

describe("brands.manage permission — DELETE /brands/:id/logos/:logoId", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to soft-delete a logo (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    // transaction: BEGIN, SELECT FOR UPDATE (two logos so not last), UPDATE deleted_at, COMMIT
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE deleted_at
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app).delete("/brands/1/logos/10");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("rejects a member without brands.manage when soft-deleting a logo (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app).delete("/brands/1/logos/10");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when soft-deleting a logo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/logos/10");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — POST /brands/:id/logos/:logoId/restore
// ---------------------------------------------------------------------------

describe("brands.manage permission — POST /brands/:id/logos/:logoId/restore", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to restore a soft-deleted logo (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/brands/1/logos/10/restore");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("rejects a member without brands.manage when restoring a logo (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app).post("/brands/1/logos/10/restore");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when restoring a logo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app).post("/brands/1/logos/10/restore");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — DELETE /brands/:id/logos/:logoId/permanent (hard-delete)
// ---------------------------------------------------------------------------

describe("brands.manage permission — DELETE /brands/:id/logos/:logoId/permanent", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to permanently delete a logo (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/logos/10/permanent");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("rejects a member without brands.manage when permanently deleting a logo (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app).delete("/brands/1/logos/10/permanent");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when permanently deleting a logo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/logos/10/permanent");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — POST /brands/:id/cover-photos
// ---------------------------------------------------------------------------

describe("brands.manage permission — POST /brands/:id/cover-photos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to upload a cover photo (201)", async () => {
    stubAllowedPages = ["brands.manage"];
    const inserted = {
      id: 5,
      brand_id: 1,
      label: "Christmas",
      photo_mime: "image/png",
      created_at: "2024-01-01",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [inserted] });               // INSERT

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("coverPhoto");
    expect(res.body.coverPhoto.label).toBe("Christmas");
  });

  it("rejects a member without brands.manage when uploading a cover photo (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when uploading a cover photo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// brands.manage permission — DELETE /brands/:id/cover-photos/:photoId
// ---------------------------------------------------------------------------

describe("brands.manage permission — DELETE /brands/:id/cover-photos/:photoId", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("allows a member with brands.manage to delete a cover photo (200)", async () => {
    stubAllowedPages = ["brands.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("rejects a member without brands.manage when deleting a cover photo (403)", async () => {
    stubAllowedPages = ["brands", "brands.view"];

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a member with an empty allowedPages array when deleting a cover photo (403)", async () => {
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

describe("brands.create permission key — POST /brands", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed (not blocked by permission gate)", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    const res = await request(app).post("/brands").field("name", "NewBrand");

    expect(res.status).not.toBe(403);
  });

  it("member with brands.create in allowedPages can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create"];

    const res = await request(app).post("/brands").field("name", "NewBrand");

    expect(res.status).not.toBe(403);
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).post("/brands").field("name", "NewBrand");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to create brands/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).post("/brands").field("name", "NewBrand");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to create brands/i);
  });

  it("member with unrelated permissions but not brands.create gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.edit", "brands.manage-logos", "products"];

    const res = await request(app).post("/brands").field("name", "NewBrand");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to create brands/i);
  });

  it("does not query the database when a member lacks brands.create", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app).post("/brands").field("name", "NewBrand");

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// brands.edit permission key — PATCH /brands/:id
// ---------------------------------------------------------------------------

describe("brands.edit permission key — PATCH /brands/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: "Acme", description: null, target_cogs: null, created_at: "2024-01-01" }], rowCount: 1 });

    const res = await request(app).patch("/brands/1").send({ name: "Acme" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brand");
  });

  it("member with brands.edit in allowedPages can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.edit"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: "Acme", description: null, target_cogs: null, created_at: "2024-01-01" }], rowCount: 1 });

    const res = await request(app).patch("/brands/1").send({ name: "Acme" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brand");
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).patch("/brands/1").send({ name: "Acme" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to edit brands/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).patch("/brands/1").send({ name: "Acme" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to edit brands/i);
  });

  it("member with unrelated permissions but not brands.edit gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.manage-logos", "products"];

    const res = await request(app).patch("/brands/1").send({ name: "Acme" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to edit brands/i);
  });

  it("does not query the database when a member lacks brands.edit", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app).patch("/brands/1").send({ name: "Acme" });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// brands.manage-logos permission key
// Covers: PATCH /brands/:id/logo, POST /brands/:id/logos,
//         PATCH /brands/:id/logos/:logoId, PUT /brands/:id/logos/reorder,
//         DELETE /brands/:id/logos/:logoId, POST …/restore, DELETE …/permanent
// ---------------------------------------------------------------------------

describe("brands.manage-logos permission key — PATCH /brands/:id/logo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("owner can always proceed (gets past the permission gate)", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).not.toBe(403);
  });

  it("member with brands.manage-logos can proceed (gets past the permission gate)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).not.toBe(403);
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with unrelated permissions but not brands.manage-logos gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.edit", "brands.manage-cover-photos"];

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });
});

describe("brands.manage-logos permission key — POST /brands/:id/logos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed (gets past the permission gate)", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).not.toBe(403);
  });

  it("member with brands.manage-logos can proceed (gets past the permission gate)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).not.toBe(403);
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with unrelated permissions but not brands.manage-logos gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.edit", "brands.manage-card-message"];

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("does not query the database when a member lacks brands.manage-logos", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("brands.manage-logos permission key — PATCH /brands/:id/logos/:logoId", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, brand_id: 1, label: "Dark", logo_mime: "image/png", sort_order: 0, created_at: "2024-01-01" }],
      rowCount: 1,
    });

    const res = await request(app).patch("/brands/1/logos/5").send({ label: "Dark" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("logo");
  });

  it("member with brands.manage-logos can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, brand_id: 1, label: "Dark", logo_mime: "image/png", sort_order: 0, created_at: "2024-01-01" }],
      rowCount: 1,
    });

    const res = await request(app).patch("/brands/1/logos/5").send({ label: "Dark" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("logo");
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).patch("/brands/1/logos/5").send({ label: "Dark" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).patch("/brands/1/logos/5").send({ label: "Dark" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("does not query the database when a member lacks brands.manage-logos", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app).patch("/brands/1/logos/5").send({ label: "Dark" });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("brands.manage-logos permission key — PUT /brands/:id/logos/reorder", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage-logos can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 2] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [1, 2] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("does not query the database when a member lacks brands.manage-logos", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app).put("/brands/1/logos/reorder").send({ ids: [1] });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("brands.manage-logos permission key — DELETE /brands/:id/logos/:logoId", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("owner can always proceed (gets past the permission gate)", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 10 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete("/brands/1/logos/5");

    expect(res.status).not.toBe(403);
  });

  it("member with brands.manage-logos can proceed (gets past the permission gate)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 10 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete("/brands/1/logos/5");

    expect(res.status).not.toBe(403);
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).delete("/brands/1/logos/5");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/logos/5");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with unrelated permissions but not brands.manage-logos gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.edit", "brands.manage-cover-photos"];

    const res = await request(app).delete("/brands/1/logos/5");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });
});

describe("brands.manage-logos permission key — POST /brands/:id/logos/:logoId/restore", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/brands/1/logos/5/restore");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage-logos can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/brands/1/logos/5/restore");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).post("/brands/1/logos/5/restore");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).post("/brands/1/logos/5/restore");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });
});

describe("brands.manage-logos permission key — DELETE /brands/:id/logos/:logoId/permanent", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/logos/5/permanent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage-logos can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-logos"];

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/logos/5/permanent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).delete("/brands/1/logos/5/permanent");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/logos/5/permanent");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage logos/i);
  });
});

// ---------------------------------------------------------------------------
// brands.manage-cover-photos permission key
// Covers: POST /brands/:id/cover-photos, DELETE /brands/:id/cover-photos/:photoId
// ---------------------------------------------------------------------------

describe("brands.manage-cover-photos permission key — POST /brands/:id/cover-photos", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed (gets past the permission gate)", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).not.toBe(403);
  });

  it("member with brands.manage-cover-photos can proceed (gets past the permission gate)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-cover-photos"];

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).not.toBe(403);
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("member with unrelated permissions but not brands.manage-cover-photos gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.edit", "brands.manage-logos"];

    const res = await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("does not query the database when a member lacks brands.manage-cover-photos", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app)
      .post("/brands/1/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("brands.manage-cover-photos permission key — DELETE /brands/:id/cover-photos/:photoId", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage-cover-photos can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-cover-photos"];

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage cover photos/i);
  });

  it("does not query the database when a member lacks brands.manage-cover-photos", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app).delete("/brands/1/cover-photos/5");

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// brands.manage-card-message permission key
// Covers: PUT /brands/:id/card-message, DELETE /brands/:id/card-message
// ---------------------------------------------------------------------------

describe("brands.manage-card-message permission key — PUT /brands/:id/card-message", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed (gets past the permission gate)", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.jpg", contentType: "image/jpeg" });

    expect(res.status).not.toBe(403);
  });

  it("member with brands.manage-card-message can proceed (gets past the permission gate)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-card-message"];

    const res = await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.jpg", contentType: "image/jpeg" });

    expect(res.status).not.toBe(403);
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage card messages/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage card messages/i);
  });

  it("member with unrelated permissions but not brands.manage-card-message gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.edit", "brands.manage-logos", "brands.manage-cover-photos"];

    const res = await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage card messages/i);
  });

  it("does not query the database when a member lacks brands.manage-card-message", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.jpg", contentType: "image/jpeg" });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("brands.manage-card-message permission key — DELETE /brands/:id/card-message", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("owner can always proceed", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage-card-message can proceed", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage-card-message"];

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member without any allowedPages gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = null;

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage card messages/i);
  });

  it("member with an empty allowedPages array gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage card messages/i);
  });

  it("member with unrelated permissions but not brands.manage-card-message gets 403", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.create", "brands.manage-logos", "brands.manage-cover-photos"];

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/you do not have permission to manage card messages/i);
  });

  it("does not query the database when a member lacks brands.manage-card-message", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    await request(app).delete("/brands/1/card-message");

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// brands.manage legacy permission — unlocks every canManageBrand-gated route
// ---------------------------------------------------------------------------

describe("brands.manage legacy permission — unlocks every write route via canManageBrand", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage"];
    stubWorkspaceOwnerId = "owner_123";
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("POST /brands — passes the permission gate (returns 400, not 403)", async () => {
    const res = await request(app)
      .post("/brands")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("PATCH /brands/:id — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).patch("/brands/bad-id").send({ name: "X" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("PATCH /brands/:id/logo — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app)
      .patch("/brands/bad-id/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("POST /brands/:id/logos — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app)
      .post("/brands/bad-id/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("PATCH /brands/:id/logos/:logoId — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).patch("/brands/bad-id/logos/5").send({ label: "X" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("PUT /brands/:id/logos/reorder — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).put("/brands/bad-id/logos/reorder").send({ ids: [1] });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("DELETE /brands/:id/logos/:logoId — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).delete("/brands/bad-id/logos/5");
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("POST /brands/:id/logos/:logoId/restore — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).post("/brands/bad-id/logos/5/restore");
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("DELETE /brands/:id/logos/:logoId/permanent — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).delete("/brands/bad-id/logos/5/permanent");
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("PUT /brands/:id/card-message — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app)
      .put("/brands/bad-id/card-message")
      .attach("image", TINY_PNG, { filename: "msg.png", contentType: "image/png" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("DELETE /brands/:id/card-message — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).delete("/brands/bad-id/card-message");
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("POST /brands/:id/cover-photos — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app)
      .post("/brands/bad-id/cover-photos")
      .field("label", "Christmas")
      .attach("photo", TINY_PNG, { filename: "cover.png", contentType: "image/png" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("DELETE /brands/:id/cover-photos/:photoId — passes the permission gate (returns 400 on bad id, not 403)", async () => {
    const res = await request(app).delete("/brands/bad-id/cover-photos/5");
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("member with brands.manage but no other pages is NOT denied via 403 on PATCH /brands/:id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: "Renamed", created_at: "2024-01-01" }], rowCount: 1 });

    const res = await request(app).patch("/brands/1").send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe("Renamed");
  });

  it("member with brands.manage is NOT denied via 403 on POST /brands/:id/logos (full success)", async () => {
    const inserted = { id: 10, brand_id: 1, label: null, logo_mime: "image/png", sort_order: 0, created_at: "2024-01-01" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ max: null }] })
      .mockResolvedValueOnce({ rows: [inserted] });

    const res = await request(app)
      .post("/brands/1/logos")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("logo");
  });

  it("member with brands.manage is NOT denied via 403 on PUT /brands/:id/logos/reorder (full success)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).put("/brands/1/logos/reorder").send({ ids: [2, 1] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage is NOT denied via 403 on DELETE /brands/:id/logos/:logoId (full success)", async () => {
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 10 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete("/brands/1/logos/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage is NOT denied via 403 on POST /brands/:id/logos/:logoId/restore (full success)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/brands/1/logos/5/restore");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage is NOT denied via 403 on DELETE /brands/:id/logos/:logoId/permanent (full success)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/logos/5/permanent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage is NOT denied via 403 on DELETE /brands/:id/card-message (full success)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("member with brands.manage is NOT denied via 403 on DELETE /brands/:id/cover-photos/:photoId (full success)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/cover-photos/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// updated_at timestamp assertions
// Verifies that logo upload and card-message mutations touch updated_at = now()
// ---------------------------------------------------------------------------

describe("PATCH /brands/:id/logo — brands row updated_at is set to now()", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("includes updated_at = now() in the brands UPDATE SQL when an existing primary logo is replaced", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                             // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })     // SELECT primary logo
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE brand_logos
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE brands (legacy)
      .mockResolvedValueOnce({ rows: [] });                            // COMMIT

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(200);

    const updateBrandsCall = mockDbClientQuery.mock.calls.find(([sql]) =>
      /UPDATE brands/i.test(String(sql)),
    );
    expect(updateBrandsCall).toBeDefined();
    const [sql] = updateBrandsCall as [string, unknown[]];
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i);
  });

  it("includes updated_at = now() in the brands UPDATE SQL when no prior logo exists (INSERT path)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // brand check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })              // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT primary logo (none)
      .mockResolvedValueOnce({ rows: [] })              // INSERT brand_logos
      .mockResolvedValueOnce({ rows: [] })              // UPDATE brands (legacy)
      .mockResolvedValueOnce({ rows: [] });             // COMMIT

    const res = await request(app)
      .patch("/brands/1/logo")
      .attach("logo", TINY_PNG, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(200);

    const updateBrandsCall = mockDbClientQuery.mock.calls.find(([sql]) =>
      /UPDATE brands/i.test(String(sql)),
    );
    expect(updateBrandsCall).toBeDefined();
    const [sql] = updateBrandsCall as [string, unknown[]];
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i);
  });
});

describe("PUT /brands/:id/card-message — brands row updated_at is set to now()", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("includes updated_at = now() in the UPDATE SQL", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // brand check
      .mockResolvedValueOnce({ rows: [] });                        // UPDATE brands

    const res = await request(app)
      .put("/brands/1/card-message")
      .attach("image", TINY_PNG, { filename: "msg.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]) =>
      /UPDATE brands/i.test(String(sql)),
    );
    expect(updateCall).toBeDefined();
    const [sql] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i);
  });
});

describe("DELETE /brands/:id/card-message — brands row updated_at is set to now()", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("includes updated_at = now() in the UPDATE SQL", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/brands/1/card-message");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i);
  });
});
