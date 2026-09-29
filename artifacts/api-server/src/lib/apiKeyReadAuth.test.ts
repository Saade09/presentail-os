import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const mockDbQuery = vi.fn();
const mockGetAuth = vi.fn(() => ({
  userId: null as string | null,
  sessionClaims: null as { userId?: string } | null,
}));

vi.mock("./db", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { query: (...args: any[]) => mockDbQuery(...args) } as any,
}));

vi.mock("@clerk/express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...actual,
    getAuth: () => mockGetAuth(),
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { apiKeyReadAuth } from "./apiKeyAuth";
import { requireAuth } from "./auth";

const VALID_KEY = "pk_live_validkey123";
const OWNER_ID = "user_owner_1";

function makeReq(opts: {
  method?: string;
  authorization?: string;
  xApiKey?: string;
  query?: Record<string, unknown>;
}) {
  const headers: Record<string, string | undefined> = {
    authorization: opts.authorization,
    "x-api-key": opts.xApiKey,
  };
  return {
    method: opts.method ?? "GET",
    query: opts.query ?? {},
    header: (name: string) => headers[name.toLowerCase()],
    headers,
  } as unknown as Parameters<typeof apiKeyReadAuth>[0];
}

function makeRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  } as unknown as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  return res;
}

describe("apiKeyReadAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetAuth.mockReturnValue({ userId: null, sessionClaims: null });
  });

  it("GET with a valid key sets userId + apiKeyReadAuth and calls next()", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, user_id: OWNER_ID }],
      rowCount: 1,
    });
    const req = makeReq({ method: "GET", authorization: `Bearer ${VALID_KEY}` });
    const res = makeRes();
    const next = vi.fn();
    await apiKeyReadAuth(req, res as never, next);
    expect(next).toHaveBeenCalled();
    const areq = req as unknown as { userId?: string; apiKeyReadAuth?: boolean };
    expect(areq.userId).toBe(OWNER_ID);
    expect(areq.apiKeyReadAuth).toBe(true);
    // looked up by sha256 hash of the raw key
    const expectedHash = crypto.createHash("sha256").update(VALID_KEY).digest("hex");
    expect(mockDbQuery.mock.calls[0][1]).toEqual([expectedHash]);
  });

  it("HEAD with a valid key also establishes a read identity", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, user_id: OWNER_ID }],
      rowCount: 1,
    });
    const req = makeReq({ method: "HEAD", authorization: `Bearer ${VALID_KEY}` });
    const res = makeRes();
    const next = vi.fn();
    await apiKeyReadAuth(req, res as never, next);
    expect(next).toHaveBeenCalled();
    const areq = req as unknown as { userId?: string; apiKeyReadAuth?: boolean };
    expect(areq.userId).toBe(OWNER_ID);
    expect(areq.apiKeyReadAuth).toBe(true);
  });

  it("does NOT establish an identity for mutating methods even with a valid key", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      mockDbQuery.mockClear();
      const req = makeReq({ method, authorization: `Bearer ${VALID_KEY}` });
      const res = makeRes();
      const next = vi.fn();
      await apiKeyReadAuth(req, res as never, next);
      expect(next).toHaveBeenCalled();
      const areq = req as unknown as { userId?: string; apiKeyReadAuth?: boolean };
      expect(areq.userId).toBeUndefined();
      expect(areq.apiKeyReadAuth).toBeUndefined();
      // never even touches the DB for a write method
      expect(mockDbQuery).not.toHaveBeenCalled();
    }
  });

  it("GET with no key leaves the request untouched and calls next()", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = vi.fn();
    await apiKeyReadAuth(req, res as never, next);
    expect(next).toHaveBeenCalled();
    const areq = req as unknown as { userId?: string; apiKeyReadAuth?: boolean };
    expect(areq.userId).toBeUndefined();
    expect(areq.apiKeyReadAuth).toBeUndefined();
  });

  it("GET with an unknown key leaves the request untouched (never rejects)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const req = makeReq({ method: "GET", authorization: `Bearer ${VALID_KEY}` });
    const res = makeRes();
    const next = vi.fn();
    await apiKeyReadAuth(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    const areq = req as unknown as { userId?: string; apiKeyReadAuth?: boolean };
    expect(areq.userId).toBeUndefined();
    expect(areq.apiKeyReadAuth).toBeUndefined();
  });

  it("accepts the key via the x-api-key header too", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 9, user_id: OWNER_ID }],
      rowCount: 1,
    });
    const req = makeReq({ method: "GET", xApiKey: VALID_KEY });
    const res = makeRes();
    const next = vi.fn();
    await apiKeyReadAuth(req, res as never, next);
    const areq = req as unknown as { userId?: string; apiKeyReadAuth?: boolean };
    expect(areq.userId).toBe(OWNER_ID);
    expect(areq.apiKeyReadAuth).toBe(true);
  });
});

describe("requireAuth honoring an API-key read identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetAuth.mockReturnValue({ userId: null, sessionClaims: null });
  });

  it("allows the request when apiKeyReadAuth was established and no Clerk session exists", () => {
    const req = makeReq({ method: "GET" }) as unknown as {
      userId?: string;
      apiKeyReadAuth?: boolean;
    };
    req.userId = OWNER_ID;
    req.apiKeyReadAuth = true;
    const res = makeRes();
    const next = vi.fn();
    requireAuth(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.userId).toBe(OWNER_ID);
  });

  it("returns 401 when there is no Clerk session and no API-key identity", () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const next = vi.fn();
    requireAuth(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not honor apiKeyReadAuth when userId is missing (defensive)", () => {
    const req = makeReq({ method: "GET" }) as unknown as { apiKeyReadAuth?: boolean };
    req.apiKeyReadAuth = true;
    const res = makeRes();
    const next = vi.fn();
    requireAuth(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("prefers the Clerk session userId when present (Clerk takes precedence)", () => {
    mockGetAuth.mockReturnValueOnce({
      userId: "user_clerk",
      sessionClaims: { userId: "user_clerk" },
    });
    const req = makeReq({ method: "GET" }) as unknown as {
      userId?: string;
      apiKeyReadAuth?: boolean;
    };
    // Even if an API-key identity is also somehow present, Clerk wins.
    req.userId = OWNER_ID;
    req.apiKeyReadAuth = true;
    const res = makeRes();
    const next = vi.fn();
    requireAuth(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe("user_clerk");
  });
});

describe("end-to-end: apiKeyReadAuth → requireAuth chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetAuth.mockReturnValue({ userId: null, sessionClaims: null });
  });

  it("GET with a valid key flows through both middlewares to next() with owner identity", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, user_id: OWNER_ID }],
      rowCount: 1,
    });
    const req = makeReq({ method: "GET", authorization: `Bearer ${VALID_KEY}` });
    const res = makeRes();
    const next1 = vi.fn();
    await apiKeyReadAuth(req, res as never, next1);
    expect(next1).toHaveBeenCalled();

    const next2 = vi.fn();
    await requireAuth(req as never, res as never, next2);
    expect(next2).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect((req as unknown as { userId?: string }).userId).toBe(OWNER_ID);
  });

  it("POST with a valid key is rejected by requireAuth (writes stay Clerk-only)", async () => {
    const req = makeReq({ method: "POST", authorization: `Bearer ${VALID_KEY}` });
    const res = makeRes();
    const next1 = vi.fn();
    await apiKeyReadAuth(req, res as never, next1);
    expect(next1).toHaveBeenCalled();

    const next2 = vi.fn();
    await requireAuth(req as never, res as never, next2);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next2).not.toHaveBeenCalled();
  });
});
