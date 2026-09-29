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
  withTransaction: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("multer", () => {
  const multerMock = () => ({
    single: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    fields: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    none: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  });
  multerMock.memoryStorage = () => ({});
  return { default: multerMock };
});

vi.mock("image-size", () => ({
  imageSize: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import brandsRouter from "./brands";

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
  app.use(brandsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// PATCH /brands/:id — whitespace-only name validation
// ---------------------------------------------------------------------------

describe("PATCH /brands/:id — name validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 400 when name is all spaces", async () => {
    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is a tab character", async () => {
    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "\t" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is a mix of spaces, tabs, and newlines", async () => {
    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "  \t\n  " });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is an empty string", async () => {
    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is omitted", async () => {
    const res = await request(app)
      .patch("/brands/1")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("accepts a name with surrounding whitespace and stores the trimmed value", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          name: "Acme Brand",
          description: null,
          target_cogs: null,
          created_at: "2024-01-01T00:00:00Z",
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "  Acme Brand  " });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brand");
    expect(res.body.brand.name).toBe("Acme Brand");

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE brands/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain("Acme Brand");
    expect(updateCall![1]).not.toContain("  Acme Brand  ");
  });

  it("does not make any DB calls when name is whitespace-only", async () => {
    await request(app)
      .patch("/brands/1")
      .send({ name: "   " });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a non-owner member without brands.edit permission", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "   " });

    expect(res.status).toBe(403);
  });

  it("returns 409 when the new name matches another brand (same case)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });

    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "Existing Brand" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error", "A brand with this name already exists");
  });

  it("returns 409 when the new name matches another brand (mixed case)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });

    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "eXiStInG bRaNd" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error", "A brand with this name already exists");
  });

  it("returns 200 when the new name does not match any other brand", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          name: "Unique Brand",
          description: null,
          target_cogs: null,
          created_at: "2024-01-01T00:00:00Z",
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .patch("/brands/1")
      .send({ name: "Unique Brand" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brand");
    expect(res.body.brand.name).toBe("Unique Brand");
  });
});
