import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const mockLogPageAccessDenial = vi.fn();
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.userId = "user_staff";
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    wreq.memberDbId = stubWorkspaceRole === "owner" ? null : 42;
    wreq.customRoleId = stubWorkspaceRole === "owner" ? null : 7;
    wreq.customRoleIds = stubWorkspaceRole === "owner" ? [] : [7];
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  logPageAccessDenial: (...args: unknown[]) => mockLogPageAccessDenial(...args),
}));

import citiesRouter from "./cities";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(citiesRouter);
  return app;
}

describe("GET /cities — page permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("preserves owner access and workspace scoping", async () => {
    const res = await request(makeApp()).get("/cities");
    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_123"]);
  });

  it("includes the market currency used by each city's pricing", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          workspace_owner_id: "owner_123",
          country_code: "AE",
          name: "Dubai",
          slug: "dubai",
          is_active: true,
          sort_order: 0,
          delivery_fee: "25",
          free_delivery_enabled: true,
          free_delivery_threshold: "250",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).get("/cities");
    expect(res.status).toBe(200);
    expect(res.body.cities[0]).toMatchObject({
      slug: "dubai",
      delivery_fee: "25",
      free_delivery_enabled: true,
      free_delivery_threshold: "250",
      currency: "AED",
    });
  });

  it.each(["cities", "cities.manage"])(
    "allows a member granted %s",
    async (permission) => {
      stubWorkspaceRole = "member";
      stubAllowedPages = [permission];
      const res = await request(makeApp()).get("/cities");
      expect(res.status).toBe(200);
    },
  );

  it("denies a member without a city permission before querying", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cmc-pos-dashboard"];
    const res = await request(makeApp()).get("/cities");
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockLogPageAccessDenial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberDbId: 42, customRoleIds: [7] }),
      ["cities", "cities.manage"],
    );
  });
});