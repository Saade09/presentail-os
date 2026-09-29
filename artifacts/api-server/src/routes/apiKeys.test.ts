import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubWorkspaceOwnerId = "owner_123";

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import apiKeysRouter from "./apiKeys";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeysRouter);
  return app;
}

describe("GET /api-keys", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("rejects non-owner workspace members without querying key metadata", async () => {
    stubWorkspaceRole = "member";

    const res = await request(app).get("/api-keys");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("lists keys belonging to the resolved workspace owner", async () => {
    const res = await request(app).get("/api-keys");

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/FROM api_keys WHERE user_id = \$1/i),
      [stubWorkspaceOwnerId],
    );
  });
});