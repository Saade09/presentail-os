import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

let mockCurrentSessionId = "sess_current";
let mockCurrentUserId = "user_abc";

const mockGetSessionList = vi.fn();
const mockRevokeSession = vi.fn();

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(),
  clerkClient: {
    sessions: {
      getSessionList: (...args: unknown[]) => mockGetSessionList(...args),
      revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
    },
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => ({ userId: (req as unknown as { _mockUserId: string })._mockUserId ?? mockCurrentUserId }),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { getAuth } from "@clerk/express";
import securityRouter from "./security";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

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
  app.use(securityRouter);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: {
  id?: string;
  lastActiveAt?: number;
  createdAt?: number;
  expireAt?: number;
  browserName?: string | null;
  deviceType?: string | null;
  ipAddress?: string | null;
  city?: string | null;
  country?: string | null;
} = {}) {
  return {
    id: overrides.id ?? "sess_other",
    lastActiveAt: overrides.lastActiveAt ?? 1700000000000,
    createdAt: overrides.createdAt ?? 1699000000000,
    expireAt: overrides.expireAt ?? 1710000000000,
    latestActivity: {
      browserName: "browserName" in overrides ? overrides.browserName : "Chrome",
      deviceType: "deviceType" in overrides ? overrides.deviceType : "desktop",
      ipAddress: "ipAddress" in overrides ? overrides.ipAddress : "192.168.1.50",
      city: "city" in overrides ? overrides.city : "Dubai",
      country: "country" in overrides ? overrides.country : "AE",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCurrentSessionId = "sess_current";
  mockCurrentUserId = "user_abc";
  vi.mocked(getAuth).mockReturnValue({ sessionId: mockCurrentSessionId, userId: mockCurrentUserId } as never);
});

// ---------------------------------------------------------------------------
// GET /security/sessions
// ---------------------------------------------------------------------------

describe("GET /security/sessions", () => {
  it("returns sessions with current session marked and sorted first", async () => {
    const currentSession = makeSession({
      id: "sess_current",
      lastActiveAt: 1700000000000,
      browserName: "Firefox",
      deviceType: "mobile",
      ipAddress: "10.0.0.1",
    });
    const olderSession = makeSession({
      id: "sess_older",
      lastActiveAt: 1699000000000,
    });
    const newerSession = makeSession({
      id: "sess_newer",
      lastActiveAt: 1701000000000,
    });

    mockGetSessionList.mockResolvedValueOnce({ data: [olderSession, currentSession, newerSession] });

    const res = await request(app).get("/security/sessions");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessions");

    const sessions = res.body.sessions as Array<{ id: string; isCurrent: boolean }>;
    expect(sessions[0].id).toBe("sess_current");
    expect(sessions[0].isCurrent).toBe(true);
    expect(sessions[1].isCurrent).toBe(false);
    expect(sessions[2].isCurrent).toBe(false);
  });

  it("sorts non-current sessions by lastActiveAt descending", async () => {
    const currentSession = makeSession({ id: "sess_current", lastActiveAt: 1700000000000 });
    const older = makeSession({ id: "sess_older", lastActiveAt: 1698000000000 });
    const newer = makeSession({ id: "sess_newer", lastActiveAt: 1702000000000 });

    mockGetSessionList.mockResolvedValueOnce({ data: [older, newer, currentSession] });

    const res = await request(app).get("/security/sessions");

    expect(res.status).toBe(200);
    const sessions = res.body.sessions as Array<{ id: string }>;
    expect(sessions[0].id).toBe("sess_current");
    expect(sessions[1].id).toBe("sess_newer");
    expect(sessions[2].id).toBe("sess_older");
  });

  it("returns the expected session shape", async () => {
    const session = makeSession({
      id: "sess_current",
      lastActiveAt: 1700000000000,
      createdAt: 1699000000000,
      expireAt: 1710000000000,
      browserName: "Safari",
      deviceType: "tablet",
      ipAddress: "203.0.113.5",
      city: "Beirut",
      country: "LB",
    });

    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.status).toBe(200);
    const s = res.body.sessions[0];
    expect(s.id).toBe("sess_current");
    expect(s.isCurrent).toBe(true);
    expect(s.deviceLabel).toBe("Safari on tablet");
    expect(s.city).toBe("Beirut");
    expect(s.country).toBe("LB");
    expect(typeof s.lastActiveAt).toBe("string");
    expect(typeof s.createdAt).toBe("string");
    expect(typeof s.expireAt).toBe("string");
  });

  it("returns an empty sessions array when no active sessions", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [] });

    const res = await request(app).get("/security/sessions");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it("calls getSessionList with the correct userId and status", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [] });

    await request(app).get("/security/sessions");

    expect(mockGetSessionList).toHaveBeenCalledWith({ userId: "user_abc", status: "active" });
  });
});

// ---------------------------------------------------------------------------
// IP masking
// ---------------------------------------------------------------------------

describe("IP masking in GET /security/sessions", () => {
  it("masks IPv4 addresses, preserving the first two octets", async () => {
    const session = makeSession({ id: "sess_current", ipAddress: "192.168.10.200" });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].ipAddress).toBe("192.168.x.xxx");
  });

  it("masks IPv6 addresses, preserving the first group", async () => {
    const session = makeSession({ id: "sess_current", ipAddress: "2001:db8:85a3:0:0:8a2e:370:7334" });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].ipAddress).toBe("2001:db8:xxxx:xxxx:xxxx");
  });

  it("returns fallback x.x.x.x for unrecognised IP format", async () => {
    const session = makeSession({ id: "sess_current", ipAddress: "not-an-ip" });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].ipAddress).toBe("x.x.x.x");
  });

  it("returns null when ipAddress is null", async () => {
    const session = makeSession({ id: "sess_current", ipAddress: null });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].ipAddress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Device label
// ---------------------------------------------------------------------------

describe("deviceLabel in GET /security/sessions", () => {
  it("returns 'Browser on Device' when both are present", async () => {
    const session = makeSession({ id: "sess_current", browserName: "Chrome", deviceType: "desktop" });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].deviceLabel).toBe("Chrome on desktop");
  });

  it("returns only the browser name when deviceType is null", async () => {
    const session = makeSession({ id: "sess_current", browserName: "Edge", deviceType: null });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].deviceLabel).toBe("Edge");
  });

  it("returns only the device type when browserName is null", async () => {
    const session = makeSession({ id: "sess_current", browserName: null, deviceType: "mobile" });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].deviceLabel).toBe("mobile");
  });

  it("returns 'Unknown device' when both browser and device are null", async () => {
    const session = makeSession({ id: "sess_current", browserName: null, deviceType: null });
    mockGetSessionList.mockResolvedValueOnce({ data: [session] });

    const res = await request(app).get("/security/sessions");

    expect(res.body.sessions[0].deviceLabel).toBe("Unknown device");
  });
});

// ---------------------------------------------------------------------------
// POST /security/sessions/:sessionId/revoke
// ---------------------------------------------------------------------------

describe("POST /security/sessions/:sessionId/revoke", () => {
  it("returns 400 when trying to revoke the current session", async () => {
    const res = await request(app).post("/security/sessions/sess_current/revoke");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot revoke the current session" });
    expect(mockGetSessionList).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the session doesn't belong to the user", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [makeSession({ id: "sess_other" })] });

    const res = await request(app).post("/security/sessions/sess_unknown/revoke");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Session not found" });
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("revokes the session and returns success when valid", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [makeSession({ id: "sess_other" })] });
    mockRevokeSession.mockResolvedValueOnce(undefined);

    const res = await request(app).post("/security/sessions/sess_other/revoke");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockRevokeSession).toHaveBeenCalledWith("sess_other");
  });

  it("calls getSessionList with the correct userId and status", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [makeSession({ id: "sess_other" })] });
    mockRevokeSession.mockResolvedValueOnce(undefined);

    await request(app).post("/security/sessions/sess_other/revoke");

    expect(mockGetSessionList).toHaveBeenCalledWith({ userId: "user_abc", status: "active" });
  });
});

// ---------------------------------------------------------------------------
// POST /security/sessions/revoke-others
// ---------------------------------------------------------------------------

describe("POST /security/sessions/revoke-others", () => {
  it("revokes all sessions except the current one", async () => {
    const sessions = [
      makeSession({ id: "sess_current" }),
      makeSession({ id: "sess_a" }),
      makeSession({ id: "sess_b" }),
    ];
    mockGetSessionList.mockResolvedValueOnce({ data: sessions });
    mockRevokeSession.mockResolvedValue(undefined);

    const res = await request(app).post("/security/sessions/revoke-others");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revokedCount: 2 });

    const revokedIds = mockRevokeSession.mock.calls.map((c) => c[0]);
    expect(revokedIds).toContain("sess_a");
    expect(revokedIds).toContain("sess_b");
    expect(revokedIds).not.toContain("sess_current");
  });

  it("returns revokedCount of 0 when no other sessions exist", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [makeSession({ id: "sess_current" })] });

    const res = await request(app).post("/security/sessions/revoke-others");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revokedCount: 0 });
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("returns revokedCount of 0 when the session list is empty", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [] });

    const res = await request(app).post("/security/sessions/revoke-others");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revokedCount: 0 });
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("calls getSessionList with the correct userId and status", async () => {
    mockGetSessionList.mockResolvedValueOnce({ data: [] });

    await request(app).post("/security/sessions/revoke-others");

    expect(mockGetSessionList).toHaveBeenCalledWith({ userId: "user_abc", status: "active" });
  });

  it("revokes all sessions when all are non-current", async () => {
    mockGetSessionList.mockResolvedValueOnce({
      data: [
        makeSession({ id: "sess_a" }),
        makeSession({ id: "sess_b" }),
        makeSession({ id: "sess_c" }),
      ],
    });
    mockRevokeSession.mockResolvedValue(undefined);

    const res = await request(app).post("/security/sessions/revoke-others");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, revokedCount: 3 });
    expect(mockRevokeSession).toHaveBeenCalledTimes(3);
  });
});
