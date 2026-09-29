import { randomBytes } from "crypto";
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import QRCode from "qrcode";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import {
  ingestReview,
  confirmMatch,
  recordAudit,
  getGoogleReviewUrl,
  DEFAULT_GOOGLE_REVIEW_URL,
  MatchConflictError,
  isSafeReviewUrl,
} from "../lib/reviewAttribution";

/**
 * Google Review Rewards — admin API.
 *
 * Employee QR profiles (CRUD + pause/reactivate + QR image), manual match
 * resolution with audit trail, payout approval, metrics, per-workspace
 * settings, and a dev-only review-ingest test endpoint.
 */
const router: IRouter = Router();
router.use(requireAuth, resolveWorkspace);

function isOwner(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceActualRole === "owner";
}

function canViewReviewRewards(wreq: ReturnType<typeof workspace>): boolean {
  return hasPageAccess(wreq, "review-rewards");
}

// ── Tracking link helpers ─────────────────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 10;

/** Random, non-identifying, URL-safe employee code (~58 bits of entropy). */
function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function isReplitPlatformDomain(d: string): boolean {
  return /(^|\.)replit\.(app|dev)$/i.test(d) || /\.repl\.co$/i.test(d);
}

/** Copy-ready absolute tracking URL for a code (mirrors buildPublicPayUrl). */
export function buildTrackingUrl(code: string): string {
  const pathPart = `/api/reviews/e/${code}`;
  if (process.env.REPLIT_DEPLOYMENT) {
    const domains = (process.env.REPLIT_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const custom = domains.find((d) => !isReplitPlatformDomain(d));
    const domain = custom ?? domains[0];
    if (domain) return `https://${domain}${pathPart}`;
    if (process.env.PUBLIC_URL) return `${process.env.PUBLIC_URL}${pathPart}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}${pathPart}`;
  }
  return `${process.env.PUBLIC_URL ?? ""}${pathPart}`;
}

interface ProfileRow {
  id: number;
  workspace_owner_id: string;
  employee_name: string;
  role: string | null;
  reward_amount: string;
  code: string;
  is_active: boolean;
  gbp_location_id: number | null;
  team_member_id: number | null;
  workspace_member_id: number | null;
  reward_currency: string;
  created_at: Date;
  updated_at: Date;
}

function serializeProfile(row: ProfileRow) {
  return {
    id: row.id,
    employeeName: row.employee_name,
    role: row.role,
    rewardAmount: row.reward_amount,
    code: row.code,
    trackingUrl: buildTrackingUrl(row.code),
    trackingPath: `/api/reviews/e/${row.code}`,
    isActive: row.is_active,
    gbpLocationId: row.gbp_location_id ?? null,
    teamMemberId: row.team_member_id ?? null,
    workspaceMemberId: row.workspace_member_id ?? null,
    rewardCurrency: row.reward_currency ?? "USD",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Profiles ──────────────────────────────────────────────────────────────────

const REWARD_CURRENCIES = ["USD", "AED"] as const;
type RewardCurrency = (typeof REWARD_CURRENCIES)[number];

const createProfileSchema = z.object({
  employeeName: z.string().trim().min(1).max(200),
  role: z.string().trim().max(200).nullish(),
  rewardAmount: z.coerce.number().min(0).max(100000).default(0),
  /** Required: gbp_location_connections.id scoping this profile to one enabled location. */
  gbpLocationId: z.coerce.number().int().positive(),
  /** At least one of these workspace-scoped employee references is required. */
  teamMemberId: z.coerce.number().int().positive().optional(),
  workspaceMemberId: z.coerce.number().int().positive().optional(),
  /** Currency driven by the location's country; defaults to USD. */
  rewardCurrency: z.enum(REWARD_CURRENCIES).default("USD"),
}).refine(
  (data) => data.teamMemberId !== undefined || data.workspaceMemberId !== undefined,
  { message: "An employee reference is required" },
);

const updateProfileSchema = z.object({
  employeeName: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().max(200).nullable().optional(),
  rewardAmount: z.coerce.number().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
  /** Reassign to a different enabled location (or omit to leave unchanged). */
  gbpLocationId: z.coerce.number().int().positive().optional(),
  /** Update the payout currency (e.g. when correcting a mis-saved profile). */
  rewardCurrency: z.enum(REWARD_CURRENCIES).optional(),
});

router.get("/review-rewards/profiles", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const result = await db.query<ProfileRow>(
    `SELECT * FROM employee_review_profiles
      WHERE workspace_owner_id = $1 AND archived_at IS NULL
        AND ($2::int IS NULL OR gbp_location_id = $2)
      ORDER BY created_at DESC`,
    [wreq.workspaceOwnerId, locationId],
  );
  res.json({ profiles: result.rows.map(serializeProfile) });
});

router.post("/review-rewards/profiles", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const parsed = createProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  // Verify the location belongs to this workspace and is currently enabled.
  const locCheck = await db.query<{ id: number }>(
    `SELECT id FROM gbp_location_connections
      WHERE id = $1 AND workspace_owner_id = $2 AND is_enabled = true`,
    [parsed.data.gbpLocationId, wreq.workspaceOwnerId],
  );
  if (locCheck.rows.length === 0) {
    res.status(422).json({ error: "Location not found or not enabled for this workspace" });
    return;
  }
  // Verify every supplied employee reference belongs to this workspace and
  // represents a current employee. A People Directory row can supply both
  // references when HR and workspace records are linked.
  const teamMemberCheck = parsed.data.teamMemberId !== undefined
    ? await db.query<{ id: number; email: string | null; member_db_id: number | null }>(
    `SELECT id, email, member_db_id FROM team_members
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [parsed.data.teamMemberId, wreq.workspaceOwnerId],
  )
    : { rows: [] as { id: number; email: string | null; member_db_id: number | null }[] };
  if (parsed.data.teamMemberId !== undefined && teamMemberCheck.rows.length === 0) {
    res.status(422).json({ error: "Team member not found or not active in this workspace" });
    return;
  }
  const workspaceMemberCheck = parsed.data.workspaceMemberId !== undefined
    ? await db.query<{ id: number; member_email: string }>(
    `SELECT id, member_email FROM workspace_members
      WHERE id = $1 AND workspace_owner_id = $2
        AND member_user_id IS NOT NULL AND revoked_at IS NULL`,
    [parsed.data.workspaceMemberId, wreq.workspaceOwnerId],
  )
    : { rows: [] as { id: number; member_email: string }[] };
  if (parsed.data.workspaceMemberId !== undefined && workspaceMemberCheck.rows.length === 0) {
    res.status(422).json({ error: "Workspace user not found or not active in this workspace" });
    return;
  }
  if (
    parsed.data.teamMemberId !== undefined &&
    parsed.data.workspaceMemberId !== undefined &&
    teamMemberCheck.rows[0].member_db_id !== parsed.data.workspaceMemberId &&
    (
      !teamMemberCheck.rows[0].email ||
      teamMemberCheck.rows[0].email!.toLowerCase() !== workspaceMemberCheck.rows[0].member_email.toLowerCase()
    )
  ) {
    res.status(422).json({ error: "Employee references do not identify the same person" });
    return;
  }
  // Canonicalize linked People Directory identities so every new profile stores
  // both references whenever the employee has both an HR record and a workspace
  // login. This lets the two partial unique indexes atomically guard the same
  // person even when concurrent callers submit different reference types, and
  // it also catches duplicates against older profiles that only stored one.
  let canonicalTeamMemberId = parsed.data.teamMemberId ?? null;
  let canonicalWorkspaceMemberId = parsed.data.workspaceMemberId ?? null;
  if (canonicalTeamMemberId !== null && canonicalWorkspaceMemberId === null) {
    const teamMember = teamMemberCheck.rows[0];
    const linkedWorkspaceMember = await db.query<{ id: number }>(
      `SELECT id
         FROM workspace_members
        WHERE workspace_owner_id = $1
          AND member_user_id IS NOT NULL
          AND revoked_at IS NULL
          AND (
            ($2::int IS NOT NULL AND id = $2)
            OR ($3::text IS NOT NULL AND lower(member_email) = lower($3))
          )
        ORDER BY (id = $2) DESC, id
        LIMIT 1`,
      [wreq.workspaceOwnerId, teamMember.member_db_id, teamMember.email],
    );
    canonicalWorkspaceMemberId = linkedWorkspaceMember.rows[0]?.id ?? null;
  }
  if (canonicalWorkspaceMemberId !== null && canonicalTeamMemberId === null) {
    const workspaceMember = workspaceMemberCheck.rows[0];
    const linkedTeamMember = await db.query<{ id: number }>(
      `SELECT id
         FROM team_members
        WHERE workspace_owner_id = $1
          AND archived_at IS NULL
          AND (
            member_db_id = $2
            OR (email IS NOT NULL AND lower(email) = lower($3))
          )
        ORDER BY (member_db_id = $2) DESC, id
        LIMIT 1`,
      [wreq.workspaceOwnerId, canonicalWorkspaceMemberId, workspaceMember.member_email],
    );
    canonicalTeamMemberId = linkedTeamMember.rows[0]?.id ?? null;
  }
  const duplicate = await db.query<{ id: number }>(
    `SELECT id FROM employee_review_profiles
      WHERE workspace_owner_id = $1 AND gbp_location_id = $2
        AND archived_at IS NULL
        AND (
          ($3::int IS NOT NULL AND team_member_id = $3)
          OR ($4::int IS NOT NULL AND workspace_member_id = $4)
        )
      LIMIT 1`,
    [
      wreq.workspaceOwnerId,
      parsed.data.gbpLocationId,
      canonicalTeamMemberId,
      canonicalWorkspaceMemberId,
    ],
  );
  if (duplicate.rows.length > 0) {
    res.status(409).json({
      error: "duplicate",
      message: "This employee already has a QR for this location.",
    });
    return;
  }
  // Retry on the (astronomically unlikely) global code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const inserted = await db.query<ProfileRow>(
        `INSERT INTO employee_review_profiles
            (workspace_owner_id, employee_name, role, reward_amount, code, gbp_location_id,
             team_member_id, workspace_member_id, reward_currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [
          wreq.workspaceOwnerId,
          parsed.data.employeeName,
          parsed.data.role ?? null,
          parsed.data.rewardAmount.toFixed(2),
          code,
          parsed.data.gbpLocationId ?? null,
          canonicalTeamMemberId,
          canonicalWorkspaceMemberId,
          parsed.data.rewardCurrency,
        ],
      );
      if (inserted.rows.length > 0) {
        res.status(201).json({ profile: serializeProfile(inserted.rows[0]) });
        return;
      }
    } catch (err: unknown) {
      // Unique-constraint violation on either employee reference.
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "23505" &&
        ["uq_erp_team_member_location", "uq_erp_workspace_member_location"].includes(
          (err as { constraint?: string }).constraint ?? "",
        )
      ) {
        res.status(409).json({
          error: "duplicate",
          message: "This employee already has a QR for this location.",
        });
        return;
      }
      throw err;
    }
  }
  res.status(500).json({ error: "Could not generate a unique code" });
});

router.patch("/review-rewards/profiles/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const u = parsed.data;
  // If a new location is specified, verify it belongs to this workspace and is enabled.
  if (u.gbpLocationId !== undefined) {
    const locCheck = await db.query<{ id: number }>(
      `SELECT id FROM gbp_location_connections
        WHERE id = $1 AND workspace_owner_id = $2 AND is_enabled = true`,
      [u.gbpLocationId, wreq.workspaceOwnerId],
    );
    if (locCheck.rows.length === 0) {
      res.status(422).json({ error: "Location not found or not enabled for this workspace" });
      return;
    }
  }
  const updated = await db.query<ProfileRow>(
    `UPDATE employee_review_profiles
        SET employee_name   = COALESCE($3, employee_name),
            role            = CASE WHEN $4 THEN $5 ELSE role END,
            reward_amount   = COALESCE($6, reward_amount),
            is_active       = COALESCE($7, is_active),
            gbp_location_id = CASE WHEN $8 THEN $9 ELSE gbp_location_id END,
            reward_currency = COALESCE($10, reward_currency),
            updated_at      = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL
      RETURNING *`,
    [
      id,
      wreq.workspaceOwnerId,
      u.employeeName ?? null,
      u.role !== undefined,
      u.role ?? null,
      u.rewardAmount !== undefined ? u.rewardAmount.toFixed(2) : null,
      u.isActive ?? null,
      u.gbpLocationId !== undefined,
      u.gbpLocationId ?? null,
      u.rewardCurrency ?? null,
    ],
  );
  if (updated.rows.length === 0) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json({ profile: serializeProfile(updated.rows[0]) });
});

async function setProfileActive(
  req: import("express").Request,
  res: import("express").Response,
  isActive: boolean,
): Promise<void> {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const updated = await db.query<ProfileRow>(
    `UPDATE employee_review_profiles
        SET is_active = $3, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL
      RETURNING *`,
    [id, wreq.workspaceOwnerId, isActive],
  );
  if (updated.rows.length === 0) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json({ profile: serializeProfile(updated.rows[0]) });
}

router.post("/review-rewards/profiles/:id/pause", (req, res) =>
  setProfileActive(req, res, false),
);
router.post("/review-rewards/profiles/:id/reactivate", (req, res) =>
  setProfileActive(req, res, true),
);

/**
 * Delete (archive) a profile. Soft delete: the row is kept so scan, reward,
 * and audit history stays intact, but the profile disappears from listings,
 * its QR code stops redirecting, and it is excluded from attribution.
 */
router.delete("/review-rewards/profiles/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const updated = await db.query<{ id: number }>(
    `UPDATE employee_review_profiles
        SET archived_at = now(), is_active = false, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL
      RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );
  if (updated.rows.length === 0) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/review-rewards/profiles/:id/qr", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid profile id" });
    return;
  }
  const result = await db.query<ProfileRow>(
    `SELECT * FROM employee_review_profiles
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  const profile = result.rows[0];
  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  const trackingUrl = buildTrackingUrl(profile.code);
  const qrDataUrl = await QRCode.toDataURL(trackingUrl, { margin: 1, width: 512 });
  res.json({ trackingUrl, trackingPath: `/reviews/e/${profile.code}`, qrDataUrl });
});

// ── Settings ──────────────────────────────────────────────────────────────────

router.get("/review-rewards/settings", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const url = await getGoogleReviewUrl(wreq.workspaceOwnerId);
  res.json({ googleReviewUrl: url, defaultGoogleReviewUrl: DEFAULT_GOOGLE_REVIEW_URL });
});

const settingsSchema = z.object({
  googleReviewUrl: z
    .url()
    .max(2000)
    .refine(isSafeReviewUrl, {
      message:
        "Must be an HTTPS Google review link (g.page, maps.app.goo.gl, or google.com)",
    })
    .nullable(),
});

router.patch("/review-rewards/settings", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  await db.query(
    `INSERT INTO workspace_settings (workspace_owner_id, google_review_url)
     VALUES ($1, $2)
     ON CONFLICT (workspace_owner_id)
     DO UPDATE SET google_review_url = EXCLUDED.google_review_url`,
    [wreq.workspaceOwnerId, parsed.data.googleReviewUrl],
  );
  const url = await getGoogleReviewUrl(wreq.workspaceOwnerId);
  res.json({ googleReviewUrl: url, defaultGoogleReviewUrl: DEFAULT_GOOGLE_REVIEW_URL });
});

// ── Reviews + manual match resolution ─────────────────────────────────────────

router.get("/review-rewards/reviews", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const locationId = parseLocationId(req.query.locationId);
  const result = await db.query(
    `SELECT g.*, p.employee_name AS matched_employee_name
       FROM google_reviews g
       LEFT JOIN employee_review_profiles p ON p.id = g.matched_profile_id
      WHERE g.workspace_owner_id = $1
        AND ($2::text IS NULL OR g.match_status = $2)
        AND ($3::integer IS NULL OR g.gbp_location_id = $3)
      ORDER BY g.review_created_at DESC
      LIMIT 200`,
    [wreq.workspaceOwnerId, status, locationId],
  );
  res.json({ reviews: result.rows });
});

const resolveSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign"),
    profileId: z.coerce.number().int().positive(),
    scanId: z.coerce.number().int().positive().nullish(),
    note: z.string().max(1000).nullish(),
  }),
  z.object({ action: z.literal("reject"), note: z.string().max(1000).nullish() }),
]);

/**
 * Resolve an ambiguous (needs_review) or unmatched review: assign it to an
 * employee profile (creating the reward) or reject it. Audit-logged.
 */
router.post("/review-rewards/reviews/:id/resolve", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid review id" });
    return;
  }
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const reviewRes = await db.query<{
    id: number;
    match_status: string;
    is_deleted: boolean;
    gbp_location_id: number | null;
  }>(
    `SELECT id, match_status, is_deleted, gbp_location_id FROM google_reviews
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const review = reviewRes.rows[0];
  if (!review) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  // Rejected is terminal — assignments and rejections only apply to unresolved
  // reviews, so a racing assign can never resurrect a rejected review.
  if (!["pending", "needs_review", "unmatched"].includes(review.match_status)) {
    res.status(409).json({ error: `Review is already ${review.match_status}` });
    return;
  }

  if (parsed.data.action === "reject") {
    // Conditional compare-and-set: only unresolved reviews can be rejected, and
    // the audit entry commits in the same transaction. A racing assignment that
    // commits first makes this claim lose → 409, never a rejected review with a
    // live reward attached.
    const client = await db.connect();
    try {
      const rejected = await withTransaction(client, async () => {
        const claim = await client.query<{ id: number }>(
          `UPDATE google_reviews
              SET match_status = 'rejected', match_reason = $2,
                  match_resolved_by = $3, match_resolved_at = now(), updated_at = now()
            WHERE id = $1
              AND match_status IN ('pending', 'needs_review', 'unmatched')
            RETURNING id`,
          [id, parsed.data.note ?? "manually rejected", wreq.userId ?? null],
        );
        if (claim.rows.length === 0) return false;
        await recordAudit(
          {
            workspaceOwnerId: wreq.workspaceOwnerId,
            reviewId: id,
            rewardId: null,
            action: "manual_reject",
            actorUserId: wreq.userId ?? null,
            details: { note: parsed.data.note ?? null },
          },
          client,
        );
        return true;
      });
      if (!rejected) {
        res.status(409).json({ error: "Review was resolved by someone else — refresh and retry" });
        return;
      }
      res.json({ ok: true, matchStatus: "rejected" });
    } finally {
      client.release();
    }
    return;
  }

  if (review.is_deleted) {
    res.status(409).json({ error: "Cannot assign a deleted review" });
    return;
  }

  const profileRes = await db.query<{ id: number; gbp_location_id: number | null }>(
    // Archived profiles are excluded from attribution entirely. Paused
    // (is_active = false) profiles ARE deliberately allowed here: manual
    // assignment is an explicit owner decision, e.g. crediting an employee
    // whose QR was paused after the customer scanned it.
    `SELECT id, gbp_location_id FROM employee_review_profiles
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [parsed.data.profileId, wreq.workspaceOwnerId],
  );
  if (profileRes.rows.length === 0) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  const profile = profileRes.rows[0];

  // Location mismatch guard: when the review carries a location (non-null),
  // the profile must be for the same location. A null profile location (e.g.
  // the linked location was disconnected) is treated as unknown and rejected
  // rather than silently allowed, to prevent cross-location reward leakage.
  // Legacy reviews with no location (null) bypass this check for backward compat.
  if (review.gbp_location_id !== null) {
    if (profile.gbp_location_id === null || profile.gbp_location_id !== review.gbp_location_id) {
      res.status(422).json({ error: "Profile location does not match the review's location" });
      return;
    }
  }

  let scanId: number | null = null;
  if (parsed.data.scanId) {
    const scanRes = await db.query<{ id: number; match_status: string; gbp_location_id: number | null }>(
      `SELECT id, match_status, gbp_location_id FROM review_scans
        WHERE id = $1 AND workspace_owner_id = $2 AND profile_id = $3`,
      [parsed.data.scanId, wreq.workspaceOwnerId, parsed.data.profileId],
    );
    if (scanRes.rows.length === 0 || scanRes.rows[0].match_status !== "unmatched") {
      res.status(409).json({ error: "Scan not found or already matched" });
      return;
    }
    // If the review has a location and the scan records one (non-null), they
    // must agree — a null scan location is a legacy row and is allowed through.
    const scan = scanRes.rows[0];
    if (
      review.gbp_location_id !== null &&
      scan.gbp_location_id !== null &&
      scan.gbp_location_id !== review.gbp_location_id
    ) {
      res.status(422).json({ error: "Scan location does not match the review's location" });
      return;
    }
    scanId = scan.id;
  }

  try {
    const rewardId = await confirmMatch({
      workspaceOwnerId: wreq.workspaceOwnerId,
      reviewId: id,
      scanId,
      profileId: parsed.data.profileId,
      matchStatus: "manually_matched",
      reason: parsed.data.note ?? "manually assigned",
      actorUserId: wreq.userId ?? undefined,
    });
    res.json({ ok: true, matchStatus: "manually_matched", rewardId });
  } catch (err) {
    if (err instanceof MatchConflictError) {
      res.status(409).json({ error: "Review or scan was resolved by someone else — refresh and retry" });
      return;
    }
    throw err;
  }
});

// ── Rewards ───────────────────────────────────────────────────────────────────

router.get("/review-rewards/rewards", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const locationId = parseLocationId(req.query.locationId);
  const result = await db.query(
    `SELECT r.*, p.employee_name, g.google_review_id, g.reviewer_name, g.rating
       FROM review_rewards r
       JOIN employee_review_profiles p ON p.id = r.profile_id
       JOIN google_reviews g ON g.id = r.review_id
      WHERE r.workspace_owner_id = $1
        AND ($2::text IS NULL OR r.status = $2)
        AND ($3::integer IS NULL OR r.gbp_location_id = $3)
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [wreq.workspaceOwnerId, status, locationId],
  );
  res.json({ rewards: result.rows });
});

/** Payout approval — marks an approved reward as paid (status only). */
router.post("/review-rewards/rewards/:id/pay", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid reward id" });
    return;
  }
  // Status transition and audit entry commit atomically — a reward can never
  // be paid without its audit record.
  const client = await db.connect();
  try {
    const paid = await withTransaction(client, async () => {
      const updated = await client.query<{ id: number; review_id: number }>(
        `UPDATE review_rewards
            SET status = 'paid', paid_at = now(), paid_by = $3, updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2 AND status = 'approved'
          RETURNING id, review_id`,
        [id, wreq.workspaceOwnerId, wreq.userId ?? null],
      );
      if (updated.rows.length === 0) return false;
      await recordAudit(
        {
          workspaceOwnerId: wreq.workspaceOwnerId,
          reviewId: updated.rows[0].review_id,
          rewardId: id,
          action: "reward_paid",
          actorUserId: wreq.userId ?? null,
        },
        client,
      );
      return true;
    });
    if (!paid) {
      res.status(409).json({ error: "Reward not found or not in approved status" });
      return;
    }
    res.json({ ok: true, status: "paid" });
  } finally {
    client.release();
  }
});

const voidSchema = z.object({ reason: z.string().trim().min(1).max(500) });

router.post("/review-rewards/rewards/:id/void", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Review rewards management requires owner access" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid reward id" });
    return;
  }
  const parsed = voidSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A void reason is required" });
    return;
  }
  // Status transition and audit entry commit atomically.
  const client = await db.connect();
  try {
    const voided = await withTransaction(client, async () => {
      const updated = await client.query<{ id: number; review_id: number }>(
        `UPDATE review_rewards
            SET status = 'voided', voided_at = now(), void_reason = $3, updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2 AND status IN ('pending', 'approved')
          RETURNING id, review_id`,
        [id, wreq.workspaceOwnerId, parsed.data.reason],
      );
      if (updated.rows.length === 0) return false;
      await recordAudit(
        {
          workspaceOwnerId: wreq.workspaceOwnerId,
          reviewId: updated.rows[0].review_id,
          rewardId: id,
          action: "reward_voided",
          actorUserId: wreq.userId ?? null,
          details: { reason: parsed.data.reason },
        },
        client,
      );
      return true;
    });
    if (!voided) {
      res.status(409).json({ error: "Reward not found or not voidable" });
      return;
    }
    res.json({ ok: true, status: "voided" });
  } finally {
    client.release();
  }
});

// ── Metrics ───────────────────────────────────────────────────────────────────

function parseDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 365);
}

function parseLocationId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get("/review-rewards/metrics/overview", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const days = parseDays(req.query.days);
  const locationId = parseLocationId(req.query.locationId);
  const [scans, reviews, rewards] = await Promise.all([
    db.query<{ total: string; flagged: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE flagged)::text AS flagged
         FROM review_scans
        WHERE workspace_owner_id = $1
          AND scanned_at > now() - make_interval(days => $2)
          AND ($3::integer IS NULL OR gbp_location_id = $3)`,
      [wreq.workspaceOwnerId, days, locationId],
    ),
    db.query<{ total: string; matched: string; needs_review: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE match_status IN ('auto_matched','manually_matched'))::text AS matched,
              count(*) FILTER (WHERE match_status = 'needs_review')::text AS needs_review
         FROM google_reviews
        WHERE workspace_owner_id = $1
          AND review_created_at > now() - make_interval(days => $2)
          AND is_deleted = false
          AND ($3::integer IS NULL OR gbp_location_id = $3)`,
      [wreq.workspaceOwnerId, days, locationId],
    ),
    db.query<{ status: string; count: string; total_amount: string }>(
      `SELECT status, count(*)::text AS count, COALESCE(sum(amount), 0)::text AS total_amount
         FROM review_rewards
        WHERE workspace_owner_id = $1 AND created_at > now() - make_interval(days => $2)
          AND ($3::integer IS NULL OR gbp_location_id = $3)
        GROUP BY status`,
      [wreq.workspaceOwnerId, days, locationId],
    ),
  ]);
  const scanTotal = Number(scans.rows[0]?.total ?? 0);
  const matched = Number(reviews.rows[0]?.matched ?? 0);
  const rewardsByStatus: Record<string, { count: number; totalAmount: string }> = {};
  for (const row of rewards.rows) {
    rewardsByStatus[row.status] = { count: Number(row.count), totalAmount: row.total_amount };
  }
  res.json({
    days,
    scans: scanTotal,
    flaggedScans: Number(scans.rows[0]?.flagged ?? 0),
    newReviews: Number(reviews.rows[0]?.total ?? 0),
    matchedReviews: matched,
    needsReview: Number(reviews.rows[0]?.needs_review ?? 0),
    conversionRate: scanTotal > 0 ? matched / scanTotal : 0,
    rewardsByStatus,
  });
});

router.get("/review-rewards/metrics/trend", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const days = parseDays(req.query.days);
  const locationId = parseLocationId(req.query.locationId);
  const result = await db.query<{ day: string; scans: string; matched_reviews: string }>(
    `WITH day_series AS (
       SELECT generate_series(
         date_trunc('day', now()) - make_interval(days => $2 - 1),
         date_trunc('day', now()),
         interval '1 day'
       )::date AS day
     ),
     scan_counts AS (
       SELECT date_trunc('day', scanned_at)::date AS day, count(*) AS n
         FROM review_scans
        WHERE workspace_owner_id = $1
          AND scanned_at > now() - make_interval(days => $2)
          AND ($3::integer IS NULL OR gbp_location_id = $3)
        GROUP BY 1
     ),
     matched_counts AS (
       SELECT date_trunc('day', review_created_at)::date AS day, count(*) AS n
         FROM google_reviews
        WHERE workspace_owner_id = $1
          AND review_created_at > now() - make_interval(days => $2)
          AND match_status IN ('auto_matched','manually_matched')
          AND is_deleted = false
          AND ($3::integer IS NULL OR gbp_location_id = $3)
        GROUP BY 1
     )
     SELECT d.day::text AS day,
            COALESCE(s.n, 0)::text AS scans,
            COALESCE(m.n, 0)::text AS matched_reviews
       FROM day_series d
       LEFT JOIN scan_counts s ON s.day = d.day
       LEFT JOIN matched_counts m ON m.day = d.day
      ORDER BY d.day`,
    [wreq.workspaceOwnerId, days, locationId],
  );
  res.json({
    days,
    series: result.rows.map((r) => ({
      day: r.day,
      scans: Number(r.scans),
      matchedReviews: Number(r.matched_reviews),
    })),
  });
});

router.get("/review-rewards/metrics/employees", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const days = parseDays(req.query.days);
  const locationId = parseLocationId(req.query.locationId);
  const result = await db.query(
    `SELECT p.id, p.employee_name, p.role, p.is_active, p.gbp_location_id,
            COALESCE(s.scans, 0)::int AS scans,
            COALESCE(g.matched_reviews, 0)::int AS matched_reviews,
            COALESCE(r.pending_amount, 0)::text AS pending_amount,
            COALESCE(r.approved_amount, 0)::text AS approved_amount,
            COALESCE(r.paid_amount, 0)::text AS paid_amount
       FROM employee_review_profiles p
       LEFT JOIN (
         SELECT profile_id, count(*) AS scans
           FROM review_scans
          WHERE workspace_owner_id = $1
            AND scanned_at > now() - make_interval(days => $2)
            AND ($3::integer IS NULL OR gbp_location_id = $3)
          GROUP BY profile_id
       ) s ON s.profile_id = p.id
       LEFT JOIN (
         SELECT matched_profile_id, count(*) AS matched_reviews
           FROM google_reviews
          WHERE workspace_owner_id = $1
            AND review_created_at > now() - make_interval(days => $2)
            AND match_status IN ('auto_matched','manually_matched')
            AND is_deleted = false
            AND ($3::integer IS NULL OR gbp_location_id = $3)
          GROUP BY matched_profile_id
       ) g ON g.matched_profile_id = p.id
       LEFT JOIN (
         SELECT rw.profile_id,
                sum(rw.amount) FILTER (WHERE rw.status = 'pending') AS pending_amount,
                sum(rw.amount) FILTER (WHERE rw.status = 'approved') AS approved_amount,
                sum(rw.amount) FILTER (WHERE rw.status = 'paid') AS paid_amount
           FROM review_rewards rw
           JOIN google_reviews grev ON grev.id = rw.review_id
          WHERE rw.workspace_owner_id = $1
            AND rw.created_at > now() - make_interval(days => $2)
            AND ($3::integer IS NULL OR grev.gbp_location_id = $3)
          GROUP BY rw.profile_id
       ) r ON r.profile_id = p.id
      WHERE p.workspace_owner_id = $1 AND p.archived_at IS NULL
        AND ($3::integer IS NULL OR p.gbp_location_id = $3)
      ORDER BY matched_reviews DESC, scans DESC`,
    [wreq.workspaceOwnerId, days, locationId],
  );
  res.json({ days, employees: result.rows });
});

router.get("/review-rewards/metrics/latest-matches", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const result = await db.query(
    `SELECT g.id, g.google_review_id, g.reviewer_name, g.rating, g.comment,
            g.review_created_at, g.match_status, g.match_resolved_at,
            p.employee_name
       FROM google_reviews g
       JOIN employee_review_profiles p ON p.id = g.matched_profile_id
      WHERE g.workspace_owner_id = $1
        AND g.match_status IN ('auto_matched','manually_matched')
        AND g.is_deleted = false
        AND ($2::int IS NULL OR g.gbp_location_id = $2)
      ORDER BY g.created_at DESC
      LIMIT 10`,
    [wreq.workspaceOwnerId, locationId],
  );
  res.json({ matches: result.rows });
});

// ── Location performance ──────────────────────────────────────────────────────

/**
 * GET /review-rewards/locations/performance
 *
 * Per-location KPI roll-ups for the Locations tab and the Overview
 * locations-performance table. Includes locations that are tracked but have
 * zero activity so the UI can show a complete list with sync status.
 */
router.get("/review-rewards/locations/performance", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewReviewRewards(wreq)) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const result = await db.query<{
    location_id: number;
    location_title: string | null;
    location_locality: string | null;
    country: string | null;
    sync_status: string | null;
    last_synced_at: string | null;
    google_status: string | null;
    review_count: string;
    scan_count: string;
    rewards_earned: string;
  }>(
    `SELECT glc.id                          AS location_id,
            glc.location_title,
            glc.location_locality,
            glc.country,
            glc.review_sync_status          AS sync_status,
            glc.last_synced_at,
            glc.last_error                  AS google_status,
            COALESCE(rc.review_count,   0)  AS review_count,
            COALESCE(sc.scan_count,     0)  AS scan_count,
            COALESCE(re.rewards_earned, 0)  AS rewards_earned
       FROM gbp_location_connections glc
       LEFT JOIN (
         SELECT gbp_location_id, count(*) AS review_count
           FROM google_reviews
          WHERE workspace_owner_id = $1 AND is_deleted = false
          GROUP BY gbp_location_id
       ) rc ON rc.gbp_location_id = glc.id
       LEFT JOIN (
         SELECT gbp_location_id, count(*) AS scan_count
           FROM review_scans
          WHERE workspace_owner_id = $1
          GROUP BY gbp_location_id
       ) sc ON sc.gbp_location_id = glc.id
       LEFT JOIN (
         SELECT gbp_location_id, sum(amount) AS rewards_earned
           FROM review_rewards
          WHERE workspace_owner_id = $1 AND status IN ('approved', 'paid')
          GROUP BY gbp_location_id
       ) re ON re.gbp_location_id = glc.id
      WHERE glc.workspace_owner_id = $1 AND glc.is_enabled = true
      ORDER BY glc.created_at ASC`,
    [wreq.workspaceOwnerId],
  );
  res.json({
    locations: result.rows.map((r) => ({
      locationId: r.location_id,
      locationTitle: r.location_title,
      locationLocality: r.location_locality ?? null,
      country: r.country ?? null,
      syncStatus: r.sync_status,
      lastSyncedAt: r.last_synced_at,
      googleStatus:
        isOwner(wreq) || !r.google_status
          ? r.google_status
          : "needs_attention",
      reviewCount: Number(r.review_count),
      scanCount: Number(r.scan_count),
      conversionRate:
        Number(r.scan_count) > 0
          ? Number(r.review_count) / Number(r.scan_count)
          : 0,
      rewardsEarned: r.rewards_earned,
    })),
  });
});

// ── Dev-only review ingest test endpoint ──────────────────────────────────────

const devIngestSchema = z.object({
  googleReviewId: z.string().trim().min(1).max(200),
  reviewerName: z.string().max(200).nullish(),
  rating: z.coerce.number().int().min(1).max(5).nullish(),
  comment: z.string().max(5000).nullish(),
  reviewCreatedAt: z.coerce.date().optional(),
  isDeleted: z.boolean().optional(),
});

if (process.env.NODE_ENV !== "production") {
  router.post("/review-rewards/dev/ingest-review", async (req, res) => {
    const wreq = workspace(req);
    if (!isOwner(wreq)) {
      res.status(403).json({ error: "Review rewards management requires owner access" });
      return;
    }
    const parsed = devIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const result = await ingestReview({
      workspaceOwnerId: wreq.workspaceOwnerId,
      ...parsed.data,
    });
    res.json(result);
  });
}

export default router;
