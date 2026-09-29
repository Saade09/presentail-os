import pg from "pg";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Workshop Cash Desk shared helpers: session-number generation, total
 * recomputation, activity logging, and the cash-transaction linking entry
 * point used by both the cash-sessions routes and any caller that records a
 * cash sale or cash expense.
 */

export type CashSessionRow = {
  id: number;
  workspace_owner_id: string;
  session_number: string;
  drawer_id: number;
  location_id: number | null;
  currency: string;
  /** Second tracked currency on dual-currency sessions (null = single). */
  secondary_currency: string | null;
  status: string;
  opening_cash: string;
  opening_cash_secondary: string | null;
  cash_in_total: string;
  cash_out_total: string;
  adjustments_total: string;
  cash_in_total_secondary: string | null;
  cash_out_total_secondary: string | null;
  adjustments_total_secondary: string | null;
  transfers_in_total: string;
  transfers_out_total: string;
  transfers_in_total_secondary: string | null;
  transfers_out_total_secondary: string | null;
  expected_cash: string | null;
  expected_cash_secondary: string | null;
  actual_cash: string | null;
  actual_cash_secondary: string | null;
  difference: string | null;
  difference_secondary: string | null;
  opening_note: string | null;
  closing_note: string | null;
  flag_reason: string | null;
  reopen_reason: string | null;
  /** Per-currency closing counts stored as JSONB. Shape varies; treated as unknown at the type level. */
  closing_counts: unknown | null;
  opened_by_member_id: number | null;
  opened_by_clerk_id: string | null;
  closed_by_clerk_id: string | null;
  approved_by_clerk_id: string | null;
  opened_at: string;
  closed_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Turn a location/drawer label into a short uppercase alpha-numeric code. */
export function deriveCode(label: string, fallback: string): string {
  const cleaned = (label || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  return cleaned || fallback;
}

/**
 * Generate the next session number for a drawer:
 *   CS-{LOCATION_CODE}-{DRAWER_CODE}-{YEAR}-{SEQUENCE}
 * Sequence is per workspace + drawer + year, zero-padded to 4 digits.
 */
export async function generateSessionNumber(
  workspaceOwnerId: string,
  drawerId: number,
  drawerCode: string,
  locationCode: string,
  year: number,
): Promise<string> {
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM cash_sessions
      WHERE workspace_owner_id = $1
        AND drawer_id = $2
        AND EXTRACT(YEAR FROM opened_at) = $3`,
    [workspaceOwnerId, drawerId, year],
  );
  const seq = (parseInt(countResult.rows[0]?.count ?? "0", 10) || 0) + 1;
  const loc = deriveCode(locationCode, "LOC");
  const drw = deriveCode(drawerCode, "DRW");
  return `CS-${loc}-${drw}-${year}-${String(seq).padStart(4, "0")}`;
}

/**
 * Recompute a session's running totals (cash in/out, adjustments, transfers,
 * expected and difference) from its linked cash_transactions. Returns the
 * refreshed row.
 *
 * @param txClient  Optional active transaction client. When provided, all
 *   queries run on the same connection so newly-inserted-but-uncommitted rows
 *   are visible. Defaults to the global pool when omitted (legacy callers).
 */
export async function recomputeSessionTotals(
  sessionId: number,
  workspaceOwnerId: string,
  txClient?: pg.PoolClient,
): Promise<CashSessionRow | null> {
  const qr = txClient ?? db;
  // The session's secondary currency decides how transactions are bucketed:
  // single-currency sessions aggregate everything (historical behavior); dual
  // sessions split by transaction currency (secondary vs everything else).
  const sessionRow = await qr.query<{ secondary_currency: string | null }>(
    `SELECT secondary_currency FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, workspaceOwnerId],
  );
  if (sessionRow.rowCount === 0) return null;
  const secondaryCurrency = sessionRow.rows[0].secondary_currency;

  // For dual sessions, a transaction counts toward the secondary bucket only
  // when its currency matches the secondary currency; everything else rolls
  // into the main bucket so session totals always reconcile.
  const secondaryMatch = secondaryCurrency ? `currency = $3` : `FALSE`;
  const aggParams: unknown[] = [sessionId, workspaceOwnerId];
  if (secondaryCurrency) aggParams.push(secondaryCurrency);

  // Use a CTE that transparently replaces multi-currency transactions with
  // their physical movement rows so session totals reflect actual drawer impact.
  // Transactions without movement rows use the parent row (legacy path).
  // Transfer types (transfer_in / transfer_out) are bucketed separately from
  // regular sales/expenses so they can be tracked in dedicated total columns.
  const agg = await qr.query<{
    cash_in: string;
    cash_out: string;
    adj_in: string;
    adj_out: string;
    xfer_in: string;
    xfer_out: string;
    cash_in_sec: string;
    cash_out_sec: string;
    adj_in_sec: string;
    adj_out_sec: string;
    xfer_in_sec: string;
    xfer_out_sec: string;
  }>(
    `WITH effective_txns AS (
       -- Legacy: transactions without movement rows — use parent row
       SELECT ct.direction, ct.currency, ct.type, ct.amount
         FROM cash_transactions ct
        WHERE ct.cash_session_id = $1 AND ct.workspace_owner_id = $2
          AND COALESCE(ct.approval_status, 'confirmed') = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM cash_transaction_movements m WHERE m.cash_transaction_id = ct.id
          )
       UNION ALL
       -- Multi-currency: transactions with movement rows — use movement rows
       SELECT
         CASE m.direction WHEN 'inflow' THEN 'in' ELSE 'out' END AS direction,
         m.currency,
         ct.type,
         m.amount
         FROM cash_transactions ct
         JOIN cash_transaction_movements m ON m.cash_transaction_id = ct.id
        WHERE ct.cash_session_id = $1 AND ct.workspace_owner_id = $2
          AND COALESCE(ct.approval_status, 'confirmed') = 'confirmed'
     )
     SELECT
        COALESCE(SUM(CASE WHEN NOT (${secondaryMatch}) AND direction = 'in'  AND type NOT IN ('adjustment','transfer_in','transfer_out') THEN amount ELSE 0 END), 0)::text AS cash_in,
        COALESCE(SUM(CASE WHEN NOT (${secondaryMatch}) AND direction = 'out' AND type NOT IN ('adjustment','transfer_in','transfer_out') THEN amount ELSE 0 END), 0)::text AS cash_out,
        COALESCE(SUM(CASE WHEN NOT (${secondaryMatch}) AND direction = 'in'  AND type = 'adjustment'   THEN amount ELSE 0 END), 0)::text AS adj_in,
        COALESCE(SUM(CASE WHEN NOT (${secondaryMatch}) AND direction = 'out' AND type = 'adjustment'   THEN amount ELSE 0 END), 0)::text AS adj_out,
        COALESCE(SUM(CASE WHEN NOT (${secondaryMatch}) AND type = 'transfer_in'  THEN amount ELSE 0 END), 0)::text AS xfer_in,
        COALESCE(SUM(CASE WHEN NOT (${secondaryMatch}) AND type = 'transfer_out' THEN amount ELSE 0 END), 0)::text AS xfer_out,
        COALESCE(SUM(CASE WHEN (${secondaryMatch}) AND direction = 'in'  AND type NOT IN ('adjustment','transfer_in','transfer_out') THEN amount ELSE 0 END), 0)::text AS cash_in_sec,
        COALESCE(SUM(CASE WHEN (${secondaryMatch}) AND direction = 'out' AND type NOT IN ('adjustment','transfer_in','transfer_out') THEN amount ELSE 0 END), 0)::text AS cash_out_sec,
        COALESCE(SUM(CASE WHEN (${secondaryMatch}) AND direction = 'in'  AND type = 'adjustment'   THEN amount ELSE 0 END), 0)::text AS adj_in_sec,
        COALESCE(SUM(CASE WHEN (${secondaryMatch}) AND direction = 'out' AND type = 'adjustment'   THEN amount ELSE 0 END), 0)::text AS adj_out_sec,
        COALESCE(SUM(CASE WHEN (${secondaryMatch}) AND type = 'transfer_in'  THEN amount ELSE 0 END), 0)::text AS xfer_in_sec,
        COALESCE(SUM(CASE WHEN (${secondaryMatch}) AND type = 'transfer_out' THEN amount ELSE 0 END), 0)::text AS xfer_out_sec
       FROM effective_txns`,
    aggParams,
  );
  const cashIn = Number(agg.rows[0]?.cash_in ?? 0);
  const cashOut = Number(agg.rows[0]?.cash_out ?? 0);
  const adjustments = Number(agg.rows[0]?.adj_in ?? 0) - Number(agg.rows[0]?.adj_out ?? 0);
  const transfersIn = Number(agg.rows[0]?.xfer_in ?? 0);
  const transfersOut = Number(agg.rows[0]?.xfer_out ?? 0);
  // expected = opening + sales_in - expenses_out + transfers_in - transfers_out + adjustments
  const expectedCash = (opening: number) =>
    opening + cashIn - cashOut + transfersIn - transfersOut + adjustments;

  // Only recompute open sessions.  Closed/pending-review/approved/flagged sessions
  // have their expected_cash, actual_cash, and difference frozen at close time;
  // recomputing them after a transfer or adjustment row was posted post-close would
  // overwrite the frozen reconciliation values with wrong numbers.
  if (!secondaryCurrency) {
    const updated = await qr.query<CashSessionRow>(
      `UPDATE cash_sessions
          SET cash_in_total        = $3,
              cash_out_total       = $4,
              adjustments_total    = $5,
              transfers_in_total   = $6,
              transfers_out_total  = $7,
              expected_cash        = opening_cash + $3 - $4 + $6 - $7 + $5,
              difference           = CASE WHEN actual_cash IS NULL THEN NULL
                                         ELSE actual_cash - (opening_cash + $3 - $4 + $6 - $7 + $5) END,
              updated_at           = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'
        RETURNING *`,
      [
        sessionId,
        workspaceOwnerId,
        cashIn.toFixed(2),
        cashOut.toFixed(2),
        adjustments.toFixed(2),
        transfersIn.toFixed(2),
        transfersOut.toFixed(2),
      ],
    );
    return updated.rows[0] ?? null;
  }

  const cashInSec = Number(agg.rows[0]?.cash_in_sec ?? 0);
  const cashOutSec = Number(agg.rows[0]?.cash_out_sec ?? 0);
  const adjustmentsSec =
    Number(agg.rows[0]?.adj_in_sec ?? 0) - Number(agg.rows[0]?.adj_out_sec ?? 0);
  const transfersInSec = Number(agg.rows[0]?.xfer_in_sec ?? 0);
  const transfersOutSec = Number(agg.rows[0]?.xfer_out_sec ?? 0);

  // Suppress unused variable lint warning — formula only used for clarity below
  void expectedCash;

  const updated = await qr.query<CashSessionRow>(
    `UPDATE cash_sessions
        SET cash_in_total                    = $3,
            cash_out_total                   = $4,
            adjustments_total                = $5,
            transfers_in_total               = $6,
            transfers_out_total              = $7,
            expected_cash                    = opening_cash + $3 - $4 + $6 - $7 + $5,
            difference                       = CASE WHEN actual_cash IS NULL THEN NULL
                                                    ELSE actual_cash - (opening_cash + $3 - $4 + $6 - $7 + $5) END,
            cash_in_total_secondary          = $8,
            cash_out_total_secondary         = $9,
            adjustments_total_secondary      = $10,
            transfers_in_total_secondary     = $11,
            transfers_out_total_secondary    = $12,
            expected_cash_secondary          = COALESCE(opening_cash_secondary, 0) + $8 - $9 + $11 - $12 + $10,
            difference_secondary             = CASE WHEN actual_cash_secondary IS NULL THEN NULL
                                                    ELSE actual_cash_secondary - (COALESCE(opening_cash_secondary, 0) + $8 - $9 + $11 - $12 + $10) END,
            updated_at                       = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'
      RETURNING *`,
    [
      sessionId,
      workspaceOwnerId,
      cashIn.toFixed(2),
      cashOut.toFixed(2),
      adjustments.toFixed(2),
      transfersIn.toFixed(2),
      transfersOut.toFixed(2),
      cashInSec.toFixed(2),
      cashOutSec.toFixed(2),
      adjustmentsSec.toFixed(2),
      transfersInSec.toFixed(2),
      transfersOutSec.toFixed(2),
    ],
  );
  return updated.rows[0] ?? null;
}

/**
 * Generate the next transfer number for a workspace inside a transaction:
 *   TR-{YEAR}-{SEQUENCE}
 * Sequence is per workspace + year, zero-padded to 5 digits.
 *
 * Must be called with the active transaction client so the COUNT sees the
 * current transaction's snapshot. The unique constraint on
 * (workspace_owner_id, transfer_number) plus withTransaction retry handles
 * the rare concurrent-insert collision.
 */
export async function generateTransferNumber(
  workspaceOwnerId: string,
  year: number,
  client: pg.PoolClient,
): Promise<string> {
  const countResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM cash_transfers
      WHERE workspace_owner_id = $1
        AND EXTRACT(YEAR FROM created_at) = $2`,
    [workspaceOwnerId, year],
  );
  const seq = (parseInt(countResult.rows[0]?.count ?? "0", 10) || 0) + 1;
  return `TR-${year}-${String(seq).padStart(5, "0")}`;
}

export async function logSessionActivity(
  workspaceOwnerId: string,
  sessionId: number,
  action: string,
  actorClerkId: string | null,
  actorName: string | null,
  detail: string | null,
  txClient?: pg.PoolClient,
): Promise<void> {
  const qr = txClient ?? db;
  try {
    await qr.query(
      `INSERT INTO cash_session_activity_logs
         (workspace_owner_id, cash_session_id, action, actor_clerk_id, actor_name, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceOwnerId, sessionId, action, actorClerkId, actorName, detail],
    );
  } catch (err) {
    logger.warn({ err, sessionId, action }, "Failed to write cash session activity log");
  }
}

export type RecordCashTransactionOptions = {
  workspaceOwnerId: string;
  amount: number;
  /** sale | expense | adjustment | other */
  type: string;
  /** in | out — defaults derived from type when omitted. */
  direction?: "in" | "out";
  currency?: string;
  drawerId?: number | null;
  locationId?: number | null;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  hasReceipt?: boolean;
  /** Optional invoice/receipt object-storage path. When set, has_receipt is forced true. */
  attachmentUrl?: string | null;
  createdByClerkId?: string | null;
  /** Explicit session to attach to (skips active-session lookup). */
  cashSessionId?: number | null;
  /**
   * Approval lifecycle status the row is inserted with. Defaults to
   * 'confirmed' (immediate balance effect). 'pending' rows are excluded from
   * totals until approved.
   */
  approvalStatus?: "confirmed" | "pending";
  /** Clerk id of the requesting member when approvalStatus is 'pending'. */
  requestedByClerkId?: string | null;
};

export type RecordCashTransactionResult = {
  transactionId: number;
  linked: boolean;
  cashSessionId: number | null;
  warning?: string;
};

/**
 * Record a cash movement and auto-link it to the currently open cash session
 * for its drawer (or, when no drawer is given, the open session matching the
 * location + currency). Recomputes the session totals when linked.
 *
 * This is the single integration point for "cash sale" / "cash expense"
 * recording — callers in the orders/expenses flows can invoke it to keep the
 * active session's drawer accountable without duplicating linking logic.
 */
export async function recordCashTransaction(
  opts: RecordCashTransactionOptions,
): Promise<RecordCashTransactionResult> {
  const direction: "in" | "out" =
    opts.direction ?? (opts.type === "expense" ? "out" : "in");
  const currency = opts.currency ?? "AED";

  // Resolve the open session to link against.
  let session: CashSessionRow | null = null;
  if (opts.cashSessionId) {
    const r = await db.query<CashSessionRow>(
      `SELECT * FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'`,
      [opts.cashSessionId, opts.workspaceOwnerId],
    );
    session = r.rows[0] ?? null;
  } else if (opts.drawerId) {
    const r = await db.query<CashSessionRow>(
      `SELECT * FROM cash_sessions
        WHERE workspace_owner_id = $1 AND drawer_id = $2 AND status = 'open'
        ORDER BY opened_at DESC LIMIT 1`,
      [opts.workspaceOwnerId, opts.drawerId],
    );
    session = r.rows[0] ?? null;
  } else if (opts.locationId) {
    const r = await db.query<CashSessionRow>(
      `SELECT * FROM cash_sessions
        WHERE workspace_owner_id = $1 AND location_id = $2
          AND (currency = $3 OR secondary_currency = $3)
          AND status = 'open'
        ORDER BY opened_at DESC LIMIT 1`,
      [opts.workspaceOwnerId, opts.locationId, currency],
    );
    session = r.rows[0] ?? null;
  }

  const drawerId = opts.drawerId ?? session?.drawer_id ?? null;
  const locationId = opts.locationId ?? session?.location_id ?? null;

  const attachmentUrl = opts.attachmentUrl ?? null;
  const hasReceipt = Boolean(attachmentUrl) || (opts.hasReceipt ?? false);

  const inserted = await db.query<{ id: number }>(
    `INSERT INTO cash_transactions
       (workspace_owner_id, cash_session_id, cash_drawer_id, location_id, currency,
        type, direction, amount, description, reference_type, reference_id,
        has_receipt, attachment_url, created_by_clerk_id, approval_status, requested_by_clerk_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      opts.workspaceOwnerId,
      session?.id ?? null,
      drawerId,
      locationId,
      currency,
      opts.type,
      direction,
      opts.amount.toFixed(2),
      opts.description ?? null,
      opts.referenceType ?? null,
      opts.referenceId ?? null,
      hasReceipt,
      attachmentUrl,
      opts.createdByClerkId ?? null,
      opts.approvalStatus ?? "confirmed",
      opts.requestedByClerkId ?? null,
    ],
  );
  const transactionId = inserted.rows[0].id;

  if (session) {
    await recomputeSessionTotals(session.id, opts.workspaceOwnerId);
    await logSessionActivity(
      opts.workspaceOwnerId,
      session.id,
      "transaction_linked",
      opts.createdByClerkId ?? null,
      null,
      JSON.stringify({ transactionId, type: opts.type, direction, amount: opts.amount.toFixed(2) }),
    );
  }

  return {
    transactionId,
    linked: Boolean(session),
    cashSessionId: session?.id ?? null,
    warning: session ? undefined : "No open cash session found; transaction recorded as unlinked.",
  };
}

// ---------------------------------------------------------------------------
// Overdue detection
// ---------------------------------------------------------------------------

/**
 * Determine whether an open cash session is overdue past its location's
 * daily-close cutoff plus a configurable grace period.
 *
 * Returns `overdue: false` whenever the location has no cutoff configured or
 * the timezone is unknown — those sessions are never flagged as overdue.
 *
 * @param openedAt   ISO timestamp when the session was opened
 * @param cutoffTime Location's same_day_cutoff_time ("HH:MM" or "HH:MM:SS"), or null
 * @param timezone   Location's IANA timezone ("Asia/Dubai"), or null
 * @param graceMinutes Extra minutes allowed past the cutoff (default 30)
 * @param now        Reference "now" (defaults to current time; injectable for tests)
 */
export function isSessionOverdue(
  openedAt: string,
  cutoffTime: string | null | undefined,
  timezone: string | null | undefined,
  graceMinutes = 30,
  now: Date = new Date(),
): { overdue: boolean; overdueByMinutes: number } {
  if (!cutoffTime || !timezone) return { overdue: false, overdueByMinutes: 0 };
  try {
    const openedDate = new Date(openedAt);
    if (isNaN(openedDate.getTime())) return { overdue: false, overdueByMinutes: 0 };

    const [hStr, mStr = "0"] = cutoffTime.split(":");
    const ch = parseInt(hStr, 10);
    const cm = parseInt(mStr, 10);
    if (!Number.isFinite(ch) || !Number.isFinite(cm)) return { overdue: false, overdueByMinutes: 0 };

    // Get the calendar date of the session's opening day in the location timezone
    const localDateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(openedDate); // "YYYY-MM-DD"
    const [y, mo, d] = localDateStr.split("-").map(Number);

    // Build the cutoff UTC timestamp by probing the UTC↔local offset at that moment.
    // We treat the desired local time as UTC first, then correct for the offset.
    const probeMs = Date.UTC(y, mo - 1, d, ch, cm, 0);
    const tzParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(probeMs));
    const get = (type: string) =>
      Number(tzParts.find((p) => p.type === type)?.value ?? "0");
    // offsetMs = probeMs(UTC) − localEquivalent(as UTC); correction to apply
    const tzAsMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), 0);
    const offsetMs = probeMs - tzAsMs;
    const cutoffUtcMs = probeMs + offsetMs;
    const cutoffWithGraceMs = cutoffUtcMs + graceMinutes * 60_000;

    const nowMs = now.getTime();
    if (nowMs <= cutoffWithGraceMs) return { overdue: false, overdueByMinutes: 0 };
    return { overdue: true, overdueByMinutes: Math.floor((nowMs - cutoffWithGraceMs) / 60_000) };
  } catch {
    return { overdue: false, overdueByMinutes: 0 };
  }
}

/**
 * Compute whether a cash session/shift is overdue and the exact UTC timestamp
 * at which it became (or will become) overdue.
 *
 * Reuses the same timezone arithmetic as `isSessionOverdue` but also returns
 * the `overdueAt` Date so callers can include it in API responses without a
 * second computation pass.
 *
 * Returns `{ isOverdue: false, overdueAt: null }` when the location has no
 * cutoff configured or the timezone is unknown.
 *
 * @param openedAt      ISO timestamp when the session/shift was opened
 * @param cutoffTime    Location's same_day_cutoff_time ("HH:MM" or "HH:MM:SS"), or null
 * @param timezone      Location's IANA timezone ("Asia/Beirut"), or null
 * @param graceMinutes  Extra minutes allowed past the cutoff (null/undefined → 30)
 * @param now           Reference "now" (defaults to current time; injectable for tests)
 */
export function computeShiftOverdue(
  openedAt: string,
  cutoffTime: string | null | undefined,
  timezone: string | null | undefined,
  graceMinutes: number | null | undefined,
  now: Date = new Date(),
): { isOverdue: boolean; overdueAt: Date | null } {
  if (!cutoffTime || !timezone) return { isOverdue: false, overdueAt: null };
  try {
    const openedDate = new Date(openedAt);
    if (isNaN(openedDate.getTime())) return { isOverdue: false, overdueAt: null };

    const [hStr, mStr = "0"] = cutoffTime.split(":");
    const ch = parseInt(hStr, 10);
    const cm = parseInt(mStr, 10);
    if (!Number.isFinite(ch) || !Number.isFinite(cm)) return { isOverdue: false, overdueAt: null };

    const grace =
      graceMinutes != null && Number.isFinite(Number(graceMinutes))
        ? Number(graceMinutes)
        : 30;

    // Calendar date of the opening day in the location timezone
    const localDateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(openedDate); // "YYYY-MM-DD"
    const [y, mo, d] = localDateStr.split("-").map(Number);

    // Build cutoff UTC timestamp via the same offset-probe technique as isSessionOverdue
    const probeMs = Date.UTC(y, mo - 1, d, ch, cm, 0);
    const tzParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(probeMs));
    const get = (type: string) =>
      Number(tzParts.find((p) => p.type === type)?.value ?? "0");
    const tzAsMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), 0);
    const offsetMs = probeMs - tzAsMs;
    const cutoffUtcMs = probeMs + offsetMs;
    const cutoffWithGraceMs = cutoffUtcMs + grace * 60_000;

    const overdueAt = new Date(cutoffWithGraceMs);
    const isOverdue = now.getTime() > cutoffWithGraceMs;
    return { isOverdue, overdueAt };
  } catch {
    return { isOverdue: false, overdueAt: null };
  }
}

// ---------------------------------------------------------------------------
// Session-detail redesign helpers: per-currency summaries, sale channels, and
// configurable thresholds for receipt requirements and variance approvals.
// ---------------------------------------------------------------------------

/** Sales channels selectable when recording a cash sale in Quick Entry. */
export const SALE_CHANNELS = [
  "walk_in",
  "whatsapp",
  "website",
  "phone_order",
  "toters",
  "deliveroo",
  "careem",
  "talabat",
  "other",
] as const;
export type SaleChannel = (typeof SALE_CHANNELS)[number];

/** Expense categories selectable when recording a cash expense. */
export const EXPENSE_CATEGORIES = [
  "supplies",
  "flowers",
  "packaging",
  "delivery",
  "fuel",
  "utilities",
  "maintenance",
  "food_beverage",
  "salaries_wages",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Payment types available under the "salaries_wages" expense category. */
export const PAYROLL_PAYMENT_TYPES = [
  "salary",
  "salary_advance",
  "bonus",
  "other_payroll",
] as const;
/**
 * Parse a JSON env override of per-currency thresholds, e.g.
 * `{"USD":100,"LBP":10000000}`. Falls back to the provided defaults.
 */
function parseThresholdEnv(
  envName: string,
  defaults: Record<string, number>,
): Record<string, number> {
  const raw = process.env[envName];
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = { ...defaults };
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k.toUpperCase()] = n;
    }
    return out;
  } catch {
    logger.warn({ envName }, "Invalid threshold JSON env; using defaults");
    return defaults;
  }
}

const RECEIPT_THRESHOLD_DEFAULTS: Record<string, number> = {
  USD: 100,
  AED: 400,
  EUR: 100,
  GBP: 100,
  SAR: 400,
  LBP: 10_000_000,
  DEFAULT: 100,
};

const VARIANCE_THRESHOLD_DEFAULTS: Record<string, number> = {
  USD: 10,
  AED: 40,
  EUR: 10,
  GBP: 10,
  SAR: 40,
  LBP: 1_000_000,
  DEFAULT: 10,
};

/** Expenses at or above this amount require a receipt attachment. */
export function receiptRequiredThreshold(currency: string): number {
  const map = parseThresholdEnv("CASH_RECEIPT_REQUIRED_THRESHOLDS", RECEIPT_THRESHOLD_DEFAULTS);
  return map[currency.toUpperCase()] ?? map.DEFAULT;
}

/**
 * Closing variances with an absolute value above this require supervisor
 * approval (the `cash_sessions.approve` permission).
 */
export function varianceApprovalThreshold(currency: string): number {
  const map = parseThresholdEnv("CASH_VARIANCE_APPROVAL_THRESHOLDS", VARIANCE_THRESHOLD_DEFAULTS);
  return map[currency.toUpperCase()] ?? map.DEFAULT;
}

/**
 * Build an ordered, de-duplicated currency list.
 *
 * For session-scoped workflows, callers must pass only the currencies captured
 * on the session itself (primary currency and optional secondary currency).
 * Drawer configuration is mutable and must not change an existing session's
 * reconciliation requirements.
 */
export function sessionCurrencies(
  sessionCurrency: string,
  ...otherCurrencies: Array<string | null | undefined>
): string[] {
  const out: string[] = [];
  for (const c of [sessionCurrency, ...otherCurrencies]) {
    const cur = (c ?? "").trim().toUpperCase();
    if (cur && !out.includes(cur)) out.push(cur);
  }
  return out;
}

export type CashTransactionLite = {
  currency: string;
  type: string;
  direction: string;
  amount: string | number;
  /**
   * Approval lifecycle status. Anything other than 'confirmed' (pending,
   * declined, cancelled) is excluded from summaries. Absent/null = confirmed
   * (legacy rows).
   */
  approval_status?: string | null;
};

export type SessionCurrencySummary = {
  currency: string;
  opening_cash: number;
  sales_collected: number;
  expenses_paid: number;
  adjustments: number;
  expected_cash: number;
};

/**
 * Compute the live per-currency summary rows for a session. Currencies are
 * strictly separate — never converted or combined. Opening cash belongs to
 * the session's own currency; other drawer currencies open at 0.
 *
 * Reversal rows flow into the bucket of the transaction type they reverse:
 * a reversal of a sale reduces sales_collected, a reversal of an expense/bill
 * reduces expenses_paid, a reversal of an adjustment flows into adjustments.
 * We infer the bucket from the reversal row's direction relative to type via
 * the reference_type convention "reversal:<original type>".
 */
export function computeSessionCurrencySummary(
  session: {
    currency: string;
    opening_cash: string | number;
    secondary_currency?: string | null;
    opening_cash_secondary?: string | number | null;
  },
  currencies: string[],
  transactions: Array<CashTransactionLite & { reference_type?: string | null }>,
): SessionCurrencySummary[] {
  const primaryCur = (session.currency ?? "").toUpperCase();
  const secondaryCur = (session.secondary_currency ?? "").toUpperCase();
  const rows = new Map<string, SessionCurrencySummary>();
  for (const cur of currencies) {
    let openingCash = 0;
    if (cur === primaryCur) {
      openingCash = Number(session.opening_cash) || 0;
    } else if (secondaryCur && cur === secondaryCur) {
      openingCash = Number(session.opening_cash_secondary) || 0;
    }
    rows.set(cur, {
      currency: cur,
      opening_cash: openingCash,
      sales_collected: 0,
      expenses_paid: 0,
      adjustments: 0,
      expected_cash: 0,
    });
  }
  for (const tx of transactions) {
    // Pending/declined/cancelled approval-gated expenses never affect totals.
    if (tx.approval_status && tx.approval_status !== "confirmed") continue;
    const cur = (tx.currency ?? "").toUpperCase();
    let row = rows.get(cur);
    if (!row) {
      // A transaction in an unexpected currency still gets its own strict row.
      row = {
        currency: cur,
        opening_cash: 0,
        sales_collected: 0,
        expenses_paid: 0,
        adjustments: 0,
        expected_cash: 0,
      };
      rows.set(cur, row);
    }
    const amt = Number(tx.amount) || 0;
    const signed = tx.direction === "out" ? -amt : amt;
    let bucket = tx.type;
    if (tx.type === "reversal") {
      const ref = tx.reference_type ?? "";
      bucket = ref.startsWith("reversal:") ? ref.slice("reversal:".length) : "adjustment";
    }
    if (bucket === "sale" || bucket === "other" || bucket === "cash_sale") {
      row.sales_collected += signed;
    } else if (bucket === "expense" || bucket === "bill") {
      row.expenses_paid += -signed;
    } else {
      row.adjustments += signed;
    }
  }
  for (const row of rows.values()) {
    row.expected_cash =
      row.opening_cash + row.sales_collected - row.expenses_paid + row.adjustments;
  }
  // Preserve requested currency order first, then any extras.
  const ordered: SessionCurrencySummary[] = [];
  for (const cur of currencies) {
    const row = rows.get(cur);
    if (row) {
      ordered.push(row);
      rows.delete(cur);
    }
  }
  ordered.push(...rows.values());
  return ordered;
}

export type ClosingCountInput = {
  currency: string;
  actual: number;
  explanation?: string | null;
};

export type ClosingCountResult = {
  currency: string;
  expected: number;
  actual: number;
  variance: number;
  explanation: string | null;
};

export type ValidateClosingCountsResult =
  | { ok: true; counts: ClosingCountResult[]; requiresApproval: boolean }
  | { ok: false; error: string };

/**
 * Validate per-currency closing counts against the live summary. Every session
 * currency must be counted; non-zero variances need an explanation; variances
 * above the per-currency approval threshold flag the close as requiring
 * supervisor approval. Currencies are never offset against each other.
 */
export function validateClosingCounts(
  summary: SessionCurrencySummary[],
  inputs: ClosingCountInput[],
): ValidateClosingCountsResult {
  const byCurrency = new Map<string, ClosingCountInput>();
  for (const input of inputs) {
    const cur = (input.currency ?? "").trim().toUpperCase();
    if (!cur) return { ok: false, error: "Each count needs a currency" };
    if (byCurrency.has(cur)) return { ok: false, error: `Duplicate count for ${cur}` };
    byCurrency.set(cur, input);
  }
  const counts: ClosingCountResult[] = [];
  let requiresApproval = false;
  for (const row of summary) {
    const input = byCurrency.get(row.currency);
    if (!input) return { ok: false, error: `Missing actual count for ${row.currency}` };
    byCurrency.delete(row.currency);
    const actual = Number(input.actual);
    if (!Number.isFinite(actual) || actual < 0) {
      return { ok: false, error: `Actual count for ${row.currency} must be a non-negative number` };
    }
    const expected = Number(row.expected_cash.toFixed(2));
    const variance = Number((actual - expected).toFixed(2));
    const explanation = String(input.explanation ?? "").trim() || null;
    if (variance !== 0 && !explanation) {
      return { ok: false, error: `An explanation is required for the ${row.currency} variance` };
    }
    if (Math.abs(variance) > varianceApprovalThreshold(row.currency)) {
      requiresApproval = true;
    }
    counts.push({ currency: row.currency, expected, actual, variance, explanation });
  }
  if (byCurrency.size > 0) {
    return { ok: false, error: `Unexpected currency count: ${[...byCurrency.keys()].join(", ")}` };
  }
  return { ok: true, counts, requiresApproval };
}

// ---------------------------------------------------------------------------
// Guided Reconcile & Close: per-currency reconciliation state stored in the
// cash_sessions.reconciliation jsonb column. Currencies are never converted,
// combined, or offset against each other.
// ---------------------------------------------------------------------------

export type ReconciliationApproval = {
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_by_clerk_id: string | null;
  decided_at: string | null;
  note: string | null;
};

export type ReconciliationCount = {
  currency: string;
  expected: number;
  actual: number;
  variance: number;
  explanation: string | null;
  requires_approval: boolean;
  approval: ReconciliationApproval | null;
};

export type ReconciliationState = {
  started_at: string;
  started_by_clerk_id: string | null;
  /** Set when counts were (re)submitted. */
  counted_at: string | null;
  counted_by_clerk_id: string | null;
  /** Transaction snapshot at count time, for stale-data detection. */
  tx_count: number;
  last_tx_id: number | null;
  counts: ReconciliationCount[];
};

/**
 * Build the per-currency reconciliation counts from the live summary and the
 * blind counts the agent entered. Unlike validateClosingCounts, explanations
 * are optional at count time (they are collected in the review step) and
 * above-threshold variances get a pending approval attached.
 */
export function buildReconciliationCounts(
  summary: SessionCurrencySummary[],
  inputs: ClosingCountInput[],
  now: Date = new Date(),
): { ok: true; counts: ReconciliationCount[] } | { ok: false; error: string } {
  const byCurrency = new Map<string, ClosingCountInput>();
  for (const input of inputs) {
    const cur = (input.currency ?? "").trim().toUpperCase();
    if (!cur) return { ok: false, error: "Each count needs a currency" };
    if (byCurrency.has(cur)) return { ok: false, error: `Duplicate count for ${cur}` };
    byCurrency.set(cur, input);
  }
  const counts: ReconciliationCount[] = [];
  for (const row of summary) {
    const input = byCurrency.get(row.currency);
    if (!input) return { ok: false, error: `Missing actual count for ${row.currency}` };
    byCurrency.delete(row.currency);
    const actual = Number(input.actual);
    if (!Number.isFinite(actual) || actual < 0) {
      return { ok: false, error: `Actual count for ${row.currency} must be a non-negative number` };
    }
    const expected = Number(row.expected_cash.toFixed(2));
    const variance = Number((actual - expected).toFixed(2));
    const requiresApproval = Math.abs(variance) > varianceApprovalThreshold(row.currency);
    counts.push({
      currency: row.currency,
      expected,
      actual: Number(actual.toFixed(2)),
      variance,
      explanation: String(input.explanation ?? "").trim() || null,
      requires_approval: requiresApproval,
      approval: requiresApproval
        ? {
            status: "pending",
            requested_at: now.toISOString(),
            decided_by_clerk_id: null,
            decided_at: null,
            note: null,
          }
        : null,
    });
  }
  if (byCurrency.size > 0) {
    return { ok: false, error: `Unexpected currency count: ${[...byCurrency.keys()].join(", ")}` };
  }
  return { ok: true, counts };
}

export type ReconciliationBlocker =
  | { code: "no_counts" }
  | { code: "missing_explanation"; currency: string }
  | { code: "approval_pending"; currency: string }
  | { code: "approval_rejected"; currency: string };

/**
 * Everything that still blocks closing the session from its reconciliation
 * state: missing counts, missing explanations on non-zero variances, and
 * pending/rejected supervisor approvals on above-threshold variances.
 */
export function reconciliationCloseBlockers(
  rec: ReconciliationState | null | undefined,
): ReconciliationBlocker[] {
  if (!rec || !Array.isArray(rec.counts) || rec.counts.length === 0) {
    return [{ code: "no_counts" }];
  }
  const blockers: ReconciliationBlocker[] = [];
  for (const count of rec.counts) {
    if (count.variance !== 0 && !(count.explanation ?? "").trim()) {
      blockers.push({ code: "missing_explanation", currency: count.currency });
    }
    if (count.requires_approval) {
      const status = count.approval?.status ?? "pending";
      if (status === "rejected") {
        blockers.push({ code: "approval_rejected", currency: count.currency });
      } else if (status !== "approved") {
        blockers.push({ code: "approval_pending", currency: count.currency });
      }
    }
  }
  return blockers;
}

/**
 * True when transactions changed after the counts were submitted (new rows or
 * a different transaction count) — the count is stale and must be redone.
 */
export function isReconciliationStale(
  rec: Pick<ReconciliationState, "tx_count" | "last_tx_id"> | null | undefined,
  currentTxCount: number,
  currentLastTxId: number | null,
): boolean {
  if (!rec) return true;
  if ((rec.tx_count ?? 0) !== currentTxCount) return true;
  return (rec.last_tx_id ?? null) !== (currentLastTxId ?? null);
}

export type PayrollPaymentType = (typeof PAYROLL_PAYMENT_TYPES)[number];

/** Returns true when the expense category triggers the payroll flow. */
export function isPayrollCategory(cat: string): boolean {
  return cat === "salaries_wages";
}
