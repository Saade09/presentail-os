import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const mockGetObjectFile = vi.fn();
const mockSetAcl = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_1";
    wreq.workspaceRole = stubRole;
    wreq.workspaceActualRole = stubRole;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    getObjectEntityFile = (...args: unknown[]) => mockGetObjectFile(...args);
  },
}));

vi.mock("../lib/objectAcl", () => ({
  setObjectAclPolicy: (...args: unknown[]) => mockSetAcl(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import countryFlagsRouter from "./countryFlags";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Stub req.log used by the route's error path.
    (req as unknown as { log: { error: (...a: unknown[]) => void } }).log = {
      error: () => {},
    };
    next();
  });
  app.use(countryFlagsRouter);
  return app;
}

describe("PUT /country-flags/:code", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetObjectFile.mockResolvedValue({
      getMetadata: async () => [{ contentType: "image/svg+xml" }],
    });
    mockSetAcl.mockResolvedValue(undefined);
    stubRole = "owner";
  });

  it("403 when the caller is not an owner", async () => {
    stubRole = "member";
    const res = await request(app)
      .put("/country-flags/lb")
      .send({ object_path: "/objects/owner_1/uploads/x.svg" });
    expect(res.status).toBe(403);
  });

  it("400 for an unknown country code", async () => {
    const res = await request(app)
      .put("/country-flags/zz")
      .send({ object_path: "/objects/owner_1/uploads/x.svg" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown/i);
  });

  it("400 when object_path is not workspace-scoped", async () => {
    const res = await request(app)
      .put("/country-flags/lb")
      .send({ object_path: "/objects/some-other-owner/uploads/x.svg" });
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("400 when the uploaded object is not an image", async () => {
    mockGetObjectFile.mockResolvedValueOnce({
      getMetadata: async () => [{ contentType: "application/pdf" }],
    });
    const res = await request(app)
      .put("/country-flags/lb")
      .send({ object_path: "/objects/owner_1/uploads/x.pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("upserts the override and returns the resolved image URL", async () => {
    const res = await request(app)
      .put("/country-flags/lb")
      .send({ object_path: "/objects/owner_1/uploads/lb.svg" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      country_code: "lb",
      image_url: "/api/storage/objects/owner_1/uploads/lb.svg",
    });
    expect(mockSetAcl).toHaveBeenCalledOnce();
    expect(mockDbQuery.mock.calls[0][1]).toEqual([
      "owner_1",
      "lb",
      "/api/storage/objects/owner_1/uploads/lb.svg",
    ]);
  });
});

describe("DELETE /country-flags/:code", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubRole = "owner";
  });

  it("403 when caller is not owner", async () => {
    stubRole = "member";
    const res = await request(app).delete("/country-flags/lb");
    expect(res.status).toBe(403);
  });

  it("400 for unknown country code", async () => {
    const res = await request(app).delete("/country-flags/zz");
    expect(res.status).toBe(400);
  });

  it("deletes the row scoped to workspace + code", async () => {
    const res = await request(app).delete("/country-flags/lb");
    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_1", "lb"]);
  });
});
