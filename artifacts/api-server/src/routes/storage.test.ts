import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const { copyMock } = vi.hoisted(() => ({
  copyMock: vi.fn(
    async (_url: string, baseKey: string, _ownerId?: string) => `${baseKey}.jpg`,
  ),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

let stubWorkspaceOwnerId = "owner_123";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    copyPrivateObjectToPublic = copyMock;
    normalizeObjectEntityPath = (p: string) => p;
    getObjectEntityUploadURL = vi.fn();
  },
  buildPublicObjectUrl: (p: string | null | undefined) =>
    p
      ? `https://os.presentail.com/api/storage/public-objects/${p.replace(/^\/+/, "")}`
      : null,
}));

import storageRouter from "./storage";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: { error: () => void; warn: () => void; info: () => void };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(storageRouter);
  return app;
}

describe("POST /storage/uploads/make-public", () => {
  beforeEach(() => {
    copyMock.mockClear();
    stubWorkspaceOwnerId = "owner_123";
  });

  it("promotes a workspace's own upload and returns an absolute online URL", async () => {
    const res = await request(makeApp())
      .post("/storage/uploads/make-public")
      .send({ objectPath: "/objects/owner_123/uploads/abc-123" });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\//);
    expect(res.body.url).toContain("/api/storage/public-objects/");
    expect(copyMock).toHaveBeenCalledTimes(1);
    const [srcPath, baseKey, ownerId] = copyMock.mock.calls[0];
    expect(srcPath).toBe("/objects/owner_123/uploads/abc-123");
    expect(baseKey).toMatch(/^uploads\/public\//);
    expect(ownerId).toBe("owner_123");
  });

  it("rejects an object owned by a different workspace (403, no copy)", async () => {
    const res = await request(makeApp())
      .post("/storage/uploads/make-public")
      .send({ objectPath: "/objects/other_owner/uploads/abc-123" });

    expect(res.status).toBe(403);
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("rejects a private path outside the uploads area (403, no copy)", async () => {
    const res = await request(makeApp())
      .post("/storage/uploads/make-public")
      .send({ objectPath: "/objects/owner_123/products/secret.pdf" });

    expect(res.status).toBe(403);
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("rejects a non-object path (400, no copy)", async () => {
    const res = await request(makeApp())
      .post("/storage/uploads/make-public")
      .send({ objectPath: "https://evil.example.com/x.jpg" });

    expect(res.status).toBe(400);
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("rejects a missing objectPath (400)", async () => {
    const res = await request(makeApp())
      .post("/storage/uploads/make-public")
      .send({});

    expect(res.status).toBe(400);
    expect(copyMock).not.toHaveBeenCalled();
  });
});
