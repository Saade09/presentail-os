import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { clerkClient } from "@clerk/express";
import { db, withTransaction } from "../lib/db";
import { requireAuth, authed } from "../lib/auth";
import { logPageAccessDenial, resolveWorkspace, workspace } from "../lib/workspace";
import { objectStorageClient, objectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { broadcastEvent } from "../lib/eventsSse";
import { notifyCashSessionFlaggedAlerts } from "../lib/orderAlerts";
import {
  notifySalaryApprovalRequested,
  notifySalaryDecisionToRequester,
} from "../lib/slack";
import { getStoredRate } from "../lib/exchangeRateService";
import {
  generateSessionNumber,
  recomputeSessionTotals,
  logSessionActivity,
  recordCashTransaction,
  sessionCurrencies,
  computeSessionCurrencySummary,
  validateClosingCounts,
  receiptRequiredThreshold,
  varianceApprovalThreshold,
  buildReconciliationCounts,
  reconciliationCloseBlockers,
  isReconciliationStale,
  isSessionOverdue,
  SALE_CHANNELS,
  EXPENSE_CATEGORIES,
  PAYROLL_PAYMENT_TYPES,
  isPayrollCategory,
  type CashSessionRow,
  type ClosingCountInput,
  type ReconciliationState,
  type ReconciliationCount,
} from "../lib/cashDesk";
import { isCmcLocation } from "../lib/cmcLocation";

const router = Router();
router.use(requireAuth, resolveWorkspace);

/**
 * In-memory idempotency store for POST /cash-sessions.
 * Key: `${workspaceOwnerId}:${idempotencyKey}`, Value: cached 201 payload + expiry.
 * TTL: 60 seconds — long enough to survive double-clicks and brief retries.
 */
const idempotencyCache = new Map<string, { expiresAt: number; body: unknown }>();
const IDEMPOTENCY_TTL_MS = 60_000;

function pruneIdempotencyCache() {
  const now = Date.now();
  for (const [k, v] of idempotencyCache) {
    if (v.expiresAt <= now) idempotencyCache.delete(k);
  }
}

// Prune stale entries every 5 minutes so the map never grows unbounded.
setInterval(pruneIdempotencyCache, 5 * 60_000).unref();

/** Multipart upload for bill invoice attachments (image or PDF). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const ALLOWED_INVOICE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/** Upload an invoice buffer to object storage, returning its /objects path. */
async function uploadInvoiceToStorage(
  buffer: Buffer,
  mime: string,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = objectStorageService.getPrivateObjectDir();

  const objectId = randomUUID();
  const entityId = `${workspaceOwnerId}/cash-bills/${objectId}`;
  const fullPath = privateObjectDir.endsWith("/")
    ? `${privateObjectDir}${entityId}`
    : `${privateObjectDir}/${entityId}`;

  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  await file.save(buffer, { contentType: mime, resumable: false });

  return `/objects/${entityId}`;
}

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

/**
 * Cash-session operating permissions imply read access to the sessions they
 * operate on. This also keeps older CMC role assignments working if their
 * action grants exist but the newer hyphenated page key is absent at runtime.
 */
function hasCashSessionViewPermission(
  wreq: ReturnType<typeof workspace>,
): boolean {
  if (hasPermission(wreq, "cash-sessions")) return true;
  const operatorPermissions = new Set([
    "cmc_pos.cash_drawer",
    "cash_sessions.open",
    "cash_sessions.close",
  ]);
  return wreq.allowedPages?.some((permission) =>
    operatorPermissions.has(permission)
  ) ?? false;
}

function logCashSessionViewDenial(
  req: Parameters<typeof authed>[0],
  wreq: ReturnType<typeof workspace>,
): void {
  logPageAccessDenial(req, wreq, [
    "cash-sessions",
    "cmc_pos.cash_drawer",
    "cash_sessions.open",
    "cash_sessions.close",
  ]);
}

/**
 * The Cash Sessions page is the lifecycle permission boundary. The individual
 * open/close permissions remain valid for roles that were configured before
 * the page-level access was introduced, but a member who can access the Cash
 * Sessions page must not be stranded by a missing redundant action flag.
 */
function hasCashSessionActionPermission(
  wreq: ReturnType<typeof workspace>,
  action: "open" | "close",
): boolean {
  return hasPermission(wreq, "cash-sessions") || hasPermission(wreq, `cash_sessions.${action}`);
}

/**
 * True when the current user may approve/decline salary expense requests:
 * workspace owners (real role) always can; otherwise the member must hold the
 * "Business Development" custom workspace role.
 */
async function canApproveSalaryExpenses(wreq: ReturnType<typeof workspace>, userId: string): Promise<boolean> {
  if (wreq.workspaceActualRole === "owner") return true;
  const result = await db.query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM workspace_members wm
       JOIN workspace_member_roles wmr ON wmr.member_id = wm.id
       JOIN workspace_roles wr ON wr.id = wmr.role_id
      WHERE wm.workspace_owner_id = $1
        AND wm.member_user_id = $2
        AND LOWER(wr.name) = 'business development'
      LIMIT 1`,
    [wreq.workspaceOwnerId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Count pending salary approval requests linked to a session. */
async function countPendingSalaryApprovals(sessionId: number, workspaceOwnerId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM cash_transactions
      WHERE cash_session_id = $1 AND workspace_owner_id = $2 AND approval_status = 'pending'`,
    [sessionId, workspaceOwnerId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10) || 0;
}

/**
 * Display names of the members who can approve salary expenses: holders of the
 * "Business Development" custom role, falling back to workspace owners/admins.
 * Names resolve via Clerk; unresolved members fall back to their email prefix.
 */
async function findSalaryApproverNames(workspaceOwnerId: string): Promise<string[]> {
  const bd = await db.query<{ member_user_id: string | null; member_email: string | null }>(
    `SELECT DISTINCT wm.member_user_id, wm.member_email
       FROM workspace_members wm
       JOIN workspace_member_roles wmr ON wmr.member_id = wm.id
       JOIN workspace_roles wr ON wr.id = wmr.role_id
      WHERE wm.workspace_owner_id = $1
        AND LOWER(wr.name) = 'business development'`,
    [workspaceOwnerId],
  );
  let rows = bd.rows;
  if (rows.length === 0) {
    const owners = await db.query<{ member_user_id: string | null; member_email: string | null }>(
      `SELECT DISTINCT member_user_id, member_email FROM workspace_members
        WHERE workspace_owner_id = $1 AND role IN ('owner', 'admin')`,
      [workspaceOwnerId],
    );
    rows = owners.rows;
  }
  const nameMap = await fetchClerkNames(rows.map((r) => r.member_user_id ?? "").filter(Boolean));
  const names = rows
    .map(
      (r) =>
        (r.member_user_id ? nameMap.get(r.member_user_id) : null) ||
        (r.member_email ? r.member_email.split("@")[0] : ""),
    )
    .filter(Boolean);
  return [...new Set(names)];
}

async function fetchClerkNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const filtered = [...new Set(userIds.filter(Boolean))];
  if (filtered.length === 0) return map;
  try {
    const users = await clerkClient.users.getUserList({ userId: filtered, limit: 100 });
    for (const u of users.data) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      map.set(u.id, name || (u.primaryEmailAddress?.emailAddress ?? u.id));
    }
  } catch (err) {
    logger.warn({ err }, "Failed to batch-fetch Clerk names for cash sessions");
  }
  return map;
}

type SessionListRow = CashSessionRow & {
  drawer_name: string | null;
  drawer_code: string | null;
  location_name: string | null;
  same_day_cutoff_time: string | null;
  location_timezone: string | null;
};

const SESSION_LIST_SELECT = `SELECT cs.*,
            d.name AS drawer_name,
            d.code AS drawer_code,
            l.name AS location_name,
            l.same_day_cutoff_time,
            l.timezone AS location_timezone,
            res.resolution_id
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
       LEFT JOIN LATERAL (
         SELECT r.id AS resolution_id
           FROM cash_session_resolutions r
          WHERE r.cash_session_id = cs.id
            AND r.workspace_id = cs.workspace_owner_id
          ORDER BY r.created_at DESC
          LIMIT 1
       ) res ON true`;

const PAGE_SIZE = 20;

const SORT_COL: Record<string, string> = {
  opened_at: "cs.opened_at",
  status:
    "CASE cs.status WHEN 'open' THEN 0 WHEN 'pending_review' THEN 1 WHEN 'flagged' THEN 2 ELSE 3 END",
  difference: "COALESCE(cs.difference::numeric, 0)",
};

/**
 * Adds SQL condition fragments for the shared "attention" or "difference"
 * pseudo-statuses plus the standard status values.  The LONG_OPEN_THRESHOLD of
 * 8 hours is enforced in SQL so it never loads all sessions into memory.
 */
function applyStatusFilter(
  status: string | null,
  conditions: string[],
  params: unknown[],
) {
  if (!status) return;
  if (status === "attention") {
    conditions.push(`(
      cs.status IN ('pending_review', 'flagged')
      OR (cs.status = 'open' AND cs.opened_at < NOW() - INTERVAL '8 hours')
      OR (cs.status = 'approved' AND cs.actual_cash IS NULL AND cs.closed_at IS NOT NULL)
    )`);
  } else if (status === "difference") {
    conditions.push(`(
      (cs.difference IS NOT NULL AND cs.difference::numeric != 0)
      OR (cs.difference_secondary IS NOT NULL AND cs.difference_secondary::numeric != 0)
    )`);
  } else {
    params.push(status);
    conditions.push(`cs.status = $${params.length}`);
  }
}

/**
 * Resolves a named date preset into inclusive SQL conditions on cs.opened_at.
 * Preset names mirror the frontend DatePreset type.  Returns raw SQL string
 * fragments (no params needed — all constants use NOW() server-side).
 */
function applyPresetFilter(preset: string | null, conditions: string[], params: unknown[], from: string | null, to: string | null) {
  switch (preset) {
    case "today":
      conditions.push(`cs.opened_at >= date_trunc('day', NOW()) AND cs.opened_at < date_trunc('day', NOW()) + INTERVAL '1 day'`);
      break;
    case "yesterday":
      conditions.push(`cs.opened_at >= date_trunc('day', NOW() - INTERVAL '1 day') AND cs.opened_at < date_trunc('day', NOW())`);
      break;
    case "this_week":
      // PostgreSQL date_trunc('week', ...) starts on Monday.
      conditions.push(`cs.opened_at >= date_trunc('week', NOW()) AND cs.opened_at < date_trunc('day', NOW()) + INTERVAL '1 day'`);
      break;
    case "this_month":
      conditions.push(`cs.opened_at >= date_trunc('month', NOW()) AND cs.opened_at < date_trunc('day', NOW()) + INTERVAL '1 day'`);
      break;
    case "custom": {
      if (from) {
        params.push(from);
        conditions.push(`cs.opened_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        // to is the end date (yyyy-mm-dd). Add 1 day for inclusive end.
        conditions.push(`cs.opened_at < $${params.length}::date + INTERVAL '1 day'`);
      }
      break;
    }
    default:
      // "all" or blank — apply explicit from/to if provided
      if (from) {
        params.push(from);
        conditions.push(`cs.opened_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`cs.opened_at <= $${params.length}`);
      }
  }
}

/**
 * GET /api/cash-sessions/kpis
 * Workspace-wide KPI aggregates (not filtered by table filters):
 *   open/pending/flagged counts, open cash held by currency,
 *   flagged-diff by currency, 30-day net difference by currency,
 *   attention sessions (up to 10), filter dropdown options, and
 *   the current user's open session (for the Continue button).
 */
router.get("/cash-sessions/kpis", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionViewPermission(wreq)) {
    logCashSessionViewDenial(req, wreq);
    res.status(403).json({ error: "Insufficient permissions to view cash sessions" });
    return;
  }
  const userId = authed(req).userId;
  const ownerId = wreq.workspaceOwnerId;

  // 1. Status counts + open held + flagged diff (all in one pass)
  const [countRows, openHeldRows, flaggedDiffRows, diffRows, attentionRows, optionsRows, mySessionRows, overdueCountRows] =
    await Promise.all([
      db.query<{ open_count: string; pending_count: string; flagged_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'open')::text AS open_count,
           COUNT(*) FILTER (WHERE status = 'pending_review')::text AS pending_count,
           COUNT(*) FILTER (WHERE status = 'flagged')::text AS flagged_count
           FROM cash_sessions
          WHERE workspace_owner_id = $1`,
        [ownerId],
      ),

      // Open cash held per currency (primary + secondary, no FX)
      db.query<{ currency: string; held: string; session_count: string }>(
        `SELECT x.currency,
                COALESCE(SUM(x.held), 0)::text AS held,
                COUNT(*)::text AS session_count
           FROM (
             SELECT currency,
                    COALESCE(expected_cash, opening_cash, 0) AS held
               FROM cash_sessions
              WHERE workspace_owner_id = $1 AND status = 'open'
             UNION ALL
             SELECT secondary_currency,
                    COALESCE(expected_cash_secondary, opening_cash_secondary, 0) AS held
               FROM cash_sessions
              WHERE workspace_owner_id = $1 AND status = 'open' AND secondary_currency IS NOT NULL
           ) x
          GROUP BY x.currency
          ORDER BY x.currency`,
        [ownerId],
      ),

      // Flagged sessions: difference by currency
      db.query<{ currency: string; total: string }>(
        `SELECT x.currency, COALESCE(SUM(x.diff), 0)::text AS total
           FROM (
             SELECT currency, COALESCE(difference::numeric, 0) AS diff
               FROM cash_sessions
              WHERE workspace_owner_id = $1 AND status = 'flagged' AND difference IS NOT NULL
             UNION ALL
             SELECT secondary_currency, COALESCE(difference_secondary::numeric, 0) AS diff
               FROM cash_sessions
              WHERE workspace_owner_id = $1 AND status = 'flagged'
                AND secondary_currency IS NOT NULL AND difference_secondary IS NOT NULL
           ) x
          GROUP BY x.currency
          ORDER BY x.currency`,
        [ownerId],
      ),

      // 30-day net difference by currency (closed sessions)
      db.query<{ currency: string; total: string; session_count: string }>(
        `SELECT x.currency,
                COALESCE(SUM(x.diff), 0)::text AS total,
                COUNT(*)::text AS session_count
           FROM (
             SELECT currency, COALESCE(difference::numeric, 0) AS diff
               FROM cash_sessions
              WHERE workspace_owner_id = $1
                AND difference IS NOT NULL
                AND closed_at >= NOW() - INTERVAL '30 days'
             UNION ALL
             SELECT secondary_currency, COALESCE(difference_secondary::numeric, 0) AS diff
               FROM cash_sessions
              WHERE workspace_owner_id = $1
                AND secondary_currency IS NOT NULL AND difference_secondary IS NOT NULL
                AND closed_at >= NOW() - INTERVAL '30 days'
           ) x
          GROUP BY x.currency
          ORDER BY x.currency`,
        [ownerId],
      ),

      // Attention sessions — top 10 (flagged + pending_review + overdue + long-open + closed-no-count)
      db.query<SessionListRow & { overdue_grace_minutes: number }>(
        `SELECT cs.*,
                d.name AS drawer_name,
                d.code AS drawer_code,
                l.name AS location_name,
                l.same_day_cutoff_time,
                l.timezone AS location_timezone,
                COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) AS overdue_grace_minutes
           FROM cash_sessions cs
           JOIN cash_drawers d ON d.id = cs.drawer_id
           LEFT JOIN locations l ON l.id = cs.location_id
           LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = cs.workspace_owner_id
          WHERE cs.workspace_owner_id = $1
            AND (
              cs.status IN ('pending_review', 'flagged')
              OR (cs.status = 'open' AND cs.opened_at < NOW() - INTERVAL '8 hours')
              OR (
                cs.status = 'open'
                AND l.same_day_cutoff_time IS NOT NULL
                AND l.timezone IS NOT NULL
                AND (
                  (
                    date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
                    + l.same_day_cutoff_time::interval
                    + COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) * INTERVAL '1 minute'
                  ) AT TIME ZONE l.timezone
                ) < now()
              )
              OR (cs.status = 'approved' AND cs.actual_cash IS NULL AND cs.closed_at IS NOT NULL)
            )
          ORDER BY
            CASE cs.status
              WHEN 'flagged' THEN 0
              WHEN 'pending_review' THEN 1
              WHEN 'open' THEN 2
              ELSE 3
            END,
            cs.opened_at DESC
          LIMIT 10`,
        [ownerId],
      ),

      // Filter option lists — distinct drawer names, currencies, operator clerk IDs
      db.query<{ drawer_name: string; currency: string; operator_id: string | null }>(
        `SELECT DISTINCT
                d.name AS drawer_name,
                cs.currency,
                cs.opened_by_clerk_id AS operator_id
           FROM cash_sessions cs
           JOIN cash_drawers d ON d.id = cs.drawer_id
          WHERE cs.workspace_owner_id = $1
          ORDER BY d.name, cs.currency`,
        [ownerId],
      ),

      // Current user's open session (for Continue button)
      db.query<SessionListRow>(
        `${SESSION_LIST_SELECT}
          WHERE cs.workspace_owner_id = $1
            AND cs.status = 'open'
            AND cs.opened_by_clerk_id = $2
          ORDER BY cs.opened_at DESC
          LIMIT 1`,
        [ownerId, userId],
      ),

      // Count of open sessions that are overdue past daily-close cutoff + grace
      db.query<{ overdue_count: string }>(
        `SELECT COUNT(*)::text AS overdue_count
           FROM cash_sessions cs
           LEFT JOIN locations l ON l.id = cs.location_id
           LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = cs.workspace_owner_id
          WHERE cs.workspace_owner_id = $1
            AND cs.status = 'open'
            AND l.same_day_cutoff_time IS NOT NULL
            AND l.timezone IS NOT NULL
            AND (
              (
                date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
                + l.same_day_cutoff_time::interval
                + COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) * INTERVAL '1 minute'
              ) AT TIME ZONE l.timezone
            ) < now()`,
        [ownerId],
      ),
    ]);

  // Annotate attention sessions with overdue status
  const now = new Date();
  const rawAttentionSessions = attentionRows.rows.map((row) => {
    const graceMinutes = row.overdue_grace_minutes ?? 30;
    const { overdue, overdueByMinutes } = isSessionOverdue(
      row.opened_at,
      row.same_day_cutoff_time,
      row.location_timezone,
      graceMinutes,
      now,
    );
    return { ...row, isOverdue: overdue, overdueByMinutes };
  });

  // Collect all clerk IDs to resolve
  const attentionSessions = rawAttentionSessions;
  const mySession = mySessionRows.rows[0] ?? null;
  const clerkIds = [
    ...attentionSessions.map((s) => s.opened_by_clerk_id ?? ""),
    ...attentionSessions.map((s) => s.closed_by_clerk_id ?? ""),
    ...attentionSessions.map((s) => s.approved_by_clerk_id ?? ""),
    mySession?.opened_by_clerk_id ?? "",
    ...optionsRows.rows.map((r) => r.operator_id ?? ""),
  ];
  const nameMap = await fetchClerkNames(clerkIds);

  // Build filter options (deduplicated)
  const drawerSet = new Set<string>();
  const currencySet = new Set<string>();
  const operatorMap = new Map<string, string>(); // clerkId → name
  for (const r of optionsRows.rows) {
    if (r.drawer_name) drawerSet.add(r.drawer_name);
    if (r.currency) currencySet.add(r.currency);
    if (r.operator_id) {
      const name = nameMap.get(r.operator_id);
      if (name) operatorMap.set(r.operator_id, name);
    }
  }

  const addName = (s: SessionListRow) => ({
    ...s,
    opened_by_name: nameMap.get(s.opened_by_clerk_id ?? "") ?? null,
    closed_by_name: nameMap.get(s.closed_by_clerk_id ?? "") ?? null,
    approved_by_name: nameMap.get(s.approved_by_clerk_id ?? "") ?? null,
  });

  res.json({
    openCount: parseInt(countRows.rows[0]?.open_count ?? "0", 10),
    pendingCount: parseInt(countRows.rows[0]?.pending_count ?? "0", 10),
    flaggedCount: parseInt(countRows.rows[0]?.flagged_count ?? "0", 10),
    overdueCount: parseInt(overdueCountRows.rows[0]?.overdue_count ?? "0", 10),
    openHeldByCurrency: openHeldRows.rows.map((r) => ({
      currency: r.currency,
      amount: parseFloat(r.held),
      count: parseInt(r.session_count, 10),
    })),
    flaggedDiffByCurrency: flaggedDiffRows.rows.map((r) => ({
      currency: r.currency,
      amount: parseFloat(r.total),
    })),
    differenceByCurrency: diffRows.rows.map((r) => ({
      currency: r.currency,
      amount: parseFloat(r.total),
      count: parseInt(r.session_count, 10),
    })),
    attentionSessions: attentionSessions.map((s) => ({
      ...addName(s),
      isOverdue: s.isOverdue,
      overdueByMinutes: s.overdueByMinutes,
    })),
    myOpenSession: mySession ? addName(mySession) : null,
    filterOptions: {
      drawers: [...drawerSet].sort(),
      currencies: [...currencySet].sort(),
      operators: [...operatorMap.entries()].map(([clerkId, name]) => ({ clerkId, name })).sort((a, b) => a.name.localeCompare(b.name)),
    },
  });
});

/**
 * GET /api/cash-sessions/employees
 * Returns active (non-archived) team members for payroll expense selection.
 * Requires cash-sessions permission (same gate as the session list).
 */
router.get("/cash-sessions/employees", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  try {
    const result = await db.query<{
      id: string;
      display_name: string;
      employee_code: string | null;
    }>(
      `SELECT
         'tm_' || tm.id::text AS id,
         TRIM(tm.first_name || COALESCE(' ' || NULLIF(tm.last_name, ''), '')) AS display_name,
         tmp.employee_code
        FROM team_members tm
        LEFT JOIN team_member_profiles tmp
               ON tmp.team_member_id = tm.id
              AND tmp.workspace_owner_id = tm.workspace_owner_id
       WHERE tm.workspace_owner_id = $1
         AND tm.archived_at IS NULL
       ORDER BY tm.first_name, tm.last_name NULLS LAST`,
      [wreq.workspaceOwnerId],
    );
    res.json(result.rows);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "42P01") {
      // team_members table not yet present — return empty list
      res.json([]);
    } else {
      throw err;
    }
  }
});

/**
 * GET /api/cash-sessions
 * Paginated, filtered, sorted session list.
 * Query params:
 *   status        — open | pending_review | approved | flagged | attention | difference
 *   preset        — all | today | yesterday | this_week | this_month | custom
 *   from / to     — yyyy-mm-dd (used when preset=custom or preset=all)
 *   drawer        — exact drawer name
 *   currency      — exact ISO currency code
 *   operator_id   — opened_by_clerk_id value
 *   q             — partial search on session_number
 *   sort          — opened_at (default) | status | difference
 *   dir           — desc (default) | asc
 *   page          — 1-based page number (default 1)
 */
router.get("/cash-sessions", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionViewPermission(wreq)) {
    logCashSessionViewDenial(req, wreq);
    res.status(403).json({ error: "Insufficient permissions to view cash sessions" });
    return;
  }

  const conditions = ["cs.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  const status =
    typeof req.query.status === "string" && req.query.status.trim()
      ? req.query.status.trim()
      : null;
  applyStatusFilter(status, conditions, params);

  const preset =
    typeof req.query.preset === "string" && req.query.preset.trim()
      ? req.query.preset.trim()
      : null;
  const from =
    typeof req.query.from === "string" && req.query.from.trim()
      ? req.query.from.trim()
      : null;
  const to =
    typeof req.query.to === "string" && req.query.to.trim()
      ? req.query.to.trim()
      : null;
  applyPresetFilter(preset, conditions, params, from, to);

  const drawer =
    typeof req.query.drawer === "string" && req.query.drawer.trim()
      ? req.query.drawer.trim()
      : null;
  if (drawer) {
    params.push(drawer);
    conditions.push(`d.name = $${params.length}`);
  }

  // Legacy drawer_id support (kept for backward compat)
  const drawerId =
    typeof req.query.drawer_id === "string" ? parseInt(req.query.drawer_id, 10) : NaN;
  if (!isNaN(drawerId) && !drawer) {
    params.push(drawerId);
    conditions.push(`cs.drawer_id = $${params.length}`);
  }

  const locationId =
    typeof req.query.location_id === "string"
      ? parseInt(req.query.location_id, 10)
      : NaN;
  if (!isNaN(locationId)) {
    params.push(locationId);
    conditions.push(`cs.location_id = $${params.length}`);
  }

  const currency =
    typeof req.query.currency === "string" && req.query.currency.trim()
      ? req.query.currency.trim()
      : null;
  if (currency) {
    params.push(currency);
    conditions.push(`cs.currency = $${params.length}`);
  }

  const operatorId =
    typeof req.query.operator_id === "string" && req.query.operator_id.trim()
      ? req.query.operator_id.trim()
      : null;
  if (operatorId) {
    params.push(operatorId);
    conditions.push(`cs.opened_by_clerk_id = $${params.length}`);
  }

  const q =
    typeof req.query.q === "string" && req.query.q.trim()
      ? req.query.q.trim()
      : null;
  if (q) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`cs.session_number ILIKE $${params.length} ESCAPE '\\'`);
  }

  const where = conditions.join(" AND ");

  // Sort
  const sortKeyRaw =
    typeof req.query.sort === "string" ? req.query.sort.trim() : "opened_at";
  const sortColSQL = SORT_COL[sortKeyRaw] ?? SORT_COL.opened_at;
  const dirSQL =
    typeof req.query.dir === "string" && req.query.dir.trim() === "asc"
      ? "ASC"
      : "DESC";

  // Pagination
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Run count + page in parallel
  const [countResult, result] = await Promise.all([
    db.query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM cash_sessions cs
         JOIN cash_drawers d ON d.id = cs.drawer_id
         LEFT JOIN locations l ON l.id = cs.location_id
        WHERE ${where}`,
      params,
    ),
    db.query<SessionListRow>(
      `${SESSION_LIST_SELECT}
        WHERE ${where}
        ORDER BY ${sortColSQL} ${dirSQL}, cs.id DESC
        LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params,
    ),
  ]);

  const totalCount = parseInt(countResult.rows[0]?.total ?? "0", 10);

  const nameMap = await fetchClerkNames([
    ...result.rows.map((s) => s.opened_by_clerk_id ?? ""),
    ...result.rows.map((s) => s.closed_by_clerk_id ?? ""),
    ...result.rows.map((s) => s.approved_by_clerk_id ?? ""),
  ]);

  res.json({
    sessions: result.rows.map((s) => ({
      ...s,
      opened_by_name: nameMap.get(s.opened_by_clerk_id ?? "") ?? null,
      closed_by_name: nameMap.get(s.closed_by_clerk_id ?? "") ?? null,
      approved_by_name: nameMap.get(s.approved_by_clerk_id ?? "") ?? null,
    })),
    total_count: totalCount,
    page,
    page_size: PAGE_SIZE,
  });
});

type BillRow = {
  id: number;
  cash_session_id: number | null;
  session_number: string | null;
  drawer_id: number | null;
  drawer_name: string | null;
  drawer_code: string | null;
  location_id: number | null;
  location_name: string | null;
  currency: string;
  amount: string;
  description: string | null;
  attachment_url: string | null;
  transaction_date: string;
  created_by_clerk_id: string | null;
};

/**
 * GET /api/cash-bills
 * Consolidated report of bills (type = "bill") paid out across all cash
 * sessions, with drawer/location context and invoice attachment links.
 * Filters: location_id, from, to (transaction_date). Includes a per-currency
 * total summary (no FX, currencies stay separate).
 */
router.get("/cash-bills", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions to view cash bills" });
    return;
  }

  const conditions = ["ct.workspace_owner_id = $1", "ct.type = 'bill'"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  const locationId = typeof req.query.location_id === "string" ? parseInt(req.query.location_id, 10) : NaN;
  if (!isNaN(locationId)) {
    params.push(locationId);
    conditions.push(`ct.location_id = $${params.length}`);
  }
  const from = typeof req.query.from === "string" && req.query.from.trim() ? req.query.from.trim() : null;
  if (from) {
    params.push(from);
    conditions.push(`ct.transaction_date >= $${params.length}`);
  }
  const to = typeof req.query.to === "string" && req.query.to.trim() ? req.query.to.trim() : null;
  if (to) {
    params.push(to);
    conditions.push(`ct.transaction_date <= $${params.length}`);
  }

  const where = conditions.join(" AND ");

  const result = await db.query<BillRow>(
    `SELECT ct.id,
            ct.cash_session_id,
            cs.session_number,
            ct.cash_drawer_id AS drawer_id,
            d.name AS drawer_name,
            d.code AS drawer_code,
            ct.location_id,
            l.name AS location_name,
            ct.currency,
            ct.amount,
            ct.description,
            ct.attachment_url,
            ct.transaction_date,
            ct.created_by_clerk_id
       FROM cash_transactions ct
       LEFT JOIN cash_sessions cs ON cs.id = ct.cash_session_id
       LEFT JOIN cash_drawers d ON d.id = ct.cash_drawer_id
       LEFT JOIN locations l ON l.id = ct.location_id
      WHERE ${where}
      ORDER BY ct.transaction_date DESC, ct.id DESC`,
    params,
  );

  const byCurrency = await db.query<{
    currency: string;
    total: string;
    bill_count: string;
  }>(
    `SELECT ct.currency,
            COALESCE(SUM(ct.amount), 0)::text AS total,
            COUNT(*)::text AS bill_count
       FROM cash_transactions ct
      WHERE ${where}
      GROUP BY ct.currency
      ORDER BY ct.currency`,
    params,
  );

  const nameMap = await fetchClerkNames(result.rows.map((b) => b.created_by_clerk_id ?? ""));

  res.json({
    bills: result.rows.map((b) => ({
      ...b,
      created_by_name: nameMap.get(b.created_by_clerk_id ?? "") ?? null,
    })),
    summary: {
      total_count: result.rows.length,
      by_currency: byCurrency.rows.map((r) => ({
        currency: r.currency,
        total: r.total,
        bill_count: parseInt(r.bill_count ?? "0", 10),
      })),
    },
  });
});

/**
 * GET /api/cash-sessions/:id
 * Session detail with linked transactions and activity log.
 */
router.get("/cash-sessions/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions to view cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const result = await db.query<SessionListRow & { drawer_currency: string; drawer_secondary_currency: string | null }>(
    `SELECT cs.*,
            d.name AS drawer_name,
            d.code AS drawer_code,
            d.currency AS drawer_currency,
            d.secondary_currency AS drawer_secondary_currency,
            l.name AS location_name
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
      WHERE cs.id = $1 AND cs.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  const session = result.rows[0];

  const [txns, movementsResult] = await Promise.all([
    db.query(
      `SELECT ct.*,
              (SELECT COUNT(*) > 0
                 FROM cash_transaction_movements m
                WHERE m.cash_transaction_id = ct.id) AS has_movements
         FROM cash_transactions ct
        WHERE ct.cash_session_id = $1 AND ct.workspace_owner_id = $2
        ORDER BY ct.transaction_date ASC, ct.id ASC`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{
      id: number;
      cash_transaction_id: number;
      direction: string;
      kind: string;
      amount: string;
      currency: string;
      exchange_rate: string | null;
      converted_amount: string | null;
    }>(
      `SELECT m.id, m.cash_transaction_id, m.direction, m.kind,
              m.amount, m.currency, m.exchange_rate, m.converted_amount
         FROM cash_transaction_movements m
         JOIN cash_transactions ct ON ct.id = m.cash_transaction_id
        WHERE ct.cash_session_id = $1 AND ct.workspace_owner_id = $2
        ORDER BY m.cash_transaction_id, m.id`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);

  // Group movements by transaction id for O(1) lookup.
  const movementsByTx = new Map<number, typeof movementsResult.rows>();
  for (const m of movementsResult.rows) {
    const arr = movementsByTx.get(m.cash_transaction_id) ?? [];
    arr.push(m);
    movementsByTx.set(m.cash_transaction_id, arr);
  }

  // ── Server-side transaction filter + pagination params ──────────────────
  const txPage = Math.max(1, parseInt(String(req.query.tx_page ?? "1"), 10) || 1);
  const txPageSize = Math.min(100, Math.max(1, parseInt(String(req.query.tx_page_size ?? "50"), 10) || 50));
  const txTypeFilter = String(req.query.tx_type ?? "all");
  const txCurrencyFilter = String(req.query.tx_currency ?? "all");
  const txQFilter = String(req.query.tx_q ?? "").trim().toLowerCase();

  const logs = await db.query<{
    id: number;
    action: string;
    actor_clerk_id: string | null;
    actor_name: string | null;
    detail: string | null;
    created_at: string;
  }>(
    `SELECT id, action, actor_clerk_id, actor_name, detail, created_at
       FROM cash_session_activity_logs
      WHERE cash_session_id = $1 AND workspace_owner_id = $2
      ORDER BY created_at ASC, id ASC`,
    [id, wreq.workspaceOwnerId],
  );

  // Actions that are session-lifecycle events (not per-transaction events).
  const SESSION_SCOPE_ACTIONS = new Set([
    "opened", "closed", "approved", "flagged", "reopened",
    "reconciliation_started", "reconciliation_cancelled",
    "reconciliation_counts_submitted", "reconciliation_recount_initiated",
    "reconciliation_explanation_added", "reconciliation_approval_requested",
    "reconciliation_approval_approved", "reconciliation_approval_rejected",
    "reconciliation_report_downloaded", "reconciliation_report_preview_downloaded",
    "adjustment_approved",
  ]);

  // Warn when another open session exists on the same drawer.
  // Suppressed for closed/approved sessions — the conflict is irrelevant once a session is no longer active.
  const shouldCheckConflict = session.status === "open" || session.status === "pending_review";
  const otherOpen = shouldCheckConflict
    ? await db.query<{ id: number; session_number: string }>(
        `SELECT id, session_number FROM cash_sessions
          WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open' AND id <> $3
          LIMIT 1`,
        [session.drawer_id, wreq.workspaceOwnerId, id],
      )
    : { rows: [] };

  // Resolve names for users referenced on the session, transactions, and log.
  const txRows = txns.rows as Array<Record<string, unknown>>;
  const nameMap = await fetchClerkNames([
    session.opened_by_clerk_id ?? "",
    session.closed_by_clerk_id ?? "",
    session.approved_by_clerk_id ?? "",
    ...logs.rows.map((l) => l.actor_clerk_id ?? ""),
    ...txRows.map((t) => String(t.created_by_clerk_id ?? "")),
  ]);

  // ── Filter + paginate transactions (server-side) ─────────────────────────
  let filteredTxRows = txRows;
  if (txTypeFilter !== "all") {
    filteredTxRows = filteredTxRows.filter((t) =>
      t.type === txTypeFilter || (txTypeFilter === "sale" && t.type === "cash_sale"),
    );
  }
  if (txCurrencyFilter !== "all") {
    filteredTxRows = filteredTxRows.filter((t) => {
      const movements = movementsByTx.get(t.id as number) ?? [];
      if (movements.length > 0) return movements.some((m) => m.currency === txCurrencyFilter);
      return t.currency === txCurrencyFilter;
    });
  }
  if (txQFilter) {
    filteredTxRows = filteredTxRows.filter((t) => {
      const enteredByName = nameMap.get(String(t.created_by_clerk_id ?? "")) ?? "";
      return [String(t.description ?? ""), String(t.reference_id ?? ""), enteredByName, String(t.type ?? "")]
        .some((f) => f.toLowerCase().includes(txQFilter));
    });
  }
  const txAllTotal = txRows.length;
  const txTotal = filteredTxRows.length;
  const txPages = Math.max(1, Math.ceil(txTotal / txPageSize));
  const paginatedTxRows = filteredTxRows.slice((txPage - 1) * txPageSize, txPage * txPageSize);
  const paginatedTxIds = new Set(paginatedTxRows.map((t) => t.id as number));

  // ── Partition activity log into session-scoped and transaction-scoped ─────
  const sessionActivityLogs: typeof logs.rows = [];
  const transactionEventsMap = new Map<number, typeof logs.rows>();

  for (const log of logs.rows) {
    if (SESSION_SCOPE_ACTIONS.has(log.action)) {
      sessionActivityLogs.push(log);
    } else {
      // Extract the transactionId from the detail JSON (transaction-scoped events).
      let txId: number | null = null;
      try {
        const detail = JSON.parse(log.detail ?? "{}") as Record<string, unknown>;
        const rawId = detail.transactionId ?? detail.originalId ?? null;
        if (rawId != null) txId = Number(rawId);
      } catch { /* ignore */ }
      if (txId && Number.isFinite(txId) && paginatedTxIds.has(txId)) {
        if (!transactionEventsMap.has(txId)) transactionEventsMap.set(txId, []);
        transactionEventsMap.get(txId)!.push(log);
      }
      // transaction_reversed also associates with the reversal target.
      if (log.action === "transaction_reversed" && log.detail) {
        try {
          const detail = JSON.parse(log.detail) as Record<string, unknown>;
          const reversalId = Number(detail.reversalId ?? 0);
          if (reversalId && Number.isFinite(reversalId) && paginatedTxIds.has(reversalId)) {
            if (!transactionEventsMap.has(reversalId)) transactionEventsMap.set(reversalId, []);
            transactionEventsMap.get(reversalId)!.push(log);
          }
        } catch { /* ignore */ }
      }
    }
  }

  // ── Active outgoing transfers (IN_TRANSIT or DISPUTED) for this source session ─
  const activeTransfersResult = await db.query<{
    id: number;
    transfer_number: string;
    status: string;
    currency_code: string;
    sent_amount: string;
    destination_location_name: string | null;
    destination_drawer_name: string | null;
  }>(
    `SELECT ct.id,
            ct.transfer_number,
            ct.status,
            ct.currency_code,
            ct.sent_amount,
            dl.name AS destination_location_name,
            dd.name AS destination_drawer_name
       FROM cash_transfers ct
       LEFT JOIN cash_drawers dd ON dd.id = ct.destination_drawer_id
       LEFT JOIN locations    dl ON dl.id = ct.destination_location_id
      WHERE ct.source_session_id = $1
        AND ct.workspace_owner_id = $2
        AND ct.status IN ('IN_TRANSIT', 'DISPUTED')
      ORDER BY ct.created_at DESC`,
    [id, wreq.workspaceOwnerId],
  );
  const activeTransfers = activeTransfersResult.rows.map((t) => ({
    id: t.id,
    transfer_number: t.transfer_number,
    status: t.status,
    currency: t.currency_code,
    amount: t.sent_amount,
    destination_location_name: t.destination_location_name,
    destination_drawer_name: t.destination_drawer_name,
  }));

  const currencies = sessionCurrencies(session.currency, session.secondary_currency);

  // Build movement-aware effective transaction list for the Live Cash Summary so
  // per-currency buckets reflect physical cash movements, not just header amounts.
  const txIdsWithMovements = new Set(movementsResult.rows.map((m) => m.cash_transaction_id));
  const txTypeMap = new Map<number, string>();
  const txRefTypeMap = new Map<number, string | null>();
  const txApprovalMap = new Map<number, string | null>();
  for (const tx of txRows) {
    const txId = tx.id as number;
    if (txIdsWithMovements.has(txId)) {
      txTypeMap.set(txId, String(tx.type ?? "sale"));
      txRefTypeMap.set(txId, (tx.reference_type as string | null) ?? null);
      txApprovalMap.set(txId, (tx.approval_status as string | null) ?? null);
    }
  }
  const effectiveTxns: Array<{ currency: string; type: string; direction: string; amount: string; reference_type?: string | null; approval_status?: string | null }> = [];
  for (const tx of txRows) {
    if (!txIdsWithMovements.has(tx.id as number)) {
      effectiveTxns.push(tx as { currency: string; type: string; direction: string; amount: string; reference_type?: string | null; approval_status?: string | null });
    }
  }
  for (const m of movementsResult.rows) {
    const type = txTypeMap.get(m.cash_transaction_id) ?? "sale";
    const reference_type = txRefTypeMap.get(m.cash_transaction_id) ?? null;
    effectiveTxns.push({
      currency: m.currency,
      type,
      direction: m.direction === "inflow" ? "in" : "out",
      amount: m.amount,
      reference_type,
      // Carry the parent transaction's approval status so pending/declined
      // salary expenses never move the live summary via their movement rows.
      approval_status: txApprovalMap.get(m.cash_transaction_id) ?? null,
    });
  }

  const summary = computeSessionCurrencySummary(session, currencies, effectiveTxns);

  // Build exchange_rates map: for each non-doc currency, fetch the display rate
  // (foreign units per 1 doc unit) so the client can show "1 USD = X LBP" labels.
  const docCurrency = session.currency;
  const exchangeRatesForSession: Record<string, number> = {};
  for (const cur of currencies) {
    if (cur === docCurrency) continue;
    const stored = await getStoredRate(docCurrency, cur, wreq.workspaceOwnerId);
    if (stored) {
      // stored.rate = target per 1 base = foreign per 1 doc → display rate
      exchangeRatesForSession[cur] = stored.rate;
    }
  }

  // Enrich closing_counts with a computed `result` field.
  type RawClosingCount = { currency: string; expected: number; actual: number | null; variance: number; explanation?: string | null };
  const rawCounts = (session.closing_counts as RawClosingCount[] | null) ?? [];
  const enrichedCounts = rawCounts.map((c) => ({
    ...c,
    result: c.actual === null
      ? "awaiting_count"
      : c.variance === 0
        ? "balanced"
        : c.variance < 0
          ? "shortage"
          : "overage",
  }));

  const pendingSalaryCount = txRows.filter((t) => t.approval_status === "pending").length;
  // Only resolve approver names when something is actually pending — keeps the
  // common path free of extra queries.
  const salaryApproverNames =
    pendingSalaryCount > 0 ? await findSalaryApproverNames(wreq.workspaceOwnerId) : [];

  res.json({
    session: {
      ...session,
      closing_counts: enrichedCounts.length > 0 ? enrichedCounts : (session.closing_counts ?? null),
      opened_by_name: nameMap.get(session.opened_by_clerk_id ?? "") ?? null,
      closed_by_name: nameMap.get(session.closed_by_clerk_id ?? "") ?? null,
      approved_by_name: nameMap.get(session.approved_by_clerk_id ?? "") ?? null,
    },
    currencies,
    exchange_rates: exchangeRatesForSession,
    currency_summary: summary,
    thresholds: currencies.map((cur) => ({
      currency: cur,
      receipt_required_above: receiptRequiredThreshold(cur),
      variance_approval_above: varianceApprovalThreshold(cur),
    })),
    active_transfers: activeTransfers,
    open_conflict: otherOpen.rows[0] ?? null,
    transactions: paginatedTxRows.map((t) => ({
      ...t,
      entered_by_name: nameMap.get(String(t.created_by_clerk_id ?? "")) ?? null,
      movements: movementsByTx.get(t.id as number) ?? [],
      requested_by_me: t.requested_by_clerk_id != null && t.requested_by_clerk_id === authed(req).userId,
    })),
    pending_salary_approvals: pendingSalaryCount,
    salary_approver_names: salaryApproverNames,
    tx_total: txTotal,
    tx_all_total: txAllTotal,
    tx_page: txPage,
    tx_pages: txPages,
    // Kept for backward-compat (full log, both session- and transaction-scoped).
    activity: logs.rows.map((l) => ({
      ...l,
      actor_name: l.actor_name ?? nameMap.get(l.actor_clerk_id ?? "") ?? null,
    })),
    // Session-lifecycle events only (no per-transaction noise).
    session_activity: sessionActivityLogs.map((l) => ({
      ...l,
      actor_name: l.actor_name ?? nameMap.get(l.actor_clerk_id ?? "") ?? null,
    })),
    // Per-transaction audit events for the current page, keyed by transaction id.
    transaction_events: Object.fromEntries(
      [...transactionEventsMap.entries()].map(([txId, events]) => [
        String(txId),
        events.map((l) => ({
          ...l,
          actor_name: l.actor_name ?? nameMap.get(l.actor_clerk_id ?? "") ?? null,
        })),
      ]),
    ),
  });
});

/**
 * POST /api/cash-sessions
 * Open a new cash session on a drawer.
 * Supports X-Idempotency-Key header to prevent double-submission.
 */
router.post("/cash-sessions", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionActionPermission(wreq, "open")) {
    res.status(403).json({ error: "Insufficient permissions to open cash sessions" });
    return;
  }

  // Idempotency: if the same key was used for a successful create within the TTL,
  // return the cached response without re-inserting.
  const idempotencyKey = req.headers["x-idempotency-key"];
  if (typeof idempotencyKey === "string" && idempotencyKey.trim()) {
    const cacheKey = `${wreq.workspaceOwnerId}:${idempotencyKey.trim()}`;
    const cached = idempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.status(201).json(cached.body);
      return;
    }
  }

  const { drawer_id, opening_cash, opening_note } = req.body ?? {};
  const drawerId = Number(drawer_id);
  if (!Number.isFinite(drawerId) || drawerId <= 0) {
    res.status(400).json({ error: "drawer_id is required" });
    return;
  }
  const openingCash = Number(opening_cash);
  if (!Number.isFinite(openingCash) || openingCash < 0) {
    res.status(400).json({ error: "opening_cash must be a non-negative number" });
    return;
  }

  const drawerResult = await db.query<{
    id: number;
    name: string;
    code: string;
    location_id: number | null;
    currency: string;
    secondary_currency: string | null;
    is_active: boolean;
    location_name: string | null;
  }>(
    `SELECT d.id, d.name, d.code, d.location_id, d.currency, d.secondary_currency, d.is_active, l.name AS location_name
       FROM cash_drawers d
       LEFT JOIN locations l ON l.id = d.location_id
      WHERE d.id = $1 AND d.workspace_owner_id = $2`,
    [drawerId, wreq.workspaceOwnerId],
  );
  if (drawerResult.rowCount === 0) {
    res.status(404).json({ error: "Cash drawer not found" });
    return;
  }
  const drawer = drawerResult.rows[0];
  if (!drawer.is_active) {
    res.status(400).json({ error: "Cannot open a session on an inactive drawer" });
    return;
  }

  // CMC Beirut Hospital sessions must be opened through the CMC POS Start Shift
  // flow, which creates the session together with a CMC shift. The generic
  // cash-sessions page must not be used for CMC drawers.
  if (isCmcLocation(drawer.location_name)) {
    res.status(422).json({
      error:
        "Cash sessions for CMC Beirut Hospital must be opened through the CMC POS Start Shift flow.",
    });
    return;
  }

  // Resolve the session currency setup. Single-currency drawers always use the
  // main currency. When the drawer has a second currency, the session tracks
  // BOTH currencies and requires an opening amount for each. A legacy payload
  // that explicitly picks one currency still opens a single-currency session.
  let sessionCurrency = drawer.currency;
  let sessionSecondaryCurrency: string | null = null;
  let openingCashSecondary: number | null = null;
  if (drawer.secondary_currency) {
    const requested = String(req.body?.currency ?? "").trim().toUpperCase();
    if (requested) {
      // Legacy single-currency open on a dual drawer.
      if (requested !== drawer.currency && requested !== drawer.secondary_currency) {
        res.status(400).json({ error: "currency must be one of the drawer's currencies" });
        return;
      }
      sessionCurrency = requested;
    } else {
      // Dual-currency session: both opening amounts are required.
      const secondaryRaw = req.body?.opening_cash_secondary;
      const secondary = Number(secondaryRaw);
      if (secondaryRaw == null || !Number.isFinite(secondary) || secondary < 0) {
        res.status(400).json({
          error: `opening_cash_secondary (${drawer.secondary_currency}) must be a non-negative number`,
        });
        return;
      }
      sessionSecondaryCurrency = drawer.secondary_currency;
      openingCashSecondary = secondary;
    }
  }

  const openExisting = await db.query<{
    id: number;
    opened_by_clerk_id: string | null;
    opened_at: string;
  }>(
    `SELECT id, opened_by_clerk_id, opened_at
       FROM cash_sessions
      WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open'
      LIMIT 1`,
    [drawerId, wreq.workspaceOwnerId],
  );
  if (openExisting.rowCount && openExisting.rowCount > 0) {
    const existing = openExisting.rows[0];
    let operatorName: string | null = null;
    if (existing.opened_by_clerk_id) {
      try {
        const users = await clerkClient.users.getUserList({
          userId: [existing.opened_by_clerk_id],
          limit: 1,
        });
        const u = users.data[0];
        if (u) {
          operatorName =
            [u.firstName, u.lastName].filter(Boolean).join(" ") ||
            u.primaryEmailAddress?.emailAddress ||
            null;
        }
      } catch {
        // Non-fatal — still return 409 without name
      }
    }
    const openedAt = new Date(existing.opened_at).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const who = operatorName ? `${operatorName}` : "Another operator";
    res.status(409).json({
      error: `${who} opened this drawer at ${openedAt}. Close that session first.`,
      opened_by_name: operatorName,
      opened_at: existing.opened_at,
    });
    return;
  }

  const userId = authed(req).userId;
  const year = new Date().getFullYear();
  const sessionNumber = await generateSessionNumber(
    wreq.workspaceOwnerId,
    drawerId,
    drawer.code,
    drawer.location_name ?? "LOC",
    year,
  );

  let session: CashSessionRow;
  try {
    const result = await db.query<CashSessionRow>(
      `INSERT INTO cash_sessions
         (workspace_owner_id, session_number, drawer_id, location_id, currency, status,
          opening_cash, expected_cash, opening_note, opened_by_member_id, opened_by_clerk_id,
          secondary_currency, opening_cash_secondary, expected_cash_secondary,
          cash_in_total_secondary, cash_out_total_secondary, adjustments_total_secondary)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $6, $7, $8, $9, $10, $11, $11,
               CASE WHEN $10::text IS NULL THEN NULL ELSE 0 END,
               CASE WHEN $10::text IS NULL THEN NULL ELSE 0 END,
               CASE WHEN $10::text IS NULL THEN NULL ELSE 0 END)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        sessionNumber,
        drawerId,
        drawer.location_id,
        sessionCurrency,
        openingCash.toFixed(2),
        opening_note ? String(opening_note).trim() || null : null,
        wreq.memberDbId,
        userId,
        sessionSecondaryCurrency,
        openingCashSecondary != null ? openingCashSecondary.toFixed(2) : null,
      ],
    );
    session = result.rows[0];
  } catch (insertErr: unknown) {
    // Unique violation on idx_cash_sessions_one_open_per_drawer — a concurrent
    // request opened this drawer between our SELECT check and the INSERT.
    if ((insertErr as { code?: string }).code === "23505") {
      const raceRow = await db.query<{
        opened_by_clerk_id: string | null;
        opened_at: string;
      }>(
        `SELECT opened_by_clerk_id, opened_at
           FROM cash_sessions
          WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open'
          LIMIT 1`,
        [drawerId, wreq.workspaceOwnerId],
      );
      const raceSession = raceRow.rows[0];
      let raceName: string | null = null;
      if (raceSession?.opened_by_clerk_id) {
        try {
          const users = await clerkClient.users.getUserList({
            userId: [raceSession.opened_by_clerk_id],
            limit: 1,
          });
          const u = users.data[0];
          if (u) {
            raceName =
              [u.firstName, u.lastName].filter(Boolean).join(" ") ||
              u.primaryEmailAddress?.emailAddress ||
              null;
          }
        } catch {
          // Non-fatal
        }
      }
      const openedAt = raceSession
        ? new Date(raceSession.opened_at).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "unknown time";
      const who = raceName ?? "Another operator";
      res.status(409).json({
        error: `${who} opened this drawer at ${openedAt}. Close that session first.`,
        opened_by_name: raceName,
        opened_at: raceSession?.opened_at ?? null,
      });
      return;
    }
    throw insertErr;
  }

  await logSessionActivity(
    wreq.workspaceOwnerId,
    session.id,
    "opened",
    userId,
    null,
    JSON.stringify({
      opening_cash: openingCash.toFixed(2),
      ...(sessionSecondaryCurrency
        ? {
            secondary_currency: sessionSecondaryCurrency,
            opening_cash_secondary: (openingCashSecondary ?? 0).toFixed(2),
          }
        : {}),
    }),
  );

  const responseBody = { session };

  // Store idempotency result so duplicate submissions within TTL return the same session.
  if (typeof idempotencyKey === "string" && idempotencyKey.trim()) {
    const cacheKey = `${wreq.workspaceOwnerId}:${idempotencyKey.trim()}`;
    idempotencyCache.set(cacheKey, {
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      body: responseBody,
    });
  }

  res.status(201).json(responseBody);
});

async function loadSession(
  id: number,
  workspaceOwnerId: string,
): Promise<CashSessionRow | null> {
  const r = await db.query<CashSessionRow>(
    `SELECT * FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [id, workspaceOwnerId],
  );
  return r.rows[0] ?? null;
}

/**
 * POST /api/cash-sessions/:id/close
 * Close an open session: enter counted cash, compute difference.
 */
router.post("/cash-sessions/:id/close", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionActionPermission(wreq, "close")) {
    res.status(403).json({ error: "Insufficient permissions to close cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Only an open session can be closed" });
    return;
  }

  // Pending salary expense approvals block the close until resolved.
  const pendingApprovals = await countPendingSalaryApprovals(id, wreq.workspaceOwnerId);
  if (pendingApprovals > 0) {
    res.status(409).json({
      error: `This session has ${pendingApprovals} pending salary expense approval${pendingApprovals === 1 ? "" : "s"} — they must be approved, declined, or cancelled before closing`,
      pending_salary_approvals: pendingApprovals,
    });
    return;
  }

  // Make sure totals reflect all linked transactions before reconciling.
  await recomputeSessionTotals(id, wreq.workspaceOwnerId);

  // Resolve every currency captured by the session snapshot and its live summary.
  const currencies = sessionCurrencies(session.currency, session.secondary_currency);
  const txns = await db.query<{
    currency: string;
    type: string;
    direction: string;
    amount: string;
    reference_type: string | null;
    approval_status: string | null;
  }>(
    `SELECT currency, type, direction, amount, reference_type, approval_status
       FROM cash_transactions
      WHERE cash_session_id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const summary = computeSessionCurrencySummary(session, currencies, txns.rows);

  // Accept the new per-currency `counts` body; keep the legacy single
  // `actual_cash` body working for single-currency sessions.
  const body = req.body ?? {};
  let inputs: ClosingCountInput[];
  if (Array.isArray(body.counts)) {
    inputs = body.counts.map((c: Record<string, unknown>) => ({
      currency: String(c?.currency ?? ""),
      actual: Number(c?.actual_cash ?? c?.actual),
      explanation: c?.explanation != null ? String(c.explanation) : null,
    }));
  } else {
    const actualCash = Number(body.actual_cash);
    if (!Number.isFinite(actualCash) || actualCash < 0) {
      res.status(400).json({ error: "actual_cash must be a non-negative number" });
      return;
    }
    // Legacy dual-currency body: actual_cash + actual_cash_secondary.
    if (session.secondary_currency != null && body.actual_cash_secondary != null) {
      const sec = Number(body.actual_cash_secondary);
      if (!Number.isFinite(sec) || sec < 0) {
        res.status(400).json({
          error: `actual_cash_secondary (${session.secondary_currency}) must be a non-negative number`,
        });
        return;
      }
      inputs = [
        {
          currency: session.currency,
          actual: actualCash,
          explanation: body.closing_note != null ? String(body.closing_note) : null,
        },
        {
          currency: session.secondary_currency,
          actual: sec,
          explanation: body.closing_note != null ? String(body.closing_note) : null,
        },
      ];
    } else {
      if (summary.length > 1) {
        res.status(400).json({ error: "This session tracks multiple currencies; counts per currency are required" });
        return;
      }
      inputs = [
        {
          currency: summary[0]?.currency ?? session.currency,
          actual: actualCash,
          explanation: body.closing_note != null ? String(body.closing_note) : null,
        },
      ];
    }
  }

  const validated = validateClosingCounts(summary, inputs);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  if (validated.requiresApproval && !hasPermission(wreq, "cash_sessions.approve")) {
    res.status(403).json({
      error: "A variance above the approval threshold requires supervisor approval to close this session",
      requires_approval: true,
    });
    return;
  }

  // Legacy columns keep tracking the session's own currency; when the session
  // has a secondary currency, its count also feeds the *_secondary columns.
  const primary =
    validated.counts.find((c) => c.currency === (session.currency ?? "").toUpperCase()) ??
    validated.counts[0];
  const secondaryCount = session.secondary_currency
    ? (validated.counts.find(
        (c) => c.currency === (session.secondary_currency ?? "").toUpperCase(),
      ) ?? null)
    : null;
  const userId = authed(req).userId;

  const result = await db.query<CashSessionRow>(
    `UPDATE cash_sessions
        SET status = 'pending_review',
            actual_cash = $3,
            expected_cash = $4,
            difference = $5,
            actual_cash_secondary = $6,
            expected_cash_secondary = COALESCE($7, expected_cash_secondary),
            difference_secondary = $8,
            closing_note = $9,
            closing_counts = $10,
            closed_by_clerk_id = $11,
            closed_at = now(),
            updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING *`,
    [
      id,
      wreq.workspaceOwnerId,
      primary.actual.toFixed(2),
      primary.expected.toFixed(2),
      primary.variance.toFixed(2),
      secondaryCount != null ? secondaryCount.actual.toFixed(2) : null,
      secondaryCount != null ? secondaryCount.expected.toFixed(2) : null,
      secondaryCount != null ? secondaryCount.variance.toFixed(2) : null,
      body.closing_note ? String(body.closing_note).trim() || null : null,
      JSON.stringify(validated.counts),
      userId,
    ],
  );

  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "closed",
    userId,
    null,
    JSON.stringify({ counts: validated.counts, requires_approval: validated.requiresApproval }),
  );

  res.json({ session: result.rows[0], counts: validated.counts });
});

// ---------------------------------------------------------------------------
// Guided Reconcile & Close
// ---------------------------------------------------------------------------

type Queryable = Pick<typeof db, "query">;

/** Current transaction snapshot for stale-data detection. */
async function loadTxStats(
  q: Queryable,
  sessionId: number,
  workspaceOwnerId: string,
): Promise<{ txCount: number; lastTxId: number | null }> {
  const r = await q.query<{ tx_count: string; last_tx_id: number | null }>(
    `SELECT COUNT(*)::text AS tx_count, MAX(id) AS last_tx_id
       FROM cash_transactions
      WHERE cash_session_id = $1 AND workspace_owner_id = $2`,
    [sessionId, workspaceOwnerId],
  );
  return {
    txCount: parseInt(r.rows[0]?.tx_count ?? "0", 10) || 0,
    lastTxId: r.rows[0]?.last_tx_id != null ? Number(r.rows[0].last_tx_id) : null,
  };
}

/** Live per-currency summary for a session (currencies + expected cash). */
async function loadSessionSummary(
  q: Queryable,
  session: CashSessionRow,
  workspaceOwnerId: string,
) {
  const currencies = sessionCurrencies(session.currency, session.secondary_currency);
  const [txnsResult, movementsResult] = await Promise.all([
    q.query<{
      id: number;
      currency: string;
      type: string;
      direction: string;
      amount: string;
      reference_type: string | null;
      approval_status?: string | null;
    }>(
      `SELECT id, currency, type, direction, amount, reference_type, approval_status
         FROM cash_transactions
        WHERE cash_session_id = $1 AND workspace_owner_id = $2`,
      [session.id, workspaceOwnerId],
    ),
    q.query<{
      cash_transaction_id: number;
      direction: string;
      currency: string;
      amount: string;
    }>(
      `SELECT m.cash_transaction_id, m.direction, m.currency, m.amount
         FROM cash_transaction_movements m
         JOIN cash_transactions ct ON ct.id = m.cash_transaction_id
        WHERE ct.cash_session_id = $1 AND ct.workspace_owner_id = $2`,
      [session.id, workspaceOwnerId],
    ),
  ]);

  // Build a movement-aware effective transaction list so per-currency summaries
  // reflect physical cash in the drawer, not just the document currency.
  const txIdsWithMovements = new Set(movementsResult.rows.map((m) => m.cash_transaction_id));
  const txTypeMap = new Map<number, string>();
  const txRefTypeMap = new Map<number, string | null>();
  const txApprovalMap = new Map<number, string | null>();
  for (const tx of txnsResult.rows) {
    if (txIdsWithMovements.has(tx.id)) {
      txTypeMap.set(tx.id, tx.type);
      txRefTypeMap.set(tx.id, tx.reference_type);
      txApprovalMap.set(tx.id, (tx as { approval_status?: string | null }).approval_status ?? null);
    }
  }

  const effectiveTxns: Array<{ currency: string; type: string; direction: string; amount: string; reference_type?: string | null; approval_status?: string | null }> = [];

  // Legacy transactions without movement rows — use parent row as-is.
  for (const tx of txnsResult.rows) {
    if (!txIdsWithMovements.has(tx.id)) {
      effectiveTxns.push(tx);
    }
  }
  // Multi-currency transactions — replace parent row with movement rows.
  for (const m of movementsResult.rows) {
    const type = txTypeMap.get(m.cash_transaction_id) ?? "sale";
    const reference_type = txRefTypeMap.get(m.cash_transaction_id) ?? null;
    effectiveTxns.push({
      currency: m.currency,
      type,
      direction: m.direction === "inflow" ? "in" : "out",
      amount: m.amount,
      reference_type,
      // Parent approval status: pending/declined salary expenses stay out of totals.
      approval_status: txApprovalMap.get(m.cash_transaction_id) ?? null,
    });
  }

  return computeSessionCurrencySummary(session, currencies, effectiveTxns);
}

function parseReconciliation(session: CashSessionRow): ReconciliationState | null {
  const raw = (session as unknown as { reconciliation?: unknown }).reconciliation;
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ReconciliationState;
    } catch {
      return null;
    }
  }
  return raw as ReconciliationState;
}

async function saveReconciliation(
  q: Queryable,
  sessionId: number,
  workspaceOwnerId: string,
  rec: ReconciliationState,
): Promise<void> {
  await q.query(
    `UPDATE cash_sessions SET reconciliation = $3, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, workspaceOwnerId, JSON.stringify(rec)],
  );
}

/**
 * POST /api/cash-sessions/:id/reconciliation/counts
 * Step 1 → 2: submit blind per-currency counts. Snapshots the transaction
 * state for stale detection and computes variances + approval requirements.
 */
router.post("/cash-sessions/:id/reconciliation/counts", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionActionPermission(wreq, "close")) {
    res.status(403).json({ error: "Insufficient permissions to reconcile cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Only an open session can be reconciled" });
    return;
  }

  await recomputeSessionTotals(id, wreq.workspaceOwnerId);
  const refreshed = (await loadSession(id, wreq.workspaceOwnerId)) ?? session;
  const summary = await loadSessionSummary(db, refreshed, wreq.workspaceOwnerId);
  if (summary.length === 0) {
    res.status(400).json({ error: "This session has no configured currency to reconcile" });
    return;
  }

  const body = req.body ?? {};
  const rawCounts = Array.isArray(body.counts) ? body.counts : [];
  const inputs: ClosingCountInput[] = rawCounts.map((c: Record<string, unknown>) => ({
    currency: String(c?.currency ?? ""),
    actual: Number(c?.actual),
    explanation: c?.explanation != null ? String(c.explanation) : null,
  }));

  const built = buildReconciliationCounts(summary, inputs);
  if (!built.ok) {
    res.status(400).json({ error: built.error });
    return;
  }

  const userId = authed(req).userId;
  const { txCount, lastTxId } = await loadTxStats(db, id, wreq.workspaceOwnerId);
  const existing = parseReconciliation(refreshed);
  const nowIso = new Date().toISOString();
  const rec: ReconciliationState = {
    started_at: existing?.started_at ?? nowIso,
    started_by_clerk_id: existing?.started_by_clerk_id ?? userId,
    counted_at: nowIso,
    counted_by_clerk_id: userId,
    tx_count: txCount,
    last_tx_id: lastTxId,
    counts: built.counts,
  };
  await saveReconciliation(db, id, wreq.workspaceOwnerId, rec);

  if (!existing) {
    await logSessionActivity(wreq.workspaceOwnerId, id, "reconciliation_started", userId, null, null);
  }
  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "reconciliation_counts_submitted",
    userId,
    null,
    JSON.stringify({
      counts: built.counts.map((c) => ({
        currency: c.currency,
        expected: c.expected,
        actual: c.actual,
        variance: c.variance,
      })),
      tx_count: txCount,
    }),
  );
  for (const count of built.counts) {
    if (count.requires_approval) {
      await logSessionActivity(
        wreq.workspaceOwnerId,
        id,
        "reconciliation_approval_requested",
        userId,
        null,
        JSON.stringify({
          currency: count.currency,
          expected: count.expected,
          actual: count.actual,
          variance: count.variance,
          threshold: varianceApprovalThreshold(count.currency),
        }),
      );
    }
  }

  res.json({ reconciliation: rec });
});

/**
 * POST /api/cash-sessions/:id/reconciliation/recount
 * Back to Step 1: clears the submitted counts (client keeps entered values).
 */
router.post("/cash-sessions/:id/reconciliation/recount", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionActionPermission(wreq, "close")) {
    res.status(403).json({ error: "Insufficient permissions to reconcile cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Only an open session can be reconciled" });
    return;
  }
  const existing = parseReconciliation(session);
  if (!existing) {
    res.status(400).json({ error: "No reconciliation in progress" });
    return;
  }

  const userId = authed(req).userId;
  const rec: ReconciliationState = {
    ...existing,
    counted_at: null,
    counted_by_clerk_id: null,
    counts: [],
  };
  await saveReconciliation(db, id, wreq.workspaceOwnerId, rec);
  await logSessionActivity(wreq.workspaceOwnerId, id, "reconciliation_recount_initiated", userId, null, null);
  res.json({ reconciliation: rec });
});

/**
 * POST /api/cash-sessions/:id/reconciliation/explanation
 * Step 2: record/update the variance explanation for one currency.
 */
router.post("/cash-sessions/:id/reconciliation/explanation", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionActionPermission(wreq, "close")) {
    res.status(403).json({ error: "Insufficient permissions to reconcile cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Only an open session can be reconciled" });
    return;
  }
  const existing = parseReconciliation(session);
  if (!existing || existing.counts.length === 0) {
    res.status(400).json({ error: "Submit counts before adding explanations" });
    return;
  }

  const body = req.body ?? {};
  const currency = String(body.currency ?? "").trim().toUpperCase();
  const explanation = String(body.explanation ?? "").trim();
  const count = existing.counts.find((c) => c.currency === currency);
  if (!count) {
    res.status(400).json({ error: `No count for currency ${currency || "(missing)"}` });
    return;
  }
  if (!explanation) {
    res.status(400).json({ error: "explanation is required" });
    return;
  }

  count.explanation = explanation;
  const userId = authed(req).userId;
  await saveReconciliation(db, id, wreq.workspaceOwnerId, existing);
  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "reconciliation_explanation_added",
    userId,
    null,
    JSON.stringify({ currency, explanation }),
  );
  res.json({ reconciliation: existing });
});

/**
 * POST /api/cash-sessions/:id/reconciliation/approval
 * Step 2: supervisor decision on an above-threshold variance.
 * Requires the approve permission; self-approval is blocked.
 */
router.post("/cash-sessions/:id/reconciliation/approval", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.approve")) {
    res.status(403).json({ error: "Insufficient permissions to approve cash variances" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Only an open session can be reconciled" });
    return;
  }
  const existing = parseReconciliation(session);
  if (!existing || existing.counts.length === 0) {
    res.status(400).json({ error: "No submitted counts to approve" });
    return;
  }

  const userId = authed(req).userId;
  if (existing.counted_by_clerk_id && existing.counted_by_clerk_id === userId) {
    res.status(403).json({ error: "You cannot approve your own variance count" });
    return;
  }

  const body = req.body ?? {};
  const currency = String(body.currency ?? "").trim().toUpperCase();
  const decision = String(body.decision ?? "");
  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    return;
  }
  const count = existing.counts.find((c) => c.currency === currency);
  if (!count) {
    res.status(400).json({ error: `No count for currency ${currency || "(missing)"}` });
    return;
  }
  if (!count.requires_approval || !count.approval) {
    res.status(400).json({ error: `The ${currency} variance does not require approval` });
    return;
  }

  count.approval = {
    ...count.approval,
    status: decision,
    decided_by_clerk_id: userId,
    decided_at: new Date().toISOString(),
    note: String(body.note ?? "").trim() || null,
  };
  await saveReconciliation(db, id, wreq.workspaceOwnerId, existing);
  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    decision === "approved" ? "reconciliation_approval_approved" : "reconciliation_approval_rejected",
    userId,
    null,
    JSON.stringify({
      currency,
      variance: count.variance,
      decision,
      note: count.approval.note,
    }),
  );
  res.json({ reconciliation: existing });
});

/** Format an amount for the text report — LBP has no decimals. */
function reportAmount(currency: string, value: number): string {
  const digits = currency.toUpperCase() === "LBP" ? 0 : 2;
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${currency}`;
}

/**
 * GET /api/cash-sessions/:id/reconciliation/report
 * Downloadable plain-text reconciliation report. Works as a preview while the
 * session is open (Step 3) and as the final report once closed. Downloads are
 * recorded in the session activity log.
 */
router.get("/cash-sessions/:id/reconciliation/report", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions to view cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const result = await db.query<
    CashSessionRow & {
      drawer_name: string | null;
      drawer_code: string | null;
      location_name: string | null;
      closing_counts: unknown;
      reconciliation: unknown;
    }
  >(
    `SELECT cs.*, d.name AS drawer_name, d.code AS drawer_code, l.name AS location_name
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
      WHERE cs.id = $1 AND cs.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  const session = result.rows[0];
  const rec = parseReconciliation(session);

  // Counts: prefer the guided reconciliation; fall back to legacy closing_counts.
  let counts: ReconciliationCount[] = rec?.counts ?? [];
  if (counts.length === 0 && session.closing_counts) {
    let legacy: unknown = session.closing_counts;
    if (typeof legacy === "string") {
      try {
        legacy = JSON.parse(legacy);
      } catch {
        legacy = [];
      }
    }
    counts = (Array.isArray(legacy) ? (legacy as Array<Record<string, unknown>>) : []).map(
      (c) => ({
        currency: String(c.currency ?? ""),
        expected: Number(c.expected) || 0,
        actual: Number(c.actual) || 0,
        variance: Number(c.variance) || 0,
        explanation: c.explanation != null ? String(c.explanation) : null,
        requires_approval: false,
        approval: null,
      }),
    );
  }
  if (counts.length === 0) {
    res.status(400).json({ error: "No reconciliation counts to report yet" });
    return;
  }

  const { txCount } = await loadTxStats(db, id, wreq.workspaceOwnerId);
  const nameMap = await fetchClerkNames([
    session.opened_by_clerk_id ?? "",
    session.closed_by_clerk_id ?? "",
    rec?.counted_by_clerk_id ?? "",
    ...counts.map((c) => c.approval?.decided_by_clerk_id ?? ""),
  ]);
  const nameOf = (clerkId: string | null | undefined): string =>
    (clerkId ? nameMap.get(clerkId) : null) ?? clerkId ?? "—";

  const isPreview = session.status === "open";
  const lines: string[] = [];
  lines.push("CASH SESSION RECONCILIATION REPORT" + (isPreview ? " (PREVIEW)" : ""));
  lines.push("=".repeat(60));
  lines.push(`Session:        ${session.session_number}`);
  lines.push(
    `Drawer:         ${session.drawer_name ?? "—"}${session.drawer_code ? ` (${session.drawer_code})` : ""}`,
  );
  lines.push(`Location:       ${session.location_name ?? "—"}`);
  lines.push(`Status:         ${session.status}`);
  lines.push(`Opened by:      ${nameOf(session.opened_by_clerk_id)} at ${session.opened_at}`);
  if (session.closed_at) {
    lines.push(`Closed by:      ${nameOf(session.closed_by_clerk_id)} at ${session.closed_at}`);
  }
  if (rec?.counted_at) {
    lines.push(`Counted by:     ${nameOf(rec.counted_by_clerk_id)} at ${rec.counted_at}`);
  }
  lines.push(`Transactions:   ${txCount}`);
  lines.push("");
  lines.push("Currencies are counted and reconciled separately — never converted or offset.");
  for (const c of counts) {
    lines.push("");
    lines.push(`--- ${c.currency} ${"-".repeat(Math.max(0, 54 - c.currency.length))}`);
    lines.push(`Expected:       ${reportAmount(c.currency, c.expected)}`);
    lines.push(`Counted:        ${reportAmount(c.currency, c.actual)}`);
    const status = c.variance === 0 ? "Balanced" : c.variance > 0 ? "Over" : "Short";
    lines.push(`Variance:       ${reportAmount(c.currency, c.variance)} (${status})`);
    if (c.explanation) lines.push(`Explanation:    ${c.explanation}`);
    if (c.requires_approval) {
      const a = c.approval;
      lines.push(
        `Approval:       ${a?.status ?? "pending"}${
          a?.decided_by_clerk_id ? ` by ${nameOf(a.decided_by_clerk_id)} at ${a.decided_at}` : ""
        }${a?.note ? ` — ${a.note}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("=".repeat(60));
  lines.push(`Generated at:   ${new Date().toISOString()}`);

  const userId = authed(req).userId;
  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    isPreview ? "reconciliation_report_preview_downloaded" : "reconciliation_report_downloaded",
    userId,
    null,
    null,
  );

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="reconciliation-${session.session_number}${isPreview ? "-preview" : ""}.txt"`,
  );
  res.send(lines.join("\n"));
});

/**
 * POST /api/cash-sessions/:id/reconcile-close
 * Step 3: atomically close the session from its reconciliation state.
 * Runs in a single transaction with a row lock; rejects concurrent closes,
 * stale counts (transactions changed since counting), missing explanations,
 * and missing/rejected approvals.
 */
router.post("/cash-sessions/:id/reconcile-close", async (req, res) => {
  const wreq = workspace(req);
  if (!hasCashSessionActionPermission(wreq, "close")) {
    res.status(403).json({ error: "Insufficient permissions to close cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const body = req.body ?? {};
  if (body.confirmed !== true) {
    res.status(400).json({ error: "confirmed must be true to close the session" });
    return;
  }
  const userId = authed(req).userId;

  const client = await db.connect();
  type CloseOutcome = { status: number; body: Record<string, unknown> };
  let outcome: CloseOutcome;
  try {
    outcome = await withTransaction(client, async (): Promise<CloseOutcome> => {
      const locked = await client.query<CashSessionRow>(
        `SELECT * FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      if (locked.rowCount === 0) {
        return { status: 404, body: { error: "Cash session not found" } };
      }
      const session = locked.rows[0];
      if (session.status !== "open") {
        return {
          status: 409,
          body: {
            error: "This session is no longer open — it may have been closed by someone else",
            already_closed: true,
          },
        };
      }
      const rec = parseReconciliation(session);
      if (!rec || rec.counts.length === 0) {
        return { status: 400, body: { error: "Submit counts before closing the session" } };
      }
      const requiredCurrencies = sessionCurrencies(
        session.currency,
        session.secondary_currency,
      );
      const countedCurrencies = new Set(
        rec.counts.map((count) => String(count.currency ?? "").trim().toUpperCase()),
      );
      const missingCurrency = requiredCurrencies.find(
        (currency) => !countedCurrencies.has(currency),
      );
      if (missingCurrency) {
        return {
          status: 400,
          body: { error: `Missing actual count for ${missingCurrency}` },
        };
      }
      const unexpectedCurrency = [...countedCurrencies].find(
        (currency) => !requiredCurrencies.includes(currency),
      );
      if (unexpectedCurrency) {
        return {
          status: 400,
          body: { error: `Unexpected currency count: ${unexpectedCurrency}` },
        };
      }

      // Pending salary expense approvals block the close until resolved.
      const pendingApprovalRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM cash_transactions
          WHERE cash_session_id = $1 AND workspace_owner_id = $2 AND approval_status = 'pending'`,
        [id, wreq.workspaceOwnerId],
      );
      const pendingApprovalCount = parseInt(pendingApprovalRes.rows[0]?.count ?? "0", 10) || 0;
      if (pendingApprovalCount > 0) {
        return {
          status: 409,
          body: {
            error: `This session has ${pendingApprovalCount} pending salary expense approval${pendingApprovalCount === 1 ? "" : "s"} — they must be approved, declined, or cancelled before closing`,
            pending_salary_approvals: pendingApprovalCount,
          },
        };
      }

      // Stale-data check: transactions must not have changed since counting.
      const { txCount, lastTxId } = await loadTxStats(client, id, wreq.workspaceOwnerId);
      if (isReconciliationStale(rec, txCount, lastTxId)) {
        return {
          status: 409,
          body: {
            error: "Transactions changed after the cash was counted — recount before closing",
            stale: true,
          },
        };
      }

      const blockers = reconciliationCloseBlockers(rec);
      if (blockers.length > 0) {
        return {
          status: 409,
          body: { error: "The reconciliation is not ready to close", blockers },
        };
      }

      const primary =
        rec.counts.find((c) => c.currency === (session.currency ?? "").toUpperCase()) ??
        rec.counts[0];
      const secondaryCount = session.secondary_currency
        ? (rec.counts.find(
            (c) => c.currency === (session.secondary_currency ?? "").toUpperCase(),
          ) ?? null)
        : null;

      // Legacy-shaped closing_counts keep historical session views working.
      const closingCounts = rec.counts.map((c) => ({
        currency: c.currency,
        expected: c.expected,
        actual: c.actual,
        variance: c.variance,
        explanation: c.explanation,
      }));
      const closingNote = body.closing_note ? String(body.closing_note).trim() || null : null;

      const updated = await client.query<CashSessionRow>(
        `UPDATE cash_sessions
            SET status = 'pending_review',
                actual_cash = $3,
                expected_cash = $4,
                difference = $5,
                actual_cash_secondary = $6,
                expected_cash_secondary = COALESCE($7, expected_cash_secondary),
                difference_secondary = $8,
                closing_note = $9,
                closing_counts = $10,
                reconciliation = $11,
                closed_by_clerk_id = $12,
                closed_at = now(),
                updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'
          RETURNING *`,
        [
          id,
          wreq.workspaceOwnerId,
          primary.actual.toFixed(2),
          primary.expected.toFixed(2),
          primary.variance.toFixed(2),
          secondaryCount != null ? secondaryCount.actual.toFixed(2) : null,
          secondaryCount != null ? secondaryCount.expected.toFixed(2) : null,
          secondaryCount != null ? secondaryCount.variance.toFixed(2) : null,
          closingNote,
          JSON.stringify(closingCounts),
          JSON.stringify(rec),
          userId,
        ],
      );
      if (updated.rowCount === 0) {
        return {
          status: 409,
          body: {
            error: "This session is no longer open — it may have been closed by someone else",
            already_closed: true,
          },
        };
      }
      return { status: 200, body: { session: updated.rows[0] } };
    });
  } finally {
    client.release();
  }

  if (outcome.status === 200) {
    const closedSession = (outcome.body as { session: CashSessionRow }).session;
    const rec = parseReconciliation(closedSession);
    await logSessionActivity(
      wreq.workspaceOwnerId,
      id,
      "closed",
      userId,
      null,
      JSON.stringify({
        via: "reconcile",
        counts: rec?.counts.map((c) => ({
          currency: c.currency,
          expected: c.expected,
          actual: c.actual,
          variance: c.variance,
          approval: c.approval?.status ?? null,
        })),
      }),
    );
  }
  res.status(outcome.status).json(outcome.body);
});

/**
 * POST /api/cash-sessions/:id/approve
 * Approve a closed (pending_review) or flagged session.
 */
router.post("/cash-sessions/:id/approve", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.approve")) {
    res.status(403).json({ error: "Insufficient permissions to approve cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "pending_review" && session.status !== "flagged") {
    res.status(409).json({ error: "Only a closed or flagged session can be approved" });
    return;
  }

  const userId = authed(req).userId;
  const result = await db.query<CashSessionRow>(
    `UPDATE cash_sessions
        SET status = 'approved',
            approved_by_clerk_id = $3,
            approved_at = now(),
            updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING *`,
    [id, wreq.workspaceOwnerId, userId],
  );
  await logSessionActivity(wreq.workspaceOwnerId, id, "approved", userId, null, null);
  res.json({ session: result.rows[0] });
});

/**
 * POST /api/cash-sessions/:id/flag
 * Flag a session for review with a reason.
 */
router.post("/cash-sessions/:id/flag", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.flag")) {
    res.status(403).json({ error: "Insufficient permissions to flag cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status === "open") {
    res.status(409).json({ error: "Close the session before flagging it" });
    return;
  }
  const reason = String((req.body ?? {}).flag_reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "flag_reason is required" });
    return;
  }

  const userId = authed(req).userId;
  const result = await db.query<CashSessionRow>(
    `UPDATE cash_sessions
        SET status = 'flagged',
            flag_reason = $3,
            updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING *`,
    [id, wreq.workspaceOwnerId, reason],
  );
  await logSessionActivity(wreq.workspaceOwnerId, id, "flagged", userId, null, JSON.stringify({ flag_reason: reason }));

  // Fetch drawer name for the notification label.
  const drawerResult = await db.query<{ name: string; location_name: string | null }>(
    `SELECT d.name, l.name AS location_name
       FROM cash_drawers d
       LEFT JOIN locations l ON l.id = $2
      WHERE d.id = $3`,
    [id, session.location_id, session.drawer_id],
  ).catch(() => ({ rows: [] as { name: string; location_name: string | null }[] }));

  const drawerName = drawerResult.rows[0]?.name ?? null;
  const locationName = drawerResult.rows[0]?.location_name ?? null;

  broadcastEvent(wreq.workspaceOwnerId, {
    event: "cash_session.flagged",
    workspaceId: wreq.workspaceOwnerId,
    data: {
      id,
      sessionNumber: session.session_number,
      drawerName,
      locationName,
      flagReason: reason,
    },
  });

  void notifyCashSessionFlaggedAlerts(
    wreq.workspaceOwnerId,
    id,
    session.session_number,
    drawerName,
  );

  res.json({ session: result.rows[0] });
});

/**
 * POST /api/cash-sessions/:id/reopen
 * Reopen a closed/flagged/approved session with a reason.
 */
router.post("/cash-sessions/:id/reopen", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.reopen")) {
    res.status(403).json({ error: "Insufficient permissions to reopen cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status === "open") {
    res.status(409).json({ error: "Session is already open" });
    return;
  }

  // Prevent two open sessions on the same drawer.
  const openExisting = await db.query(
    `SELECT id FROM cash_sessions WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open' AND id <> $3`,
    [session.drawer_id, wreq.workspaceOwnerId, id],
  );
  if (openExisting.rowCount && openExisting.rowCount > 0) {
    res.status(409).json({ error: "This drawer already has another open session" });
    return;
  }

  const reason = String((req.body ?? {}).reopen_reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "reopen_reason is required" });
    return;
  }

  const userId = authed(req).userId;
  const result = await db.query<CashSessionRow>(
    `UPDATE cash_sessions
        SET status = 'open',
            reopen_reason = $3,
            actual_cash = NULL,
            difference = NULL,
            actual_cash_secondary = NULL,
            difference_secondary = NULL,
            closed_by_clerk_id = NULL,
            closed_at = NULL,
            approved_by_clerk_id = NULL,
            approved_at = NULL,
            updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING *`,
    [id, wreq.workspaceOwnerId, reason],
  );
  await logSessionActivity(wreq.workspaceOwnerId, id, "reopened", userId, null, JSON.stringify({ reopen_reason: reason }));
  res.json({ session: result.rows[0] });
});

/**
 * POST /api/cash-sessions/:id/adjustment
 * Add a manual cash adjustment (in/out) to an open session.
 */
router.post("/cash-sessions/:id/adjustment", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.adjust")) {
    res.status(403).json({ error: "Insufficient permissions to adjust cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Adjustments can only be added to an open session" });
    return;
  }

  const { amount, direction, description } = req.body ?? {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const dir = direction === "out" ? "out" : "in";
  const note = String(description ?? "").trim();
  if (!note) {
    res.status(400).json({ error: "description is required for an adjustment" });
    return;
  }
  // On dual-currency sessions the caller may pick which currency to adjust.
  let txnCurrency = session.currency;
  const requestedCurrency = String((req.body ?? {}).currency ?? "").trim().toUpperCase();
  if (requestedCurrency) {
    if (requestedCurrency !== session.currency && requestedCurrency !== session.secondary_currency) {
      res.status(400).json({ error: "currency must be one of the session's currencies" });
      return;
    }
    txnCurrency = requestedCurrency;
  }

  const userId = authed(req).userId;
  const result = await recordCashTransaction({
    workspaceOwnerId: wreq.workspaceOwnerId,
    amount: amt,
    type: "adjustment",
    direction: dir,
    currency: txnCurrency,
    drawerId: session.drawer_id,
    locationId: session.location_id,
    description: note,
    referenceType: "manual_adjustment",
    createdByClerkId: userId,
    cashSessionId: session.id,
  });

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  res.status(201).json({ session: refreshed, transaction_id: result.transactionId });
});

/** Validate an already-uploaded attachment URL for this workspace. */
function parseAttachmentUrl(
  raw: unknown,
  workspaceOwnerId: string,
): { ok: true; url: string | null } | { ok: false } {
  if (raw == null || !String(raw).trim()) return { ok: true, url: null };
  const url = String(raw).trim();
  if (!url.startsWith(`/objects/${workspaceOwnerId}/`)) return { ok: false };
  return { ok: true, url };
}

/** Load the drawer currencies allowed for a session. */
async function allowedCurrenciesFor(
  session: CashSessionRow,
  workspaceOwnerId: string,
): Promise<string[]> {
  const r = await db.query<{ currency: string; secondary_currency: string | null }>(
    `SELECT currency, secondary_currency FROM cash_drawers WHERE id = $1 AND workspace_owner_id = $2`,
    [session.drawer_id, workspaceOwnerId],
  );
  return sessionCurrencies(session.currency, r.rows[0]?.currency, r.rows[0]?.secondary_currency);
}

/**
 * Recompute a supplier invoice's outstanding_balance and payment_status from
 * the sum of non-reversed supplier_invoice_payments rows.
 * Call after any payment insert or reversal to keep the snapshot current.
 */
async function recomputeInvoicePaymentStatus(
  invoiceId: number,
  workspaceOwnerId: string,
): Promise<void> {
  await db.query(
    `WITH paid AS (
       SELECT COALESCE(SUM(amount), 0) AS total_paid
         FROM supplier_invoice_payments
        WHERE supplier_invoice_id = $1 AND is_reversed = false
     )
     UPDATE supplier_invoices si
        SET outstanding_balance = GREATEST(COALESCE(si.grand_total, si.amount) - paid.total_paid, 0),
            payment_status      = CASE
              WHEN paid.total_paid <= 0                                                                THEN 'unpaid'
              WHEN GREATEST(COALESCE(si.grand_total, si.amount) - paid.total_paid, 0) <= 0            THEN 'paid'
              ELSE 'partially_paid'
            END,
            paid_at             = CASE
              WHEN GREATEST(COALESCE(si.grand_total, si.amount) - paid.total_paid, 0) <= 0
              THEN COALESCE(si.paid_at, now())
              ELSE NULL
            END
       FROM paid
      WHERE si.id = $1 AND si.workspace_owner_id = $2`,
    [invoiceId, workspaceOwnerId],
  );
}

/**
 * Insert movement rows for a multi-currency settlement leg.
 * `direction` is the cash_transaction_movements direction ('inflow'|'outflow').
 * `kind` is the movement kind ('payment'|'change'|'expense_payment'|etc.).
 * Rate-override activity is logged per line when override_approved_by is set.
 */
/**
 * Insert movement rows for a multi-currency settlement leg.
 * `direction` is the cash_transaction_movements direction ('inflow'|'outflow').
 * `kind` is the movement kind ('payment'|'change'|'expense_payment'|etc.).
 *
 * Security: `override_approved_by` is always set to `createdByClerkId` (the
 * authenticated user making the request), never to a client-supplied value.
 * The client signals that a rate override is in use by setting
 * `is_rate_override: true` on the line; the server records who authorised it.
 */
async function insertMovementRows(
  workspaceOwnerId: string,
  transactionId: number,
  createdByClerkId: string,
  lines: Array<{
    amount: unknown;
    currency: unknown;
    exchange_rate?: unknown;
    is_rate_override?: unknown;
  }>,
  direction: "inflow" | "outflow",
  kind: string,
  sessionId: number,
): Promise<void> {
  for (const line of lines) {
    const lineAmt = Number(line.amount);
    if (!Number.isFinite(lineAmt) || lineAmt < 0) continue;
    const lineCurrency = String(line.currency ?? "").trim().toUpperCase();
    if (!lineCurrency) continue;
    const lineRate = line.exchange_rate != null ? Number(line.exchange_rate) : null;
    const convertedAmount =
      lineRate != null && Number.isFinite(lineRate)
        ? (lineAmt * lineRate).toFixed(2)
        : null;
    const isOverride = Boolean(line.is_rate_override);
    const rateSource = isOverride ? "override" : lineRate != null ? "session_rate" : null;
    // Override approver is always the authenticated request user — never client-supplied.
    const overrideApprovedBy = isOverride ? createdByClerkId : null;

    await db.query(
      `INSERT INTO cash_transaction_movements
         (workspace_owner_id, cash_transaction_id, direction, kind,
          amount, currency, exchange_rate, converted_amount,
          rate_source, override_approved_by, created_by_clerk_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        workspaceOwnerId,
        transactionId,
        direction,
        kind,
        lineAmt.toFixed(2),
        lineCurrency,
        lineRate != null ? lineRate.toFixed(8) : null,
        convertedAmount,
        rateSource,
        overrideApprovedBy,
        createdByClerkId,
      ],
    );

    if (isOverride) {
      await logSessionActivity(
        workspaceOwnerId,
        sessionId,
        "exchange_rate_override",
        createdByClerkId,
        null,
        JSON.stringify({
          transactionId,
          currency: lineCurrency,
          exchange_rate: lineRate,
          override_approved_by: createdByClerkId,
        }),
      );
    }
  }
}

// ── Quick Entry idempotency cache ──────────────────────────────────────────
// Short-lived in-memory store keyed by X-Idempotency-Key header value.
// Prevents duplicate ledger entries from double-clicks or repeated Enter presses.
const _quickEntryIdempotencyCache = new Map<string, { body: unknown; expiresAt: number }>();
const QUICK_ENTRY_IDEMPOTENCY_TTL_MS = 30_000;

function checkQuickEntryIdempotency(key: string): unknown | null {
  const entry = _quickEntryIdempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _quickEntryIdempotencyCache.delete(key); return null; }
  return entry.body;
}

function storeQuickEntryIdempotency(key: string, body: unknown): void {
  // Prune expired entries to keep the map bounded.
  for (const [k, v] of _quickEntryIdempotencyCache) {
    if (Date.now() > v.expiresAt) _quickEntryIdempotencyCache.delete(k);
  }
  _quickEntryIdempotencyCache.set(key, { body, expiresAt: Date.now() + QUICK_ENTRY_IDEMPOTENCY_TTL_MS });
}

/**
 * POST /api/cash-sessions/:id/sale
 * Record a cash sale on an open session from the Quick Entry panel.
 */
router.post("/cash-sessions/:id/sale", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_transactions.create")) {
    res.status(403).json({ error: "Insufficient permissions to record cash sales" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Sales can only be recorded on an open session" });
    return;
  }

  // Idempotency: if the caller provided a key and we've seen it recently, replay the cached response.
  const saleIdempotencyKey = typeof req.headers["x-idempotency-key"] === "string"
    ? req.headers["x-idempotency-key"]
    : null;
  if (saleIdempotencyKey) {
    const cached = checkQuickEntryIdempotency(saleIdempotencyKey);
    if (cached) { res.status(409).json(cached); return; }
  }

  const body = req.body ?? {};
  const amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const currency = String(body.currency ?? "").trim().toUpperCase();
  const allowed = await allowedCurrenciesFor(session, wreq.workspaceOwnerId);
  if (!currency || !allowed.includes(currency)) {
    res.status(400).json({ error: "currency must be one of the drawer's currencies" });
    return;
  }
  const channel = String(body.sale_channel ?? "").trim();
  if (!SALE_CHANNELS.includes(channel as (typeof SALE_CHANNELS)[number])) {
    res.status(400).json({ error: "sale_channel is required" });
    return;
  }
  const attachment = parseAttachmentUrl(body.attachment_url, wreq.workspaceOwnerId);
  if (!attachment.ok) {
    res.status(400).json({ error: "Invalid receipt attachment" });
    return;
  }
  const reference = body.reference != null ? String(body.reference).trim() || null : null;
  const note = body.note != null ? String(body.note).trim() || null : null;

  // Optional multi-currency settlement arrays.
  const paymentsRaw = Array.isArray(body.payments) ? body.payments : null;
  const changeRaw = Array.isArray(body.change) ? body.change : [];
  const transactionCurrency = paymentsRaw
    ? String(body.transaction_currency ?? currency).trim().toUpperCase() || currency
    : currency;
  const balanceDifferenceKind = body.balance_difference_kind
    ? String(body.balance_difference_kind).trim() || null
    : null;

  // Upfront validation and balance check for multi-currency settlement.
  const ALLOWED_BALANCE_DIFFERENCE_KINDS = ["rounding", "fx_difference", "overpayment"] as const;
  const BALANCE_TOLERANCE = 0.05;

  type RawLine = { amount?: unknown; currency?: unknown; exchange_rate?: unknown; is_rate_override?: unknown };

  function validateAndConvertLines(lines: RawLine[], label: string): { ok: true; total: number } | { ok: false; error: string } {
    let total = 0;
    for (const line of lines) {
      const lineAmt = Number(line.amount);
      if (!Number.isFinite(lineAmt) || lineAmt <= 0) {
        return { ok: false, error: `Invalid ${label} line: amount must be a positive number` };
      }
      const lineCurrency = String(line.currency ?? "").trim().toUpperCase();
      if (!lineCurrency) {
        return { ok: false, error: `Invalid ${label} line: currency is required` };
      }
      // Validate each line's currency against the drawer's allowed currencies.
      // Accepting an unsupported currency would add it to the session's expected_cash
      // total without a matching physical denomination in the drawer (e.g. AED amounts
      // added to a USD-only drawer balance), corrupting reconciliation.
      if (!allowed.includes(lineCurrency)) {
        return {
          ok: false,
          error: `Invalid ${label} line: currency ${lineCurrency} is not accepted by this drawer (allowed: ${allowed.join(", ")})`,
        };
      }
      if (line.exchange_rate != null) {
        const lineRate = Number(line.exchange_rate);
        if (!Number.isFinite(lineRate) || lineRate <= 0) {
          return { ok: false, error: `Invalid ${label} line: exchange_rate must be a positive number` };
        }
        // Convert to the transaction currency using the supplied rate (rate = transactionCurrency per 1 lineCurrency).
        total += lineAmt * lineRate;
      } else if (lineCurrency === transactionCurrency) {
        // Same currency as the transaction — include directly in the balance total.
        total += lineAmt;
      }
      // else: different currency with no exchange rate — tracked as a movement row
      // but excluded from the same-currency balance check (e.g. LBP change against
      // a USD expense; the two drawers settle independently).
    }
    return { ok: true, total };
  }

  if (paymentsRaw) {
    // Rate-override authorization: requires cash_sessions.adjust permission.
    const hasOverride =
      paymentsRaw.some((l: RawLine) => l.is_rate_override) ||
      changeRaw.some((l: RawLine) => l.is_rate_override);
    if (hasOverride && !hasPermission(wreq, "cash_sessions.adjust")) {
      res.status(403).json({ error: "Exchange rate overrides require the cash_sessions.adjust permission" });
      return;
    }

    const paymentsResult = validateAndConvertLines(paymentsRaw as RawLine[], "payment");
    if (!paymentsResult.ok) { res.status(400).json({ error: paymentsResult.error }); return; }
    const changeResult = validateAndConvertLines(changeRaw as RawLine[], "change");
    if (!changeResult.ok) { res.status(400).json({ error: changeResult.error }); return; }

    const diff = Math.abs(paymentsResult.total - changeResult.total - amt);
    if (
      diff > BALANCE_TOLERANCE &&
      (!balanceDifferenceKind || !ALLOWED_BALANCE_DIFFERENCE_KINDS.includes(balanceDifferenceKind as (typeof ALLOWED_BALANCE_DIFFERENCE_KINDS)[number]))
    ) {
      res.status(422).json({
        error: `Payment amounts do not balance: expected ${amt.toFixed(2)} ${transactionCurrency}, ` +
          `received ${(paymentsResult.total - changeResult.total).toFixed(2)} (difference ${diff.toFixed(2)}). ` +
          `Provide a balance_difference_kind (rounding | fx_difference | overpayment) to classify the residual.`,
      });
      return;
    }
  }

  const userId = authed(req).userId;
  const result = await recordCashTransaction({
    workspaceOwnerId: wreq.workspaceOwnerId,
    amount: amt,
    type: "sale",
    direction: "in",
    currency: transactionCurrency,
    drawerId: session.drawer_id,
    locationId: session.location_id,
    description: note,
    referenceType: reference ? "order" : null,
    referenceId: reference,
    attachmentUrl: attachment.url,
    createdByClerkId: userId,
    cashSessionId: session.id,
  });
  if (channel) {
    await db.query(
      `UPDATE cash_transactions SET sale_channel = $1 WHERE id = $2 AND workspace_owner_id = $3`,
      [channel, result.transactionId, wreq.workspaceOwnerId],
    );
  }

  // Write transaction_currency / balance_difference_kind + movement rows when
  // a multi-currency settlement was provided.
  if (paymentsRaw) {
    await db.query(
      `UPDATE cash_transactions SET transaction_currency = $1, balance_difference_kind = $2 WHERE id = $3 AND workspace_owner_id = $4`,
      [transactionCurrency, balanceDifferenceKind, result.transactionId, wreq.workspaceOwnerId],
    );
    await insertMovementRows(wreq.workspaceOwnerId, result.transactionId, userId, paymentsRaw, "inflow", "payment", id);
    await insertMovementRows(wreq.workspaceOwnerId, result.transactionId, userId, changeRaw, "outflow", "change", id);
    // Recompute after movements so the returned session reflects physical drawer impact.
    await recomputeSessionTotals(id, wreq.workspaceOwnerId);
  }

  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "sale_recorded",
    userId,
    null,
    JSON.stringify({ transactionId: result.transactionId, amount: amt.toFixed(2), currency: transactionCurrency, sale_channel: channel, multi_currency: Boolean(paymentsRaw) }),
  );

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  const saleResponseBody = { session: refreshed, transaction_id: result.transactionId };
  if (saleIdempotencyKey) storeQuickEntryIdempotency(saleIdempotencyKey, saleResponseBody);
  res.status(201).json(saleResponseBody);
});

/**
 * POST /api/cash-sessions/:id/expense
 * Record a cash expense on an open session from the Quick Entry panel.
 * Category, payee, description, and drawer-paid confirmation are required;
 * a receipt is required at or above the per-currency threshold.
 */
router.post("/cash-sessions/:id/expense", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_transactions.create")) {
    res.status(403).json({ error: "Insufficient permissions to record cash expenses" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Expenses can only be recorded on an open session" });
    return;
  }

  // Idempotency: replay cached response when the same key is seen within the TTL window.
  const expenseIdempotencyKey = typeof req.headers["x-idempotency-key"] === "string"
    ? req.headers["x-idempotency-key"]
    : null;
  if (expenseIdempotencyKey) {
    const cached = checkQuickEntryIdempotency(expenseIdempotencyKey);
    if (cached) { res.status(409).json(cached); return; }
  }

  const body = req.body ?? {};
  const amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const currency = String(body.currency ?? "").trim().toUpperCase();
  const allowed = await allowedCurrenciesFor(session, wreq.workspaceOwnerId);
  if (!currency || !allowed.includes(currency)) {
    res.status(400).json({ error: "currency must be one of the drawer's currencies" });
    return;
  }
  // Older Quick Entry clients used "office_supplies" for the supplies
  // category. Keep accepting that legacy value, but normalize it before
  // validation/storage so the persisted value remains part of the current
  // expense-category enum.
  const rawCategory = String(body.expense_category ?? "").trim();
  const category = rawCategory === "office_supplies" ? "supplies" : rawCategory;
  if (!EXPENSE_CATEGORIES.includes(category as (typeof EXPENSE_CATEGORIES)[number])) {
    res.status(400).json({ error: "expense_category is required" });
    return;
  }

  // ── Payroll-specific validation ────────────────────────────────────────────
  let payee: string;
  let description: string;
  let payrollEmployeeNameSnapshot: string | null = null;

  if (isPayrollCategory(category)) {
    // Only owners/admins or roles with payroll_expenses permission may use this category.
    if (!hasPermission(wreq, "payroll_expenses") && wreq.workspaceActualRole !== "owner" && wreq.workspaceActualRole !== "admin") {
      res.status(403).json({ error: "Insufficient permissions to record payroll expenses" });
      return;
    }

    const payrollEmployeeId = String(body.payroll_employee_id ?? "").trim();
    const payrollPeriod = String(body.payroll_period ?? "").trim();
    const payrollPaymentType = String(body.payroll_payment_type ?? "").trim();

    if (!payrollEmployeeId) {
      res.status(400).json({ fields: { payroll_employee_id: "Employee is required" }, error: "Employee and payroll details are required." });
      return;
    }
    if (!payrollPeriod || !/^\d{4}-\d{2}$/.test(payrollPeriod)) {
      res.status(400).json({ fields: { payroll_period: "Payroll period is required (YYYY-MM)" }, error: "Employee and payroll details are required." });
      return;
    }
    if (!PAYROLL_PAYMENT_TYPES.includes(payrollPaymentType as (typeof PAYROLL_PAYMENT_TYPES)[number])) {
      res.status(400).json({ fields: { payroll_payment_type: "Payment type is required" }, error: "Employee and payroll details are required." });
      return;
    }

    // Validate employee exists and is not archived (team_members table).
    let employeeRow: { id: number; first_name: string; last_name: string | null } | null = null;
    try {
      const empResult = await db.query<{ id: number; first_name: string; last_name: string | null }>(
        `SELECT id, first_name, last_name
           FROM team_members
          WHERE workspace_owner_id = $1
            AND ('tm_' || id::text) = $2
            AND archived_at IS NULL`,
        [wreq.workspaceOwnerId, payrollEmployeeId],
      );
      employeeRow = empResult.rows[0] ?? null;
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "42P01") throw err;
    }
    if (!employeeRow) {
      res.status(400).json({ fields: { payroll_employee_id: "Employee not found or archived" }, error: "Employee not found or archived" });
      return;
    }
    const employeeDisplayName = [employeeRow.first_name, employeeRow.last_name].filter(Boolean).join(" ");
    payrollEmployeeNameSnapshot = employeeDisplayName;

    // Duplicate detection: same employee + period + payment_type + currency + amount already in workspace.
    // Use `currency` (the document currency) here since transactionCurrency is resolved later.
    if (body.confirm_duplicate !== true) {
      const dupResult = await db.query<{ id: number }>(
        `SELECT ct.id FROM cash_transactions ct
          WHERE ct.workspace_owner_id = $1
            AND ct.expense_category = 'salaries_wages'
            AND ct.payroll_employee_id = $2
            AND ct.payroll_period = $3
            AND ct.payroll_payment_type = $4
            AND ct.currency = $5
            AND ct.amount = $6
            AND ct.is_reversed = false
          LIMIT 1`,
        [wreq.workspaceOwnerId, payrollEmployeeId, payrollPeriod, payrollPaymentType, currency, amt.toFixed(2)],
      );
      if ((dupResult.rowCount ?? 0) > 0) {
        res.status(409).json({
          error: "Duplicate payroll expense detected. Submit again with confirm_duplicate: true to proceed.",
          duplicate: {
            transaction_id: dupResult.rows[0].id,
            employee_name: employeeDisplayName,
            period: payrollPeriod,
            payment_type: payrollPaymentType,
          },
        });
        return;
      }
    }

    // Auto-build description and payee from payroll metadata.
    const payrollNotes = String(body.payroll_notes ?? "").trim() || null;
    const periodLabel = (() => {
      const [yr, mo] = payrollPeriod.split("-");
      try { return new Date(parseInt(yr), parseInt(mo) - 1).toLocaleString("en-US", { month: "long", year: "numeric" }); }
      catch { return payrollPeriod; }
    })();
    const paymentTypeLabels: Record<string, string> = {
      salary: "Salary", salary_advance: "Salary advance", bonus: "Bonus", other_payroll: "Other payroll payment",
    };
    const ptLabel = paymentTypeLabels[payrollPaymentType] ?? payrollPaymentType;
    description = `${ptLabel} — ${employeeDisplayName} — ${periodLabel}`;
    payee = employeeDisplayName;

    // Store payroll fields on the request body-like object for the UPDATE below.
    (body as Record<string, unknown>).__payrollEmployeeId = payrollEmployeeId;
    (body as Record<string, unknown>).__payrollPeriod = payrollPeriod;
    (body as Record<string, unknown>).__payrollPaymentType = payrollPaymentType;
    (body as Record<string, unknown>).__payrollNotes = payrollNotes;
  } else {
    payee = String(body.payee ?? "").trim();
    if (!payee) {
      res.status(400).json({ error: "payee is required" });
      return;
    }
    description = String(body.description ?? "").trim();
    if (!description) {
      res.status(400).json({ error: "description is required" });
      return;
    }
  }

  // paid_from_drawer defaults to true when absent (backward compat for clients
  // that stop sending the field).  Explicit false is still rejected.
  if (body.paid_from_drawer !== undefined && body.paid_from_drawer !== null && body.paid_from_drawer !== true) {
    res.status(400).json({ error: "Confirm the amount was paid from this drawer" });
    return;
  }
  const attachment = parseAttachmentUrl(body.attachment_url, wreq.workspaceOwnerId);
  if (!attachment.ok) {
    res.status(400).json({ error: "Invalid receipt attachment" });
    return;
  }
  // Receipts are optional — no server-side rejection for missing receipt.

  // Optional multi-currency disbursement arrays.
  const paymentsRaw = Array.isArray(body.payments) ? body.payments : null;
  const changeRaw = Array.isArray(body.change) ? body.change : [];
  const transactionCurrency = paymentsRaw
    ? String(body.transaction_currency ?? currency).trim().toUpperCase() || currency
    : currency;
  const balanceDifferenceKind = body.balance_difference_kind
    ? String(body.balance_difference_kind).trim() || null
    : null;

  // Upfront validation and balance check for multi-currency disbursement.
  const ALLOWED_BALANCE_DIFFERENCE_KINDS_EXP = ["rounding", "fx_difference", "overpayment"] as const;
  const BALANCE_TOLERANCE_EXP = 0.05;

  type RawLineExp = { amount?: unknown; currency?: unknown; exchange_rate?: unknown; is_rate_override?: unknown };

  function validateAndConvertLinesExp(lines: RawLineExp[], label: string): { ok: true; total: number } | { ok: false; error: string } {
    let total = 0;
    for (const line of lines) {
      const lineAmt = Number(line.amount);
      if (!Number.isFinite(lineAmt) || lineAmt <= 0) {
        return { ok: false, error: `Invalid ${label} line: amount must be a positive number` };
      }
      const lineCurrency = String(line.currency ?? "").trim().toUpperCase();
      if (!lineCurrency) {
        return { ok: false, error: `Invalid ${label} line: currency is required` };
      }
      // Validate each line's currency against the drawer's allowed currencies.
      if (!allowed.includes(lineCurrency)) {
        return {
          ok: false,
          error: `Invalid ${label} line: currency ${lineCurrency} is not accepted by this drawer (allowed: ${allowed.join(", ")})`,
        };
      }
      if (line.exchange_rate != null) {
        const lineRate = Number(line.exchange_rate);
        if (!Number.isFinite(lineRate) || lineRate <= 0) {
          return { ok: false, error: `Invalid ${label} line: exchange_rate must be a positive number` };
        }
        // Convert to the transaction currency using the supplied rate (rate = transactionCurrency per 1 lineCurrency).
        total += lineAmt * lineRate;
      } else if (lineCurrency === transactionCurrency) {
        // Same currency as the transaction — include directly in the balance total.
        total += lineAmt;
      }
      // else: different currency with no exchange rate — tracked as a movement row
      // but excluded from the same-currency balance check (e.g. LBP change against
      // a USD expense; the two drawers settle independently).
    }
    return { ok: true, total };
  }

  if (paymentsRaw) {
    // Rate-override authorization: requires cash_sessions.adjust permission.
    const hasOverrideExp =
      paymentsRaw.some((l: RawLineExp) => l.is_rate_override) ||
      changeRaw.some((l: RawLineExp) => l.is_rate_override);
    if (hasOverrideExp && !hasPermission(wreq, "cash_sessions.adjust")) {
      res.status(403).json({ error: "Exchange rate overrides require the cash_sessions.adjust permission" });
      return;
    }

    const paymentsResultExp = validateAndConvertLinesExp(paymentsRaw as RawLineExp[], "payment");
    if (!paymentsResultExp.ok) { res.status(400).json({ error: paymentsResultExp.error }); return; }
    const changeResultExp = validateAndConvertLinesExp(changeRaw as RawLineExp[], "change");
    if (!changeResultExp.ok) { res.status(400).json({ error: changeResultExp.error }); return; }

    const diff = Math.abs(paymentsResultExp.total - changeResultExp.total - amt);
    if (
      diff > BALANCE_TOLERANCE_EXP &&
      (!balanceDifferenceKind || !ALLOWED_BALANCE_DIFFERENCE_KINDS_EXP.includes(balanceDifferenceKind as (typeof ALLOWED_BALANCE_DIFFERENCE_KINDS_EXP)[number]))
    ) {
      res.status(422).json({
        error: `Payment amounts do not balance: expected ${amt.toFixed(2)} ${transactionCurrency}, ` +
          `received ${(paymentsResultExp.total - changeResultExp.total).toFixed(2)} (difference ${diff.toFixed(2)}). ` +
          `Provide a balance_difference_kind (rounding | fx_difference | overpayment) to classify the residual.`,
      });
      return;
    }
  }

  const userId = authed(req).userId;
  // Salaries & Wages expenses require Business Development approval before
  // they affect the drawer balance — insert them as pending.
  const requiresApprovalFlow = isPayrollCategory(category);
  const result = await recordCashTransaction({
    workspaceOwnerId: wreq.workspaceOwnerId,
    amount: amt,
    type: "expense",
    direction: "out",
    currency: transactionCurrency,
    drawerId: session.drawer_id,
    locationId: session.location_id,
    description,
    referenceType: "expense",
    attachmentUrl: attachment.url,
    createdByClerkId: userId,
    cashSessionId: session.id,
    approvalStatus: requiresApprovalFlow ? "pending" : "confirmed",
    requestedByClerkId: requiresApprovalFlow ? userId : null,
  });
  await db.query(
    `UPDATE cash_transactions SET expense_category = $1, payee = $2 WHERE id = $3 AND workspace_owner_id = $4`,
    [category, payee, result.transactionId, wreq.workspaceOwnerId],
  );

  // Persist payroll metadata when applicable.
  if (isPayrollCategory(category)) {
    await db.query(
      `UPDATE cash_transactions
          SET payroll_employee_id            = $1,
              payroll_employee_name_snapshot = $2,
              payroll_period                 = $3,
              payroll_payment_type           = $4,
              payroll_notes                  = $5
        WHERE id = $6 AND workspace_owner_id = $7`,
      [
        body.__payrollEmployeeId,
        payrollEmployeeNameSnapshot,
        body.__payrollPeriod,
        body.__payrollPaymentType,
        body.__payrollNotes ?? null,
        result.transactionId,
        wreq.workspaceOwnerId,
      ],
    );
  }

  if (paymentsRaw) {
    await db.query(
      `UPDATE cash_transactions SET transaction_currency = $1, balance_difference_kind = $2 WHERE id = $3 AND workspace_owner_id = $4`,
      [transactionCurrency, balanceDifferenceKind, result.transactionId, wreq.workspaceOwnerId],
    );
    // Expense disbursement: each payment line is cash leaving the drawer.
    await insertMovementRows(wreq.workspaceOwnerId, result.transactionId, userId, paymentsRaw, "outflow", "expense_payment", id);
    // Change returned by supplier: each change line is cash entering the drawer.
    if (changeRaw.length > 0) {
      await insertMovementRows(wreq.workspaceOwnerId, result.transactionId, userId, changeRaw, "inflow", "change", id);
    }
    // Recompute after movements so the returned session reflects physical drawer impact.
    await recomputeSessionTotals(id, wreq.workspaceOwnerId);
  }

  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    requiresApprovalFlow ? "expense_pending_approval" : "expense_recorded",
    userId,
    null,
    JSON.stringify({ transactionId: result.transactionId, amount: amt.toFixed(2), currency: transactionCurrency, expense_category: category, payee, multi_currency: Boolean(paymentsRaw) }),
  );

  // Fire-and-forget: DM the Business Development approvers on Slack. Fully
  // detached so the route response (and mocked db-call ordering in tests)
  // never depends on it.
  if (requiresApprovalFlow) {
    void notifySalaryApprovalRequested({
      workspaceOwnerId: wreq.workspaceOwnerId,
      requesterClerkId: userId,
      fields: {
        payee,
        amount: amt.toFixed(2),
        currency: transactionCurrency,
        requesterName: "",
        paymentTypeLabel: typeof body.__payrollPaymentType === "string" ? String(body.__payrollPaymentType) : null,
        sessionNumber: (session as { session_number?: string | null }).session_number ?? null,
        transactionId: result.transactionId,
      },
    });
  }

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  const expenseResponseBody = {
    session: refreshed,
    transaction_id: result.transactionId,
    pending_approval: requiresApprovalFlow,
    // Who the request is waiting on, so the client can say
    // "Pending approval from <names>".
    approver_names: requiresApprovalFlow ? await findSalaryApproverNames(wreq.workspaceOwnerId) : [],
  };
  if (expenseIdempotencyKey) storeQuickEntryIdempotency(expenseIdempotencyKey, expenseResponseBody);
  res.status(201).json(expenseResponseBody);
});

// ─────────────────────────────────────────────────────────────────────────────
// Salary expense approvals
// ─────────────────────────────────────────────────────────────────────────────

type SalaryApprovalRow = {
  id: number;
  cash_session_id: number | null;
  amount: string;
  currency: string;
  transaction_currency: string | null;
  payee: string | null;
  description: string | null;
  payroll_payment_type: string | null;
  payroll_period: string | null;
  requested_by_clerk_id: string | null;
  approval_status: string;
  transaction_date: string;
  session_number: string | null;
};

const SALARY_APPROVAL_SELECT = `
  SELECT ct.id, ct.cash_session_id, ct.amount, ct.currency, ct.transaction_currency,
         ct.payee, ct.description, ct.payroll_payment_type, ct.payroll_period,
         ct.requested_by_clerk_id, ct.approval_status, ct.transaction_date,
         cs.session_number
    FROM cash_transactions ct
    LEFT JOIN cash_sessions cs ON cs.id = ct.cash_session_id`;

/**
 * GET /api/cash-approvals
 * Pending salary expense approval requests for the workspace. Gated to
 * Business Development role holders and workspace owners.
 */
router.get("/cash-approvals", async (req, res) => {
  const wreq = workspace(req);
  const userId = authed(req).userId;
  const isApprover = await canApproveSalaryExpenses(wreq, userId);
  if (!isApprover) {
    res.status(403).json({ error: "Only Business Development role holders can review salary expense approvals" });
    return;
  }
  const rows = await db.query<SalaryApprovalRow>(
    `${SALARY_APPROVAL_SELECT}
      WHERE ct.workspace_owner_id = $1 AND ct.approval_status = 'pending'
      ORDER BY ct.transaction_date ASC, ct.id ASC`,
    [wreq.workspaceOwnerId],
  );
  const names = await fetchClerkNames(rows.rows.map((r) => r.requested_by_clerk_id ?? "").filter(Boolean));
  res.json({
    requests: rows.rows.map((r) => ({
      ...r,
      requested_by_name: r.requested_by_clerk_id ? (names.get(r.requested_by_clerk_id) ?? r.requested_by_clerk_id) : null,
    })),
  });
});

/**
 * GET /api/cash-approvals/my-decisions
 * The current user's recently decided (approved/declined) salary expense
 * requests that they have not yet acknowledged — feeds the in-app bell.
 */
router.get("/cash-approvals/my-decisions", async (req, res) => {
  const wreq = workspace(req);
  const userId = authed(req).userId;
  const rows = await db.query<SalaryApprovalRow & { approval_decline_reason: string | null; approval_decided_at: string | null }>(
    `${SALARY_APPROVAL_SELECT.replace("cs.session_number", "ct.approval_decline_reason, ct.approval_decided_at, cs.session_number")}
      WHERE ct.workspace_owner_id = $1
        AND ct.requested_by_clerk_id = $2
        AND ct.approval_status IN ('confirmed', 'declined')
        AND ct.approval_decided_at IS NOT NULL
        AND ct.approval_requester_ack_at IS NULL
      ORDER BY ct.approval_decided_at DESC
      LIMIT 20`,
    [wreq.workspaceOwnerId, userId],
  );
  res.json({ decisions: rows.rows });
});

/**
 * POST /api/cash-approvals/my-decisions/ack
 * Marks decision notifications as seen for the requester. Body: { ids: number[] }
 */
router.post("/cash-approvals/my-decisions/ack", async (req, res) => {
  const wreq = workspace(req);
  const userId = authed(req).userId;
  const ids = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).map((v) => parseInt(String(v), 10)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array of transaction ids" });
    return;
  }
  await db.query(
    `UPDATE cash_transactions
        SET approval_requester_ack_at = now()
      WHERE workspace_owner_id = $1 AND requested_by_clerk_id = $2 AND id = ANY($3::int[])`,
    [wreq.workspaceOwnerId, userId, ids],
  );
  res.json({ ok: true });
});

/** Load one pending salary approval row or answer with 404/409. */
async function loadPendingSalaryApproval(
  workspaceOwnerId: string,
  txId: number,
): Promise<{ ok: true; row: SalaryApprovalRow } | { ok: false; status: number; error: string }> {
  const result = await db.query<SalaryApprovalRow>(
    `${SALARY_APPROVAL_SELECT}
      WHERE ct.id = $1 AND ct.workspace_owner_id = $2 AND ct.expense_category = 'salaries_wages'`,
    [txId, workspaceOwnerId],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, status: 404, error: "Salary expense request not found" };
  if (row.approval_status !== "pending") {
    return { ok: false, status: 409, error: `This request has already been ${row.approval_status === "confirmed" ? "approved" : row.approval_status}` };
  }
  return { ok: true, row };
}

/** Shared post-decision side effects: activity log, SSE, requester Slack DM. */
async function emitSalaryDecisionSideEffects(args: {
  wreq: ReturnType<typeof workspace>;
  row: SalaryApprovalRow;
  deciderId: string;
  approved: boolean;
  reason?: string | null;
}): Promise<void> {
  const { wreq, row, deciderId, approved, reason } = args;
  if (row.cash_session_id != null) {
    await logSessionActivity(
      wreq.workspaceOwnerId,
      row.cash_session_id,
      approved ? "salary_expense_approved" : "salary_expense_declined",
      deciderId,
      null,
      JSON.stringify({ transactionId: row.id, amount: row.amount, currency: row.transaction_currency ?? row.currency, payee: row.payee, reason: reason ?? undefined }),
    );
  }
  try {
    broadcastEvent(wreq.workspaceOwnerId, {
      event: "salary_approval.decided",
      workspaceId: wreq.workspaceOwnerId,
      data: {
        transaction_id: row.id,
        approved,
        requested_by_clerk_id: row.requested_by_clerk_id,
        payee: row.payee,
        amount: row.amount,
        currency: row.transaction_currency ?? row.currency,
        reason: reason ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err }, "salary approval: SSE broadcast failed");
  }
  // Fire-and-forget requester Slack DM (email-matched; silently skipped otherwise).
  void notifySalaryDecisionToRequester({
    workspaceOwnerId: wreq.workspaceOwnerId,
    requesterClerkId: row.requested_by_clerk_id,
    fields: {
      payee: row.payee ?? "—",
      amount: Number(row.amount).toFixed(2),
      currency: row.transaction_currency ?? row.currency,
      approved,
      reason,
    },
  });
}

/**
 * POST /api/cash-approvals/:txId/approve
 * Approve a pending salary expense — the transaction becomes confirmed and
 * the session balance is deducted.
 */
router.post("/cash-approvals/:txId/approve", async (req, res) => {
  const wreq = workspace(req);
  const userId = authed(req).userId;
  const txId = parseInt(req.params.txId, 10);
  if (isNaN(txId)) { res.status(400).json({ error: "Invalid transaction id" }); return; }
  if (!(await canApproveSalaryExpenses(wreq, userId))) {
    res.status(403).json({ error: "Only Business Development role holders can approve salary expenses" });
    return;
  }
  const loaded = await loadPendingSalaryApproval(wreq.workspaceOwnerId, txId);
  if (!loaded.ok) { res.status(loaded.status).json({ error: loaded.error }); return; }
  const updated = await db.query(
    `UPDATE cash_transactions
        SET approval_status = 'confirmed',
            approval_decided_by_clerk_id = $3,
            approval_decided_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND approval_status = 'pending'`,
    [txId, wreq.workspaceOwnerId, userId],
  );
  if ((updated.rowCount ?? 0) === 0) {
    res.status(409).json({ error: "This request was already decided" });
    return;
  }
  if (loaded.row.cash_session_id != null) {
    await recomputeSessionTotals(loaded.row.cash_session_id, wreq.workspaceOwnerId);
  }
  await emitSalaryDecisionSideEffects({ wreq, row: loaded.row, deciderId: userId, approved: true });
  res.json({ ok: true, status: "confirmed" });
});

/**
 * POST /api/cash-approvals/:txId/decline
 * Decline a pending salary expense (optional reason) — never affects totals.
 */
router.post("/cash-approvals/:txId/decline", async (req, res) => {
  const wreq = workspace(req);
  const userId = authed(req).userId;
  const txId = parseInt(req.params.txId, 10);
  if (isNaN(txId)) { res.status(400).json({ error: "Invalid transaction id" }); return; }
  if (!(await canApproveSalaryExpenses(wreq, userId))) {
    res.status(403).json({ error: "Only Business Development role holders can decline salary expenses" });
    return;
  }
  const reason = req.body?.reason != null ? String(req.body.reason).trim() || null : null;
  const loaded = await loadPendingSalaryApproval(wreq.workspaceOwnerId, txId);
  if (!loaded.ok) { res.status(loaded.status).json({ error: loaded.error }); return; }
  const updated = await db.query(
    `UPDATE cash_transactions
        SET approval_status = 'declined',
            approval_decided_by_clerk_id = $3,
            approval_decided_at = now(),
            approval_decline_reason = $4
      WHERE id = $1 AND workspace_owner_id = $2 AND approval_status = 'pending'`,
    [txId, wreq.workspaceOwnerId, userId, reason],
  );
  if ((updated.rowCount ?? 0) === 0) {
    res.status(409).json({ error: "This request was already decided" });
    return;
  }
  await emitSalaryDecisionSideEffects({ wreq, row: loaded.row, deciderId: userId, approved: false, reason });
  res.json({ ok: true, status: "declined" });
});

/**
 * POST /api/cash-approvals/:txId/cancel
 * The requester withdraws their own pending salary expense request.
 */
router.post("/cash-approvals/:txId/cancel", async (req, res) => {
  const wreq = workspace(req);
  const userId = authed(req).userId;
  const txId = parseInt(req.params.txId, 10);
  if (isNaN(txId)) { res.status(400).json({ error: "Invalid transaction id" }); return; }
  const loaded = await loadPendingSalaryApproval(wreq.workspaceOwnerId, txId);
  if (!loaded.ok) { res.status(loaded.status).json({ error: loaded.error }); return; }
  if (loaded.row.requested_by_clerk_id !== userId) {
    res.status(403).json({ error: "Only the requester can cancel their own pending request" });
    return;
  }
  const updated = await db.query(
    `UPDATE cash_transactions
        SET approval_status = 'cancelled',
            approval_decided_by_clerk_id = $3,
            approval_decided_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND approval_status = 'pending'`,
    [txId, wreq.workspaceOwnerId, userId],
  );
  if ((updated.rowCount ?? 0) === 0) {
    res.status(409).json({ error: "This request was already decided" });
    return;
  }
  if (loaded.row.cash_session_id != null) {
    await logSessionActivity(
      wreq.workspaceOwnerId,
      loaded.row.cash_session_id,
      "salary_expense_cancelled",
      userId,
      null,
      JSON.stringify({ transactionId: txId }),
    );
  }
  res.json({ ok: true, status: "cancelled" });
});

/**
 * GET /api/cash-sessions/:id/payable-bills
 * Return open or partially-paid supplier invoices for the session's workspace,
 * searchable by supplier name or invoice number (optional ?q=).
 * Requires the same cash_transactions.create permission as the expense route.
 * Returns up to 20 results ordered by due date (nulls last).
 */
router.get("/cash-sessions/:id/payable-bills", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_transactions.create")) {
    res.status(403).json({ error: "Insufficient permissions to view payable bills" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }

  const q =
    typeof req.query.q === "string" && req.query.q.trim()
      ? req.query.q.trim()
      : null;

  const conditions: string[] = [
    `si.workspace_owner_id = $1`,
    `si.payment_status IN ('unpaid', 'partially_paid')`,
    `COALESCE(si.status, 'issued') NOT IN ('cancelled', 'voided', 'draft')`,
  ];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (q) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    const idx = params.length;
    conditions.push(
      `(s.name ILIKE $${idx} ESCAPE '\\' OR si.invoice_number ILIKE $${idx} ESCAPE '\\')`,
    );
  }

  const where = conditions.join(" AND ");

  const result = await db.query<{
    id: number;
    invoice_number: string | null;
    supplier_id: number;
    supplier_name: string | null;
    due_date: string | null;
    currency: string;
    amount: string;
    outstanding_balance: string | null;
  }>(
    `SELECT si.id,
            si.invoice_number,
            si.supplier_id,
            s.name   AS supplier_name,
            si.due_date,
            si.currency,
            si.amount,
            si.outstanding_balance
       FROM supplier_invoices si
       JOIN suppliers s ON s.id = si.supplier_id
      WHERE ${where}
      ORDER BY si.due_date ASC NULLS LAST, si.id DESC
      LIMIT 20`,
    params,
  );

  res.json({
    bills: result.rows.map((row) => ({
      ...row,
      // Fallback for pre-migration rows where outstanding_balance is NULL.
      outstanding_balance: row.outstanding_balance ?? row.amount,
    })),
  });
});

/**
 * POST /api/cash-sessions/:id/bill-payment
 * Pay an existing supplier invoice from this open cash session.
 *
 * Body: {
 *   supplier_invoice_id:    number,   // invoice to pay
 *   payment_amount:         number,   // amount in the invoice's currency
 *   currency:               string,   // drawer currency used for the transaction
 *   payments?:              Line[],   // multi-currency settlement lines
 *   change?:                Line[],   // change returned (settlement)
 *   transaction_currency?:  string,
 *   balance_difference_kind?: string,
 * }
 *
 * Side effects:
 *  - Inserts cash_transactions (type='bill_payment', direction='out')
 *  - Inserts supplier_invoice_payments
 *  - Recomputes invoice outstanding_balance and payment_status
 *  - Runs same multi-currency movement logic as the expense route
 */
router.post("/cash-sessions/:id/bill-payment", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_transactions.create")) {
    res.status(403).json({ error: "Insufficient permissions to record cash expenses" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Bill payments can only be recorded on an open session" });
    return;
  }

  // Idempotency
  const billPaymentIdempotencyKey =
    typeof req.headers["x-idempotency-key"] === "string"
      ? req.headers["x-idempotency-key"]
      : null;
  if (billPaymentIdempotencyKey) {
    const cached = checkQuickEntryIdempotency(billPaymentIdempotencyKey);
    if (cached) { res.status(409).json(cached); return; }
  }

  const body = req.body ?? {};

  // ── Validate supplier_invoice_id ──────────────────────────────────────────
  const invoiceId = Number(body.supplier_invoice_id);
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
    res.status(400).json({ error: "supplier_invoice_id is required" });
    return;
  }

  const invoiceResult = await db.query<{
    id: number;
    supplier_id: number;
    currency: string;
    amount: string;
    grand_total: string | null;
    outstanding_balance: string | null;
    payment_status: string;
    status: string;
    invoice_number: string | null;
  }>(
    `SELECT id, supplier_id, currency, amount, grand_total, outstanding_balance,
            payment_status, COALESCE(status, 'issued') AS status, invoice_number
       FROM supplier_invoices
      WHERE id = $1 AND workspace_owner_id = $2`,
    [invoiceId, wreq.workspaceOwnerId],
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) {
    res.status(404).json({ error: "Supplier invoice not found" });
    return;
  }

  // Validate invoice is payable.
  const PAYABLE_STATUSES = ["unpaid", "partially_paid"] as const;
  const NON_PAYABLE_DOC_STATUSES = ["cancelled", "voided", "draft"] as const;
  if (!PAYABLE_STATUSES.includes(invoice.payment_status as (typeof PAYABLE_STATUSES)[number])) {
    res.status(409).json({ error: `Invoice is already ${invoice.payment_status} and cannot be paid` });
    return;
  }
  if (NON_PAYABLE_DOC_STATUSES.includes(invoice.status as (typeof NON_PAYABLE_DOC_STATUSES)[number])) {
    res.status(409).json({ error: `Invoice is ${invoice.status} and cannot be paid` });
    return;
  }

  // ── Validate payment_amount ───────────────────────────────────────────────
  const paymentAmount = Number(body.payment_amount);
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    res.status(400).json({ error: "payment_amount must be a positive number" });
    return;
  }

  // Use the stored snapshot; fall back to grand_total / amount for legacy rows.
  const outstandingBalance = Number(
    invoice.outstanding_balance ?? invoice.grand_total ?? invoice.amount,
  );

  // Stale-balance guard: reject if balance is already 0.
  if (outstandingBalance <= 0) {
    res.status(409).json({ error: "Invoice is already fully paid" });
    return;
  }
  if (paymentAmount > outstandingBalance + 0.001) {
    res.status(400).json({
      error: `Payment amount (${paymentAmount.toFixed(2)}) exceeds the outstanding balance (${outstandingBalance.toFixed(2)})`,
    });
    return;
  }

  // ── Validate currency ─────────────────────────────────────────────────────
  const currency = String(body.currency ?? "").trim().toUpperCase();
  const allowed = await allowedCurrenciesFor(session, wreq.workspaceOwnerId);
  if (!currency || !allowed.includes(currency)) {
    res.status(400).json({ error: "currency must be one of the drawer's currencies" });
    return;
  }

  // ── Multi-currency settlement validation ──────────────────────────────────
  const paymentsRaw = Array.isArray(body.payments) ? body.payments : null;
  const changeRaw   = Array.isArray(body.change) ? body.change : [];
  const transactionCurrency = paymentsRaw
    ? String(body.transaction_currency ?? currency).trim().toUpperCase() || currency
    : currency;
  const balanceDifferenceKind = body.balance_difference_kind
    ? String(body.balance_difference_kind).trim() || null
    : null;

  const ALLOWED_BALANCE_DIFFERENCE_KINDS_BP = ["rounding", "fx_difference", "overpayment"] as const;
  const BALANCE_TOLERANCE_BP = 0.05;

  type RawLineBP = { amount?: unknown; currency?: unknown; exchange_rate?: unknown; is_rate_override?: unknown };

  function validateAndConvertLinesBP(
    lines: RawLineBP[],
    label: string,
  ): { ok: true; total: number } | { ok: false; error: string } {
    let total = 0;
    for (const line of lines) {
      const lineAmt = Number(line.amount);
      if (!Number.isFinite(lineAmt) || lineAmt <= 0) {
        return { ok: false, error: `Invalid ${label} line: amount must be a positive number` };
      }
      const lineCurrency = String(line.currency ?? "").trim().toUpperCase();
      if (!lineCurrency) {
        return { ok: false, error: `Invalid ${label} line: currency is required` };
      }
      if (!allowed.includes(lineCurrency)) {
        return {
          ok: false,
          error: `Invalid ${label} line: currency ${lineCurrency} is not accepted by this drawer (allowed: ${allowed.join(", ")})`,
        };
      }
      if (line.exchange_rate != null) {
        const lineRate = Number(line.exchange_rate);
        if (!Number.isFinite(lineRate) || lineRate <= 0) {
          return { ok: false, error: `Invalid ${label} line: exchange_rate must be a positive number` };
        }
        total += lineAmt * lineRate;
      } else if (lineCurrency === transactionCurrency) {
        total += lineAmt;
      }
    }
    return { ok: true, total };
  }

  if (paymentsRaw) {
    const hasOverrideBP =
      paymentsRaw.some((l: RawLineBP) => l.is_rate_override) ||
      changeRaw.some((l: RawLineBP) => l.is_rate_override);
    if (hasOverrideBP && !hasPermission(wreq, "cash_sessions.adjust")) {
      res.status(403).json({ error: "Exchange rate overrides require the cash_sessions.adjust permission" });
      return;
    }

    const paymentsResultBP = validateAndConvertLinesBP(paymentsRaw as RawLineBP[], "payment");
    if (!paymentsResultBP.ok) { res.status(400).json({ error: paymentsResultBP.error }); return; }
    const changeResultBP = validateAndConvertLinesBP(changeRaw as RawLineBP[], "change");
    if (!changeResultBP.ok) { res.status(400).json({ error: changeResultBP.error }); return; }

    const diff = Math.abs(paymentsResultBP.total - changeResultBP.total - paymentAmount);
    if (
      diff > BALANCE_TOLERANCE_BP &&
      (!balanceDifferenceKind || !ALLOWED_BALANCE_DIFFERENCE_KINDS_BP.includes(
        balanceDifferenceKind as (typeof ALLOWED_BALANCE_DIFFERENCE_KINDS_BP)[number],
      ))
    ) {
      res.status(422).json({
        error:
          `Payment amounts do not balance: expected ${paymentAmount.toFixed(2)} ${transactionCurrency}, ` +
          `received ${(paymentsResultBP.total - changeResultBP.total).toFixed(2)} ` +
          `(difference ${diff.toFixed(2)}). ` +
          `Provide a balance_difference_kind (rounding | fx_difference | overpayment) to classify the residual.`,
      });
      return;
    }
  }

  // ── Build description from supplier name ──────────────────────────────────
  const userId = authed(req).userId;
  const supplierResult = await db.query<{ name: string }>(
    `SELECT name FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [invoice.supplier_id, wreq.workspaceOwnerId],
  );
  const supplierName = supplierResult.rows[0]?.name ?? "Unknown Supplier";
  const billRef = invoice.invoice_number ?? String(invoice.id);
  const description = `Bill payment — ${supplierName} #${billRef}`;

  // ── Record cash transaction ───────────────────────────────────────────────
  const result = await recordCashTransaction({
    workspaceOwnerId: wreq.workspaceOwnerId,
    amount:           paymentAmount,
    type:             "bill_payment",
    direction:        "out",
    currency:         transactionCurrency,
    drawerId:         session.drawer_id,
    locationId:       session.location_id,
    description,
    referenceType:    "supplier_invoice",
    referenceId:      String(invoiceId),
    createdByClerkId: userId,
    cashSessionId:    session.id,
  });

  // ── Insert supplier_invoice_payments row ──────────────────────────────────
  await db.query(
    `INSERT INTO supplier_invoice_payments
       (workspace_owner_id, supplier_invoice_id, cash_transaction_id, amount, currency, paid_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      wreq.workspaceOwnerId,
      invoiceId,
      result.transactionId,
      paymentAmount.toFixed(4),
      invoice.currency,           // store in bill's native currency
    ],
  );

  // ── Recompute invoice outstanding_balance and payment_status ──────────────
  await recomputeInvoicePaymentStatus(invoiceId, wreq.workspaceOwnerId);

  // ── Multi-currency movement rows ──────────────────────────────────────────
  if (paymentsRaw) {
    await db.query(
      `UPDATE cash_transactions
          SET transaction_currency = $1, balance_difference_kind = $2
        WHERE id = $3 AND workspace_owner_id = $4`,
      [transactionCurrency, balanceDifferenceKind, result.transactionId, wreq.workspaceOwnerId],
    );
    await insertMovementRows(
      wreq.workspaceOwnerId, result.transactionId, userId,
      paymentsRaw, "outflow", "expense_payment", id,
    );
    if (changeRaw.length > 0) {
      await insertMovementRows(
        wreq.workspaceOwnerId, result.transactionId, userId,
        changeRaw, "inflow", "change", id,
      );
    }
    await recomputeSessionTotals(id, wreq.workspaceOwnerId);
  }

  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "bill_payment_recorded",
    userId,
    null,
    JSON.stringify({
      transactionId:  result.transactionId,
      invoiceId,
      amount:         paymentAmount.toFixed(2),
      currency:       transactionCurrency,
      multi_currency: Boolean(paymentsRaw),
    }),
  );

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  const billPaymentResponseBody = { session: refreshed, transaction_id: result.transactionId };
  if (billPaymentIdempotencyKey) storeQuickEntryIdempotency(billPaymentIdempotencyKey, billPaymentResponseBody);
  res.status(201).json(billPaymentResponseBody);
});

/**
 * GET /api/cash-sessions/:id/transactions/:txId/movements
 * Return all movement rows for a transaction (multi-currency settlement lines).
 */
router.get("/cash-sessions/:id/transactions/:txId/movements", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  const txId = parseInt(req.params.txId, 10);
  if (isNaN(id) || isNaN(txId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Verify the transaction belongs to this session and workspace.
  const txCheck = await db.query(
    `SELECT id FROM cash_transactions
      WHERE id = $1 AND cash_session_id = $2 AND workspace_owner_id = $3`,
    [txId, id, wreq.workspaceOwnerId],
  );
  if (txCheck.rowCount === 0) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  const result = await db.query<{
    id: number;
    direction: string;
    kind: string;
    amount: string;
    currency: string;
    exchange_rate: string | null;
    converted_amount: string | null;
    rate_source: string | null;
    override_approved_by: string | null;
    created_at: string;
  }>(
    `SELECT id, direction, kind, amount, currency, exchange_rate, converted_amount,
            rate_source, override_approved_by, created_at
       FROM cash_transaction_movements
      WHERE cash_transaction_id = $1
      ORDER BY id`,
    [txId],
  );
  res.json({ movements: result.rows });
});

/**
 * POST /api/cash-sessions/:id/transactions/:txId/reverse
 * Correct a transaction by recording a linked opposite-direction reversal.
 * The original stays visible and is marked reversed. Requires a reason.
 */
router.post("/cash-sessions/:id/transactions/:txId/reverse", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.adjust")) {
    res.status(403).json({ error: "Insufficient permissions to reverse cash transactions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  const txId = parseInt(req.params.txId, 10);
  if (isNaN(id) || isNaN(txId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Corrections can only be made on an open session" });
    return;
  }
  const reason = String((req.body ?? {}).reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "A correction reason is required" });
    return;
  }

  const txResult = await db.query<{
    id: number;
    type: string;
    direction: string;
    amount: string;
    currency: string;
    description: string | null;
    is_reversed: boolean;
  }>(
    `SELECT id, type, direction, amount, currency, description, is_reversed
       FROM cash_transactions
      WHERE id = $1 AND cash_session_id = $2 AND workspace_owner_id = $3`,
    [txId, id, wreq.workspaceOwnerId],
  );
  const original = txResult.rows[0];
  if (!original) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  if (original.type === "reversal") {
    res.status(400).json({ error: "A reversal cannot be reversed" });
    return;
  }
  if (original.is_reversed) {
    res.status(409).json({ error: "This transaction has already been reversed" });
    return;
  }

  const userId = authed(req).userId;
  const reversedDirection = original.direction === "in" ? "out" : "in";
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO cash_transactions
       (workspace_owner_id, cash_session_id, cash_drawer_id, location_id, currency,
        type, direction, amount, description, reference_type, reference_id,
        reversal_of_id, reversal_reason, created_by_clerk_id)
     VALUES ($1, $2, $3, $4, $5, 'reversal', $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      wreq.workspaceOwnerId,
      id,
      session.drawer_id,
      session.location_id,
      original.currency,
      reversedDirection,
      original.amount,
      `Reversal of #${original.id}${original.description ? ` — ${original.description}` : ""}`,
      `reversal:${original.type}`,
      String(original.id),
      original.id,
      reason,
      userId,
    ],
  );
  const reversalId = inserted.rows[0].id;
  await db.query(
    `UPDATE cash_transactions SET is_reversed = true WHERE id = $1 AND workspace_owner_id = $2`,
    [original.id, wreq.workspaceOwnerId],
  );

  // Mirror any movement rows from the original transaction onto the reversal,
  // flipping direction so the physical drawer impact is exactly cancelled.
  const originalMovements = await db.query<{
    direction: string;
    kind: string;
    amount: string;
    currency: string;
    exchange_rate: string | null;
    converted_amount: string | null;
    rate_source: string | null;
  }>(
    `SELECT direction, kind, amount, currency, exchange_rate, converted_amount, rate_source
       FROM cash_transaction_movements
      WHERE cash_transaction_id = $1`,
    [original.id],
  );
  for (const m of originalMovements.rows) {
    const mirrorDirection = m.direction === "inflow" ? "outflow" : "inflow";
    await db.query(
      `INSERT INTO cash_transaction_movements
         (workspace_owner_id, cash_transaction_id, direction, kind,
          amount, currency, exchange_rate, converted_amount, rate_source, created_by_clerk_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        wreq.workspaceOwnerId,
        reversalId,
        mirrorDirection,
        m.kind,
        m.amount,
        m.currency,
        m.exchange_rate,
        m.converted_amount,
        m.rate_source,
        userId,
      ],
    );
  }

  await recomputeSessionTotals(id, wreq.workspaceOwnerId);

  // If the original was a bill_payment, also reverse the linked
  // supplier_invoice_payments record and recompute the invoice balance.
  if (original.type === "bill_payment") {
    const sipRow = await db.query<{ id: number; supplier_invoice_id: number }>(
      `UPDATE supplier_invoice_payments
          SET is_reversed = true
        WHERE cash_transaction_id = $1 AND workspace_owner_id = $2 AND is_reversed = false
        RETURNING id, supplier_invoice_id`,
      [original.id, wreq.workspaceOwnerId],
    );
    if (sipRow.rows[0]) {
      await recomputeInvoicePaymentStatus(sipRow.rows[0].supplier_invoice_id, wreq.workspaceOwnerId);
    }
  }

  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "transaction_reversed",
    userId,
    null,
    JSON.stringify({ originalId: original.id, reversalId, reason, amount: original.amount, currency: original.currency }),
  );

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  res.status(201).json({ session: refreshed, reversal_id: reversalId });
});

/**
 * POST /api/cash-sessions/:id/bill/invoice
 * Upload an optional invoice file (image or PDF) for a bill and return its
 * object-storage path. The frontend uploads first, then passes the resulting
 * URL to the bill endpoint. Same permission as adjusting a session.
 */
router.post("/cash-sessions/:id/bill/invoice", upload.single("invoice"), async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.adjust")) {
    res.status(403).json({ error: "Insufficient permissions to adjust cash sessions" });
    return;
  }
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "An invoice file is required" });
    return;
  }
  const mime = file.mimetype as string;
  if (!ALLOWED_INVOICE_MIME.includes(mime as (typeof ALLOWED_INVOICE_MIME)[number])) {
    res.status(400).json({ error: "Invoice must be a JPEG, PNG, WebP, or PDF file" });
    return;
  }
  try {
    const url = await uploadInvoiceToStorage(file.buffer, mime, wreq.workspaceOwnerId);
    res.json({ url });
  } catch (err) {
    logger.error({ err }, "Failed to upload bill invoice");
    res.status(500).json({ error: "Failed to upload invoice" });
  }
});

/**
 * POST /api/cash-sessions/:id/bill
 * Record a bill (money paid out of the drawer against an invoice/expense) on an
 * open session. Mirrors /adjustment but always direction "out" and accepts an
 * optional already-uploaded invoice attachment URL.
 */
router.post("/cash-sessions/:id/bill", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.adjust")) {
    res.status(403).json({ error: "Insufficient permissions to adjust cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Bills can only be added to an open session" });
    return;
  }

  const { amount, description, attachment_url } = req.body ?? {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const note = String(description ?? "").trim();
  if (!note) {
    res.status(400).json({ error: "description is required for a bill" });
    return;
  }

  let attachmentUrl: string | null = null;
  if (attachment_url != null && String(attachment_url).trim()) {
    const raw = String(attachment_url).trim();
    if (!raw.startsWith(`/objects/${wreq.workspaceOwnerId}/`)) {
      res.status(400).json({ error: "Invalid invoice attachment" });
      return;
    }
    attachmentUrl = raw;
  }

  // On dual-currency sessions the caller may pick which currency the bill is in.
  let billCurrency = session.currency;
  const requestedBillCurrency = String((req.body ?? {}).currency ?? "").trim().toUpperCase();
  if (requestedBillCurrency) {
    if (
      requestedBillCurrency !== session.currency &&
      requestedBillCurrency !== session.secondary_currency
    ) {
      res.status(400).json({ error: "currency must be one of the session's currencies" });
      return;
    }
    billCurrency = requestedBillCurrency;
  }

  const userId = authed(req).userId;
  const result = await recordCashTransaction({
    workspaceOwnerId: wreq.workspaceOwnerId,
    amount: amt,
    type: "bill",
    direction: "out",
    currency: billCurrency,
    drawerId: session.drawer_id,
    locationId: session.location_id,
    description: note,
    referenceType: "bill",
    attachmentUrl,
    createdByClerkId: userId,
    cashSessionId: session.id,
  });

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  res.status(201).json({ session: refreshed, transaction_id: result.transactionId });
});

/** Load a bill transaction scoped to a session + workspace. */
async function loadBill(
  txId: number,
  sessionId: number,
  workspaceOwnerId: string,
): Promise<{ id: number; type: string; attachment_url: string | null } | null> {
  const r = await db.query<{ id: number; type: string; attachment_url: string | null }>(
    `SELECT id, type, attachment_url
       FROM cash_transactions
      WHERE id = $1 AND cash_session_id = $2 AND workspace_owner_id = $3`,
    [txId, sessionId, workspaceOwnerId],
  );
  return r.rows[0] ?? null;
}

/**
 * PATCH /api/cash-sessions/:id/bill/:txId
 * Edit a recorded bill (amount, description, invoice attachment) on an open
 * session. Same permission/scoping as creating a bill. Recomputes totals.
 */
router.patch("/cash-sessions/:id/bill/:txId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.adjust")) {
    res.status(403).json({ error: "Insufficient permissions to adjust cash sessions" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  const txId = parseInt(req.params.txId, 10);
  if (isNaN(id) || isNaN(txId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const session = await loadSession(id, wreq.workspaceOwnerId);
  if (!session) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  if (session.status !== "open") {
    res.status(409).json({ error: "Bills can only be edited on an open session" });
    return;
  }

  const existing = await loadBill(txId, id, wreq.workspaceOwnerId);
  if (!existing) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  if (existing.type !== "bill") {
    res.status(400).json({ error: "Only bills can be edited" });
    return;
  }

  const { amount, description, attachment_url } = req.body ?? {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const note = String(description ?? "").trim();
  if (!note) {
    res.status(400).json({ error: "description is required for a bill" });
    return;
  }

  // attachment_url omitted → keep existing; empty → clear; otherwise validate.
  let attachmentUrl: string | null = existing.attachment_url;
  if (attachment_url !== undefined) {
    const raw = String(attachment_url ?? "").trim();
    if (!raw) {
      attachmentUrl = null;
    } else if (!raw.startsWith(`/objects/${wreq.workspaceOwnerId}/`)) {
      res.status(400).json({ error: "Invalid invoice attachment" });
      return;
    } else {
      attachmentUrl = raw;
    }
  }

  const userId = authed(req).userId;
  await db.query(
    `UPDATE cash_transactions
        SET amount = $1, description = $2, attachment_url = $3, has_receipt = $4
      WHERE id = $5 AND cash_session_id = $6 AND workspace_owner_id = $7`,
    [amt.toFixed(2), note, attachmentUrl, Boolean(attachmentUrl), txId, id, wreq.workspaceOwnerId],
  );

  await recomputeSessionTotals(id, wreq.workspaceOwnerId);
  await logSessionActivity(
    wreq.workspaceOwnerId,
    id,
    "bill_edited",
    userId,
    null,
    JSON.stringify({ transactionId: txId, amount: amt.toFixed(2), description: note }),
  );

  const refreshed = await loadSession(id, wreq.workspaceOwnerId);
  res.json({ session: refreshed, transaction_id: txId });
});

/**
 * DELETE /api/cash-sessions/:id/bill/:txId
 * Hard deletes are no longer allowed — cash transactions are permanent.
 * Corrections must be recorded as linked reversals via
 * POST /cash-sessions/:id/transactions/:txId/reverse.
 */
router.delete("/cash-sessions/:id/bill/:txId", async (_req, res) => {
  res.status(405).json({
    error: "Cash transactions cannot be deleted. Record a correction as a reversal instead.",
  });
});

/**
 * POST /api/cash-transactions
 * Record a cash sale/expense/other and auto-link to the open session for the
 * drawer (or location + currency). This is the integration entry point for
 * cash sales and cash expenses.
 */
router.post("/cash-transactions", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_transactions.create")) {
    res.status(403).json({ error: "Insufficient permissions to record cash transactions" });
    return;
  }
  const body = req.body ?? {};
  const amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const type = String(body.type ?? "sale").trim() || "sale";
  if (!["sale", "expense", "other"].includes(type)) {
    res.status(400).json({ error: "type must be one of sale, expense, other" });
    return;
  }
  const direction = body.direction === "out" ? "out" : body.direction === "in" ? "in" : undefined;
  const userId = authed(req).userId;

  const result = await recordCashTransaction({
    workspaceOwnerId: wreq.workspaceOwnerId,
    amount: amt,
    type,
    direction,
    currency: body.currency ? String(body.currency).trim().toUpperCase() : undefined,
    drawerId: body.drawer_id != null && Number.isFinite(Number(body.drawer_id)) ? Number(body.drawer_id) : undefined,
    locationId: body.location_id != null && Number.isFinite(Number(body.location_id)) ? Number(body.location_id) : undefined,
    description: body.description ? String(body.description).trim() : null,
    referenceType: body.reference_type ? String(body.reference_type).trim() : null,
    referenceId: body.reference_id ? String(body.reference_id).trim() : null,
    hasReceipt: Boolean(body.has_receipt),
    createdByClerkId: userId,
  });

  res.status(201).json(result);
});

export default router;
