import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

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

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAssignedLocationIds: number[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.assignedLocationIds = stubAssignedLocationIds;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import devicesRouter from "./devices";

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(devicesRouter);
  return app;
}

describe("GET /devices — response validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAssignedLocationIds = null;
  });

  it("returns 200 with devices array on success", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Front Desk Mac",
          machine_id: "mac-abc",
          os: "darwin",
          agent_version: "1.0.0",
          printers: [],
          last_seen_at: "2024-01-01T00:00:00Z",
          created_at: "2024-01-01T00:00:00Z",
          location_id: null,
          location_name: null,
          location_country: null,
        },
      ],
    });

    const res = await request(app).get("/devices");

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].name).toBe("Front Desk Mac");
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          // id should be a number — string here triggers Zod failure
          id: "not-a-number",
          name: "Bad Device",
          machine_id: "mac-bad",
          location_id: null,
        },
      ],
    });

    const res = await request(app).get("/devices");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /devices", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});
