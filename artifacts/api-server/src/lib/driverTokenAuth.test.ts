import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbQuery = vi.fn();
const mockGetAuth = vi.fn(() => ({
  userId: null as string | null,
  sessionClaims: null as { publicMetadata?: { userType?: string } } | null,
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

import {
  DRIVER_TOKEN_PREFIX,
  generateDriverToken,
  hashDriverToken,
  issueDriverToken,
  revokeDriverTokens,
  requireDriverToken,
} from "./driverTokenAuth";

describe("driverTokenAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe("generateDriverToken", () => {
    it("creates a fdt_live_ prefixed token with stable hash", () => {
      const t = generateDriverToken();
      expect(t.plaintext.startsWith(DRIVER_TOKEN_PREFIX)).toBe(true);
      expect(t.hash).toBe(hashDriverToken(t.plaintext));
      expect(t.prefix.length).toBe(16);
    });

    it("hashDriverToken is deterministic and different per input", () => {
      const a = hashDriverToken("foo");
      const b = hashDriverToken("foo");
      const c = hashDriverToken("bar");
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toHaveLength(64);
    });
  });

  describe("issueDriverToken", () => {
    it("revokes existing active tokens before inserting a new one", async () => {
      await issueDriverToken(7);
      expect(mockDbQuery).toHaveBeenCalledTimes(2);
      const firstSql = String(mockDbQuery.mock.calls[0][0]);
      expect(firstSql).toMatch(/UPDATE fleet_driver_api_tokens/);
      expect(firstSql).toMatch(/revoked_at IS NULL/);
      const secondSql = String(mockDbQuery.mock.calls[1][0]);
      expect(secondSql).toMatch(/INSERT INTO fleet_driver_api_tokens/);
    });
  });

  describe("revokeDriverTokens", () => {
    it("revokes only currently-active tokens for the driver", async () => {
      await revokeDriverTokens(99);
      expect(mockDbQuery).toHaveBeenCalledTimes(1);
      const sql = String(mockDbQuery.mock.calls[0][0]);
      expect(sql).toMatch(/UPDATE fleet_driver_api_tokens/);
      expect(sql).toMatch(/revoked_at IS NULL/);
      expect(mockDbQuery.mock.calls[0][1]).toEqual([99]);
    });
  });

  describe("requireDriverToken", () => {
    function makeReq(authorization?: string) {
      return {
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? authorization : undefined,
      } as unknown as Parameters<typeof requireDriverToken>[0];
    }
    function makeRes() {
      const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } = {
        status: vi.fn(() => res),
        json: vi.fn(() => res),
      } as unknown as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
      return res;
    }

    it("returns 401 when no Authorization header is provided", async () => {
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq(), res as never, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects tokens that don't match the fdt_live_ prefix", async () => {
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq("Bearer pk_live_xxx"), res as never, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects revoked tokens (no row returned)", async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(
        makeReq(`Bearer ${DRIVER_TOKEN_PREFIX}aaaaaaaaaaaaaaaa`),
        res as never,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects tokens for non-approved drivers", async () => {
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            driver_id: 5,
            workspace_owner_id: "owner_1",
            onboarding_status: "pending",
            deleted_at: null,
          },
        ],
        rowCount: 1,
      });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(
        makeReq(`Bearer ${DRIVER_TOKEN_PREFIX}abcdef`),
        res as never,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("rejects tokens that have expired", async () => {
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            driver_id: 5,
            workspace_owner_id: "owner_1",
            onboarding_status: "approved",
            deleted_at: null,
            expires_at: new Date(Date.now() - 1000).toISOString(),
          },
        ],
        rowCount: 1,
      });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(
        makeReq(`Bearer ${DRIVER_TOKEN_PREFIX}aaaaaaaaaaaaaaaa`),
        res as never,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(401);
      const body = res.json.mock.calls[0][0];
      expect(body?.error?.code).toBe("TOKEN_EXPIRED");
      expect(next).not.toHaveBeenCalled();
    });

    it("attaches driverId/workspace and calls next() for valid tokens", async () => {
      mockDbQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 11,
              driver_id: 5,
              workspace_owner_id: "owner_1",
              onboarding_status: "approved",
              deleted_at: null,
              expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const req = makeReq(`Bearer ${DRIVER_TOKEN_PREFIX}abcdef`) as unknown as {
        driverId?: number;
        driverWorkspaceOwnerId?: string;
        header: (n: string) => string | undefined;
      };
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(req as never, res as never, next);
      expect(next).toHaveBeenCalled();
      expect(req.driverId).toBe(5);
      expect(req.driverWorkspaceOwnerId).toBe("owner_1");
    });
  });

  describe("requireDriverToken — Clerk JWT path", () => {
    function makeReq(authorization?: string) {
      return {
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? authorization : undefined,
      } as unknown as Parameters<typeof requireDriverToken>[0];
    }
    function makeRes() {
      const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } = {
        status: vi.fn(() => res),
        json: vi.fn(() => res),
      } as unknown as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
      return res;
    }

    it("returns 401 when Clerk session has no userId (unauthenticated)", async () => {
      mockGetAuth.mockReturnValueOnce({ userId: null, sessionClaims: null });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq("Bearer some-clerk-jwt"), res as never, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when Clerk user has wrong userType (not a driver)", async () => {
      mockGetAuth.mockReturnValueOnce({
        userId: "user_abc",
        sessionClaims: { publicMetadata: { userType: "admin" } },
      });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq("Bearer some-clerk-jwt"), res as never, next);
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body?.error?.code).toBe("NOT_A_DRIVER");
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when Clerk userType is driver but no matching driver row exists", async () => {
      mockGetAuth.mockReturnValueOnce({
        userId: "user_orphan",
        sessionClaims: { publicMetadata: { userType: "driver" } },
      });
      mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq("Bearer some-clerk-jwt"), res as never, next);
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body?.error?.code).toBe("NOT_A_DRIVER");
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when driver is found but not approved", async () => {
      mockGetAuth.mockReturnValueOnce({
        userId: "user_pending",
        sessionClaims: { publicMetadata: { userType: "driver" } },
      });
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 20,
            workspace_owner_id: "owner_2",
            onboarding_status: "pending",
            status: "active",
            deleted_at: null,
          },
        ],
        rowCount: 1,
      });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq("Bearer some-clerk-jwt"), res as never, next);
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body?.error?.code).toBe("DRIVER_NOT_ACTIVE");
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when driver is approved but status is inactive", async () => {
      mockGetAuth.mockReturnValueOnce({
        userId: "user_inactive",
        sessionClaims: { publicMetadata: { userType: "driver" } },
      });
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 21,
            workspace_owner_id: "owner_2",
            onboarding_status: "approved",
            status: "inactive",
            deleted_at: null,
          },
        ],
        rowCount: 1,
      });
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(makeReq("Bearer some-clerk-jwt"), res as never, next);
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body?.error?.code).toBe("DRIVER_NOT_ACTIVE");
      expect(next).not.toHaveBeenCalled();
    });

    it("attaches driverId/workspace and calls next() for valid Clerk JWT", async () => {
      mockGetAuth.mockReturnValueOnce({
        userId: "user_valid",
        sessionClaims: { publicMetadata: { userType: "driver" } },
      });
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            workspace_owner_id: "owner_3",
            onboarding_status: "approved",
            status: "active",
            deleted_at: null,
          },
        ],
        rowCount: 1,
      });
      const req = makeReq("Bearer some-clerk-jwt") as unknown as {
        driverId?: number;
        driverWorkspaceOwnerId?: string;
        header: (n: string) => string | undefined;
      };
      const res = makeRes();
      const next = vi.fn();
      await requireDriverToken(req as never, res as never, next);
      expect(next).toHaveBeenCalled();
      expect(req.driverId).toBe(42);
      expect(req.driverWorkspaceOwnerId).toBe("owner_3");
    });
  });
});
