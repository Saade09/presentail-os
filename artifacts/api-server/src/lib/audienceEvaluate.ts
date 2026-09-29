/**
 * Audience evaluation service — the SINGLE place that turns a rule tree into
 * set-based SQL over contacts / orders / order_contacts / order_payment.
 *
 * Used by: builder previews, saved-audience refresh, the matching-contacts
 * endpoint, the index summary metrics, and opportunity templates — so counts
 * can never drift between surfaces.
 *
 * Semantics (documented contract):
 *  - The unit of evaluation is the canonical contact row (contacts.id). A
 *    contact appears at most once regardless of how many orders/roles it has;
 *    a self-order (same contact as customer AND recipient of one order) never
 *    duplicates a contact.
 *  - "gift sent" = a customer-role order that has at least one recipient-role
 *    link to a DIFFERENT contact. "gift received" = a recipient-role order
 *    whose customer is a DIFFERENT contact. Self-orders count in orders_count
 *    but in neither gift counter.
 *  - Reachability is consent-based, never inferred from possession of an
 *    email/phone: email_reachable = VALID email AND email_consent AND not
 *    suppressed; whatsapp_reachable = VALID phone (7+ digits) AND
 *    whatsapp_consent AND not suppressed. Malformed values are never
 *    marketable. is_suppressed = contacts.unsubscribed_at IS NOT NULL.
 *  - Spend counts only paid/recorded order_payment.amount_usd (same rule as
 *    the Customers page).
 *  - All heavy lookups are aggregated CTEs grouped by contact_id (no
 *    correlated-per-contact N+1); contact results are always paginated.
 */
import { db } from "./db";
import { phoneCountrySql } from "./defaults";
import {
  type RuleTree,
  type RuleGroup,
  type RuleCondition,
  FIELDS_BY_KEY,
  resolveFieldKey,
  flattenConditions,
  groupIsEmpty,
} from "./audienceRules";

class Params {
  values: unknown[] = [];
  constructor(initial: unknown[] = []) {
    this.values = [...initial];
  }
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

const VALID_EMAIL_SQL = `~* '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`;

/**
 * The base CTE exposes one row per non-archived workspace contact with a
 * column per registry field key. $1 is always the workspace owner id.
 */
function baseCteSql(): string {
  const phoneCountry = phoneCountrySql("c.phone");
  return `
cust AS (
  SELECT oc.contact_id,
         COUNT(DISTINCT o.id)::int AS orders_count,
         MIN(COALESCE(o.ordered_at, o.created_at)) AS first_order_at,
         MAX(COALESCE(o.ordered_at, o.created_at)) AS last_order_at,
         COUNT(DISTINCT o.id) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_contacts r WHERE r.order_id = o.id AND r.role = 'recipient' AND r.contact_id <> oc.contact_id
         ))::int AS gifts_sent_count,
         MAX(COALESCE(o.ordered_at, o.created_at)) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_contacts r WHERE r.order_id = o.id AND r.role = 'recipient' AND r.contact_id <> oc.contact_id
         )) AS last_gift_sent_at,
         COUNT(DISTINCT o.id) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_contacts r WHERE r.order_id = o.id AND r.role = 'recipient' AND r.contact_id = oc.contact_id
         ))::int AS self_orders_count
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
   WHERE oc.role = 'customer' AND o.workspace_owner_id = $1
   GROUP BY oc.contact_id
),
uniq_recips AS (
  SELECT oc.contact_id, COUNT(DISTINCT r.contact_id)::int AS unique_recipients_count
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
    JOIN order_contacts r ON r.order_id = o.id AND r.role = 'recipient' AND r.contact_id <> oc.contact_id
   WHERE oc.role = 'customer' AND o.workspace_owner_id = $1
   GROUP BY oc.contact_id
),
spend AS (
  SELECT oc.contact_id, SUM(op.amount_usd) AS total_spent
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
    JOIN order_payment op ON op.order_id = o.id
   WHERE oc.role = 'customer' AND o.workspace_owner_id = $1
     AND lower(COALESCE(op.status, '')) IN ('paid', 'recorded')
     AND op.amount_usd IS NOT NULL
   GROUP BY oc.contact_id
),
recip AS (
  SELECT oc.contact_id,
         COUNT(DISTINCT o.id)::int AS recipient_orders_count,
         COUNT(DISTINCT o.id) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_contacts cu WHERE cu.order_id = o.id AND cu.role = 'customer' AND cu.contact_id <> oc.contact_id
         ))::int AS gifts_received_count,
         MAX(COALESCE(o.ordered_at, o.created_at)) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_contacts cu WHERE cu.order_id = o.id AND cu.role = 'customer' AND cu.contact_id <> oc.contact_id
         )) AS last_gift_received_at
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
   WHERE oc.role = 'recipient' AND o.workspace_owner_id = $1
   GROUP BY oc.contact_id
),
recip_countries AS (
  SELECT oc.contact_id,
         array_agg(DISTINCT lower(COALESCE(${phoneCountrySql("rc.phone")},
           NULLIF(TRIM(COALESCE(o.delivery_address->>'countryCode', '')), '')))) AS recipient_countries
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
    JOIN order_contacts r ON r.order_id = o.id AND r.role = 'recipient' AND r.contact_id <> oc.contact_id
    JOIN contacts rc ON rc.id = r.contact_id
   WHERE oc.role = 'customer' AND o.workspace_owner_id = $1
     AND COALESCE(${phoneCountrySql("rc.phone")}, NULLIF(TRIM(COALESCE(o.delivery_address->>'countryCode', '')), '')) IS NOT NULL
   GROUP BY oc.contact_id
),
city AS (
  SELECT DISTINCT ON (oc.contact_id) oc.contact_id,
         NULLIF(TRIM(COALESCE(o.delivery_address->>'city', '')), '') AS city
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
   WHERE o.workspace_owner_id = $1
     AND NULLIF(TRIM(COALESCE(o.delivery_address->>'city', '')), '') IS NOT NULL
   ORDER BY oc.contact_id, o.ordered_at DESC NULLS LAST, o.created_at DESC
),
occ AS (
  SELECT oc.contact_id, array_agg(DISTINCT lower(a.slug)) AS occasion_types
    FROM order_contacts oc
    JOIN orders o ON o.id = oc.order_id
    JOIN order_line_items li ON li.order_id = o.id AND li.product_id IS NOT NULL
    JOIN product_occasions po ON po.product_id = li.product_id
    JOIN occasions a ON a.id = po.attribute_id
   WHERE oc.role = 'customer' AND o.workspace_owner_id = $1
   GROUP BY oc.contact_id
),
gift_dates AS (
  -- Gift orders only: sender + a DIFFERENT recipient on the same order.
  -- Recurrence is correlated per recipient relationship so unrelated or
  -- self purchases can never establish an inferred repeat date.
  SELECT occ.contact_id, ocr.contact_id AS recipient_id,
         COALESCE(o.ordered_at, o.created_at) AS d
    FROM order_contacts occ
    JOIN orders o ON o.id = occ.order_id
    JOIN order_contacts ocr ON ocr.order_id = occ.order_id
     AND ocr.role = 'recipient' AND ocr.contact_id <> occ.contact_id
   WHERE occ.role = 'customer' AND o.workspace_owner_id = $1
     AND COALESCE(o.ordered_at, o.created_at) IS NOT NULL
),
-- Qualifying gift pairs: same sender→recipient, different years, ≤7 DOY offset.
-- The "upcoming days" and "prior-year gap" are derived ONLY from these pairs so
-- that self-orders and unrelated-recipient orders can never contribute.
repeat_gift_pairs AS (
  SELECT a.contact_id,
         a.recipient_id,
         a.d                 AS gift_date_a,
         b.d                 AS gift_date_b,
         LEAST(
           ABS(date_part('doy', a.d)::int - date_part('doy', b.d)::int),
           365 - ABS(date_part('doy', a.d)::int - date_part('doy', b.d)::int)
         ) AS doy_dist
    FROM gift_dates a
    JOIN gift_dates b ON b.contact_id = a.contact_id
     AND b.recipient_id = a.recipient_id
     AND date_part('year', b.d) <> date_part('year', a.d)
     AND LEAST(
           ABS(date_part('doy', a.d)::int - date_part('doy', b.d)::int),
           365 - ABS(date_part('doy', a.d)::int - date_part('doy', b.d)::int)
         ) <= 7
),
repeat_dates AS (
  -- has_inferred_repeat_date flag: contact has ≥1 qualifying gift pair.
  SELECT DISTINCT contact_id FROM repeat_gift_pairs
),
repeat_anniv AS (
  -- occasion_upcoming_days and occasion_prior_year_days derived exclusively from
  -- qualifying gift pairs (NOT all customer orders). This ensures unrelated
  -- orders and self-purchases cannot contribute an upcoming-window date.
  SELECT contact_id,
         MIN(((date_part('doy', gift_date_a)::int - date_part('doy', now())::int) + 365) % 365)
           AS days_to_next_anniversary,
         MIN(ABS(EXTRACT(EPOCH FROM (gift_date_a - (now() - interval '1 year'))) / 86400))
           AS prior_year_gap_days
    FROM repeat_gift_pairs
   GROUP BY contact_id
),
base AS (
  SELECT c.id,
         c.first_name, c.last_name, c.display_name, c.email, c.phone,
         CASE
           WHEN COALESCE(cust.orders_count, 0) > 0 AND COALESCE(recip.recipient_orders_count, 0) > 0 THEN 'both'
           WHEN COALESCE(cust.orders_count, 0) > 0 THEN 'customer'
           WHEN COALESCE(recip.recipient_orders_count, 0) > 0 THEN 'recipient'
           ELSE 'none'
         END AS contact_type,
         lower(COALESCE(${phoneCountry}, NULLIF(TRIM(COALESCE(c.metadata->>'country_code', '')), ''))) AS country,
         lower(city.city) AS city,
         lower(NULLIF(TRIM(COALESCE(c.metadata->>'preferred_language', '')), '')) AS language,
         lower(NULLIF(TRIM(COALESCE(c.source, '')), '')) AS source,
         c.created_at,
         c.tags,
         COALESCE(cust.orders_count, 0) AS orders_count,
         COALESCE(cust.gifts_sent_count, 0) AS gifts_sent_count,
         COALESCE(spend.total_spent, 0)::numeric AS total_spent,
         (COALESCE(spend.total_spent, 0) / NULLIF(cust.orders_count, 0))::numeric AS aov,
         cust.first_order_at,
         cust.last_order_at,
         FLOOR(EXTRACT(EPOCH FROM (now() - cust.last_order_at)) / 86400)::int AS days_since_last_order,
         (COALESCE(cust.orders_count, 0) >= 2) AS is_repeat_customer,
         COALESCE(recip.gifts_received_count, 0) AS gifts_received_count,
         COALESCE(uniq_recips.unique_recipients_count, 0) AS unique_recipients_count,
         (COALESCE(recip.gifts_received_count, 0) >= 2) AS is_repeat_recipient,
         COALESCE(recip_countries.recipient_countries, '{}'::text[]) AS recipient_country,
         cust.last_gift_sent_at,
         recip.last_gift_received_at,
         (COALESCE(cust.self_orders_count, 0) > 0) AS has_self_order,
         (COALESCE(cust.gifts_sent_count, 0) > 0) AS has_gift_order,
         COALESCE(occ.occasion_types, '{}'::text[]) AS occasion_type,
         repeat_anniv.days_to_next_anniversary AS occasion_upcoming_days,
         repeat_anniv.prior_year_gap_days AS occasion_prior_year_days,
         (repeat_dates.contact_id IS NOT NULL) AS has_inferred_repeat_date,
         c.email_consent,
         c.whatsapp_consent,
         (c.unsubscribed_at IS NOT NULL) AS is_suppressed,
         (c.email IS NOT NULL AND c.email ${VALID_EMAIL_SQL} AND c.email_consent AND c.unsubscribed_at IS NULL) AS email_reachable,
         (c.phone IS NOT NULL AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 7 AND c.whatsapp_consent AND c.unsubscribed_at IS NULL) AS whatsapp_reachable,
         (c.email IS NOT NULL) AS has_email,
         (c.email IS NOT NULL AND c.email ${VALID_EMAIL_SQL}) AS valid_email,
         (c.phone IS NOT NULL) AS has_phone,
         (c.phone IS NOT NULL AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 7) AS valid_phone,
         (c.respondio_contact_id IS NOT NULL) AS respondio_synced
    FROM contacts c
    LEFT JOIN cust ON cust.contact_id = c.id
    LEFT JOIN uniq_recips ON uniq_recips.contact_id = c.id
    LEFT JOIN spend ON spend.contact_id = c.id
    LEFT JOIN recip ON recip.contact_id = c.id
    LEFT JOIN recip_countries ON recip_countries.contact_id = c.id
    LEFT JOIN city ON city.contact_id = c.id
    LEFT JOIN occ ON occ.contact_id = c.id
    LEFT JOIN repeat_anniv ON repeat_anniv.contact_id = c.id
    LEFT JOIN repeat_dates ON repeat_dates.contact_id = c.id
   WHERE c.workspace_owner_id = $1 AND c.archived_at IS NULL
)`;
}

// ── Condition → SQL predicate ───────────────────────────────────────────

/** Array-valued fields (matched with ANY / && semantics). */
const ARRAY_FIELDS = new Set(["tags", "recipient_country", "occasion_type"]);
/** Fields whose within_next_days means "column value (days) <= N". */
const DAYS_THRESHOLD_FIELDS = new Set(["occasion_upcoming_days", "occasion_prior_year_days"]);

export function conditionSql(cond: RuleCondition, params: Params): string {
  const fieldKey = resolveFieldKey(cond.field);
  const def = FIELDS_BY_KEY.get(fieldKey);
  if (!def) throw new Error(`unknown field ${cond.field}`);
  const col = fieldKey;
  const op = cond.operator;
  const v = cond.value;

  if (DAYS_THRESHOLD_FIELDS.has(col)) {
    // within_next_days N → precomputed day distance <= N.
    return `(${col} IS NOT NULL AND ${col} <= ${params.add(v)})`;
  }

  if (ARRAY_FIELDS.has(col)) {
    switch (op) {
      case "contains":
      case "eq":
        return `EXISTS (SELECT 1 FROM unnest(${col}) _t WHERE lower(_t) = lower(${params.add(v)}))`;
      case "not_contains":
      case "neq":
        return `NOT EXISTS (SELECT 1 FROM unnest(${col}) _t WHERE lower(_t) = lower(${params.add(v)}))`;
      case "in":
        return `EXISTS (SELECT 1 FROM unnest(${col}) _t WHERE lower(_t) = ANY(SELECT lower(_x) FROM unnest(${params.add(v)}::text[]) _x))`;
      case "not_in":
        return `NOT EXISTS (SELECT 1 FROM unnest(${col}) _t WHERE lower(_t) = ANY(SELECT lower(_x) FROM unnest(${params.add(v)}::text[]) _x))`;
      default:
        throw new Error(`operator ${op} not supported on array field ${col}`);
    }
  }

  if (def.type === "boolean") {
    if (op === "is_true") return `(${col} IS TRUE)`;
    if (op === "is_false") return `(${col} IS NOT TRUE)`;
    throw new Error(`operator ${op} not supported on boolean field ${col}`);
  }

  if (def.type === "date") {
    switch (op) {
      case "before":
        return `(${col} IS NOT NULL AND ${col} < ${params.add(v)}::timestamptz)`;
      case "after":
        return `(${col} IS NOT NULL AND ${col} > ${params.add(v)}::timestamptz)`;
      case "between": {
        const [a, b] = v as [string, string];
        return `(${col} IS NOT NULL AND ${col} >= ${params.add(a)}::timestamptz AND ${col} <= ${params.add(b)}::timestamptz)`;
      }
      case "within_last_days":
        return `(${col} IS NOT NULL AND ${col} >= now() - (${params.add(v)} || ' days')::interval)`;
      case "more_than_days_ago":
        return `(${col} IS NOT NULL AND ${col} < now() - (${params.add(v)} || ' days')::interval)`;
      case "is_set":
        return `(${col} IS NOT NULL)`;
      case "is_missing":
        return `(${col} IS NULL)`;
      default:
        throw new Error(`operator ${op} not supported on date field ${col}`);
    }
  }

  if (def.type === "number") {
    switch (op) {
      case "eq":
        return `(${col} = ${params.add(v)})`;
      case "neq":
        return `(${col} IS DISTINCT FROM ${params.add(v)})`;
      case "gt":
        return `(${col} > ${params.add(v)})`;
      case "gte":
        return `(${col} >= ${params.add(v)})`;
      case "lt":
        return `(${col} < ${params.add(v)})`;
      case "lte":
        return `(${col} <= ${params.add(v)})`;
      case "between": {
        const [a, b] = v as [number, number];
        return `(${col} >= ${params.add(a)} AND ${col} <= ${params.add(b)})`;
      }
      default:
        throw new Error(`operator ${op} not supported on number field ${col}`);
    }
  }

  // string / enum
  switch (op) {
    case "eq":
      return `(lower(${col}::text) = lower(${params.add(v)}))`;
    case "neq":
      return `(${col} IS NULL OR lower(${col}::text) <> lower(${params.add(v)}))`;
    case "in":
      return `(lower(${col}::text) = ANY(SELECT lower(_x) FROM unnest(${params.add(v)}::text[]) _x))`;
    case "not_in":
      return `(${col} IS NULL OR NOT (lower(${col}::text) = ANY(SELECT lower(_x) FROM unnest(${params.add(v)}::text[]) _x)))`;
    case "is_set":
      return `(${col} IS NOT NULL)`;
    case "is_missing":
      return `(${col} IS NULL)`;
    default:
      throw new Error(`operator ${op} not supported on field ${col}`);
  }
}

export function groupSql(group: RuleGroup | null | undefined, params: Params): string {
  if (!group || groupIsEmpty(group)) return "FALSE";
  const parts: string[] = [];
  for (const c of group.conditions ?? []) parts.push(conditionSql(c, params));
  for (const g of group.groups ?? []) {
    if (!groupIsEmpty(g)) parts.push(groupSql(g, params));
  }
  const joiner = group.logic === "ANY" ? " OR " : " AND ";
  return `(${parts.join(joiner)})`;
}

// ── Public API ──────────────────────────────────────────────────────────

export type AudienceMetrics = {
  matched: number;
  emailReachable: number;
  whatsappReachable: number;
  bothReachable: number;
  excluded: number;
  avgLifetimeSpendUsd: number | null;
};

export type EvidenceEntry = {
  path: string;
  field: string;
  operator: string;
  value: unknown;
  actual: unknown;
  matched: boolean;
};

export type MatchedContact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  emailReachable: boolean;
  whatsappReachable: boolean;
  totalSpentUsd: number;
  /** Include-rule evidence: matched values for every include condition. */
  evidence: EvidenceEntry[];
  /** Exclusion conditions evaluated for this (included) contact — matched=true means a near-miss. */
  nearMissExclusions: EvidenceEntry[];
};

type EvalSource =
  | { kind: "rules"; tree: RuleTree }
  | { kind: "static"; audienceId: string };

function membershipPredicate(source: EvalSource, params: Params): { inc: string; exc: string } {
  if (source.kind === "static") {
    return {
      inc: `EXISTS (SELECT 1 FROM audience_members am WHERE am.audience_id = ${params.add(source.audienceId)} AND am.contact_id = base.id)`,
      exc: "FALSE",
    };
  }
  const inc = groupSql(source.tree.include, params);
  const exc = source.tree.exclude && !groupIsEmpty(source.tree.exclude)
    ? groupSql(source.tree.exclude, params)
    : "FALSE";
  return { inc, exc };
}

/** Compute the metrics block for a rule tree or a static audience. */
export async function evaluateMetrics(
  workspaceOwnerId: string,
  source: EvalSource,
): Promise<AudienceMetrics> {
  const params = new Params([workspaceOwnerId]);
  const { inc, exc } = membershipPredicate(source, params);
  const sql = `WITH ${baseCteSql()}
    SELECT
      COUNT(*) FILTER (WHERE _inc AND NOT _exc)::int AS matched,
      COUNT(*) FILTER (WHERE _inc AND _exc)::int AS excluded,
      COUNT(*) FILTER (WHERE _inc AND NOT _exc AND email_reachable)::int AS email_reachable,
      COUNT(*) FILTER (WHERE _inc AND NOT _exc AND whatsapp_reachable)::int AS whatsapp_reachable,
      COUNT(*) FILTER (WHERE _inc AND NOT _exc AND email_reachable AND whatsapp_reachable)::int AS both_reachable,
      AVG(total_spent) FILTER (WHERE _inc AND NOT _exc) AS avg_spend
    FROM (SELECT base.*, (${inc}) AS _inc, (${exc}) AS _exc FROM base) base`;
  const r = await db.query<{
    matched: number;
    excluded: number;
    email_reachable: number;
    whatsapp_reachable: number;
    both_reachable: number;
    avg_spend: string | null;
  }>(sql, params.values);
  const row = r.rows[0];
  return {
    matched: row.matched,
    excluded: row.excluded,
    emailReachable: row.email_reachable,
    whatsappReachable: row.whatsapp_reachable,
    bothReachable: row.both_reachable,
    avgLifetimeSpendUsd:
      row.avg_spend != null ? Math.round(parseFloat(String(row.avg_spend)) * 100) / 100 : null,
  };
}

/**
 * Paginated matching contacts with per-contact "why included" evidence.
 * For static audiences the evidence lists are empty (membership is explicit).
 */
export async function evaluateContacts(
  workspaceOwnerId: string,
  source: EvalSource,
  page: number,
  limit: number,
): Promise<{ contacts: MatchedContact[]; total: number }> {
  const params = new Params([workspaceOwnerId]);
  const { inc, exc } = membershipPredicate(source, params);

  const includeConds =
    source.kind === "rules" ? flattenConditions(source.tree.include, "include") : [];
  const excludeConds =
    source.kind === "rules" ? flattenConditions(source.tree.exclude ?? null, "exclude") : [];

  const condCols: string[] = [];
  includeConds.forEach((c, i) => {
    condCols.push(`(${conditionSql(c.condition, params)}) AS m_inc_${i}`);
  });
  excludeConds.forEach((c, i) => {
    condCols.push(`(${conditionSql(c.condition, params)}) AS m_exc_${i}`);
  });

  const fieldCols = [
    ...new Set(
      [...includeConds, ...excludeConds]
        .map((c) => c.condition.field)
        .filter((f) => !["created_at"].includes(f)),
    ),
  ];

  const offset = (page - 1) * limit;
  const sql = `WITH ${baseCteSql()},
    matched AS (
      SELECT base.*${condCols.length ? ", " + condCols.join(", ") : ""}
        FROM (SELECT base.*, (${inc}) AS _inc, (${exc}) AS _exc FROM base) base
       WHERE _inc AND NOT _exc
    )
    SELECT *, COUNT(*) OVER ()::int AS _total
      FROM matched
     ORDER BY last_order_at DESC NULLS LAST, id
     LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;

  const r = await db.query<Record<string, unknown>>(sql, params.values);
  const total = r.rows.length > 0 ? Number(r.rows[0]._total) : await countOnly();

  async function countOnly(): Promise<number> {
    // Page beyond the end — run the cheap count so `total` stays correct.
    const m = await evaluateMetrics(workspaceOwnerId, source);
    return m.matched;
  }

  const toEvidence = (
    row: Record<string, unknown>,
    conds: { path: string; condition: RuleCondition }[],
    prefix: string,
  ): EvidenceEntry[] =>
    conds.map((c, i) => ({
      path: c.path,
      field: c.condition.field,
      operator: c.condition.operator,
      value: c.condition.value ?? null,
      actual: fieldCols.includes(c.condition.field) ? row[c.condition.field] ?? null : row.created_at ?? null,
      matched: row[`${prefix}${i}`] === true,
    }));

  const contacts: MatchedContact[] = r.rows.map((row) => ({
    id: String(row.id),
    firstName: (row.first_name as string) ?? null,
    lastName: (row.last_name as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    emailReachable: row.email_reachable === true,
    whatsappReachable: row.whatsapp_reachable === true,
    totalSpentUsd: row.total_spent != null ? parseFloat(String(row.total_spent)) : 0,
    evidence: toEvidence(row, includeConds, "m_inc_"),
    nearMissExclusions: toEvidence(row, excludeConds, "m_exc_"),
  }));

  return { contacts, total };
}

/** Contact ids matched by a rule tree (used to snapshot into a static audience). */
export async function evaluateContactIds(
  workspaceOwnerId: string,
  tree: RuleTree,
  cap = 50_000,
): Promise<string[]> {
  const params = new Params([workspaceOwnerId]);
  const { inc, exc } = membershipPredicate({ kind: "rules", tree }, params);
  const sql = `WITH ${baseCteSql()}
    SELECT id FROM (SELECT base.*, (${inc}) AS _inc, (${exc}) AS _exc FROM base) base
     WHERE _inc AND NOT _exc
     LIMIT ${params.add(cap)}`;
  const r = await db.query<{ id: string }>(sql, params.values);
  return r.rows.map((row) => row.id);
}
