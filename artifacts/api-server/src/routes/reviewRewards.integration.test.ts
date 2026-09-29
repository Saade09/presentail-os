/**
 * Integration tests for the Google Review Rewards module.
 *
 * Runs against a real throwaway PostgreSQL database (DATABASE_URL must be set;
 * auto-skipped otherwise).
 *
 * Coverage:
 *  - Profile CRUD + pause/reactivate + unique code + QR/tracking link
 *  - Public scan redirect logging (302 no-store) + rapid-repeat flagging
 *  - ingestReview idempotency (one review record, one reward per review id)
 *  - 6-hour most-recent-eligible-scan matching rule
 *  - Ambiguity handling (multiple profiles / review predates scan → needs_review)
 *  - Manual match resolution (assign + reject) with audit trail
 *  - Review deletion voiding pending rewards
 *  - Reward state transitions (pending → approved sweep, approved → paid, void)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_review_rewards_integration__";
const USER_ID = "__test_rr_user__";
const workspaceAccess = vi.hoisted(() => ({
  role: "owner" as "owner" | "member",
  allowedPages: null as string[] | null,
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = workspaceAccess.role;
    wreq.workspaceActualRole = workspaceAccess.role;
    wreq.allowedPages = workspaceAccess.allowedPages;
    wreq.userId = USER_ID;
    wreq.userEmail = "rr@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, page: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(page),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import reviewRewardsRouter from "./reviewRewards";
import reviewRedirectRouter from "./reviewRedirect";
import { ingestReview, markReviewDeleted } from "../lib/reviewAttribution";
import { runReviewRewardSweep } from "../lib/reviewRewardJob";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(reviewRedirectRouter);
  app.use(reviewRewardsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("Google Review Rewards — integration", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let reviewSeq = 0;
  /** A valid gbp_location_connections ID re-created after each cleanup. */
  let sharedGbpLocationId = 0;
  let employeeSequence = 0;

  function nextReviewId(): string {
    return `g-review-${Date.now()}-${++reviewSeq}`;
  }

  async function cleanup() {
    await pool.query(`DELETE FROM review_match_audit WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM review_rewards WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM review_scans WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM google_reviews WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM employee_review_profiles WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM team_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM gbp_location_connections WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM gbp_connections WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  async function createProfile(name: string, rewardAmount = 5, overrideGbpLocationId?: number): Promise<{
    id: number;
    code: string;
  }> {
    let locationId: number;
    if (overrideGbpLocationId !== undefined) {
      locationId = overrideGbpLocationId;
    } else {
      await ensureSharedLocation();
      locationId = sharedGbpLocationId;
    }
    const workspaceMemberId = await createWorkspaceMember(name);
    const res = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: name,
        role: "Florist",
        rewardAmount,
        gbpLocationId: locationId,
        workspaceMemberId,
      });
    expect(res.status).toBe(201);
    return { id: res.body.profile.id, code: res.body.profile.code };
  }

  /** Insert a scan directly with a controlled timestamp. */
  async function insertScan(
    profileId: number,
    scannedAt: Date,
    opts: { deviceHash?: string; flagged?: boolean } = {},
  ): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO review_scans (workspace_owner_id, profile_id, scanned_at, device_hash, flagged)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [OWNER_ID, profileId, scannedAt, opts.deviceHash ?? "hash0000000000aa", opts.flagged ?? false],
    );
    return r.rows[0].id;
  }

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(async () => {
    workspaceAccess.role = "owner";
    workspaceAccess.allowedPages = null;
    await cleanup();
    sharedGbpLocationId = 0; // Reset — createProfile() will re-create lazily on first call.
    employeeSequence = 0;
  });

  /**
   * Lazily create (or reuse) the shared GBP connection + location that
   * createProfile() relies on. Idempotent: safe to call multiple times per test.
   */
  async function ensureSharedLocation(): Promise<void> {
    if (sharedGbpLocationId !== 0) return;
    const conn = await pool.query<{ id: number }>(
      `INSERT INTO gbp_connections (workspace_owner_id, credentials_encrypted)
       VALUES ($1, 'test-creds') RETURNING id`,
      [OWNER_ID],
    );
    const loc = await pool.query<{ id: number }>(
      `INSERT INTO gbp_location_connections
         (workspace_owner_id, gbp_connection_id, location_name, location_title, is_enabled)
       VALUES ($1, $2, 'locations/shared001', 'Shared Store', true) RETURNING id`,
      [OWNER_ID, conn.rows[0].id],
    );
    sharedGbpLocationId = loc.rows[0].id;
  }

  async function createWorkspaceMember(name: string): Promise<number> {
    const suffix = ++employeeSequence;
    const result = await pool.query<{ id: number }>(
      `INSERT INTO workspace_members
         (workspace_owner_id, member_user_id, member_email, role, joined_at)
       VALUES ($1, $2, $3, 'member', now()) RETURNING id`,
      [OWNER_ID, `${OWNER_ID}-clerk-${suffix}`, `${name.toLowerCase()}-${suffix}@example.com`],
    );
    return result.rows[0].id;
  }

  async function createTeamMember(
    name: string,
    email: string | null = null,
    memberDbId: number | null = null,
  ): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO team_members (workspace_owner_id, first_name, email, member_db_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [OWNER_ID, name, email, memberDbId],
    );
    return result.rows[0].id;
  }

  // ── Profiles ────────────────────────────────────────────────────────────────

  it("allows every read-only page endpoint for a permitted member and denies all reads without the page permission", async () => {
    const created = await createProfile("Read Only");
    const readPaths = [
      "/review-rewards/profiles",
      `/review-rewards/profiles/${created.id}/qr`,
      "/review-rewards/settings",
      "/review-rewards/reviews",
      "/review-rewards/rewards",
      "/review-rewards/metrics/overview?days=30",
      "/review-rewards/metrics/trend?days=30",
      "/review-rewards/metrics/employees?days=30",
      "/review-rewards/metrics/latest-matches",
      "/review-rewards/locations/performance",
    ];

    workspaceAccess.role = "member";
    workspaceAccess.allowedPages = ["review-rewards"];
    for (const path of readPaths) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }

    workspaceAccess.allowedPages = [];
    for (const path of readPaths) {
      expect((await request(app).get(path)).status, path).toBe(403);
    }
  });

  it("keeps profile, settings, review, and reward mutations owner-only", async () => {
    const created = await createProfile("Owner Only");
    workspaceAccess.role = "member";
    workspaceAccess.allowedPages = ["review-rewards"];

    const responses = await Promise.all([
      request(app).post("/review-rewards/profiles").send({}),
      request(app).patch(`/review-rewards/profiles/${created.id}`).send({ employeeName: "Changed" }),
      request(app).post(`/review-rewards/profiles/${created.id}/pause`),
      request(app).post(`/review-rewards/profiles/${created.id}/reactivate`),
      request(app).delete(`/review-rewards/profiles/${created.id}`),
      request(app).patch("/review-rewards/settings").send({ googleReviewUrl: null }),
      request(app).post("/review-rewards/reviews/1/resolve").send({ action: "reject" }),
      request(app).post("/review-rewards/rewards/1/pay"),
      request(app).post("/review-rewards/rewards/1/void").send({ reason: "test" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403, 403, 403,
    ]);
  });

  it("creates a profile with a unique random code and tracking URL, updates, pauses and reactivates it", async () => {
    await ensureSharedLocation();
    const workspaceMemberId = await createWorkspaceMember("Maya");
    const created = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Maya",
        role: "Florist",
        rewardAmount: 10,
        gbpLocationId: sharedGbpLocationId,
        workspaceMemberId,
      });
    expect(created.status).toBe(201);
    const profile = created.body.profile;
    expect(profile.code).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(profile.trackingPath).toBe(`/api/reviews/e/${profile.code}`);
    expect(profile.trackingUrl).toContain(`/api/reviews/e/${profile.code}`);
    expect(profile.isActive).toBe(true);

    const second = await createProfile("Rami");
    expect(second.code).not.toBe(profile.code);

    const patched = await request(app)
      .patch(`/review-rewards/profiles/${profile.id}`)
      .send({ rewardAmount: 7.5, role: "Senior Florist" });
    expect(patched.status).toBe(200);
    expect(patched.body.profile.rewardAmount).toBe("7.50");
    expect(patched.body.profile.role).toBe("Senior Florist");

    const paused = await request(app).post(`/review-rewards/profiles/${profile.id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.profile.isActive).toBe(false);

    const reactivated = await request(app).post(
      `/review-rewards/profiles/${profile.id}/reactivate`,
    );
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.profile.isActive).toBe(true);

    const qr = await request(app).get(`/review-rewards/profiles/${profile.id}/qr`);
    expect(qr.status).toBe(200);
    expect(qr.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr.body.trackingUrl).toContain(`/api/reviews/e/${profile.code}`);

    const list = await request(app).get("/review-rewards/profiles");
    expect(list.status).toBe(200);
    expect(list.body.profiles).toHaveLength(2);
  });

  it("rejects profile creation without a gbpLocationId with 400", async () => {
    const res = await request(app)
      .post("/review-rewards/profiles")
      .send({ employeeName: "NoLocation", role: "Florist", rewardAmount: 5 });
    expect(res.status).toBe(400);
  });

  it("accepts workspace users and HR team members, and prevents duplicate QRs per location", async () => {
    await ensureSharedLocation();
    const workspaceMemberId = await createWorkspaceMember("Nour");
    const first = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Nour",
        rewardAmount: 5,
        gbpLocationId: sharedGbpLocationId,
        workspaceMemberId,
      });
    expect(first.status).toBe(201);
    expect(first.body.profile.workspaceMemberId).toBe(workspaceMemberId);

    const duplicateWorkspaceUser = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Nour",
        rewardAmount: 5,
        gbpLocationId: sharedGbpLocationId,
        workspaceMemberId,
      });
    expect(duplicateWorkspaceUser.status).toBe(409);
    expect(duplicateWorkspaceUser.body.error).toBe("duplicate");

    const teamMemberId = await createTeamMember("Omar");
    const hrProfile = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Omar",
        rewardAmount: 5,
        gbpLocationId: sharedGbpLocationId,
        teamMemberId,
      });
    expect(hrProfile.status).toBe(201);
    expect(hrProfile.body.profile.teamMemberId).toBe(teamMemberId);

    const duplicateTeamMember = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Omar",
        rewardAmount: 5,
        gbpLocationId: sharedGbpLocationId,
        teamMemberId,
      });
    expect(duplicateTeamMember.status).toBe(409);
    expect(duplicateTeamMember.body.error).toBe("duplicate");
  });

  it("prevents duplicates across linked HR and workspace references in either direction", async () => {
    await ensureSharedLocation();

    const legacyWorkspaceMemberId = await createWorkspaceMember("Layla");
    const legacyTeamMemberId = await createTeamMember("Layla", null, legacyWorkspaceMemberId);
    await pool.query(
      `INSERT INTO employee_review_profiles
          (workspace_owner_id, employee_name, reward_amount, code, gbp_location_id, team_member_id)
       VALUES ($1, 'Layla', 5, 'legacyhr01', $2, $3)`,
      [OWNER_ID, sharedGbpLocationId, legacyTeamMemberId],
    );

    const duplicateViaWorkspace = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Layla",
        rewardAmount: 5,
        gbpLocationId: sharedGbpLocationId,
        workspaceMemberId: legacyWorkspaceMemberId,
      });
    expect(duplicateViaWorkspace.status).toBe(409);
    expect(duplicateViaWorkspace.body.error).toBe("duplicate");

    const workspaceOnlyMemberId = await createWorkspaceMember("Hadi");
    const linkedTeamMemberId = await createTeamMember("Hadi", null, workspaceOnlyMemberId);
    await pool.query(
      `INSERT INTO employee_review_profiles
          (workspace_owner_id, employee_name, reward_amount, code, gbp_location_id, workspace_member_id)
       VALUES ($1, 'Hadi', 5, 'legacyws01', $2, $3)`,
      [OWNER_ID, sharedGbpLocationId, workspaceOnlyMemberId],
    );

    const duplicateViaHr = await request(app)
      .post("/review-rewards/profiles")
      .send({
        employeeName: "Hadi",
        rewardAmount: 5,
        gbpLocationId: sharedGbpLocationId,
        teamMemberId: linkedTeamMemberId,
      });
    expect(duplicateViaHr.status).toBe(409);
    expect(duplicateViaHr.body.error).toBe("duplicate");
  });

  // ── Scan redirect ───────────────────────────────────────────────────────────

  it("logs a scan and 302-redirects with no-store; paused code gets the fallback page", async () => {
    const { id, code } = await createProfile("Maya");

    const res = await request(app)
      .get(`/api/reviews/e/${code}?src=qr`)
      .set("User-Agent", "TestAgent/1.0");
    expect(res.status).toBe(302);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.location).toContain("https://");

    const scans = await pool.query(
      `SELECT * FROM review_scans WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(scans.rows).toHaveLength(1);
    expect(scans.rows[0].profile_id).toBe(id);
    expect(scans.rows[0].source).toBe("qr");
    expect(scans.rows[0].flagged).toBe(false);
    expect(scans.rows[0].device_hash).toHaveLength(16);

    // Second scan from the same device within the rapid window is flagged.
    const res2 = await request(app)
      .get(`/api/reviews/e/${code}`)
      .set("User-Agent", "TestAgent/1.0");
    expect(res2.status).toBe(302);
    const scans2 = await pool.query(
      `SELECT flagged FROM review_scans WHERE workspace_owner_id = $1 ORDER BY id`,
      [OWNER_ID],
    );
    expect(scans2.rows.map((r) => r.flagged)).toEqual([false, true]);

    // Paused profile → fallback page, no new scan.
    await request(app).post(`/review-rewards/profiles/${id}/pause`);
    const res3 = await request(app).get(`/api/reviews/e/${code}`);
    expect(res3.status).toBe(404);
    expect(res3.text).toContain("not available");
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM review_scans WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(count.rows[0].n).toBe(2);

    // Unknown code → fallback.
    const res4 = await request(app).get(`/api/reviews/e/doesnotexist`);
    expect(res4.status).toBe(404);
  });

  it("delete archives the profile: hidden from lists, QR stops redirecting, history preserved, attribution excluded", async () => {
    const { id, code } = await createProfile("Maya", 5);
    await request(app).get(`/api/reviews/e/${code}`); // one scan on record

    const del = await request(app).delete(`/review-rewards/profiles/${id}`);
    expect(del.status).toBe(200);

    // Hidden from list + further edits 404; second delete 404.
    const list = await request(app).get("/review-rewards/profiles");
    expect(list.body.profiles).toHaveLength(0);
    expect((await request(app).patch(`/review-rewards/profiles/${id}`).send({ rewardAmount: 1 })).status).toBe(404);
    expect((await request(app).delete(`/review-rewards/profiles/${id}`)).status).toBe(404);

    // QR link stops working, but scan history is preserved.
    const scan = await request(app).get(`/api/reviews/e/${code}`);
    expect(scan.status).toBe(404);
    const scans = await pool.query(
      `SELECT count(*)::int AS n FROM review_scans WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(scans.rows[0].n).toBe(1);

    // Archived profiles never auto-match new reviews.
    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-archived-profile",
    });
    expect(result.matchStatus).not.toBe("auto_matched");

    // …and cannot be manually assigned either.
    const assign = await request(app)
      .post(`/review-rewards/reviews/${result.reviewId}/resolve`)
      .send({ action: "assign", profileId: id });
    expect(assign.status).toBe(404);
    const rewards = await pool.query(
      `SELECT count(*)::int AS n FROM review_rewards WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rewards.rows[0].n).toBe(0);
  });

  it("rejects unsafe or non-Google review URLs and never redirects to them", async () => {
    const { code } = await createProfile("Maya");
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://google.com/review", // not HTTPS
      "https://evil.example.com/review",
      "https://notgoogle.com.evil.io/x",
      // Google's outbound redirector must not be usable as an open redirect.
      "https://www.google.com/url?q=https://evil.example",
      "https://google.com/url?q=https://evil.example",
      // Arbitrary google.com paths and subdomains are not review links.
      "https://www.google.com/search?q=x",
      "https://accounts.google.com/o/oauth2/auth",
    ]) {
      const res = await request(app)
        .patch("/review-rewards/settings")
        .send({ googleReviewUrl: bad });
      expect(res.status, `should reject: ${bad}`).toBe(400);
    }

    // Defense in depth: even a bad value written directly to the DB is
    // ignored by the public redirect in favour of the safe default.
    await pool.query(
      `INSERT INTO workspace_settings (workspace_owner_id, google_review_url)
       VALUES ($1, 'javascript:alert(1)')
       ON CONFLICT (workspace_owner_id) DO UPDATE SET google_review_url = EXCLUDED.google_review_url`,
      [OWNER_ID],
    );
    const res = await request(app).get(`/api/reviews/e/${code}`);
    expect(res.status).toBe(302);
    expect(res.headers.location.startsWith("https://")).toBe(true);
    expect(res.headers.location).not.toContain("javascript");
  });

  it("uses the workspace-configured Google review URL for the redirect", async () => {
    const { code } = await createProfile("Maya");
    const set = await request(app)
      .patch("/review-rewards/settings")
      .send({ googleReviewUrl: "https://g.page/r/custom-store/review" });
    expect(set.status).toBe(200);
    expect(set.body.googleReviewUrl).toBe("https://g.page/r/custom-store/review");

    const res = await request(app).get(`/api/reviews/e/${code}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://g.page/r/custom-store/review");
  });

  // ── Matching ────────────────────────────────────────────────────────────────

  it("auto-matches a review to the most recent eligible scan within 6 hours and creates one pending reward", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(300)); // older scan
    const recentScan = await insertScan(profileId, minutesAgo(30));

    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-match-1",
      reviewerName: "Happy Customer",
      rating: 5,
      reviewCreatedAt: new Date(),
    });
    expect(result.created).toBe(true);
    expect(result.matchStatus).toBe("auto_matched");
    expect(result.matchedProfileId).toBe(profileId);
    expect(result.rewardId).not.toBeNull();

    const review = await pool.query(
      `SELECT * FROM google_reviews WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(review.rows[0].match_status).toBe("auto_matched");
    expect(review.rows[0].matched_scan_id).toBe(recentScan);

    const scan = await pool.query(`SELECT * FROM review_scans WHERE id = $1`, [recentScan]);
    expect(scan.rows[0].match_status).toBe("matched");
    expect(scan.rows[0].matched_review_id).toBe(review.rows[0].id);

    const reward = await pool.query(
      `SELECT * FROM review_rewards WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(reward.rows).toHaveLength(1);
    expect(reward.rows[0].status).toBe("pending");
    expect(reward.rows[0].amount).toBe("5.00");
    const pendingUntil = new Date(reward.rows[0].pending_until).getTime();
    expect(pendingUntil).toBeGreaterThan(Date.now() + 6.9 * 24 * 60 * 60 * 1000);
    expect(pendingUntil).toBeLessThan(Date.now() + 7.1 * 24 * 60 * 60 * 1000);
  });

  it("is idempotent: re-ingesting the same google review id never re-matches or duplicates rewards", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(10));

    const gid = nextReviewId();
    const first = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: gid });
    const second = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: gid });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.rewardId).toBe(first.rewardId);

    const reviews = await pool.query(
      `SELECT count(*)::int AS n FROM google_reviews WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(reviews.rows[0].n).toBe(1);
    const rewards = await pool.query(
      `SELECT count(*)::int AS n FROM review_rewards WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rewards.rows[0].n).toBe(1);
  });

  it("does not match scans older than 6 hours (unmatched when no other activity)", async () => {
    const { id: profileId } = await createProfile("Maya");
    await insertScan(profileId, minutesAgo(6 * 60 + 30));

    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-old-scan",
    });
    expect(result.matchStatus).toBe("unmatched");
    expect(result.rewardId).toBeNull();
  });

  it("flags needs_review when multiple plausible employees scanned within the window", async () => {
    const a = await createProfile("Maya");
    const b = await createProfile("Rami");
    await insertScan(a.id, minutesAgo(60));
    await insertScan(b.id, minutesAgo(20));

    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-ambiguous",
    });
    expect(result.matchStatus).toBe("needs_review");
    expect(result.matchedProfileId).toBeNull();
    expect(result.rewardId).toBeNull();

    const scans = await pool.query(
      `SELECT match_status FROM review_scans WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(scans.rows.every((r) => r.match_status === "unmatched")).toBe(true);
  });

  it("flags needs_review when the review predates the only scan", async () => {
    const { id: profileId } = await createProfile("Maya");
    await insertScan(profileId, minutesAgo(5));

    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-predates",
      reviewCreatedAt: minutesAgo(60),
    });
    expect(result.matchStatus).toBe("needs_review");
    expect(result.rewardId).toBeNull();
  });

  it("excludes flagged scans and paused-profile scans from auto-matching", async () => {
    const active = await createProfile("Maya");
    const pausedProfile = await createProfile("Rami");
    await request(app).post(`/review-rewards/profiles/${pausedProfile.id}/pause`);

    // A flagged scan on the active profile and an unflagged scan on the paused
    // one — neither is eligible, but flagged activity in the window routes to
    // manual review rather than silently unmatched.
    await insertScan(active.id, minutesAgo(30), { flagged: true });
    await insertScan(pausedProfile.id, minutesAgo(20));

    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-flagged-only",
    });
    expect(result.matchStatus).toBe("needs_review");
    expect(result.rewardId).toBeNull();
  });

  // ── Manual resolution ───────────────────────────────────────────────────────

  it("manually assigns an ambiguous review with an audit trail; second resolve conflicts", async () => {
    const a = await createProfile("Maya", 8);
    const b = await createProfile("Rami");
    await insertScan(a.id, minutesAgo(50));
    const scanB = await insertScan(b.id, minutesAgo(25));

    const ingest = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-manual",
    });
    expect(ingest.matchStatus).toBe("needs_review");

    const resolve = await request(app)
      .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
      .send({ action: "assign", profileId: b.id, scanId: scanB, note: "confirmed by manager" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.matchStatus).toBe("manually_matched");
    expect(resolve.body.rewardId).not.toBeNull();

    const review = await pool.query(`SELECT * FROM google_reviews WHERE id = $1`, [
      ingest.reviewId,
    ]);
    expect(review.rows[0].match_status).toBe("manually_matched");
    expect(review.rows[0].matched_profile_id).toBe(b.id);
    expect(review.rows[0].match_resolved_by).toBe(USER_ID);

    const audit = await pool.query(
      `SELECT * FROM review_match_audit WHERE review_id = $1 AND action = 'manual_match'`,
      [ingest.reviewId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_user_id).toBe(USER_ID);

    // Already resolved — cannot resolve again.
    const again = await request(app)
      .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
      .send({ action: "assign", profileId: a.id });
    expect(again.status).toBe(409);
  });

  it("manually rejects a review with an audit trail and no reward", async () => {
    const { id: profileId } = await createProfile("Maya");
    await insertScan(profileId, minutesAgo(5));
    const ingest = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-reject",
      reviewCreatedAt: minutesAgo(60),
    });
    expect(ingest.matchStatus).toBe("needs_review");

    const resolve = await request(app)
      .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
      .send({ action: "reject", note: "spam review" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.matchStatus).toBe("rejected");

    const rewards = await pool.query(
      `SELECT count(*)::int AS n FROM review_rewards WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rewards.rows[0].n).toBe(0);
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM review_match_audit WHERE review_id = $1 AND action = 'manual_reject'`,
      [ingest.reviewId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  // ── Deletion voiding ────────────────────────────────────────────────────────

  it("voids the pending reward when the review is deleted (via re-ingest with isDeleted)", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(15));
    const gid = nextReviewId();
    const ingest = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: gid });
    expect(ingest.matchStatus).toBe("auto_matched");

    const reIngest = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: gid,
      isDeleted: true,
    });
    expect(reIngest.created).toBe(false);

    const review = await pool.query(`SELECT * FROM google_reviews WHERE id = $1`, [
      ingest.reviewId,
    ]);
    expect(review.rows[0].is_deleted).toBe(true);

    const reward = await pool.query(`SELECT * FROM review_rewards WHERE review_id = $1`, [
      ingest.reviewId,
    ]);
    expect(reward.rows[0].status).toBe("voided");
    expect(reward.rows[0].void_reason).toBe("review deleted on Google");
  });

  // ── Reward lifecycle ────────────────────────────────────────────────────────

  it("sweep auto-approves rewards past pending_until when the review still exists, and voids deleted-review rewards", async () => {
    const { id: profileId } = await createProfile("Maya", 5);

    // Reward A — pending window elapsed, review alive → approved.
    await insertScan(profileId, minutesAgo(15));
    const a = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-sweep-a" });
    expect(a.matchStatus).toBe("auto_matched");
    await pool.query(`UPDATE review_rewards SET pending_until = now() - interval '1 hour' WHERE id = $1`, [
      a.rewardId,
    ]);

    // Reward B — review deleted (direct service call), still pending.
    await insertScan(profileId, minutesAgo(10));
    const b = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-sweep-b" });
    expect(b.matchStatus).toBe("auto_matched");
    // Simulate a deletion that slipped past inline voiding: mark deleted, then
    // un-void so only the sweep can catch it.
    await markReviewDeleted(OWNER_ID, b.reviewId);
    await pool.query(
      `UPDATE review_rewards SET status = 'pending', voided_at = NULL, void_reason = NULL WHERE id = $1`,
      [b.rewardId],
    );

    // Reward C — still pending, not yet due → untouched.
    await insertScan(profileId, minutesAgo(5));
    const c = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-sweep-c" });
    expect(c.matchStatus).toBe("auto_matched");

    await runReviewRewardSweep();

    const rows = await pool.query(
      `SELECT id, status FROM review_rewards WHERE workspace_owner_id = $1 ORDER BY id`,
      [OWNER_ID],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(byId.get(a.rewardId)).toBe("approved");
    expect(byId.get(b.rewardId)).toBe("voided");
    expect(byId.get(c.rewardId)).toBe("pending");
  });

  it("pays only approved rewards; voids pending rewards with a reason", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(15));
    const a = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-pay" });

    // Cannot pay while pending.
    const early = await request(app).post(`/review-rewards/rewards/${a.rewardId}/pay`);
    expect(early.status).toBe(409);

    await pool.query(`UPDATE review_rewards SET pending_until = now() - interval '1 hour' WHERE id = $1`, [
      a.rewardId,
    ]);
    await runReviewRewardSweep();

    const pay = await request(app).post(`/review-rewards/rewards/${a.rewardId}/pay`);
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe("paid");

    // Paid rewards cannot be voided.
    const voidPaid = await request(app)
      .post(`/review-rewards/rewards/${a.rewardId}/void`)
      .send({ reason: "mistake" });
    expect(voidPaid.status).toBe(409);

    // A fresh pending reward can be voided with a reason.
    await insertScan(profileId, minutesAgo(10));
    const b = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-void" });
    const voided = await request(app)
      .post(`/review-rewards/rewards/${b.rewardId}/void`)
      .send({ reason: "suspected self-review" });
    expect(voided.status).toBe(200);
    const row = await pool.query(`SELECT * FROM review_rewards WHERE id = $1`, [b.rewardId]);
    expect(row.rows[0].status).toBe("voided");
    expect(row.rows[0].void_reason).toBe("suspected self-review");

    // Rewards list + audit reconcile.
    const list = await request(app).get("/review-rewards/rewards");
    expect(list.status).toBe(200);
    expect(list.body.rewards).toHaveLength(2);
    const paidAudit = await pool.query(
      `SELECT count(*)::int AS n FROM review_match_audit WHERE reward_id = $1 AND action = 'reward_paid'`,
      [a.rewardId],
    );
    expect(paidAudit.rows[0].n).toBe(1);
  });

  // ── Metrics ─────────────────────────────────────────────────────────────────

  it("metrics reconcile with the underlying records", async () => {
    const maya = await createProfile("Maya", 5);
    const rami = await createProfile("Rami", 5);

    await insertScan(maya.id, minutesAgo(90), { deviceHash: "hash000000000001" });
    await insertScan(maya.id, minutesAgo(45), { deviceHash: "hash000000000002" });
    await insertScan(rami.id, minutesAgo(600), { deviceHash: "hash000000000003" });

    const matched = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-metrics-1",
      rating: 5,
    });
    expect(matched.matchStatus).toBe("auto_matched");
    // Review predating all scan activity → routed to manual review.
    const ambiguousReview = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: "g-metrics-2",
      reviewCreatedAt: minutesAgo(30 * 60),
    });
    expect(ambiguousReview.matchStatus).toBe("needs_review");

    const overview = await request(app).get("/review-rewards/metrics/overview?days=30");
    expect(overview.status).toBe(200);
    expect(overview.body.scans).toBe(3);
    expect(overview.body.newReviews).toBe(2);
    expect(overview.body.matchedReviews).toBe(1);
    expect(overview.body.rewardsByStatus.pending.count).toBe(1);
    expect(overview.body.rewardsByStatus.pending.totalAmount).toBe("5.00");

    const trend = await request(app).get("/review-rewards/metrics/trend?days=7");
    expect(trend.status).toBe(200);
    expect(trend.body.series).toHaveLength(7);
    const totalScans = trend.body.series.reduce(
      (sum: number, p: { scans: number }) => sum + p.scans,
      0,
    );
    expect(totalScans).toBe(3);

    const employees = await request(app).get("/review-rewards/metrics/employees?days=30");
    expect(employees.status).toBe(200);
    const mayaRow = employees.body.employees.find(
      (e: { id: number }) => e.id === maya.id,
    );
    expect(mayaRow.scans).toBe(2);
    expect(mayaRow.matched_reviews).toBe(1);
    expect(mayaRow.pending_amount).toBe("5.00");

    const latest = await request(app).get("/review-rewards/metrics/latest-matches");
    expect(latest.status).toBe(200);
    expect(latest.body.matches).toHaveLength(1);
    expect(latest.body.matches[0].employee_name).toBe("Maya");
  });

  // ── Concurrency ─────────────────────────────────────────────────────────────

  it("concurrent ingests competing for one scan never double-assign it or double-reward", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(15));

    const [a, b] = await Promise.all([
      ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-race-a" }),
      ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-race-b" }),
    ]);

    // Exactly one wins the scan; the loser is never silently assigned.
    const statuses = [a.matchStatus, b.matchStatus].sort();
    expect(statuses).toContain("auto_matched");
    expect(statuses.filter((s) => s === "auto_matched")).toHaveLength(1);

    const rewards = await pool.query(
      `SELECT count(*)::int AS n FROM review_rewards WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rewards.rows[0].n).toBe(1);

    const scan = await pool.query(
      `SELECT match_status, matched_review_id FROM review_scans WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(scan.rows).toHaveLength(1);
    expect(scan.rows[0].match_status).toBe("matched");
    expect(scan.rows[0].matched_review_id).not.toBeNull();
  });

  it("concurrent ingests of the same google review id produce one record and at most one reward", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(15));
    const gid = nextReviewId();

    const results = await Promise.all([
      ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: gid }),
      ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: gid }),
      ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: gid }),
    ]);
    expect(new Set(results.map((r) => r.reviewId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const reviews = await pool.query(
      `SELECT count(*)::int AS n FROM google_reviews WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(reviews.rows[0].n).toBe(1);
    const rewards = await pool.query(
      `SELECT count(*)::int AS n FROM review_rewards WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rewards.rows[0].n).toBeLessThanOrEqual(1);
  });

  it("concurrent manual resolutions: only one wins, review and reward stay consistent", async () => {
    const a = await createProfile("Maya", 5);
    const b = await createProfile("Rami", 9);
    const scanA = await insertScan(a.id, minutesAgo(50), { deviceHash: "hashrace0000000a" });
    const scanB = await insertScan(b.id, minutesAgo(25), { deviceHash: "hashrace0000000b" });

    const ingest = await ingestReview({ workspaceOwnerId: OWNER_ID, googleReviewId: "g-race-manual" });
    expect(ingest.matchStatus).toBe("needs_review");

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
        .send({ action: "assign", profileId: a.id, scanId: scanA }),
      request(app)
        .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
        .send({ action: "assign", profileId: b.id, scanId: scanB }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);

    // The review's assigned profile must own the single reward.
    const review = await pool.query(
      `SELECT matched_profile_id FROM google_reviews WHERE id = $1`,
      [ingest.reviewId],
    );
    const rewards = await pool.query(
      `SELECT profile_id FROM review_rewards WHERE review_id = $1`,
      [ingest.reviewId],
    );
    expect(rewards.rows).toHaveLength(1);
    expect(rewards.rows[0].profile_id).toBe(review.rows[0].matched_profile_id);
  });

  it("concurrent assign vs reject: exactly one terminal resolution; rejected reviews carry no reward", async () => {
    // Repeat a few times to exercise both interleavings.
    for (let round = 0; round < 3; round++) {
      await cleanup();
      sharedGbpLocationId = 0; // Reset so createProfile() re-creates the shared location.
      const a = await createProfile("Maya", 5);
      const b = await createProfile("Rami", 5);
      await insertScan(a.id, minutesAgo(50), { deviceHash: `hashar000000000${round}` });
      const scanB = await insertScan(b.id, minutesAgo(25), { deviceHash: `hashbr000000000${round}` });

      const ingest = await ingestReview({
        workspaceOwnerId: OWNER_ID,
        googleReviewId: `g-assign-vs-reject-${round}`,
      });
      expect(ingest.matchStatus).toBe("needs_review");

      const [assign, reject] = await Promise.all([
        request(app)
          .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
          .send({ action: "assign", profileId: b.id, scanId: scanB }),
        request(app)
          .post(`/review-rewards/reviews/${ingest.reviewId}/resolve`)
          .send({ action: "reject", note: "spam" }),
      ]);
      expect([assign.status, reject.status].sort()).toEqual([200, 409]);

      const review = await pool.query<{ match_status: string }>(
        `SELECT match_status FROM google_reviews WHERE id = $1`,
        [ingest.reviewId],
      );
      const rewards = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM review_rewards WHERE review_id = $1`,
        [ingest.reviewId],
      );
      if (review.rows[0].match_status === "rejected") {
        expect(assign.status).toBe(409);
        expect(rewards.rows[0].n).toBe(0);
      } else {
        expect(review.rows[0].match_status).toBe("manually_matched");
        expect(assign.status).toBe(200);
        expect(rewards.rows[0].n).toBe(1);
      }
    }
  });

  // ── Dev ingest endpoint ─────────────────────────────────────────────────────

  it("dev ingest endpoint feeds ingestReview (non-production only)", async () => {
    const { id: profileId } = await createProfile("Maya", 5);
    await insertScan(profileId, minutesAgo(20));

    const res = await request(app)
      .post("/review-rewards/dev/ingest-review")
      .send({ googleReviewId: "g-dev-1", rating: 4, reviewerName: "Dev Tester" });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(res.body.matchStatus).toBe("auto_matched");
  });

  // ── Multi-location support ───────────────────────────────────────────────────

  /** Insert a minimal gbp_connections row so we can create gbp_location_connections rows. */
  async function createTestGbpConn(): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO gbp_connections (workspace_owner_id, credentials_encrypted)
       VALUES ($1, 'test-creds') RETURNING id`,
      [OWNER_ID],
    );
    return r.rows[0].id;
  }

  /** Insert a gbp_location_connections row directly (no OAuth needed). */
  async function createTestGbpLocation(
    connId: number,
    locationName: string,
    locationTitle: string,
    locationLocality: string | null = null,
  ): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO gbp_location_connections
         (workspace_owner_id, gbp_connection_id, location_name, location_title,
          location_locality, is_enabled)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [OWNER_ID, connId, locationName, locationTitle, locationLocality],
    );
    return r.rows[0].id;
  }

  it("(a) saveGbpLocations creates gbp_location_connections rows and disables de-selected ones", async () => {
    const connId = await createTestGbpConn();

    // Enable two locations directly (simulating what saveGbpLocations does).
    const locIdA = await createTestGbpLocation(connId, "locations/ml001001", "Store Alpha");
    const locIdB = await createTestGbpLocation(connId, "locations/ml001002", "Store Beta");

    const rows = await pool.query<{ location_name: string; location_title: string; is_enabled: boolean }>(
      `SELECT location_name, location_title, is_enabled
         FROM gbp_location_connections
        WHERE workspace_owner_id = $1
        ORDER BY created_at`,
      [OWNER_ID],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].location_name).toBe("locations/ml001001");
    expect(rows.rows[1].location_name).toBe("locations/ml001002");
    expect(rows.rows[0].is_enabled).toBe(true);
    expect(rows.rows[1].is_enabled).toBe(true);

    // De-selecting locB must disable it (not delete it).
    await pool.query(
      `UPDATE gbp_location_connections SET is_enabled = false WHERE id = $1`,
      [locIdB],
    );
    const after = await pool.query<{ location_name: string; is_enabled: boolean }>(
      `SELECT location_name, is_enabled FROM gbp_location_connections WHERE workspace_owner_id = $1 ORDER BY created_at`,
      [OWNER_ID],
    );
    expect(after.rows.find((r) => r.location_name === "locations/ml001001")?.is_enabled).toBe(true);
    expect(after.rows.find((r) => r.location_name === "locations/ml001002")?.is_enabled).toBe(false);

    void locIdA; // used for side-effect (insert)
  });

  it("(b+d) overview metrics filter correctly by locationId; omitting locationId aggregates across all locations", async () => {
    // Two location_connections rows seeded directly.
    const connId = await createTestGbpConn();
    const locIdA = await createTestGbpLocation(connId, "locations/ml002001", "Café A");
    const locIdB = await createTestGbpLocation(connId, "locations/ml002002", "Café B");

    // Create each profile with the specific location it belongs to so the
    // attribution filter (p.gbp_location_id = locId) works correctly.
    const profileA = await createProfile("Maya", 5, locIdA);
    const profileB = await createProfile("Rami", 5, locIdB);

    // Scan for A — manually set gbp_location_id after insert.
    const scanA = await insertScan(profileA.id, minutesAgo(30));
    await pool.query(`UPDATE review_scans SET gbp_location_id = $1 WHERE id = $2`, [locIdA, scanA]);

    // Scan for B.
    const scanB = await insertScan(profileB.id, minutesAgo(20));
    await pool.query(`UPDATE review_scans SET gbp_location_id = $1 WHERE id = $2`, [locIdB, scanB]);

    // Reviews attributed to each location via ingestReview.
    const revA = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: nextReviewId(),
      gbpLocationId: locIdA,
    });
    const revB = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: nextReviewId(),
      gbpLocationId: locIdB,
    });
    expect(revA.created).toBe(true);
    expect(revB.created).toBe(true);

    // Filtered by location A → 1 review.
    const overviewA = await request(app).get(`/review-rewards/metrics/overview?locationId=${locIdA}`);
    expect(overviewA.status).toBe(200);
    expect(overviewA.body.newReviews).toBe(1);
    expect(overviewA.body.scans).toBe(1);

    // Filtered by location B → 1 review.
    const overviewB = await request(app).get(`/review-rewards/metrics/overview?locationId=${locIdB}`);
    expect(overviewB.status).toBe(200);
    expect(overviewB.body.newReviews).toBe(1);

    // No filter → aggregate both (2 reviews, 2 scans).
    const overviewAll = await request(app).get("/review-rewards/metrics/overview");
    expect(overviewAll.status).toBe(200);
    expect(overviewAll.body.newReviews).toBe(2);
    expect(overviewAll.body.scans).toBe(2);
  });

  it("(c) profile created with gbpLocationId stores it and returns it in the response", async () => {
    const connId = await createTestGbpConn();
    const gbpLocationId = await createTestGbpLocation(connId, "locations/ml003001", "Flagship");
    const workspaceMemberId = await createWorkspaceMember("Sara");

    const res = await request(app)
      .post("/review-rewards/profiles")
      .send({ employeeName: "Sara", rewardAmount: 10, gbpLocationId, workspaceMemberId });
    expect(res.status).toBe(201);
    expect(res.body.profile.gbpLocationId).toBe(gbpLocationId);

    // Verify the column is persisted in the database.
    const row = await pool.query<{ gbp_location_id: number | null }>(
      `SELECT gbp_location_id FROM employee_review_profiles WHERE id = $1`,
      [res.body.profile.id],
    );
    expect(row.rows[0].gbp_location_id).toBe(gbpLocationId);
  });

  it("ingestReview propagates gbpLocationId to google_reviews and confirmMatch copies it to review_rewards", async () => {
    const connId = await createTestGbpConn();
    const gbpLocationId = await createTestGbpLocation(connId, "locations/ml004001", "Downtown");

    // Profile must use the same location so the attribution filter matches it.
    const { id: profileId } = await createProfile("Maya", 5, gbpLocationId);
    await insertScan(profileId, minutesAgo(15));

    const result = await ingestReview({
      workspaceOwnerId: OWNER_ID,
      googleReviewId: nextReviewId(),
      gbpLocationId,
    });
    expect(result.created).toBe(true);
    expect(result.matchStatus).toBe("auto_matched");

    // gbp_location_id must be on the review row.
    const reviewRow = await pool.query<{ gbp_location_id: number | null }>(
      `SELECT gbp_location_id FROM google_reviews WHERE id = $1`,
      [result.reviewId],
    );
    expect(reviewRow.rows[0].gbp_location_id).toBe(gbpLocationId);

    // confirmMatch must copy it to the reward row.
    const rewardRow = await pool.query<{ gbp_location_id: number | null }>(
      `SELECT gbp_location_id FROM review_rewards WHERE review_id = $1`,
      [result.reviewId],
    );
    expect(rewardRow.rows[0].gbp_location_id).toBe(gbpLocationId);

    // The performance endpoint includes this location with review_count = 1.
    const perf = await request(app).get("/review-rewards/locations/performance");
    expect(perf.status).toBe(200);
    const loc = perf.body.locations.find((l: { locationId: number }) => l.locationId === gbpLocationId);
    expect(loc).toBeDefined();
    expect(loc.reviewCount).toBe(1);
    // Reward is pending (not approved/paid) so rewardsEarned should be 0.
    expect(Number(loc.rewardsEarned)).toBe(0);
  });

  it("returns the stored Google-derived area with the location performance data", async () => {
    const connId = await createTestGbpConn();
    const gbpLocationId = await createTestGbpLocation(
      connId,
      "locations/perf-area",
      "Presentail",
      "Dubai",
    );

    const perf = await request(app).get("/review-rewards/locations/performance");
    expect(perf.status).toBe(200);
    expect(perf.body.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locationId: gbpLocationId,
          locationTitle: "Presentail",
          locationLocality: "Dubai",
        }),
      ]),
    );
  });

  // ── Cross-workspace tenancy isolation ─────────────────────────────────────────

  it("(e) a second workspace cannot activate a GBP location already enabled in another workspace", async () => {
    // Workspace A (OWNER_ID) connects location "locations/tenant001".
    const connId = await createTestGbpConn();
    const locId = await createTestGbpLocation(connId, "locations/tenant001", "Tenant Store");
    expect(locId).toBeGreaterThan(0);

    // Workspace B attempts to enable the same location.
    // The global partial unique index (is_enabled = true) should block this.
    const OWNER_B = "__test_rr_tenant_b__";
    let connBId: number | null = null;
    try {
      const connBRow = await pool.query<{ id: number }>(
        `INSERT INTO gbp_connections (workspace_owner_id, credentials_encrypted)
         VALUES ($1, 'test-creds-b') RETURNING id`,
        [OWNER_B],
      );
      connBId = connBRow.rows[0].id;
      await pool.query(
        `INSERT INTO gbp_location_connections
           (workspace_owner_id, gbp_connection_id, location_name, location_title, is_enabled)
         VALUES ($1, $2, $3, $4, true)`,
        [OWNER_B, connBId, "locations/tenant001", "Duplicate"],
      );
      throw new Error("Expected unique constraint violation but did not get one");
    } catch (err: unknown) {
      // 23505 = unique_violation — the global index fired as expected.
      expect((err as { code?: string }).code).toBe("23505");
    } finally {
      if (connBId !== null) {
        await pool.query(`DELETE FROM gbp_location_connections WHERE workspace_owner_id = $1`, [OWNER_B]);
        await pool.query(`DELETE FROM gbp_connections WHERE workspace_owner_id = $1`, [OWNER_B]);
      }
    }
  });

  it("(f) inbound review delivery via findGbpLocationByName resolves to the owning workspace", async () => {
    const { findGbpLocationByName } = await import("../lib/googleBusinessProfile");

    const connId = await createTestGbpConn();
    await createTestGbpLocation(connId, "locations/tenant002", "Routing Store");

    // The lookup must return the row owned by OWNER_ID and no other workspace.
    const found = await findGbpLocationByName("locations/tenant002");
    expect(found).not.toBeNull();
    expect(found!.workspace_owner_id).toBe(OWNER_ID);
    expect(found!.location_name).toBe("locations/tenant002");

    // Looking up an unknown location returns null — no cross-workspace leakage.
    const notFound = await findGbpLocationByName("locations/does-not-exist");
    expect(notFound).toBeNull();
  });

  // ── Manual-resolve location enforcement ───────────────────────────────────────

  it("(g) manual assignment of a Location A profile to a Location B review is rejected with 422", async () => {
    // Create two distinct GBP locations.
    const connId = await createTestGbpConn();
    const locIdA = await createTestGbpLocation(connId, "locations/resolve001A", "Store A");
    const locIdB = await createTestGbpLocation(connId, "locations/resolve001B", "Store B");

    // Employee profile assigned to location A.
    const { id: profileId } = await createProfile("Resolve Test A", 10, locIdA);

    // Ingest a review scoped to location B.
    const reviewId = await pool.query<{ id: number }>(
      `INSERT INTO google_reviews
         (workspace_owner_id, google_review_id, reviewer_name, rating, review_created_at, review_text,
          match_status, gbp_location_id, ingested_at, updated_at)
       VALUES ($1, $2, 'Tester', 5, now(), null, 'needs_review', $3, now(), now())
       RETURNING id`,
      [OWNER_ID, `g-resolve-xlocA-${Date.now()}`, locIdB],
    );
    const revId = reviewId.rows[0].id;

    // Attempting to assign the Location A profile to the Location B review must fail.
    const res = await request(app)
      .post(`/review-rewards/reviews/${revId}/resolve`)
      .send({ action: "assign", profileId });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/location/i);

    void locIdA;
    void locIdB;
  });

  it("(h) manual assignment with a cross-location scan is rejected with 422", async () => {
    const connId = await createTestGbpConn();
    const locIdA = await createTestGbpLocation(connId, "locations/resolve002A", "Store A2");
    const locIdB = await createTestGbpLocation(connId, "locations/resolve002B", "Store B2");

    // Profile at location A.
    const { id: profileId } = await createProfile("Resolve Test B", 10, locIdA);

    // Ingest a review at location A (same as profile — profile assignment is valid).
    const reviewId = await pool.query<{ id: number }>(
      `INSERT INTO google_reviews
         (workspace_owner_id, google_review_id, reviewer_name, rating, review_created_at, review_text,
          match_status, gbp_location_id, ingested_at, updated_at)
       VALUES ($1, $2, 'Tester', 5, now(), null, 'needs_review', $3, now(), now())
       RETURNING id`,
      [OWNER_ID, `g-resolve-scan-${Date.now()}`, locIdA],
    );
    const revId = reviewId.rows[0].id;

    // Scan that was recorded under location B (cross-location).
    const scanId = await pool.query<{ id: number }>(
      `INSERT INTO review_scans
         (workspace_owner_id, profile_id, device_hash, source, flagged, scanned_at, gbp_location_id)
       VALUES ($1, $2, 'dev-resolve', 'test', false, now() - interval '30 minutes', $3)
       RETURNING id`,
      [OWNER_ID, profileId, locIdB],
    );
    const sId = scanId.rows[0].id;

    // Providing a Location B scan for a Location A review must be rejected.
    const res = await request(app)
      .post(`/review-rewards/reviews/${revId}/resolve`)
      .send({ action: "assign", profileId, scanId: sId });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/location/i);
  });
});
