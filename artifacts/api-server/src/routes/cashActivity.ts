/**
 * Cash Activity API routes.
 *
 * Mounted WITHOUT the /api prefix in this file; the parent router adds it.
 * All paths here are relative to /api/cash-activity.
 */
import { Router } from "express";
import { z } from "zod";
import { db, withTransaction } from "../lib/db";
import { requireAuth, authed } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  getCashActivityChart,
  getCashActivitySummary,
  getPaginatedTransactions,
  getOrCreateMonthStatus,
  validateMatchEligibility,
  parseYearMonth,
  type MatchCandidate,
} from "../lib/cashActivity";
import type { Request, Response } from "express";

const router = Router();

// Apply auth + workspace middleware to all cash-activity routes, matching the
// pattern used by every adjacent cash router (cashSessions, cashDrawers, etc.).
router.use(requireAuth, resolveWorkspace);

// ── YEAR_MONTH_RE ─────────────────────────────────────────────────────────────

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── Permission helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the authenticated user has at least general Cash Activity
 * read access: workspace owner, or "cash-activity" in allowedPages.
 *
 * Uses the real WorkspaceRequest fields set by resolveWorkspace middleware.
 */
function hasCashActivityAccess(req: Request): boolean {
  const wreq = workspace(req);
  if (wreq.workspaceRole === "owner") return true;
  return !!wreq.allowedPages?.includes("cash-activity");
}

/**
 * Returns true if the authenticated user has Finance Admin access required
 * for unmatch, finalize, and reopen: workspace owner, or
 * "cash-activity-admin" in allowedPages.
 */
function hasCashActivityAdmin(req: Request): boolean {
  const wreq = workspace(req);
  if (wreq.workspaceRole === "owner") return true;
  return !!wreq.allowedPages?.includes("cash-activity-admin");
}

/** Returns the authenticated user's ID set by requireAuth middleware. */
function actorId(req: Request): string {
  return authed(req).userId;
}

// ── Shared query param schema ─────────────────────────────────────────────────

const baseFilterSchema = z.object({
  yearMonth: z.string().regex(YEAR_MONTH_RE, "yearMonth must be YYYY-MM (e.g. 2026-08)"),
  entityId: z.coerce.number().int().positive().optional().nullable(),
  locationId: z.coerce.number().int().positive().optional().nullable(),
  drawerId: z.coerce.number().int().positive().optional().nullable(),
  currency: z.string().min(1).max(10).optional().nullable(),
});

// ── GET /cash-activity/transactions ──────────────────────────────────────────

router.get("/cash-activity/transactions", async (req: Request, res: Response) => {
  if (!hasCashActivityAccess(req)) {
    return res.status(403).json({ error: "Finance access required" });
  }

  const qs = z
    .object({
      ...baseFilterSchema.shape,
      tab: z.enum(["unmatched", "matched", "needs-review"]).optional(),
      search: z.string().optional().nullable(),
      type: z.string().optional().nullable(),
      evidence: z.enum(["with", "without"]).optional().nullable(),
      status: z.string().optional().nullable(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
    })
    .safeParse(req.query);

  if (!qs.success) {
    return res.status(400).json({ error: "Invalid query parameters", details: qs.error.issues });
  }

  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;

  try {
    const result = await getPaginatedTransactions({
      workspaceOwnerId,
      yearMonth: qs.data.yearMonth,
      entityId: qs.data.entityId,
      locationId: qs.data.locationId,
      drawerId: qs.data.drawerId,
      currency: qs.data.currency,
      tab: qs.data.tab,
      search: qs.data.search,
      typeFilter: qs.data.type,
      evidenceFilter: qs.data.evidence,
      statusFilter: qs.data.status,
      page: qs.data.page,
      pageSize: qs.data.pageSize,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

// ── GET /cash-activity/summary ────────────────────────────────────────────────

router.get("/cash-activity/summary", async (req: Request, res: Response) => {
  if (!hasCashActivityAccess(req)) {
    return res.status(403).json({ error: "Finance access required" });
  }

  const qs = baseFilterSchema.safeParse(req.query);
  if (!qs.success) {
    return res.status(400).json({ error: "Invalid query parameters", details: qs.error.issues });
  }

  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;

  try {
    const summary = await getCashActivitySummary({
      workspaceOwnerId,
      yearMonth: qs.data.yearMonth,
      entityId: qs.data.entityId,
      locationId: qs.data.locationId,
      drawerId: qs.data.drawerId,
      currency: qs.data.currency,
    });
    return res.json({ summary });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

// ── GET /cash-activity/chart ──────────────────────────────────────────────────

router.get("/cash-activity/chart", async (req: Request, res: Response) => {
  if (!hasCashActivityAccess(req)) {
    return res.status(403).json({ error: "Finance access required" });
  }

  const qs = baseFilterSchema.safeParse(req.query);
  if (!qs.success) {
    return res.status(400).json({ error: "Invalid query parameters", details: qs.error.issues });
  }

  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;

  try {
    const series = await getCashActivityChart({
      workspaceOwnerId,
      yearMonth: qs.data.yearMonth,
      entityId: qs.data.entityId,
      locationId: qs.data.locationId,
      drawerId: qs.data.drawerId,
      currency: qs.data.currency,
    });
    return res.json({ series });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

// ── POST /cash-activity/match ─────────────────────────────────────────────────

const matchBodySchema = z.object({
  transactionIds: z.array(z.number().int().positive()).min(2),
  yearMonth: z.string().regex(YEAR_MONTH_RE, "yearMonth must be YYYY-MM"),
  entityId: z.number().int().positive().optional().nullable(),
  locationId: z.number().int().positive().optional().nullable(),
  drawerId: z.number().int().positive().optional().nullable(),
  currency: z.string().optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
});

router.post("/cash-activity/match", async (req: Request, res: Response) => {
  if (!hasCashActivityAccess(req)) {
    return res.status(403).json({ error: "Finance access required" });
  }

  const body = matchBodySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid request body", details: body.error.issues });
  }

  const { transactionIds, yearMonth, entityId, locationId, drawerId, currency, note } = body.data;
  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;
  const actor = actorId(req);

  const client = await db.connect();
  try {
    const groupId = await withTransaction(client, async () => {
      // Fetch candidate rows, including drawer entity_id for entity validation
      const txResult = await client.query<MatchCandidate>(
        `SELECT ct.id, ct.workspace_owner_id, ct.currency, ct.direction, ct.amount,
                ct.status, ct.approval_status, ct.is_reversed,
                ct.cash_drawer_id, cd.entity_id AS drawer_entity_id,
                ct.location_id, ct.transaction_date, ct.type
           FROM cash_transactions ct
           LEFT JOIN cash_drawers cd ON cd.id = ct.cash_drawer_id
          WHERE ct.id = ANY($1)
            AND ct.workspace_owner_id = $2`,
        [transactionIds, workspaceOwnerId],
      );

      if (txResult.rows.length !== transactionIds.length) {
        throw Object.assign(new Error("One or more transactions not found"), { status: 404 });
      }

      // ── Step 1: Derive all group dimensions from the validated transaction rows.
      // This MUST happen before the month lock so the correct entity-scoped row
      // is locked (not the workspace-level row when entityId is omitted).
      const first = txResult.rows[0];
      const derivedCurrency = first.currency;
      const derivedEntityId = first.drawer_entity_id ?? null;
      const derivedLocationId = first.location_id ?? null;
      const allDrawerIds = new Set(txResult.rows.map((r) => r.cash_drawer_id).filter(Boolean));
      const derivedDrawerId = allDrawerIds.size === 1 ? first.cash_drawer_id : null;

      // Validate caller-supplied values against derived values before locking.
      if (currency != null && currency !== derivedCurrency) {
        throw Object.assign(
          new Error(`Supplied currency '${currency}' does not match transactions' currency '${derivedCurrency}'`),
          { status: 422, errors: [`currency mismatch: supplied ${currency}, transactions have ${derivedCurrency}`] },
        );
      }
      if (entityId != null && entityId !== derivedEntityId) {
        throw Object.assign(
          new Error(`Supplied entityId ${entityId} does not match transactions' entity ${derivedEntityId}`),
          { status: 422, errors: [`entityId mismatch: supplied ${entityId}, transactions belong to entity ${derivedEntityId}`] },
        );
      }

      // ── Step 2: Lock the derived entity-month row.
      // Use derivedEntityId (from transaction drawers) — NOT the caller-supplied
      // entityId — so the lock is always on the correct entity-scoped row even
      // when the caller omits entityId. This prevents the race where:
      //   • match omits entityId → locks workspace-level row
      //   • concurrent finalize locks entity-E row → finalizes unchecked
      //   • match inserts bridge rows after finalization
      await client.query(
        `INSERT INTO cash_activity_months (workspace_owner_id, entity_id, year_month)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [workspaceOwnerId, derivedEntityId, yearMonth],
      );
      const monthResult = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM cash_activity_months
          WHERE workspace_owner_id = $1
            AND year_month = $2
            AND ($3::integer IS NULL AND entity_id IS NULL OR entity_id = $3)
          FOR UPDATE`,
        [workspaceOwnerId, yearMonth, derivedEntityId],
      );
      const monthStatus = monthResult.rows[0]?.status ?? "OPEN";

      // Rule 1: entity-month must be OPEN
      if (monthStatus === "FINALIZED") {
        throw Object.assign(
          new Error(`Accounting month ${yearMonth} is finalized; no changes allowed`),
          { status: 409 },
        );
      }

      // ── Hierarchical lock: also lock the workspace-level (null-entity) month row.
      // Without this, a workspace-scoped finalize can commit concurrently with an
      // entity-scoped match because they lock different rows. Holding both locks in
      // the same transaction serializes them correctly.
      if (derivedEntityId !== null) {
        await client.query(
          `INSERT INTO cash_activity_months (workspace_owner_id, entity_id, year_month)
           VALUES ($1, NULL, $2)
           ON CONFLICT DO NOTHING`,
          [workspaceOwnerId, yearMonth],
        );
        const wsMonthResult = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM cash_activity_months
            WHERE workspace_owner_id = $1
              AND year_month = $2
              AND entity_id IS NULL
            FOR UPDATE`,
          [workspaceOwnerId, yearMonth],
        );
        const wsMonthStatus = wsMonthResult.rows[0]?.status ?? "OPEN";
        if (wsMonthStatus === "FINALIZED") {
          throw Object.assign(
            new Error(`Accounting month ${yearMonth} is finalized at workspace level; no changes allowed`),
            { status: 409 },
          );
        }
      }

      // Run the remaining eligibility checks (Rules 2–8 + entity rule)
      const eligibility = validateMatchEligibility(
        txResult.rows,
        "OPEN", // month check already passed above
        yearMonth,
        entityId,
      );
      if (!eligibility.valid) {
        throw Object.assign(new Error(eligibility.errors.join("; ")), {
          status: 422,
          errors: eligibility.errors,
        });
      }

      // Create the match group using exclusively derived (transaction-validated) values
      const groupResult = await client.query<{ id: number }>(
        `INSERT INTO cash_match_groups
           (workspace_owner_id, entity_id, location_id, cash_drawer_id,
            currency, accounting_month, matched_by, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          workspaceOwnerId,
          derivedEntityId,
          derivedLocationId,
          derivedDrawerId,
          derivedCurrency,
          yearMonth,
          actor,
          note ?? null,
        ],
      );
      const newGroupId = groupResult.rows[0].id;

      // Insert bridge rows. UNIQUE(transaction_id) prevents double-matching.
      // Any duplicate will cause a pg 23505 unique violation → caught → 409.
      for (const txId of transactionIds) {
        await client.query(
          `INSERT INTO cash_match_group_transactions (match_group_id, transaction_id)
           VALUES ($1, $2)`,
          [newGroupId, txId],
        );
      }

      // Write audit log (same transaction — atomic with the state change above)
      await client.query(
        `INSERT INTO cash_activity_audit_log
           (workspace_owner_id, entity_id, action, actor, payload)
         VALUES ($1, $2, 'MATCH', $3, $4::jsonb)`,
        [
          workspaceOwnerId,
          derivedEntityId,
          actor,
          JSON.stringify({
            groupId: newGroupId,
            transactionIds,
            yearMonth,
            note: note ?? null,
          }),
        ],
      );

      return newGroupId;
    });

    return res.status(201).json({ groupId });
  } catch (err: any) {
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ error: "One or more transactions are already part of an active match group" });
    }
    const status = err.status ?? 500;
    return res.status(status).json({
      error: err.message ?? "Internal server error",
      errors: err.errors,
    });
  } finally {
    client.release();
  }
});

// ── DELETE /cash-activity/match/:groupId ──────────────────────────────────────

router.delete("/cash-activity/match/:groupId", async (req: Request, res: Response) => {
  if (!hasCashActivityAdmin(req)) {
    return res.status(403).json({ error: "Finance Admin access required" });
  }

  const rawGroupId = parseInt(req.params.groupId as string, 10);
  if (!Number.isFinite(rawGroupId) || rawGroupId <= 0) {
    return res.status(400).json({ error: "groupId must be a positive integer" });
  }

  const body = z
    .object({ reason: z.string().min(1, "reason is required").max(1000) })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "reason is required", details: body.error.issues });
  }

  const { reason } = body.data;
  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;
  const actor = actorId(req);

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Fetch and lock the group row to prevent concurrent unmatch + finalize
      const groupResult = await client.query<{
        id: number;
        status: string;
        accounting_month: string;
        entity_id: number | null;
      }>(
        `SELECT id, status, accounting_month, entity_id
           FROM cash_match_groups
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [rawGroupId, workspaceOwnerId],
      );

      const group = groupResult.rows[0];
      if (!group) {
        throw Object.assign(new Error("Match group not found"), { status: 404 });
      }
      if (group.status === "UNMATCHED") {
        throw Object.assign(
          new Error("This match group has already been unmatched"),
          { status: 409 },
        );
      }

      // Lock the month row before checking status to prevent unmatch racing with finalize.
      // An unmatched read that sees OPEN before a concurrent finalize commits would allow
      // bridge-row deletion after finalization — this FOR UPDATE prevents that.
      await client.query(
        `INSERT INTO cash_activity_months (workspace_owner_id, entity_id, year_month)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [workspaceOwnerId, group.entity_id, group.accounting_month],
      );
      const monthResult = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM cash_activity_months
          WHERE workspace_owner_id = $1
            AND year_month = $2
            AND ($3::integer IS NULL AND entity_id IS NULL OR entity_id = $3)
          FOR UPDATE`,
        [workspaceOwnerId, group.accounting_month, group.entity_id],
      );
      if (monthResult.rows[0]?.status === "FINALIZED") {
        throw Object.assign(
          new Error(`Accounting month ${group.accounting_month} is finalized; cannot unmatch`),
          { status: 409 },
        );
      }

      // ── Hierarchical lock: also lock workspace-level (null-entity) month row.
      // Without this, a workspace-scoped finalize can race with an entity-scoped
      // unmatch: finalize validates and commits while unmatch deletes bridge rows
      // afterward, leaving finalized activity mutable. Lock order matches match
      // route: entity-specific first, then workspace-null.
      if (group.entity_id !== null) {
        await client.query(
          `INSERT INTO cash_activity_months (workspace_owner_id, entity_id, year_month)
           VALUES ($1, NULL, $2)
           ON CONFLICT DO NOTHING`,
          [workspaceOwnerId, group.accounting_month],
        );
        const wsMonthResult = await client.query<{ id: number; status: string }>(
          `SELECT id, status FROM cash_activity_months
            WHERE workspace_owner_id = $1
              AND year_month = $2
              AND entity_id IS NULL
            FOR UPDATE`,
          [workspaceOwnerId, group.accounting_month],
        );
        const wsMonthStatus = wsMonthResult.rows[0]?.status ?? "OPEN";
        if (wsMonthStatus === "FINALIZED") {
          throw Object.assign(
            new Error(
              `Accounting month ${group.accounting_month} is finalized at workspace level; cannot unmatch`,
            ),
            { status: 409 },
          );
        }
      }

      // Collect the transaction IDs being released (for the audit payload)
      const bridgeResult = await client.query<{ transaction_id: number }>(
        `SELECT transaction_id FROM cash_match_group_transactions WHERE match_group_id = $1`,
        [rawGroupId],
      );
      const releasedTxIds = bridgeResult.rows.map((r) => r.transaction_id);

      // ── KEY FIX: delete bridge rows so released transactions can be re-matched.
      // The group row is preserved (status = UNMATCHED) for the audit trail.
      await client.query(
        `DELETE FROM cash_match_group_transactions WHERE match_group_id = $1`,
        [rawGroupId],
      );

      // Mark the group as UNMATCHED
      await client.query(
        `UPDATE cash_match_groups SET status = 'UNMATCHED', updated_at = now() WHERE id = $1`,
        [rawGroupId],
      );

      // Atomic audit log write (same transaction as the state changes above)
      await client.query(
        `INSERT INTO cash_activity_audit_log
           (workspace_owner_id, entity_id, action, actor, reason, payload)
         VALUES ($1, $2, 'UNMATCH', $3, $4, $5::jsonb)`,
        [
          workspaceOwnerId,
          group.entity_id,
          actor,
          reason,
          JSON.stringify({
            groupId: rawGroupId,
            releasedTransactionIds: releasedTxIds,
          }),
        ],
      );
    });

    return res.json({ success: true });
  } catch (err: any) {
    const status = err.status ?? 500;
    return res.status(status).json({ error: err.message ?? "Internal server error" });
  } finally {
    client.release();
  }
});

// ── GET /cash-activity/match-groups ──────────────────────────────────────────

router.get("/cash-activity/match-groups", async (req: Request, res: Response) => {
  if (!hasCashActivityAccess(req)) {
    return res.status(403).json({ error: "Finance access required" });
  }

  const qs = baseFilterSchema.safeParse(req.query);
  if (!qs.success) {
    return res.status(400).json({ error: "Invalid query parameters", details: qs.error.issues });
  }

  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;

  try {
    const result = await db.query<{
      id: number;
      entity_id: number | null;
      location_id: number | null;
      cash_drawer_id: number | null;
      currency: string;
      accounting_month: string;
      status: string;
      matched_by: string;
      created_at: string;
      note: string | null;
      transaction_ids: number[];
      total_in: string;
      total_out: string;
      transaction_count: string;
    }>(
      `SELECT
         cmg.id,
         cmg.entity_id,
         cmg.location_id,
         cmg.cash_drawer_id,
         cmg.currency,
         cmg.accounting_month,
         cmg.status,
         cmg.matched_by,
         cmg.created_at,
         cmg.note,
         COALESCE(ARRAY_AGG(cmgt.transaction_id ORDER BY cmgt.transaction_id), '{}') AS transaction_ids,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'in'), 0)::text AS total_in,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out'), 0)::text AS total_out,
         COUNT(cmgt.transaction_id)::text AS transaction_count
       FROM cash_match_groups cmg
       LEFT JOIN cash_match_group_transactions cmgt ON cmgt.match_group_id = cmg.id
       LEFT JOIN cash_transactions ct ON ct.id = cmgt.transaction_id
       WHERE cmg.workspace_owner_id = $1
         AND cmg.accounting_month = $2
         AND ($3::integer IS NULL OR cmg.entity_id = $3)
         AND ($4::integer IS NULL OR cmg.location_id = $4)
         AND ($5::integer IS NULL OR cmg.cash_drawer_id = $5)
         AND ($6::text IS NULL OR cmg.currency = $6)
         AND cmg.status = 'ACTIVE'
       GROUP BY cmg.id
       ORDER BY cmg.created_at DESC`,
      [
        workspaceOwnerId,
        qs.data.yearMonth,
        qs.data.entityId ?? null,
        qs.data.locationId ?? null,
        qs.data.drawerId ?? null,
        qs.data.currency ?? null,
      ],
    );

    return res.json({
      groups: result.rows.map((g) => ({
        id: g.id,
        entityId: g.entity_id,
        locationId: g.location_id,
        cashDrawerId: g.cash_drawer_id,
        currency: g.currency,
        accountingMonth: g.accounting_month,
        status: g.status,
        matchedBy: g.matched_by,
        createdAt: g.created_at,
        note: g.note,
        transactionIds: g.transaction_ids,
        totalIn: g.total_in,
        totalOut: g.total_out,
        transactionCount: parseInt(g.transaction_count, 10),
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

// ── GET /cash-activity/months/:yearMonth/status ───────────────────────────────

router.get("/cash-activity/months/:yearMonth/status", async (req: Request, res: Response) => {
  if (!hasCashActivityAccess(req)) {
    return res.status(403).json({ error: "Finance access required" });
  }

  const yearMonth = req.params.yearMonth as string;
  if (!YEAR_MONTH_RE.test(yearMonth)) {
    return res.status(400).json({ error: "yearMonth must be in YYYY-MM format (e.g. 2026-08)" });
  }

  const qs = z
    .object({ entityId: z.coerce.number().int().positive().optional().nullable() })
    .safeParse(req.query);
  if (!qs.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;

  try {
    const month = await getOrCreateMonthStatus(
      workspaceOwnerId,
      yearMonth,
      qs.data.entityId ?? null,
    );

    const { monthStart, monthEnd } = parseYearMonth(yearMonth);
    const entityId = qs.data.entityId ?? null;

    // Build entity scope clauses using parameterized queries.
    // Sessions are filtered via drawer_id → cash_drawers.entity_id.
    // Transactions are filtered via cash_drawer_id → cash_drawers.entity_id.
    const sessionParams: unknown[] = [workspaceOwnerId, monthStart, monthEnd];
    const sessionEntityClause = entityId != null
      ? (() => { sessionParams.push(entityId); return `AND cs.drawer_id IN (SELECT id FROM cash_drawers WHERE entity_id = $${sessionParams.length} AND workspace_owner_id = $1)`; })()
      : "";

    const txParams: unknown[] = [workspaceOwnerId, monthStart, monthEnd];
    const txEntityClause = entityId != null
      ? (() => { txParams.push(entityId); return `AND ct.cash_drawer_id IN (SELECT id FROM cash_drawers WHERE entity_id = $${txParams.length} AND workspace_owner_id = $1)`; })()
      : "";

    // Compute blocking conditions — must stay in sync with the finalize route.
    // Session lifecycle: open → pending_review → flagged → approved (no 'closed' status).
    // 'approved' is the terminal closed state; only non-approved, non-cancelled sessions block.
    const [openSessions, missingEvidence, pendingTransactions, unmatchedTxs] = await Promise.all([
      // cash_sessions uses opened_at (timestamptz) not session_date
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM cash_sessions cs
          WHERE cs.workspace_owner_id = $1
            AND cs.opened_at >= $2
            AND cs.opened_at < $3
            AND cs.status NOT IN ('approved', 'cancelled')
            ${sessionEntityClause}`,
        sessionParams,
      ),
      // Missing evidence: independent of match status
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM cash_transactions ct
          WHERE ct.workspace_owner_id = $1
            AND ct.transaction_date >= $2
            AND ct.transaction_date < $3
            AND ct.is_reversed = false
            AND ct.approval_status != 'cancelled'
            AND ct.has_receipt = false
            AND ct.attachment_url IS NULL
            ${txEntityClause}`,
        txParams,
      ),
      // Pending (unconfirmed) transactions
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM cash_transactions ct
          WHERE ct.workspace_owner_id = $1
            AND ct.transaction_date >= $2
            AND ct.transaction_date < $3
            AND ct.is_reversed = false
            AND ct.approval_status = 'pending'
            ${txEntityClause}`,
        txParams,
      ),
      // Unmatched confirmed transactions: active txns not in any ACTIVE match group
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM cash_transactions ct
          WHERE ct.workspace_owner_id = $1
            AND ct.transaction_date >= $2
            AND ct.transaction_date < $3
            AND ct.is_reversed = false
            AND ct.approval_status = 'confirmed'
            AND ct.id NOT IN (
              SELECT cmgt.transaction_id
                FROM cash_match_group_transactions cmgt
                JOIN cash_match_groups cmg ON cmg.id = cmgt.match_group_id
               WHERE cmg.status = 'ACTIVE'
                 AND cmg.workspace_owner_id = $1
            )
            ${txEntityClause}`,
        txParams,
      ),
    ]);

    const blockers: string[] = [];
    const openSessionCount = parseInt(openSessions.rows[0]?.count ?? "0", 10);
    const missingEvidenceCount = parseInt(missingEvidence.rows[0]?.count ?? "0", 10);
    const pendingCount = parseInt(pendingTransactions.rows[0]?.count ?? "0", 10);
    const unmatchedCount = parseInt(unmatchedTxs.rows[0]?.count ?? "0", 10);

    if (openSessionCount > 0) {
      blockers.push(`${openSessionCount} open session(s) must be closed before finalizing`);
    }
    if (missingEvidenceCount > 0) {
      blockers.push(`${missingEvidenceCount} transaction(s) are missing supporting evidence`);
    }
    if (pendingCount > 0) {
      blockers.push(`${pendingCount} transaction(s) are still pending approval`);
    }
    if (unmatchedCount > 0) {
      blockers.push(`${unmatchedCount} confirmed transaction(s) remain unmatched`);
    }

    return res.json({
      yearMonth: month.yearMonth,
      status: month.status,
      finalizedBy: month.finalizedBy,
      finalizedAt: month.finalizedAt,
      reopenReason: month.reopenReason,
      reopenActor: month.reopenActor,
      reopenAt: month.reopenAt,
      canFinalize: month.status === "OPEN" && blockers.length === 0,
      blockers,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

// ── POST /cash-activity/months/:yearMonth/finalize ────────────────────────────

router.post("/cash-activity/months/:yearMonth/finalize", async (req: Request, res: Response) => {
  if (!hasCashActivityAdmin(req)) {
    return res.status(403).json({ error: "Finance Admin access required" });
  }

  const yearMonth = req.params.yearMonth as string;
  if (!YEAR_MONTH_RE.test(yearMonth)) {
    return res.status(400).json({ error: "yearMonth must be in YYYY-MM format (e.g. 2026-08)" });
  }

  const qs = z
    .object({ entityId: z.coerce.number().int().positive().optional().nullable() })
    .safeParse(req.query);
  if (!qs.success) {
    return res.status(400).json({ error: "Invalid query parameter: entityId must be a positive integer" });
  }

  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;
  const actor = actorId(req);
  const entityId = qs.data.entityId ?? null;

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const { monthStart, monthEnd } = parseYearMonth(yearMonth);

      // Upsert the month row (idempotent) so we can lock it
      await client.query(
        `INSERT INTO cash_activity_months (workspace_owner_id, entity_id, year_month)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [workspaceOwnerId, entityId, yearMonth],
      );

      // Acquire a row-level lock to serialize finalize / unmatch / match
      const monthResult = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM cash_activity_months
          WHERE workspace_owner_id = $1
            AND year_month = $2
            AND ($3::integer IS NULL AND entity_id IS NULL OR entity_id = $3)
          FOR UPDATE`,
        [workspaceOwnerId, yearMonth, entityId],
      );
      const month = monthResult.rows[0];
      if (!month) {
        throw Object.assign(new Error("Month record not found"), { status: 500 });
      }

      if (month.status === "FINALIZED") {
        throw Object.assign(
          new Error(`Month ${yearMonth} is already finalized`),
          { status: 409 },
        );
      }

      // Build entity scope clauses using parameterized queries.
      const sessionParams: unknown[] = [workspaceOwnerId, monthStart, monthEnd];
      const sessionEntityClause = entityId != null
        ? (() => { sessionParams.push(entityId); return `AND cs.drawer_id IN (SELECT id FROM cash_drawers WHERE entity_id = $${sessionParams.length} AND workspace_owner_id = $1)`; })()
        : "";

      const txParams: unknown[] = [workspaceOwnerId, monthStart, monthEnd];
      const txEntityClause = entityId != null
        ? (() => { txParams.push(entityId); return `AND ct.cash_drawer_id IN (SELECT id FROM cash_drawers WHERE entity_id = $${txParams.length} AND workspace_owner_id = $1)`; })()
        : "";

      // ── Blocker checks (inside locked transaction) ──────────────────────
      // Session lifecycle: open → pending_review → flagged → approved.
      // 'approved' is the terminal closed state; there is no 'closed' status.
      // Only non-approved, non-cancelled sessions block finalization.
      //
      // Finalization-lock scope: only Cash Activity API mutations (match/unmatch)
      // check cash_activity_months.status before writing. Existing session and
      // transaction mutation routes (cashSessions.ts, cashTransactions.ts) are not
      // gated by month finalization status — source records remain correctable after
      // period close, which is standard accounting practice. Any correction made
      // after finalization is visible via the audit log and does not alter match
      // group state. Enforcing the lock in those routes is a follow-up task.
      const [openSessions, missingEvidence, pendingTxs, unmatchedTxs] = await Promise.all([
        // cash_sessions uses opened_at (timestamptz) not session_date
        client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM cash_sessions cs
            WHERE cs.workspace_owner_id = $1
              AND cs.opened_at >= $2
              AND cs.opened_at < $3
              AND cs.status NOT IN ('approved', 'cancelled')
              ${sessionEntityClause}`,
          sessionParams,
        ),
        // Missing evidence: independent of match status
        client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM cash_transactions ct
            WHERE ct.workspace_owner_id = $1
              AND ct.transaction_date >= $2
              AND ct.transaction_date < $3
              AND ct.is_reversed = false
              AND ct.approval_status != 'cancelled'
              AND ct.has_receipt = false
              AND ct.attachment_url IS NULL
              ${txEntityClause}`,
          txParams,
        ),
        // Pending transactions block finalization
        client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM cash_transactions ct
            WHERE ct.workspace_owner_id = $1
              AND ct.transaction_date >= $2
              AND ct.transaction_date < $3
              AND ct.is_reversed = false
              AND ct.approval_status = 'pending'
              ${txEntityClause}`,
          txParams,
        ),
        // Unmatched confirmed transactions: active txns not in any ACTIVE match group
        client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM cash_transactions ct
            WHERE ct.workspace_owner_id = $1
              AND ct.transaction_date >= $2
              AND ct.transaction_date < $3
              AND ct.is_reversed = false
              AND ct.approval_status = 'confirmed'
              AND ct.id NOT IN (
                SELECT cmgt.transaction_id
                  FROM cash_match_group_transactions cmgt
                  JOIN cash_match_groups cmg ON cmg.id = cmgt.match_group_id
                 WHERE cmg.status = 'ACTIVE'
                   AND cmg.workspace_owner_id = $1
              )
              ${txEntityClause}`,
          txParams,
        ),
      ]);

      const blockers: string[] = [];
      const openCount = parseInt(openSessions.rows[0]?.count ?? "0", 10);
      const missingCount = parseInt(missingEvidence.rows[0]?.count ?? "0", 10);
      const pendingCount = parseInt(pendingTxs.rows[0]?.count ?? "0", 10);
      const unmatchedCount = parseInt(unmatchedTxs.rows[0]?.count ?? "0", 10);

      if (openCount > 0) {
        blockers.push(`${openCount} open session(s) must be closed`);
      }
      if (missingCount > 0) {
        blockers.push(`${missingCount} transaction(s) are missing supporting evidence`);
      }
      if (pendingCount > 0) {
        blockers.push(`${pendingCount} transaction(s) are still pending approval`);
      }
      if (unmatchedCount > 0) {
        blockers.push(`${unmatchedCount} confirmed transaction(s) remain unmatched`);
      }

      if (blockers.length > 0) {
        throw Object.assign(
          new Error(`Cannot finalize: ${blockers.join("; ")}`),
          { status: 409 },
        );
      }

      // ── Atomic: state transition + audit in one transaction ─────────────
      await client.query(
        `UPDATE cash_activity_months
            SET status = 'FINALIZED',
                finalized_by = $1,
                finalized_at = now()
          WHERE id = $2`,
        [actor, month.id],
      );

      await client.query(
        `INSERT INTO cash_activity_audit_log
           (workspace_owner_id, entity_id, action, actor, payload)
         VALUES ($1, $2, 'FINALIZE', $3, $4::jsonb)`,
        [
          workspaceOwnerId,
          entityId,
          actor,
          JSON.stringify({ yearMonth, monthId: month.id }),
        ],
      );
    });

    return res.json({ success: true, status: "FINALIZED" });
  } catch (err: any) {
    const status = err.status ?? 500;
    return res.status(status).json({ error: err.message ?? "Internal server error" });
  } finally {
    client.release();
  }
});

// ── POST /cash-activity/months/:yearMonth/reopen ──────────────────────────────

router.post("/cash-activity/months/:yearMonth/reopen", async (req: Request, res: Response) => {
  if (!hasCashActivityAdmin(req)) {
    return res.status(403).json({ error: "Finance Admin access required" });
  }

  const yearMonth = req.params.yearMonth as string;
  if (!YEAR_MONTH_RE.test(yearMonth)) {
    return res.status(400).json({ error: "yearMonth must be in YYYY-MM format (e.g. 2026-08)" });
  }

  const body = z
    .object({
      reason: z.string().min(1, "reason is required").max(1000),
      entityId: z.number().int().positive().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "reason is required", details: body.error.issues });
  }

  const { reason, entityId } = body.data;
  const workspaceOwnerId: string = workspace(req).workspaceOwnerId;
  const actor = actorId(req);

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Fetch and lock the month row
      const monthResult = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM cash_activity_months
          WHERE workspace_owner_id = $1
            AND year_month = $2
            AND ($3::integer IS NULL AND entity_id IS NULL OR entity_id = $3)
          FOR UPDATE`,
        [workspaceOwnerId, yearMonth, entityId ?? null],
      );

      const month = monthResult.rows[0];
      if (!month) {
        throw Object.assign(new Error("Month record not found"), { status: 404 });
      }
      if (month.status === "OPEN") {
        throw Object.assign(new Error(`Month ${yearMonth} is already open`), { status: 409 });
      }

      // Atomic: update + audit in one transaction
      await client.query(
        `UPDATE cash_activity_months
            SET status = 'OPEN',
                reopen_reason = $1,
                reopen_actor = $2,
                reopen_at = now()
          WHERE id = $3`,
        [reason, actor, month.id],
      );

      await client.query(
        `INSERT INTO cash_activity_audit_log
           (workspace_owner_id, entity_id, action, actor, reason, payload)
         VALUES ($1, $2, 'REOPEN', $3, $4, $5::jsonb)`,
        [
          workspaceOwnerId,
          entityId ?? null,
          actor,
          reason,
          JSON.stringify({ yearMonth, monthId: month.id }),
        ],
      );
    });

    return res.json({ success: true, status: "OPEN" });
  } catch (err: any) {
    const status = err.status ?? 500;
    return res.status(status).json({ error: err.message ?? "Internal server error" });
  } finally {
    client.release();
  }
});

export default router;
