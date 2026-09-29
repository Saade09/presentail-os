import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const {
  resolveWorkspace,
  allowedPages,
  workspaceRole,
  createGalleryRun,
  recoverProductGalleryRun,
  processProductGalleryWork,
  ActiveRunError,
} = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  allowedPages: { value: [] as string[] },
  workspaceRole: { value: "member" as "owner" | "member" },
  createGalleryRun: vi.fn(),
  recoverProductGalleryRun: vi.fn(),
  processProductGalleryWork: vi.fn(),
  ActiveRunError: class ActiveRunError extends Error {
    code = "ACTIVE_RUN_EXISTS";
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    resolveWorkspace(req, res, next);
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceRole = workspaceRole.value;
    wreq.workspaceActualRole = workspaceRole.value;
    wreq.workspaceOwnerId = "owner_test";
    wreq.userId = "member_test";
    wreq.allowedPages = allowedPages.value;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/db", () => ({
  db: { query: vi.fn() },
  withTransaction: vi.fn(),
}));

vi.mock("../lib/catalogWebhook", () => ({ fireCatalogDataWebhook: vi.fn() }));
vi.mock("../lib/merchantSyncQueue", () => ({ enqueueProductCreateOrUpdateSync: vi.fn() }));
vi.mock("../lib/productGallery", () => ({
  createGalleryRun,
  GALLERY_TYPES: ["white_bg"],
  markCandidateForRegeneration: vi.fn(),
  processProductGalleryWork,
  ProductGalleryActiveRunError: ActiveRunError,
  recoverProductGalleryRun,
}));
vi.mock("../lib/productPublicImages", () => ({ syncProductPublicImages: vi.fn() }));
vi.mock("../lib/productPublishing", () => ({ notifyProductChanged: vi.fn() }));

import productGalleryRouter from "./productGallery";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { warn: vi.fn(), error: vi.fn() };
    next();
  });
  app.use(productGalleryRouter);
  app.get("/cities", (_req, res) => res.json({ reached: "cities" }));
  app.get("/cmc-pos/locations", (_req, res) => res.json({ reached: "cmc-pos" }));
  return app;
}

describe("product gallery router middleware scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowedPages.value = [];
    workspaceRole.value = "member";
  });

  it("does not intercept unrelated routes mounted after the gallery router", async () => {
    const app = makeApp();

    for (const [path, reached] of [
      ["/cities", "cities"],
      ["/cmc-pos/locations", "cmc-pos"],
    ] as const) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reached });
    }

    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it("still enforces products.manage on product gallery routes", async () => {
    const res = await request(makeApp())
      .post("/products/1/gallery/runs")
      .send({ selectedTypes: ["white_bg"], idempotencyKey: "test" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("returns an active-run conflict only for the known active-run condition", async () => {
    workspaceRole.value = "owner";
    createGalleryRun.mockRejectedValue(new ActiveRunError("already active"));

    const res = await request(makeApp())
      .post("/products/1/gallery/runs")
      .send({ selectedTypes: ["white_bg"], idempotencyKey: "test" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACTIVE_RUN_EXISTS");
  });

  it("reports unexpected creation failures as server errors instead of active runs", async () => {
    workspaceRole.value = "owner";
    createGalleryRun.mockRejectedValue(new Error("database unavailable"));

    const res = await request(makeApp())
      .post("/products/1/gallery/runs")
      .send({ selectedTypes: ["white_bg"], idempotencyKey: "test" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Gallery generation could not be started. Refresh and try again.",
      code: "GALLERY_RUN_CREATE_FAILED",
    });
  });

  it("recovers only the requested workspace run and wakes processing", async () => {
    workspaceRole.value = "owner";
    recoverProductGalleryRun.mockResolvedValue({ recoveredCount: 1 });
    processProductGalleryWork.mockResolvedValue(undefined);

    const res = await request(makeApp())
      .post("/products/42/gallery/runs/9/recover");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runId: 9,
      status: "RECOVERY_REQUESTED",
      recoveredCount: 1,
    });
    expect(recoverProductGalleryRun).toHaveBeenCalledWith("owner_test", 42, 9);
    expect(processProductGalleryWork).toHaveBeenCalledOnce();
  });
});