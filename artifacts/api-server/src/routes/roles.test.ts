/**
 * roles.test.ts
 *
 * Unit tests for POST /roles and PATCH /roles/:id.
 *
 * Covers:
 *  - allowedPages page-key validation (the main focus of this file)
 *  - Basic 403 guard for non-owner callers
 *  - Happy-path role creation with valid keys
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
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
}));

// ---------------------------------------------------------------------------
// Drizzle mock — queue-based (used for channel_ids selects in GET and PATCH)
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain(result: unknown[]): any {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    then: (f: Parameters<typeof p.then>[0], r: Parameters<typeof p.then>[1]) => p.then(f, r),
    catch: (f: Parameters<typeof p.catch>[0]) => p.catch(f),
    finally: (f: Parameters<typeof p.finally>[0]) => p.finally(f),
  };
  return chain;
}

const mockDrizzleSelect = vi.fn(() => makeChain(popResult()));

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: () => mockDrizzleSelect(),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.userId = "user_abc";
    wreq.userEmail = "owner@example.com";
    wreq.allowedPages = null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import rolesRouter from "./roles";

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
  app.use(rolesRouter);
  return app;
}

// ---------------------------------------------------------------------------
// POST /roles — page key validation
// ---------------------------------------------------------------------------

describe("POST /roles — allowedPages validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller is not owner", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .post("/roles")
      .send({ name: "Test", allowedPages: ["devices"] });
    expect(res.status).toBe(403);
  });

  it("returns 400 when allowedPages contains an unknown key", async () => {
    const res = await request(app)
      .post("/roles")
      .send({ name: "Bad Role", allowedPages: ["not-a-real-page"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown page key/i);
    expect(res.body.error).toContain("not-a-real-page");
  });

  it("returns 400 when allowedPages contains multiple unknown keys", async () => {
    const res = await request(app)
      .post("/roles")
      .send({ name: "Bad Role", allowedPages: ["fake-page", "also-fake"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown page keys/i);
    expect(res.body.error).toContain("fake-page");
    expect(res.body.error).toContain("also-fake");
  });

  it("returns 400 when allowedPages contains a non-string value", async () => {
    const res = await request(app)
      .post("/roles")
      .send({ name: "Bad Role", allowedPages: [42] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown page key/i);
  });

  it("accepts all known top-level page keys", async () => {
    mockDbClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: "Full Access", allowed_pages: "[]", created_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(undefined);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const validKeys = [
      "project-manager-dashboard",
      "devices",
      "invoice-scanners",
      "stickers",
      "locations",
      "brands",
      "channels.manage",
      "products",
      "base-items",
      "api-keys",
      "downloads",
      "print-history",
      "analytics",
      "users",
      "roles",
      "payment-links",
      "api-docs",
      "settings",
      "cmc-pos-dashboard",
      "cmc-pos-new-order",
    ];

    const res = await request(app)
      .post("/roles")
      .send({ name: "Full Access", allowedPages: validKeys });

    expect(res.status).not.toBe(400);
  });

  it("creates a role without conflating the split CMC page grants", async () => {
    const allowedPages = ["cmc-pos-new-order"];
    mockDbClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{
          id: 3,
          name: "CMC New Order",
          description: null,
          allowed_pages: allowedPages,
          created_at: new Date("2026-08-27T00:00:00Z"),
          updated_at: new Date("2026-08-27T00:00:00Z"),
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/roles")
      .send({ name: "CMC New Order", allowedPages });

    expect(res.status).toBe(201);
    expect(res.body.role.allowed_pages).toEqual(allowedPages);
    expect(mockDbClientQuery.mock.calls[1]?.[1]).toEqual([
      "owner_123",
      "CMC New Order",
      null,
      JSON.stringify(allowedPages),
    ]);
  });

  it("accepts all known sub-permission keys", async () => {
    mockDbClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 2, name: "Brand Role", allowed_pages: "[]", created_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(undefined);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const subKeys = [
      "brands.manage",
      "brands.create",
      "brands.edit",
      "brands.manage-logos",
      "brands.manage-cover-photos",
      "brands.manage-card-message",
      "brands.delete",
      "products.manage",
      "base_items.manage",
      "stickers.upload",
    ];

    const res = await request(app)
      .post("/roles")
      .send({ name: "Brand Role", allowedPages: subKeys });

    expect(res.status).not.toBe(400);
  });

  it("returns 400 for a valid key mixed with an invalid key", async () => {
    mockDbQuery.mockImplementation(() => new Promise(() => {}));
    const res = await request(app)
      .post("/roles")
      .send({ name: "Mixed", allowedPages: ["devices", "typo_key"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("typo_key");
  });
});

// ---------------------------------------------------------------------------
// GET /roles — response shape validation
// ---------------------------------------------------------------------------

describe("GET /roles — response validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    drizzleQueue.length = 0;
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 200 with the validated roles payload", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Designer",
          description: null,
          allowed_pages: ["devices", "brands"],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });
    // channel_ids now fetched via drizzle
    drizzleQueue.push([{ role_id: 1, channel_id: 5 }]);

    const res = await request(app).get("/roles");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      roles: [
        {
          id: 1,
          name: "Designer",
          description: null,
          allowed_pages: ["devices", "brands"],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
          channel_ids: [5],
        },
      ],
    });
    expect(mockReqLogError).not.toHaveBeenCalled();
  });

  it("loads both split CMC page grants unchanged", async () => {
    const allowedPages = ["cmc-pos-dashboard", "cmc-pos-new-order"];
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 2,
        name: "CMC Pages",
        description: null,
        allowed_pages: allowedPages,
        created_at: "2026-08-27T00:00:00Z",
        updated_at: "2026-08-27T00:00:00Z",
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/roles");

    expect(res.status).toBe(200);
    expect(res.body.roles[0].allowed_pages).toEqual(allowedPages);
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Bad Role",
          allowed_pages: "not-an-array",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });
    // channel_ids now fetched via drizzle; empty queue returns [] by default

    const res = await request(app).get("/roles");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledTimes(1);
    const [logArgs] = mockReqLogError.mock.calls[0] as [
      { route: string; err: unknown },
      string,
    ];
    expect(logArgs.route).toBe("GET /roles");
    expect(Array.isArray(logArgs.err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PATCH /roles/:id — page key validation
// ---------------------------------------------------------------------------

describe("PATCH /roles/:id — allowedPages validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when caller is not owner", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .patch("/roles/1")
      .send({ allowedPages: ["devices"] });
    expect(res.status).toBe(403);
  });

  it("returns 400 when allowedPages contains an unknown key", async () => {
    const res = await request(app)
      .patch("/roles/1")
      .send({ allowedPages: ["project_manager_dashboard"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown page key/i);
    expect(res.body.error).toContain("project_manager_dashboard");
  });

  it("returns 400 when allowedPages contains a non-string value", async () => {
    const res = await request(app)
      .patch("/roles/1")
      .send({ allowedPages: [null] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown page key/i);
  });

  it("accepts valid allowedPages and proceeds to update", async () => {
    mockDbClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: "Devices Only", allowed_pages: '["devices"]', created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(undefined);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/roles/1")
      .send({ allowedPages: ["devices", "analytics"] });

    expect(res.status).not.toBe(400);
  });

  it("updates and returns the split CMC grants unchanged", async () => {
    const allowedPages = ["cmc-pos-dashboard"];
    mockDbClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          name: "CMC Dashboard",
          description: null,
          allowed_pages: allowedPages,
          created_at: new Date("2026-08-27T00:00:00Z"),
          updated_at: new Date("2026-08-27T00:00:00Z"),
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch("/roles/1")
      .send({ allowedPages });

    expect(res.status).toBe(200);
    expect(res.body.role.allowed_pages).toEqual(allowedPages);
    expect(mockDbClientQuery.mock.calls[1]?.[1]?.[0]).toBe(JSON.stringify(allowedPages));
  });

  it("does not validate allowedPages when the field is absent", async () => {
    mockDbClientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: "Updated Name", allowed_pages: "[]", created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(undefined);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/roles/1")
      .send({ name: "Updated Name" });

    expect(res.status).not.toBe(400);
  });
});
