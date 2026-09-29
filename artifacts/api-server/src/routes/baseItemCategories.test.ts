import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
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

import baseItemCategoriesRouter from "./baseItemCategories";

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
  app.use(baseItemCategoriesRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCategoryRow(overrides: Partial<{
  id: number;
  workspace_owner_id: string;
  name: string;
  parent_id: number | null;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Main Category",
    parent_id: null,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
});

// ---------------------------------------------------------------------------
// GET /base-item-categories
// ---------------------------------------------------------------------------

describe("GET /base-item-categories", () => {
  it("returns an empty categories array when there are no categories", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).get("/base-item-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ categories: [] });
  });

  it("returns only main categories with empty subcategories arrays when no subcategories exist", async () => {
    const main1 = makeCategoryRow({ id: 1, name: "Signage", parent_id: null });
    const main2 = makeCategoryRow({ id: 2, name: "Banners", parent_id: null });
    mockDbQuery.mockResolvedValueOnce({ rows: [main1, main2] });

    const res = await request(makeApp()).get("/base-item-categories");

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories[0]).toMatchObject({ id: 1, name: "Signage", parent_id: null, subcategories: [] });
    expect(res.body.categories[1]).toMatchObject({ id: 2, name: "Banners", parent_id: null, subcategories: [] });
  });

  it("nests subcategories under their parent main category", async () => {
    const main = makeCategoryRow({ id: 1, name: "Signage", parent_id: null });
    const sub1 = makeCategoryRow({ id: 2, name: "Indoor", parent_id: 1 });
    const sub2 = makeCategoryRow({ id: 3, name: "Outdoor", parent_id: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [main, sub1, sub2] });

    const res = await request(makeApp()).get("/base-item-categories");

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    const category = res.body.categories[0];
    expect(category).toMatchObject({ id: 1, name: "Signage" });
    expect(category.subcategories).toHaveLength(2);
    expect(category.subcategories[0]).toMatchObject({ id: 2, name: "Indoor", parent_id: 1 });
    expect(category.subcategories[1]).toMatchObject({ id: 3, name: "Outdoor", parent_id: 1 });
  });

  it("does not include subcategories as top-level categories", async () => {
    const main = makeCategoryRow({ id: 1, name: "Signage", parent_id: null });
    const sub = makeCategoryRow({ id: 2, name: "Indoor", parent_id: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [main, sub] });

    const res = await request(makeApp()).get("/base-item-categories");

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].id).toBe(1);
  });

  it("queries only for the current workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get("/base-item-categories");

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("bic.workspace_owner_id = $1"),
      ["owner_xyz"],
    );
  });

  it("correctly assigns subcategories to their respective parent categories", async () => {
    const main1 = makeCategoryRow({ id: 1, name: "Signage", parent_id: null });
    const main2 = makeCategoryRow({ id: 2, name: "Banners", parent_id: null });
    const sub1 = makeCategoryRow({ id: 3, name: "Indoor", parent_id: 1 });
    const sub2 = makeCategoryRow({ id: 4, name: "Roll-up", parent_id: 2 });
    mockDbQuery.mockResolvedValueOnce({ rows: [main1, main2, sub1, sub2] });

    const res = await request(makeApp()).get("/base-item-categories");

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    const signage = res.body.categories.find((c: { id: number }) => c.id === 1);
    const banners = res.body.categories.find((c: { id: number }) => c.id === 2);
    expect(signage.subcategories).toHaveLength(1);
    expect(signage.subcategories[0].id).toBe(3);
    expect(banners.subcategories).toHaveLength(1);
    expect(banners.subcategories[0].id).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// POST /base-item-categories
// ---------------------------------------------------------------------------

describe("POST /base-item-categories", () => {
  it("creates a main category and returns 201 with the created category", async () => {
    const created = makeCategoryRow({ id: 10, name: "Signage", parent_id: null });
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Signage" });

    expect(res.status).toBe(201);
    expect(res.body.category).toMatchObject({ id: 10, name: "Signage", parent_id: null });
  });

  it("trims whitespace from the name before saving", async () => {
    const created = makeCategoryRow({ id: 10, name: "Signage", parent_id: null });
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });

    await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "  Signage  " });

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO base_item_categories"),
      ["owner_123", "Signage", null, null, null, "active", null],
    );
  });

  it("creates a subcategory when a valid parent_id is provided", async () => {
    const parentRow = makeCategoryRow({ id: 1, name: "Signage", parent_id: null });
    const created = makeCategoryRow({ id: 20, name: "Indoor", parent_id: 1 });

    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [parentRow] })
      .mockResolvedValueOnce({ rows: [created] });

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Indoor", parent_id: 1 });

    expect(res.status).toBe(201);
    expect(res.body.category).toMatchObject({ id: 20, name: "Indoor", parent_id: 1 });
  });

  it("returns 403 when the requester is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Signage" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permissions/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when name is an empty string", async () => {
    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when parent_id is not a valid number", async () => {
    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Indoor", parent_id: "not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parent_id/i);
  });

  it("returns 400 when parent_id is zero or negative", async () => {
    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Indoor", parent_id: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parent_id/i);
  });

  it("returns 404 when the parent category does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Indoor", parent_id: 99 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/parent category not found/i);
  });

  it("returns 400 when trying to create a sub-subcategory (3 levels deep)", async () => {
    const alreadySubRow = makeCategoryRow({ id: 5, name: "Indoor", parent_id: 1 });
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [alreadySubRow] });

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Deep Nesting", parent_id: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sub-subcategory|2 levels/i);
  });

  it("inserts with null parent_id when no parent_id is given", async () => {
    const created = makeCategoryRow({ id: 10, name: "Banners", parent_id: null });
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });

    await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Banners" });

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO base_item_categories"),
      ["owner_123", "Banners", null, null, null, "active", null],
    );
  });

  it("accepts a name that is exactly 100 characters long", async () => {
    const longName = "a".repeat(100);
    const created = makeCategoryRow({ id: 11, name: longName, parent_id: null });
    mockDbQuery.mockResolvedValueOnce({ rows: [created] });

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: longName });

    expect(res.status).toBe(201);
  });

  it("returns 400 when name exceeds 100 characters", async () => {
    const tooLong = "a".repeat(101);

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: tooLong });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 409 when the category name already exists in the workspace", async () => {
    const uniqueViolationError = Object.assign(new Error("duplicate key value"), { code: "23505" });
    mockDbQuery.mockRejectedValueOnce(uniqueViolationError);

    const res = await request(makeApp())
      .post("/base-item-categories")
      .send({ name: "Signage" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /base-item-categories/:id
// ---------------------------------------------------------------------------

describe("PATCH /base-item-categories/:id", () => {
  it("renames a category and returns the updated row", async () => {
    const updated = makeCategoryRow({ id: 1, name: "Renamed" });
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [updated] });

    const res = await request(makeApp())
      .patch("/base-item-categories/1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.category).toMatchObject({ id: 1, name: "Renamed" });
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(makeApp())
      .patch("/base-item-categories/1")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 403 when the requester is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .patch("/base-item-categories/1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the category does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .patch("/base-item-categories/999")
      .send({ name: "Renamed" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("accepts a name that is exactly 100 characters long", async () => {
    const longName = "b".repeat(100);
    const updated = makeCategoryRow({ id: 1, name: longName });
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [updated] });

    const res = await request(makeApp())
      .patch("/base-item-categories/1")
      .send({ name: longName });

    expect(res.status).toBe(200);
  });

  it("returns 400 when name exceeds 100 characters", async () => {
    const tooLong = "b".repeat(101);

    const res = await request(makeApp())
      .patch("/base-item-categories/1")
      .send({ name: tooLong });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /base-item-categories/:id
// ---------------------------------------------------------------------------

describe("DELETE /base-item-categories/:id", () => {
  it("deletes a main category and its subcategories when not in use", async () => {
    const mainRow = { id: 1, parent_id: null };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [mainRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).delete("/base-item-categories/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("deletes a subcategory when not in use", async () => {
    const subRow = { id: 5, parent_id: 1 };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [subRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).delete("/base-item-categories/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("cascades and deletes subcategories when a main category is deleted", async () => {
    const mainRow = { id: 1, parent_id: null };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [mainRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).delete("/base-item-categories/1");

    const deleteSubsCall = mockDbQuery.mock.calls.find(
      (call) => String(call[0]).includes("WHERE parent_id = $1"),
    );
    expect(deleteSubsCall).toBeDefined();
    expect(deleteSubsCall![1]).toContain(1);
  });

  it("returns 403 when the requester is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).delete("/base-item-categories/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permissions/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the category does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp()).delete("/base-item-categories/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 409 when base items are assigned directly to the category", async () => {
    const mainRow = { id: 1, parent_id: null };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [mainRow] })
      .mockResolvedValueOnce({ rows: [{ count: "3" }] });

    const res = await request(makeApp()).delete("/base-item-categories/1");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/base items are assigned/i);
  });

  it("returns 409 when base items are assigned to a subcategory of the deleted main category", async () => {
    const mainRow = { id: 1, parent_id: null };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [mainRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ count: "2" }] });

    const res = await request(makeApp()).delete("/base-item-categories/1");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/subcategory/i);
  });

  it("returns 400 when the id is not a valid number", async () => {
    const res = await request(makeApp()).delete("/base-item-categories/abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid category id/i);
  });

  it("does not delete a category belonging to a different workspace owner", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp()).delete("/base-item-categories/1");

    expect(res.status).toBe(404);

    const catCheckCall = mockDbQuery.mock.calls[0];
    expect(catCheckCall[1]).toContain("owner_123");
  });

  it("does not attempt subcategory cascade for a subcategory deletion", async () => {
    const subRow = { id: 5, parent_id: 1 };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [subRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).delete("/base-item-categories/5");

    const subcascadeCall = mockDbQuery.mock.calls.find(
      (call) => String(call[0]).includes("WHERE parent_id = $1"),
    );
    expect(subcascadeCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PATCH /base-item-categories/:id
// ---------------------------------------------------------------------------

describe("PATCH /base-item-categories/:id", () => {
  it("returns 200 with the updated category on a successful rename", async () => {
    const updated = makeCategoryRow({ id: 7, name: "Renamed Category" });
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [updated] });

    const res = await request(makeApp())
      .patch("/base-item-categories/7")
      .send({ name: "Renamed Category" });

    expect(res.status).toBe(200);
    expect(res.body.category).toMatchObject({ id: 7, name: "Renamed Category" });
  });

  it("trims whitespace from the name before saving", async () => {
    const updated = makeCategoryRow({ id: 7, name: "Trimmed Name" });
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [updated] });

    await request(makeApp())
      .patch("/base-item-categories/7")
      .send({ name: "  Trimmed Name  " });

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE base_item_categories"),
      ["Trimmed Name", null, 7, "owner_123"],
    );
  });

  it("returns 403 when the requester is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp())
      .patch("/base-item-categories/7")
      .send({ name: "New Name" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permissions/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the id is not a valid number", async () => {
    const res = await request(makeApp())
      .patch("/base-item-categories/abc")
      .send({ name: "New Name" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid category id/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(makeApp())
      .patch("/base-item-categories/7")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when name is blank (whitespace only)", async () => {
    const res = await request(makeApp())
      .patch("/base-item-categories/7")
      .send({ name: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the category does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .patch("/base-item-categories/999")
      .send({ name: "New Name" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 409 when the new name collides with an existing category name in the same workspace", async () => {
    const uniqueViolationError = Object.assign(new Error("duplicate key value"), { code: "23505" });
    mockDbQuery.mockRejectedValueOnce(uniqueViolationError);

    const res = await request(makeApp())
      .patch("/base-item-categories/7")
      .send({ name: "Signage" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("scopes the update to the current workspace and returns 404 for a category in another workspace", async () => {
    stubWorkspaceOwnerId = "other_owner";
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .patch("/base-item-categories/7")
      .send({ name: "New Name" });

    expect(res.status).toBe(404);

    const updateCall = mockDbQuery.mock.calls[0];
    expect(updateCall[1]).toContain("other_owner");
  });
});
