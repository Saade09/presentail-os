/**
 * members.test.ts
 *
 * Covers the owner-only endpoints in users.ts that manage workspace members
 * and related resources (locations, failed-access-requests, member removal).
 *
 * For every describe block that has a "returns 403 when caller is not owner"
 * test there is at least one counterpart confirming an owner receives a 2xx.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbClientQuery = vi.fn();
const mockDbClientRelease = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockDbClientQuery(...args),
      release: mockDbClientRelease,
    }),
  },
  withTransaction: async (
    client: { query: (...a: unknown[]) => unknown },
    fn: () => Promise<unknown>,
  ) => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow */
      }
      throw err;
    }
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/email", () => ({
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

// Clerk is imported by users.ts; mock it so tests don't hit the network.
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

// Configurable workspace stub — mirrors the pattern from brands.test.ts.
let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.userId = "user_abc";
    wreq.userEmail = "owner@example.com";
    wreq.allowedPages = null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import usersRouter from "./users";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(usersRouter);
  return app;
}

// ---------------------------------------------------------------------------
// DELETE /users/:id — remove a member
// ---------------------------------------------------------------------------

describe("DELETE /users/:id — remove a member", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when the caller is not a workspace owner", async () => {
    stubActualRole = "member";
    // Route peeks at the member to determine which permission is needed
    mockDbQuery.mockResolvedValueOnce({ rows: [{ joined: true }], rowCount: 1 });

    const res = await request(app).delete("/users/42");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a non-numeric member id", async () => {
    const res = await request(app).delete("/users/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when the member does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app).delete("/users/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/member not found/i);
  });

  it("returns 200 ok when an owner successfully removes a member", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(app).delete("/users/42");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("scopes the DELETE to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_isolated";
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await request(app).delete("/users/7");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_isolated");
  });
});

// ---------------------------------------------------------------------------
// GET /users/:id/locations — list a member's location assignments
// ---------------------------------------------------------------------------

describe("GET /users/:id/locations — list member location assignments", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when the caller is not a workspace owner", async () => {
    stubActualRole = "member";

    const res = await request(app).get("/users/1/locations");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the workspace owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric member id", async () => {
    const res = await request(app).get("/users/bad-id/locations");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when the member does not exist in this workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // member check

    const res = await request(app).get("/users/999/locations");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/member not found/i);
  });

  it("returns 200 with an empty locations array when the member has no assignments", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // member check
      .mockResolvedValueOnce({ rows: [] });                        // location query

    const res = await request(app).get("/users/1/locations");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("locations");
    expect(res.body.locations).toEqual([]);
  });

  it("returns 200 with location rows when assignments exist", async () => {
    const locationRow = { id: 5, name: "Dubai HQ", country: "AE", location_type: "office" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [locationRow] });

    const res = await request(app).get("/users/1/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0].name).toBe("Dubai HQ");
  });
});

// ---------------------------------------------------------------------------
// PUT /users/:id/locations — replace a member's location assignments
// ---------------------------------------------------------------------------

describe("PUT /users/:id/locations — replace member location assignments", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("returns 403 when the caller is not a workspace owner", async () => {
    stubActualRole = "member";

    const res = await request(app).put("/users/1/locations").send({ locationIds: [] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the workspace owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when locationIds is not an array", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1, role: "member" }], rowCount: 1 }); // member check

    const res = await request(app).put("/users/1/locations").send({ locationIds: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an array/i);
  });

  it("returns 400 when the member is an owner (owners cannot have location restrictions)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1, role: "owner" }], rowCount: 1 });

    const res = await request(app).put("/users/1/locations").send({ locationIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owners always see all data/i);
  });

  it("returns 404 when the member does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // member check

    const res = await request(app).put("/users/999/locations").send({ locationIds: [] });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/member not found/i);
  });

  it("returns 200 ok when an owner clears all location assignments", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1, role: "member" }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).put("/users/1/locations").send({ locationIds: [] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, locationIds: [] });
  });

  it("returns 200 ok when an owner assigns valid location ids", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, role: "member" }], rowCount: 1 }) // member check
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 });   // location validation

    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).put("/users/1/locations").send({ locationIds: [10, 20] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, locationIds: [10, 20] });
  });
});

// ---------------------------------------------------------------------------
// GET /users/failed-access-requests — list undismissed failed access requests
// ---------------------------------------------------------------------------

describe("GET /users/failed-access-requests — list failed access requests", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when the caller is not a workspace owner", async () => {
    stubActualRole = "member";

    const res = await request(app).get("/users/failed-access-requests");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the workspace owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 200 with an empty array when there are no failed requests", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/users/failed-access-requests");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("failedRequests");
    expect(res.body.failedRequests).toEqual([]);
  });

  it("returns 200 with failed request rows when they exist", async () => {
    const row = {
      id: 3,
      requester_email: "unknown@example.com",
      requester_name: "Unknown",
      error_message: "No matching domain",
      created_at: "2024-01-01T00:00:00Z",
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });

    const res = await request(app).get("/users/failed-access-requests");

    expect(res.status).toBe(200);
    expect(res.body.failedRequests).toHaveLength(1);
    expect(res.body.failedRequests[0].requester_email).toBe("unknown@example.com");
  });
});

// ---------------------------------------------------------------------------
// DELETE /users/failed-access-requests/:id — dismiss a failed access request
// ---------------------------------------------------------------------------

describe("DELETE /users/failed-access-requests/:id — dismiss a failed access request", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
  });

  it("returns 403 when the caller is not a workspace owner", async () => {
    stubActualRole = "member";

    const res = await request(app).delete("/users/failed-access-requests/3");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the workspace owner/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).delete("/users/failed-access-requests/bad-id");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when the request is not found or already dismissed", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app).delete("/users/failed-access-requests/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 200 ok when an owner successfully dismisses a failed request", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(app).delete("/users/failed-access-requests/3");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
