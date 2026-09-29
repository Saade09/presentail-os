import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: () => ({ userId: "user_abc" }),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] = [];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    (wreq as unknown as { allowedPages: string[] }).allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import cashDrawersRouter from "./cashDrawers";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void; warn: () => void; info: () => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(cashDrawersRouter);
  return app;
}

function makeDrawerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Front Desk",
    code: "FD",
    location_id: null,
    currency: "AED",
    secondary_currency: null,
    is_active: true,
    notes: null,
    created_by_clerk_id: "user_abc",
    updated_by_clerk_id: "user_abc",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
  stubAllowedPages = [];
});

// ---------------------------------------------------------------------------
// POST /cash-drawers — currency validation
// ---------------------------------------------------------------------------

describe("POST /cash-drawers currency rules", () => {
  it("rejects an invalid main currency", async () => {
    const res = await request(makeApp())
      .post("/cash-drawers")
      .send({ name: "Front Desk", code: "FD", currency: "XYZ" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currency must be one of/);
    // No dup-check or INSERT should have run.
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects a secondary currency equal to the main currency", async () => {
    const res = await request(makeApp())
      .post("/cash-drawers")
      .send({ name: "Front Desk", code: "FD", currency: "USD", secondary_currency: "USD" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different from the main currency/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects an invalid secondary currency", async () => {
    const res = await request(makeApp())
      .post("/cash-drawers")
      .send({ name: "Front Desk", code: "FD", currency: "USD", secondary_currency: "XYZ" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/secondary_currency must be one of/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("resolves an empty secondary currency to null", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // dup check
      .mockResolvedValueOnce({ rows: [makeDrawerRow({ currency: "USD" })], rowCount: 1 }); // INSERT

    const res = await request(makeApp())
      .post("/cash-drawers")
      .send({ name: "Front Desk", code: "FD", currency: "USD", secondary_currency: "" });

    expect(res.status).toBe(201);
    // INSERT is the 2nd query; secondary_currency is param index 5.
    const insertParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(insertParams[4]).toBe("USD");
    expect(insertParams[5]).toBe(null);
  });

  it("resolves a NONE secondary currency to null", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // dup check
      .mockResolvedValueOnce({ rows: [makeDrawerRow({ currency: "USD" })], rowCount: 1 }); // INSERT

    const res = await request(makeApp())
      .post("/cash-drawers")
      .send({ name: "Front Desk", code: "FD", currency: "USD", secondary_currency: "NONE" });

    expect(res.status).toBe(201);
    const insertParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(insertParams[5]).toBe(null);
  });

  it("persists a valid, distinct secondary currency (normalized)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // dup check
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
        rowCount: 1,
      }); // INSERT

    const res = await request(makeApp())
      .post("/cash-drawers")
      .send({ name: "Front Desk", code: "FD", currency: "usd", secondary_currency: "lbp" });

    expect(res.status).toBe(201);
    const insertParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(insertParams[4]).toBe("USD");
    expect(insertParams[5]).toBe("LBP");
  });
});

// ---------------------------------------------------------------------------
// PATCH /cash-drawers/:id — currency validation
// ---------------------------------------------------------------------------

describe("PATCH /cash-drawers/:id currency rules", () => {
  it("rejects an invalid main currency", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeDrawerRow({ currency: "USD" })], rowCount: 1 }); // existing

    const res = await request(makeApp())
      .patch("/cash-drawers/1")
      .send({ currency: "XYZ" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currency must be one of/);
    // Only the existing-row SELECT should have run (no UPDATE).
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a secondary currency equal to the main currency", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeDrawerRow({ currency: "USD" })], rowCount: 1 }); // existing

    const res = await request(makeApp())
      .patch("/cash-drawers/1")
      .send({ currency: "EUR", secondary_currency: "EUR" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different from the main currency/);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects when an existing secondary would equal a newly-set main currency", async () => {
    // Drawer already has LBP secondary; changing main to LBP (without sending
    // secondary) must be rejected so the two can never end up equal.
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
      rowCount: 1,
    }); // existing

    const res = await request(makeApp())
      .patch("/cash-drawers/1")
      .send({ currency: "LBP" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different from the main currency/);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("resolves an empty secondary currency to null on update", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
        rowCount: 1,
      }) // existing
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: null })],
        rowCount: 1,
      }); // UPDATE

    const res = await request(makeApp())
      .patch("/cash-drawers/1")
      .send({ secondary_currency: "" });

    expect(res.status).toBe(200);
    // UPDATE is the 2nd query; secondary_currency is param index 6.
    const updateParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(updateParams[6]).toBe(null);
  });

  it("resolves a NONE secondary currency to null on update", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
        rowCount: 1,
      }) // existing
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: null })],
        rowCount: 1,
      }); // UPDATE

    const res = await request(makeApp())
      .patch("/cash-drawers/1")
      .send({ secondary_currency: "NONE" });

    expect(res.status).toBe(200);
    const updateParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(updateParams[6]).toBe(null);
  });

  it("persists a valid, distinct secondary currency on update", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: null })],
        rowCount: 1,
      }) // existing
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
        rowCount: 1,
      }); // UPDATE

    const res = await request(makeApp())
      .patch("/cash-drawers/1")
      .send({ secondary_currency: "lbp" });

    expect(res.status).toBe(200);
    const updateParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(updateParams[5]).toBe("USD");
    expect(updateParams[6]).toBe("LBP");
  });
});
