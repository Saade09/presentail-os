import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Regression test: the review scan-redirect route must be mounted BEFORE
// clerkMiddleware in app.ts so an unauthenticated QR scan is never
// intercepted by Clerk's handshake logic (e.g. a `host_invalid` error
// rejecting the request before it reaches the redirect handler). This test
// exercises the *full* app (with clerkMiddleware attached), simulating a
// clerkMiddleware that always fails, and asserts the redirect still
// succeeds — while a normal authenticated-style route mounted after
// clerkMiddleware does surface the simulated failure, proving the harness
// would actually catch a mounting-order regression.
// ---------------------------------------------------------------------------

vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Simulates a broken Clerk handshake: every request that reaches this
// middleware gets Clerk's raw error JSON instead of continuing to the route
// handler — mirroring the production `host_invalid` failure mode.
const CLERK_HANDSHAKE_ERROR_BODY = { clerkError: true, errors: [{ code: "host_invalid" }] };

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      res.status(401).json(CLERK_HANDSHAKE_ERROR_BODY);
    },
  getAuth: vi.fn(),
  clerkClient: { users: { getUser: vi.fn() } },
}));

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
  withTransaction: vi.fn(),
}));

import app from "../app";
import { DEFAULT_GOOGLE_REVIEW_URL } from "../lib/reviewAttribution";

const PROFILE_ROW = {
  id: 7,
  workspace_owner_id: "owner_1",
  is_active: true,
  gbp_location_id: null,
  location_review_url: null,
};

function queueHappyPath() {
  mockDbQuery
    .mockResolvedValueOnce({ rows: [PROFILE_ROW], rowCount: 1 }) // profile lookup
    .mockResolvedValueOnce({ rows: [{ n: "0" }], rowCount: 1 }) // rapid-scan check
    .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // scan insert
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // workspace google_review_url
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/reviews/e/:code through the full app (Clerk middleware attached)", () => {
  it("redirects to the Google review URL even when Clerk's handshake would reject the request", async () => {
    queueHappyPath();

    const res = await request(app).get("/api/reviews/e/abc123XYZw");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEFAULT_GOOGLE_REVIEW_URL);
    // Prove it's a real redirect, not Clerk's error payload.
    expect(res.body).not.toMatchObject({ clerkError: true });
  });

  it("still shows the fallback page (not a Clerk error) for an unknown code", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/api/reviews/e/nope");

    expect(res.status).toBe(404);
    expect(res.text).toContain("not available");
    expect(res.body).not.toMatchObject({ clerkError: true });
  });

  it("sanity check: a route mounted after clerkMiddleware does hit the simulated Clerk failure", async () => {
    // Confirms the mocked clerkMiddleware is actually wired into the app and
    // would have failed this test had reviewRedirectRouter been mounted
    // after it instead of before.
    const res = await request(app).get("/api/request-access");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ clerkError: true });
  });
});
