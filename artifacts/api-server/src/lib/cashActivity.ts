/**
 * Cash Activity module — shared query helpers.
 *
 * All database access uses raw SQL via the `db` pool (consistent with the rest
 * of the API server). None of the functions here mutate state; mutation belongs
 * in the route handlers where it can be wrapped in a transaction.
 */
import { db } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TransactionTab = "unmatched" | "matched" | "needs-review";

export interface TransactionFilters {
  workspaceOwnerId: string;
  yearMonth: string; // YYYY-MM
  entityId?: number | null;
  locationId?: number | null;
  drawerId?: number | null;
  currency?: string | null;
  tab?: TransactionTab;
  search?: string | null;
  // column filters
  typeFilter?: string | null;
  evidenceFilter?: "with" | "without" | null;
  statusFilter?: string | null;
  page?: number;
  pageSize?: number;
}

export interface TransactionRow {
  id: number;
  transactionDate: string;
  type: string;
  direction: string;
  referenceId: string | null;
  description: string | null;
  entityId: number | null;
  entityName: string | null;
  locationId: number | null;
  locationName: string | null;
  drawerId: number | null;
  drawerName: string | null;
  expenseCategory: string | null;
  currency: string;
  amount: string;
  cashIn: string | null;
  cashOut: string | null;
  hasReceipt: boolean;
  attachmentUrl: string | null;
  status: string;
  approvalStatus: string;
  isReversed: boolean;
  matchGroupId: number | null;
  matchedBy: string | null;
  matchedAt: string | null;
  saleChannel: string | null;
}

export interface PaginatedTransactions {
  rows: TransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CashActivitySummary {
  cashSalesTotal: string;
  refundsTotal: string;
  cashExpensesTotal: string;
  netCashActivity: string;
  needsReviewCount: number;
  totalTransactions: number;
  // cash position
  expectedCash: string;
  deposited: string;
  transferred: string;
  cashPositionDifference: string;
  balanced: boolean;
}

export interface DailyChartPoint {
  date: string; // YYYY-MM-DD
  cashIn: string;
  cashOut: string;
  net: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse YYYY-MM and return { monthStart, monthEnd } as ISO date strings
 * suitable for timestamptz comparisons in SQL.
 */
export function parseYearMonth(yearMonth: string): { monthStart: string; monthEnd: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`Invalid yearMonth: ${yearMonth}`);
  }
  const monthStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const monthEnd = new Date(Date.UTC(year, month, 1)).toISOString();
  return { monthStart, monthEnd };
}

/**
 * Build the shared WHERE clause for cash_transactions filtered by month,
 * entity, location, drawer, and currency.
 *
 * Entity filtering is implemented as a subquery against cash_drawers.entity_id
 * so the caller does not need to join cash_drawers themselves.
 */
function buildBaseConditions(filters: TransactionFilters): {
  conditions: string[];
  params: unknown[];
} {
  const { workspaceOwnerId, yearMonth, entityId, locationId, drawerId, currency } = filters;
  const { monthStart, monthEnd } = parseYearMonth(yearMonth);

  const params: unknown[] = [workspaceOwnerId, monthStart, monthEnd];
  const conditions: string[] = [
    "ct.workspace_owner_id = $1",
    "ct.transaction_date >= $2",
    "ct.transaction_date < $3",
    // Exclude reversed transactions (correction rows replace them)
    "ct.is_reversed = false",
    // Exclude cancelled (voided) approval-gated transactions
    "ct.approval_status != 'cancelled'",
  ];

  // Entity filter: cash_transactions → cash_drawers.entity_id
  if (entityId != null) {
    params.push(entityId);
    conditions.push(
      `ct.cash_drawer_id IN (
         SELECT id FROM cash_drawers
          WHERE entity_id = $${params.length}
            AND workspace_owner_id = $1
       )`,
    );
  }

  if (locationId != null) {
    params.push(locationId);
    conditions.push(`ct.location_id = $${params.length}`);
  }
  if (drawerId != null) {
    params.push(drawerId);
    conditions.push(`ct.cash_drawer_id = $${params.length}`);
  }
  if (currency != null) {
    params.push(currency.toUpperCase());
    conditions.push(`ct.currency = $${params.length}`);
  }

  return { conditions, params };
}

// ── Paginated transaction list ────────────────────────────────────────────────

export async function getPaginatedTransactions(
  filters: TransactionFilters,
): Promise<PaginatedTransactions> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const { conditions, params } = buildBaseConditions(filters);

  // Tab filter
  const tab = filters.tab ?? "unmatched";
  if (tab === "unmatched") {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM cash_match_group_transactions cmgt
      JOIN cash_match_groups cmg ON cmg.id = cmgt.match_group_id
      WHERE cmgt.transaction_id = ct.id AND cmg.status = 'ACTIVE'
    )`);
  } else if (tab === "matched") {
    conditions.push(`EXISTS (
      SELECT 1 FROM cash_match_group_transactions cmgt
      JOIN cash_match_groups cmg ON cmg.id = cmgt.match_group_id
      WHERE cmgt.transaction_id = ct.id AND cmg.status = 'ACTIVE'
    )`);
  } else if (tab === "needs-review") {
    // Needs review = missing evidence (no receipt, no attachment).
    // This is INDEPENDENT of match status — a matched transaction can still
    // be needs-review if it lacks supporting documentation.
    conditions.push(`ct.has_receipt = false AND ct.attachment_url IS NULL`);
  }

  // Column filters
  if (filters.typeFilter) {
    params.push(filters.typeFilter);
    conditions.push(`ct.type = $${params.length}`);
  }
  if (filters.evidenceFilter === "with") {
    conditions.push(`(ct.has_receipt = true OR ct.attachment_url IS NOT NULL)`);
  } else if (filters.evidenceFilter === "without") {
    conditions.push(`(ct.has_receipt = false AND ct.attachment_url IS NULL)`);
  }
  if (filters.statusFilter) {
    params.push(filters.statusFilter);
    conditions.push(`ct.status = $${params.length}`);
  }

  // Full-text search: reference_id, description, or amount match
  if (filters.search) {
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm);
    const pn = params.length;
    conditions.push(`(
      ct.reference_id ILIKE $${pn}
      OR ct.description ILIKE $${pn}
      OR ct.amount::text ILIKE $${pn}
    )`);
  }

  const where = conditions.join(" AND ");

  const [countResult, rowsResult] = await Promise.all([
    db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
         FROM cash_transactions ct
        WHERE ${where}`,
      params,
    ),
    db.query<{
      id: number;
      transaction_date: string;
      type: string;
      direction: string;
      reference_id: string | null;
      description: string | null;
      entity_id: number | null;
      entity_name: string | null;
      location_id: number | null;
      location_name: string | null;
      drawer_id: number | null;
      drawer_name: string | null;
      expense_category: string | null;
      currency: string;
      amount: string;
      has_receipt: boolean;
      attachment_url: string | null;
      status: string;
      approval_status: string;
      is_reversed: boolean;
      match_group_id: number | null;
      matched_by: string | null;
      matched_at: string | null;
      sale_channel: string | null;
    }>(
      `SELECT ct.id,
              ct.transaction_date,
              ct.type,
              ct.direction,
              ct.reference_id,
              ct.description,
              cd.entity_id,
              fe.legal_name AS entity_name,
              ct.location_id,
              l.name AS location_name,
              ct.cash_drawer_id AS drawer_id,
              cd.name AS drawer_name,
              ct.expense_category,
              ct.currency,
              ct.amount,
              ct.has_receipt,
              ct.attachment_url,
              ct.status,
              ct.approval_status,
              ct.is_reversed,
              ct.sale_channel,
              cmg.id AS match_group_id,
              cmg.matched_by,
              cmg.created_at AS matched_at
         FROM cash_transactions ct
         LEFT JOIN locations l ON l.id = ct.location_id
         LEFT JOIN cash_drawers cd ON cd.id = ct.cash_drawer_id
         LEFT JOIN finance_entities fe ON fe.id = cd.entity_id
         LEFT JOIN cash_match_group_transactions cmgt ON cmgt.transaction_id = ct.id
         LEFT JOIN cash_match_groups cmg ON cmg.id = cmgt.match_group_id AND cmg.status = 'ACTIVE'
        WHERE ${where}
        ORDER BY ct.transaction_date DESC, ct.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    ),
  ]);

  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);

  const rows: TransactionRow[] = rowsResult.rows.map((r) => ({
    id: r.id,
    transactionDate: r.transaction_date,
    type: r.type,
    direction: r.direction,
    referenceId: r.reference_id,
    description: r.description,
    entityId: r.entity_id,
    entityName: r.entity_name,
    locationId: r.location_id,
    locationName: r.location_name,
    drawerId: r.drawer_id,
    drawerName: r.drawer_name,
    expenseCategory: r.expense_category,
    currency: r.currency,
    amount: r.amount,
    cashIn: r.direction === "in" ? r.amount : null,
    cashOut: r.direction === "out" ? r.amount : null,
    hasReceipt: r.has_receipt,
    attachmentUrl: r.attachment_url,
    status: r.status,
    approvalStatus: r.approval_status,
    isReversed: r.is_reversed,
    matchGroupId: r.match_group_id,
    matchedBy: r.matched_by,
    matchedAt: r.matched_at,
    saleChannel: r.sale_channel,
  }));

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ── Summary KPIs ──────────────────────────────────────────────────────────────

export async function getCashActivitySummary(
  filters: Omit<
    TransactionFilters,
    "tab" | "search" | "page" | "pageSize" | "typeFilter" | "evidenceFilter" | "statusFilter"
  >,
): Promise<CashActivitySummary> {
  const { conditions, params } = buildBaseConditions(filters);
  const where = conditions.join(" AND ");

  const [kpiResult, positionResult] = await Promise.all([
    db.query<{
      cash_sales: string;
      refunds: string;
      cash_expenses: string;
      needs_review_count: string;
      total_count: string;
    }>(
      // needs_review_count: evidence-independent, same as needs-review tab
      `SELECT
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'in' AND ct.type IN ('sale', 'cash_sale')), 0)::text AS cash_sales,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out' AND ct.type IN ('refund', 'cash_refund')), 0)::text AS refunds,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out' AND ct.type = 'expense'), 0)::text AS cash_expenses,
         COUNT(*) FILTER (
           WHERE ct.has_receipt = false AND ct.attachment_url IS NULL
         )::text AS needs_review_count,
         COUNT(*)::text AS total_count
         FROM cash_transactions ct
        WHERE ${where}`,
      params,
    ),
    db.query<{
      total_in: string;
      total_out: string;
      deposited: string;
      transferred: string;
    }>(
      `SELECT
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'in'), 0)::text AS total_in,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out'), 0)::text AS total_out,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.type = 'transfer_out'), 0)::text AS deposited,
         COALESCE(SUM(ct.amount) FILTER (WHERE ct.type = 'transfer_in'), 0)::text AS transferred
         FROM cash_transactions ct
        WHERE ${where}`,
      params,
    ),
  ]);

  const kpi = kpiResult.rows[0];
  const pos = positionResult.rows[0];

  const totalIn = parseFloat(pos?.total_in ?? "0");
  const totalOut = parseFloat(pos?.total_out ?? "0");
  const netCash = totalIn - totalOut;
  const deposited = parseFloat(pos?.deposited ?? "0");
  const transferred = parseFloat(pos?.transferred ?? "0");
  const expectedCash = netCash;
  const difference = expectedCash - deposited - transferred;

  return {
    cashSalesTotal: kpi?.cash_sales ?? "0",
    refundsTotal: kpi?.refunds ?? "0",
    cashExpensesTotal: kpi?.cash_expenses ?? "0",
    netCashActivity: netCash.toFixed(2),
    needsReviewCount: parseInt(kpi?.needs_review_count ?? "0", 10),
    totalTransactions: parseInt(kpi?.total_count ?? "0", 10),
    expectedCash: expectedCash.toFixed(2),
    deposited: deposited.toFixed(2),
    transferred: transferred.toFixed(2),
    cashPositionDifference: difference.toFixed(2),
    balanced: Math.abs(difference) < 0.01,
  };
}

// ── Daily chart series ────────────────────────────────────────────────────────

export async function getCashActivityChart(
  filters: Omit<
    TransactionFilters,
    "tab" | "search" | "page" | "pageSize" | "typeFilter" | "evidenceFilter" | "statusFilter"
  >,
): Promise<DailyChartPoint[]> {
  const { conditions, params } = buildBaseConditions(filters);
  const where = conditions.join(" AND ");

  const result = await db.query<{
    date: string;
    cash_in: string;
    cash_out: string;
  }>(
    `SELECT
       DATE(ct.transaction_date)::text AS date,
       COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'in'), 0)::text AS cash_in,
       COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out'), 0)::text AS cash_out
       FROM cash_transactions ct
      WHERE ${where}
      GROUP BY DATE(ct.transaction_date)
      ORDER BY DATE(ct.transaction_date)`,
    params,
  );

  return result.rows.map((r) => {
    const cashIn = parseFloat(r.cash_in);
    const cashOut = parseFloat(r.cash_out);
    return {
      date: r.date,
      cashIn: r.cash_in,
      cashOut: r.cash_out,
      net: (cashIn - cashOut).toFixed(2),
    };
  });
}

// ── Month status helpers ──────────────────────────────────────────────────────

export interface MonthStatusRow {
  id: number;
  yearMonth: string;
  status: string;
  finalizedBy: string | null;
  finalizedAt: string | null;
  reopenReason: string | null;
  reopenActor: string | null;
  reopenAt: string | null;
}

export async function getOrCreateMonthStatus(
  workspaceOwnerId: string,
  yearMonth: string,
  entityId: number | null,
): Promise<MonthStatusRow> {
  // Upsert — find or create
  await db.query(
    `INSERT INTO cash_activity_months (workspace_owner_id, entity_id, year_month)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceOwnerId, entityId, yearMonth],
  );

  const result = await db.query<{
    id: number;
    year_month: string;
    status: string;
    finalized_by: string | null;
    finalized_at: string | null;
    reopen_reason: string | null;
    reopen_actor: string | null;
    reopen_at: string | null;
  }>(
    `SELECT id, year_month, status, finalized_by, finalized_at,
            reopen_reason, reopen_actor, reopen_at
       FROM cash_activity_months
      WHERE workspace_owner_id = $1
        AND year_month = $2
        AND ($3::integer IS NULL AND entity_id IS NULL OR entity_id = $3)
      LIMIT 1`,
    [workspaceOwnerId, yearMonth, entityId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to find/create month record for ${yearMonth}`);
  }

  return {
    id: row.id,
    yearMonth: row.year_month,
    status: row.status,
    finalizedBy: row.finalized_by,
    finalizedAt: row.finalized_at,
    reopenReason: row.reopen_reason,
    reopenActor: row.reopen_actor,
    reopenAt: row.reopen_at,
  };
}

// ── Match eligibility validation ──────────────────────────────────────────────

export interface MatchEligibilityResult {
  valid: boolean;
  errors: string[];
}

export interface MatchCandidate {
  id: number;
  workspace_owner_id: string;
  currency: string;
  direction: string;
  amount: string;
  status: string;
  approval_status: string;
  is_reversed: boolean;
  cash_drawer_id: number | null;
  drawer_entity_id: number | null;
  location_id: number | null;
  transaction_date: string;
  type: string;
}

/**
 * Validate all 8 eligibility rules for creating a match group.
 * Rules:
 *  1. Month must be OPEN (not FINALIZED)
 *  2. At least one cash-in transaction required
 *  3. At least one cash-out transaction required
 *  4. All transactions must share the same currency / location / drawer / month
 *  5. None already matched (in an ACTIVE match group) — enforced by DB UNIQUE constraint
 *  6. None voided or cancelled (approval_status = 'cancelled')
 *  7. None reversed (is_reversed = true)
 *  8. Cash-in total equals cash-out total (within currency precision: 2 dp)
 *
 * Additionally, when entityId is supplied:
 *  E. All transactions must belong to drawers scoped to the given entity
 */
export function validateMatchEligibility(
  transactions: MatchCandidate[],
  monthStatus: string,
  yearMonth: string,
  entityId?: number | null,
): MatchEligibilityResult {
  const errors: string[] = [];

  // Rule 1: month must be OPEN
  if (monthStatus === "FINALIZED") {
    errors.push(`Accounting month ${yearMonth} is finalized; no changes allowed`);
  }

  // Rules 6 & 7: voided / locked / reversed
  for (const t of transactions) {
    if (t.approval_status === "cancelled") {
      errors.push(`Transaction ${t.id} is cancelled and cannot be matched`);
    }
    if (t.status === "voided") {
      errors.push(`Transaction ${t.id} is voided and cannot be matched`);
    }
    if (t.status === "locked") {
      errors.push(`Transaction ${t.id} is locked and cannot be matched`);
    }
    if (t.is_reversed) {
      errors.push(`Transaction ${t.id} has been reversed and cannot be matched`);
    }
  }

  const active = transactions.filter(
    (t) => t.approval_status !== "cancelled" && t.status !== "voided" && t.status !== "locked" && !t.is_reversed,
  );

  // Rule 2 & 3: at least one cash-in and one cash-out
  const cashIns = active.filter((t) => t.direction === "in");
  const cashOuts = active.filter((t) => t.direction === "out");
  if (cashIns.length === 0) {
    errors.push("At least one cash-in transaction is required");
  }
  if (cashOuts.length === 0) {
    errors.push("At least one cash-out transaction is required");
  }

  // Rule 4: same currency / location / drawer / month for all active transactions
  if (active.length > 0) {
    const refCurrency = active[0].currency;
    const refLocation = active[0].location_id;
    const refDrawer = active[0].cash_drawer_id;
    const refMonth = active[0].transaction_date.substring(0, 7); // YYYY-MM

    for (const t of active) {
      if (t.currency !== refCurrency) {
        errors.push(`Transaction ${t.id} has currency ${t.currency}; expected ${refCurrency}`);
      }
      if (t.location_id !== refLocation) {
        errors.push(`Transaction ${t.id} has a different location from the other transactions`);
      }
      if (t.cash_drawer_id !== refDrawer) {
        errors.push(`Transaction ${t.id} has a different cash drawer from the other transactions`);
      }
      const tMonth = t.transaction_date.substring(0, 7);
      if (tMonth !== refMonth) {
        errors.push(`Transaction ${t.id} belongs to month ${tMonth}, not ${refMonth}`);
      }
    }

    // Rule 4b: month matches the requested accounting_month
    if (errors.length === 0 && refMonth !== yearMonth) {
      errors.push(
        `Transactions belong to month ${refMonth} but the accounting month is ${yearMonth}`,
      );
    }

    // Entity rule: all drawers must belong to the specified entity (when provided)
    if (entityId != null) {
      for (const t of active) {
        if (t.drawer_entity_id !== entityId) {
          errors.push(
            `Transaction ${t.id} belongs to a drawer not scoped to entity ${entityId}`,
          );
        }
      }
    }
  }

  // Rule 8: cash-in total === cash-out total (to 2 dp)
  if (errors.length === 0 && cashIns.length > 0 && cashOuts.length > 0) {
    const totalIn = cashIns.reduce((s, t) => s + parseFloat(t.amount), 0);
    const totalOut = cashOuts.reduce((s, t) => s + parseFloat(t.amount), 0);
    if (Math.abs(totalIn - totalOut) >= 0.005) {
      errors.push(
        `Cash-in total (${totalIn.toFixed(2)}) must equal cash-out total (${totalOut.toFixed(2)})`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
