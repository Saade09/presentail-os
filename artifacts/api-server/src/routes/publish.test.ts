import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mutable stubs controlled per-test
// ---------------------------------------------------------------------------

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

const mockPublishAllSnapshot = vi.fn();
const mockPublishProducts = vi.fn();

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/publishSnapshot", () => ({
  publishAllSnapshot: (...args: unknown[]) => mockPublishAllSnapshot(...args),
  publishProducts: (...args: unknown[]) => mockPublishProducts(...args),
}));

import publishRouter from "./publish";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(publishRouter);
  return app;
}

const app = makeApp();

describe("POST /publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("returns the snapshot result for an owner", async () => {
    mockPublishAllSnapshot.mockResolvedValueOnce({
      success: true,
      results: [
        { area: "delivery", success: true, count: 1 },
        { area: "catalog_attributes", success: true, count: 4 },
        { area: "products", success: true, count: 10 },
      ],
    });

    const res = await request(app).post("/publish");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.results).toHaveLength(3);
    expect(mockPublishAllSnapshot).toHaveBeenCalledWith("owner_123");
  });

  it("surfaces partial failures with per-area results", async () => {
    mockPublishAllSnapshot.mockResolvedValueOnce({
      success: false,
      results: [
        { area: "delivery", success: true, count: 1 },
        { area: "catalog_attributes", success: false, count: 0, error: "boom" },
        { area: "products", success: true, count: 10 },
      ],
    });

    const res = await request(app).post("/publish");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.results[1]).toMatchObject({ area: "catalog_attributes", success: false, error: "boom" });
  });

  it("allows non-owner members to publish", async () => {
    stubWorkspaceRole = "member";
    mockPublishAllSnapshot.mockResolvedValueOnce({
      success: true,
      results: [
        { area: "delivery", success: true, count: 1 },
        { area: "catalog_attributes", success: true, count: 4 },
        { area: "products", success: true, count: 10 },
      ],
    });

    const res = await request(app).post("/publish");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPublishAllSnapshot).toHaveBeenCalledWith("owner_123");
  });
});

describe("POST /publish/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
  });

  it("returns the products area result for an owner", async () => {
    mockPublishProducts.mockResolvedValueOnce({ area: "products", success: true, count: 7 });

    const res = await request(app).post("/publish/products");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ area: "products", success: true, count: 7 });
    expect(mockPublishProducts).toHaveBeenCalledWith("owner_123");
  });

  it("surfaces a failure result with an error", async () => {
    mockPublishProducts.mockResolvedValueOnce({ area: "products", success: false, count: 0, error: "boom" });

    const res = await request(app).post("/publish/products");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ area: "products", success: false, error: "boom" });
  });

  it("allows a member with the products.manage permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products.manage"];
    mockPublishProducts.mockResolvedValueOnce({ area: "products", success: true, count: 3 });

    const res = await request(app).post("/publish/products");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPublishProducts).toHaveBeenCalledWith("owner_123");
  });

  it("rejects a member without the products.manage permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(app).post("/publish/products");

    expect(res.status).toBe(403);
    expect(mockPublishProducts).not.toHaveBeenCalled();
  });
});
