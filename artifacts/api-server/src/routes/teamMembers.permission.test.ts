import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
let workspaceRole: "owner" | "member" = "owner";
let allowedPages: string[] | null = null;

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = workspaceRole;
    wreq.workspaceActualRole = workspaceRole;
    wreq.allowedPages = allowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, page: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(page),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) } },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import teamMembersRouter from "./teamMembers";

const app = express();
app.use(express.json());
app.use(teamMembersRouter);

beforeEach(() => {
  vi.clearAllMocks();
  workspaceRole = "owner";
  allowedPages = null;
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("team-members people.directory permission", () => {
  it.each(["/team-members", "/team-members/1"])(
    "rejects an unauthorized member from %s before querying",
    async (path) => {
      workspaceRole = "member";
      allowedPages = ["people.time-off"];

      const res = await request(app).get(path);

      expect(res.status).toBe(403);
      expect(mockDbQuery).not.toHaveBeenCalled();
    },
  );

  it("allows a member with people.directory access", async () => {
    workspaceRole = "member";
    allowedPages = ["people.directory"];

    const res = await request(app).get("/team-members");

    expect(res.status).toBe(200);
  });

  it("preserves owner access", async () => {
    const res = await request(app).get("/team-members");
    expect(res.status).toBe(200);
  });
});