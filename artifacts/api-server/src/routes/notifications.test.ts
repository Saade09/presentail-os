import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

let stubUserId = "user_a";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (_req: express.Request) => ({ userId: stubUserId }),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import notificationsRouter from "./notifications";

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
  app.use(notificationsRouter);
  return app;
}

describe("GET /notifications/seen", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubUserId = "user_a";
  });

  it("returns the seen IDs stored for the authenticated user", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ access_request_id: 1 }, { access_request_id: 2 }, { access_request_id: 3 }],
      rowCount: 3,
    });

    const res = await request(app).get("/notifications/seen");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seenIds: [1, 2, 3] });
  });

  it("returns an empty array when no IDs have been marked seen", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/notifications/seen");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seenIds: [] });
  });

  it("queries with the authenticated user's id (user A does not see user B's rows)", async () => {
    stubUserId = "user_a";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/notifications/seen");

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE\s+user_id\s*=\s*\$1/i);
    expect(params).toEqual(["user_a"]);

    mockDbQuery.mockClear();
    stubUserId = "user_b";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/notifications/seen");

    const [, params2] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params2).toEqual(["user_b"]);
  });
});

describe("POST /notifications/seen", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubUserId = "user_a";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("stores submitted IDs and responds { ok: true }", async () => {
    const res = await request(app)
      .post("/notifications/seen")
      .send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("uses ON CONFLICT DO NOTHING for idempotency", async () => {
    await request(app).post("/notifications/seen").send({ ids: [1, 2] });

    const [sql] = mockDbQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ON CONFLICT\s+DO NOTHING/i);
  });

  it("re-submitting the same IDs is idempotent (both POSTs succeed and both use ON CONFLICT DO NOTHING)", async () => {
    const res1 = await request(app).post("/notifications/seen").send({ ids: [1, 2] });
    const res2 = await request(app).post("/notifications/seen").send({ ids: [1, 2] });

    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ ok: true });
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ ok: true });

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const [sql1] = mockDbQuery.mock.calls[0] as [string];
    const [sql2] = mockDbQuery.mock.calls[1] as [string];
    expect(sql1).toMatch(/ON CONFLICT\s+DO NOTHING/i);
    expect(sql2).toMatch(/ON CONFLICT\s+DO NOTHING/i);
  });

  it("passes the authenticated userId and all submitted IDs as query parameters", async () => {
    stubUserId = "user_xyz";

    await request(app).post("/notifications/seen").send({ ids: [10, 20, 30] });

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("user_xyz");
    expect(params.slice(1)).toEqual([10, 20, 30]);
  });

  it("returns 400 when the body is missing", async () => {
    const res = await request(app)
      .post("/notifications/seen")
      .set("Content-Type", "application/json")
      .send();

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when ids is an empty array", async () => {
    const res = await request(app).post("/notifications/seen").send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when ids contains non-integer values", async () => {
    const res = await request(app)
      .post("/notifications/seen")
      .send({ ids: [1, "two", 3] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
