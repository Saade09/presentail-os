import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock("../lib/customerUpsert", () => ({
  normalizePhone: (phone: string) => phone,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubCustomRoleId: number | null = null;
let stubAllowedPages: string[] | null | undefined = undefined;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.customRoleId = stubCustomRoleId;
    wreq.allowedPages = stubAllowedPages as string[] | null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import channelDetailRouter from "./channelDetail";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void; warn: () => void; info: () => void } }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use(channelDetailRouter);
  return app;
}

// ---------------------------------------------------------------------------
// POST /channels/:channelId/image-configs — permission checks
// ---------------------------------------------------------------------------

describe("POST /channels/:channelId/image-configs — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
    stubCustomRoleId = null;
  });

  it("returns 403 for members without channels.manage or channels.manage-image-configs", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "product", width_px: 800, height_px: 600 });

    expect(res.status).toBe(403);
  });

  it("returns 403 for members with no allowedPages at all", async () => {
    stubActualRole = "member";
    stubAllowedPages = undefined;

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "product", width_px: 800, height_px: 600 });

    expect(res.status).toBe(403);
  });

  it("allows owner to create an image config", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // channel check
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          channel_id: 1,
          image_type: "product",
          width_px: 800,
          height_px: 600,
          output_format: "jpeg",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "product", width_px: 800, height_px: 600 });

    expect(res.status).toBe(201);
    expect(res.body.image_config.image_type).toBe("product");
  });

  it("allows member with channels.manage to create an image config", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          channel_id: 1,
          image_type: "banner",
          width_px: 1920,
          height_px: 600,
          output_format: "jpeg",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "banner", width_px: 1920, height_px: 600 });

    expect(res.status).toBe(201);
  });

  it("allows member with channels.manage-image-configs to create an image config", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage-image-configs"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          channel_id: 1,
          image_type: "logo",
          width_px: 200,
          height_px: 200,
          output_format: "png",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "logo", width_px: 200, height_px: 200, output_format: "png" });

    expect(res.status).toBe(201);
    expect(res.body.image_config.image_type).toBe("logo");
  });

  it("returns 404 when channel does not exist", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/channels/999/image-configs")
      .send({ image_type: "product", width_px: 800, height_px: 600 });

    expect(res.status).toBe(404);
  });

  it("returns 400 when image_type is invalid", async () => {
    stubActualRole = "owner";

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "invalid_type", width_px: 800, height_px: 600 });

    expect(res.status).toBe(400);
  });

  it("returns 409 when a config for that image_type already exists", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockRejectedValueOnce({ code: "23505" });

    const res = await request(app)
      .post("/channels/1/image-configs")
      .send({ image_type: "product", width_px: 800, height_px: 600 });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PUT /channels/:channelId/image-configs/:configId — permission checks
// ---------------------------------------------------------------------------

describe("PUT /channels/:channelId/image-configs/:configId — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
    stubCustomRoleId = null;
  });

  it("returns 403 for members without channels.manage or channels.manage-image-configs", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands"];

    const res = await request(app)
      .put("/channels/1/image-configs/5")
      .send({ width_px: 1024, height_px: 768 });

    expect(res.status).toBe(403);
  });

  it("allows member with channels.manage-image-configs to update an image config", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage-image-configs"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          channel_id: 1,
          image_type: "product",
          width_px: 1024,
          height_px: 768,
          output_format: "jpeg",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .put("/channels/1/image-configs/5")
      .send({ width_px: 1024, height_px: 768 });

    expect(res.status).toBe(200);
    expect(res.body.image_config.width_px).toBe(1024);
  });

  it("allows member with channels.manage to update an image config", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          channel_id: 1,
          image_type: "banner",
          width_px: 800,
          height_px: 400,
          output_format: "png",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .put("/channels/1/image-configs/5")
      .send({ width_px: 800, height_px: 400, output_format: "png" });

    expect(res.status).toBe(200);
  });

  it("returns 404 when config not found", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .put("/channels/1/image-configs/999")
      .send({ width_px: 800, height_px: 600 });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /channels/:channelId/image-configs/:configId — permission checks
// ---------------------------------------------------------------------------

describe("DELETE /channels/:channelId/image-configs/:configId — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
    stubCustomRoleId = null;
  });

  it("returns 403 for members without channels.manage or channels.manage-image-configs", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];

    const res = await request(app).delete("/channels/1/image-configs/5");

    expect(res.status).toBe(403);
  });

  it("returns 403 for members with no allowedPages at all", async () => {
    stubActualRole = "member";
    stubAllowedPages = undefined;

    const res = await request(app).delete("/channels/1/image-configs/5");

    expect(res.status).toBe(403);
  });

  it("allows member with channels.manage-image-configs to delete an image config", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage-image-configs"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/channels/1/image-configs/5");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows member with channels.manage to delete an image config", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/channels/1/image-configs/5");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when config not found", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/channels/1/image-configs/999");

    expect(res.status).toBe(404);
  });

  it("returns 200 and ok:true on success for owner", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/channels/1/image-configs/5");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
