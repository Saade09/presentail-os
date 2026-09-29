import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

const mockDbQuery = vi.fn();
let workspaceRole: "owner" | "member" = "member";
let allowedPages: string[] = [];
let assignedLocationIds: number[] | null = [7];

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, {
      workspaceOwnerId: "owner_123",
      workspaceRole,
      workspaceActualRole: workspaceRole,
      allowedPages,
      assignedLocationIds,
    });
    next();
  },
  workspace: (req: Request) => req,
  hasPageAccess: (req: Request & { workspaceRole?: string; allowedPages?: string[] }, page: string) =>
    req.workspaceRole === "owner" || Boolean(req.allowedPages?.includes(page)),
}));

import printJobsRouter from "./printJobs";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(printJobsRouter);
  return app;
}

describe("print job destructive access", () => {
  beforeEach(() => {
    workspaceRole = "member";
    allowedPages = [];
    assignedLocationIds = [7];
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it.each([
    ["get", "/print-jobs"],
    ["delete", "/print-jobs/12"],
    ["post", "/print-jobs/12/restore"],
    ["delete", "/print-jobs/12/permanent"],
  ] as const)("%s %s requires print-history access", async (method, path) => {
    const res = await request(makeApp())[method](path);

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("scopes expired soft-delete cleanup to assigned locations", async () => {
    allowedPages = ["print-history"];

    const res = await request(makeApp()).get("/print-jobs");

    expect(res.status).toBe(200);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("d.location_id = ANY($2::int[])");
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_123", [7]]);
  });

  it.each([
    ["delete", "/print-jobs/12"],
    ["post", "/print-jobs/12/restore"],
    ["delete", "/print-jobs/12/permanent"],
  ] as const)("%s %s scopes the target through its device location", async (method, path) => {
    allowedPages = ["print-history"];

    const res = await request(makeApp())[method](path);

    expect(res.status).toBe(404);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("d.location_id = ANY($3::int[])");
    expect(mockDbQuery.mock.calls[0][1]).toEqual([12, "owner_123", [7]]);
  });
});