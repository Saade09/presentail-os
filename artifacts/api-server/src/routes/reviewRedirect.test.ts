import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import reviewRedirectRouter from "./reviewRedirect";
import { DEFAULT_GOOGLE_REVIEW_URL } from "../lib/reviewAttribution";

function makeApp() {
  const app = express();
  app.use(reviewRedirectRouter);
  return app;
}

const PROFILE_ROW = {
  id: 7,
  workspace_owner_id: "owner_1",
  is_active: true,
};

/**
 * The route issues, in order:
 *  1. SELECT profile by code
 *  2. SELECT recent scan count for the device hash (rapid-repeat check)
 *  3. INSERT the scan
 *  4. SELECT workspace google_review_url
 */
function queueHappyPath(opts: { recentCount?: number; reviewUrl?: string | null } = {}) {
  mockDbQuery
    .mockResolvedValueOnce({ rows: [PROFILE_ROW], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ n: String(opts.recentCount ?? 0) }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: opts.reviewUrl === undefined ? [] : [{ google_review_url: opts.reviewUrl }],
      rowCount: 1,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /reviews/e/:code", () => {
  it("records a scan and 302-redirects to the default Google review URL with no-store", async () => {
    queueHappyPath();
    const res = await request(makeApp()).get("/reviews/e/abc123XYZw");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEFAULT_GOOGLE_REVIEW_URL);
    expect(res.headers["cache-control"]).toBe("no-store");

    // Scan insert (3rd query) carries workspace, profile, hash, source, flagged=false.
    const insertCall = mockDbQuery.mock.calls[2];
    expect(insertCall[0]).toContain("INSERT INTO review_scans");
    expect(insertCall[1][0]).toBe("owner_1");
    expect(insertCall[1][1]).toBe(7);
    expect(typeof insertCall[1][2]).toBe("string"); // anonymized device hash
    expect(insertCall[1][2]).toHaveLength(16);
    expect(insertCall[1][4]).toBe(false);
  });

  it("redirects to the workspace-configured Google review URL when set", async () => {
    queueHappyPath({ reviewUrl: "https://g.page/r/custom/review" });
    const res = await request(makeApp()).get("/reviews/e/abc123XYZw");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://g.page/r/custom/review");
  });

  it("records the ?src= source tag on the scan", async () => {
    queueHappyPath();
    await request(makeApp()).get("/reviews/e/abc123XYZw?src=sticker");
    expect(mockDbQuery.mock.calls[2][1][3]).toBe("sticker");
  });

  it("flags a rapid repeat scan from the same device hash but still redirects", async () => {
    queueHappyPath({ recentCount: 2 });
    const res = await request(makeApp()).get("/reviews/e/abc123XYZw");
    expect(res.status).toBe(302);
    expect(mockDbQuery.mock.calls[2][1][4]).toBe(true); // flagged
  });

  it("renders the fallback page for an unknown code without logging a scan", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).get("/reviews/e/nope");
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("not available");
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("renders the fallback page for a paused profile without logging a scan", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...PROFILE_ROW, is_active: false }],
      rowCount: 1,
    });
    const res = await request(makeApp()).get("/reviews/e/paused1234");
    expect(res.status).toBe(404);
    expect(res.text).toContain("not available");
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("renders the fallback page when the database fails", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("boom"));
    const res = await request(makeApp()).get("/reviews/e/abc123XYZw");
    expect(res.status).toBe(404);
  });
});
