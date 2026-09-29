import { Router } from "express";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { findCountryByCode, findCountryByName, phoneCountrySql } from "../lib/defaults";
import { logger } from "../lib/logger";
import { queueGenderInference } from "../lib/genderInference";
import { getRespondIoContactUrl } from "../lib/respondio";
import { buildSearchTerms, escapeLike, normalizeQueryDigits } from "../lib/contactSearchNormalize";
import { syncContactToRespondIo } from "../lib/contactUpsert";

const router = Router();

/**
 * Dashboard contacts list for the Customers page.
 *
 * Sources the list from the shared `contacts` pool (the only table that holds
 * recipients) rather than the sender-only `customers` aggregate. Each row's
 * Customer / Recipient role is computed from `order_contacts` (never stored).
 * Manual, free-text tags live in `contacts.tags`; the reserved words
 * `customer` / `recipient` may never be added as manual tags so they cannot
 * collide with the computed role badges.
 */

const RESERVED_TAGS = ["customer", "recipient"];

function isReservedTag(tag: string): boolean {
  return RESERVED_TAGS.includes(tag.trim().toLowerCase());
}

/** Strip reserved role words from a manual-tags array before returning it. */
function manualTags(tags: string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => !isReservedTag(t));
}

// SQL fragments: a contact "is a customer" / "is a recipient" when at least
// one of its order_contacts rows in this workspace carries that role.
const CUSTOMER_EXISTS = `EXISTS (
  SELECT 1 FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
  WHERE oc.contact_id = c.id AND oc.role = 'customer'
    AND o.workspace_owner_id = c.workspace_owner_id
)`;
const RECIPIENT_EXISTS = `EXISTS (
  SELECT 1 FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
  WHERE oc.contact_id = c.id AND oc.role = 'recipient'
    AND o.workspace_owner_id = c.workspace_owner_id
)`;

// Country derived from the contact's phone dial code (lowercase ISO code, or
// NULL when the phone is missing/local-format/unrecognized).
const PHONE_COUNTRY = phoneCountrySql("c.phone");

// Effective raw country value for a contact: the phone-derived country wins;
// contacts without a recognizable dial code fall back to the billing country
// code persisted on the contact's metadata, then the most recent linked
// order's delivery_address countryCode. The raw value may be an ISO code
// ("LB") or a full name; it is resolved to a display name in JS.
const COUNTRY_RAW = `COALESCE(
  ${PHONE_COUNTRY},
  NULLIF(TRIM(COALESCE(c.metadata->>'country_code', '')), ''),
  (SELECT NULLIF(TRIM(COALESCE(o.delivery_address->>'countryCode', '')), '')
     FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
    WHERE oc.contact_id = c.id AND o.workspace_owner_id = c.workspace_owner_id
      AND NULLIF(TRIM(COALESCE(o.delivery_address->>'countryCode', '')), '') IS NOT NULL
    ORDER BY o.ordered_at DESC NULLS LAST, o.created_at DESC
    LIMIT 1)
)`;

// A contact is flagged as a duplicate when another contact in the same
// workspace shares its digit-normalized phone or case-normalized email.
// (Exact-match duplicates cannot exist — unique constraints — so this catches
// format variants like "+961 70 123" vs "96170123".)
const DUP_EXISTS = `EXISTS (
  SELECT 1 FROM contacts c2
  WHERE c2.workspace_owner_id = c.workspace_owner_id
    AND c2.id <> c.id
    AND (
      (c.phone IS NOT NULL AND c2.phone IS NOT NULL
        AND regexp_replace(c.phone, '[^0-9]', '', 'g') <> ''
        AND regexp_replace(c2.phone, '[^0-9]', '', 'g') = regexp_replace(c.phone, '[^0-9]', '', 'g'))
      OR (c.email IS NOT NULL AND c2.email IS NOT NULL
        AND lower(c2.email) = lower(c.email))
    )
)`;

const VIP_EXISTS = `EXISTS (SELECT 1 FROM unnest(c.tags) tg WHERE lower(tg) = 'vip')`;

/** Resolve a raw stored country value (ISO code or name) to a display name. */
function countryDisplayName(raw: string | null): string | null {
  if (!raw) return null;
  const entry = findCountryByCode(raw) ?? findCountryByName(raw);
  return entry?.name ?? raw;
}

const SORTABLE: Record<string, string> = {
  created_at: "c.created_at",
  last_order_at: "last_order_at",
  orders_placed: "orders_placed",
  name: "name_sort",
  total_spent_usd: "total_spent_usd",
};

type ContactListRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  created_at: string;
  is_customer: boolean;
  is_recipient: boolean;
  orders_placed: number;
  last_order_at: string | null;
  customer_id: number | null;
  total_spent_usd: string | null;
  country_raw: string | null;
  is_vip: boolean;
};

router.use("/contacts", requireAuth, resolveWorkspace);
router.use("/contacts", (req, res, next) => {
  if (hasPageAccess(workspace(req), "customers")) {
    next();
    return;
  }
  res.status(403).json({ error: "You do not have access to customers" });
});

/**
 * GET /api/contacts — paginated list of people involved in orders (customers
 * and recipients), with computed role flags, manual tags, and order stats.
 */
router.get("/contacts", async (req, res) => {
  const wreq = workspace(req);
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
  const offset = (page - 1) * limit;
  const search = ((req.query.search as string) || "").trim();
  const sortKey = ((req.query.sort as string) || "created_at").toLowerCase();
  const sortDir = ((req.query.dir as string) || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortCol = SORTABLE[sortKey] ?? SORTABLE.created_at;
  const role = ((req.query.role as string) || "").trim().toLowerCase();
  // `type` supersedes the legacy `role` param (which stays supported).
  const type = ((req.query.type as string) || "").trim().toLowerCase() || role;
  const tag = ((req.query.tag as string) || "").trim();
  const country = ((req.query.country as string) || "").trim();

  const conds: string[] = ["c.workspace_owner_id = $1", "c.archived_at IS NULL"];
  const params: unknown[] = [wreq.workspaceOwnerId];
  let idx = 2;

  // Type/role filter. Default ("all") still restricts to people involved in orders.
  if (type === "customer") {
    conds.push(CUSTOMER_EXISTS);
  } else if (type === "recipient") {
    conds.push(RECIPIENT_EXISTS);
  } else if (type === "both") {
    conds.push(`${CUSTOMER_EXISTS} AND ${RECIPIENT_EXISTS}`);
  } else if (type === "vip") {
    conds.push(`(${CUSTOMER_EXISTS} OR ${RECIPIENT_EXISTS})`);
    conds.push(VIP_EXISTS);
  } else if (type === "duplicates") {
    conds.push(`(${CUSTOMER_EXISTS} OR ${RECIPIENT_EXISTS})`);
    conds.push(DUP_EXISTS);
  } else {
    conds.push(`(${CUSTOMER_EXISTS} OR ${RECIPIENT_EXISTS})`);
  }

  if (tag) {
    conds.push(`$${idx} = ANY(c.tags)`);
    params.push(tag);
    idx++;
  }

  if (country) {
    // The dropdown sends a country display name; stored raw values may be ISO
    // codes or names, so accept both (lowercased).
    const entry = findCountryByName(country) ?? findCountryByCode(country);
    const accepted = entry
      ? [entry.code.toLowerCase(), entry.name.toLowerCase()]
      : [country.toLowerCase()];
    conds.push(`lower(${COUNTRY_RAW}) = ANY($${idx}::text[])`);
    params.push(accepted);
    idx++;
  }

  if (search) {
    const terms = buildSearchTerms(search);
    const searchClauses: string[] = [];

    if (terms.phoneDigits) {
      const queryDigits = normalizeQueryDigits(terms.phoneDigits);
      const likePattern = `${escapeLike(queryDigits)}%`;
      searchClauses.push(
        `(EXISTS (SELECT 1 FROM unnest(c.phone_search_tokens) AS _t WHERE _t LIKE $${idx} ESCAPE '\\')
          OR (c.phone_search_tokens IS NULL
              AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $${idx + 1} ESCAPE '\\'))`,
      );
      params.push(likePattern);
      params.push(`%${escapeLike(queryDigits)}%`);
      idx += 2;
    }

    if (terms.emailQuery) {
      searchClauses.push(`lower(COALESCE(c.email, '')) LIKE $${idx} ESCAPE '\\'`);
      params.push(`%${escapeLike(terms.emailQuery)}%`);
      idx++;
    }

    if (terms.nameQuery) {
      const like = `%${escapeLike(terms.nameQuery)}%`;
      searchClauses.push(
        `(COALESCE(c.first_name,'') ILIKE $${idx} ESCAPE '\\'
          OR COALESCE(c.last_name,'') ILIKE $${idx} ESCAPE '\\'
          OR COALESCE(c.display_name,'') ILIKE $${idx} ESCAPE '\\')`,
      );
      params.push(like);
      idx++;
    }

    // Plain fallback: if the query didn't resolve to any typed term (e.g. short
    // digit run < 4 digits), still search the email column as a substring to
    // preserve pre-existing behaviour for ambiguous short queries.
    if (searchClauses.length === 0) {
      const like = `%${escapeLike(search)}%`;
      searchClauses.push(
        `(COALESCE(c.first_name,'') ILIKE $${idx} ESCAPE '\\'
          OR COALESCE(c.last_name,'') ILIKE $${idx} ESCAPE '\\'
          OR COALESCE(c.display_name,'') ILIKE $${idx} ESCAPE '\\'
          OR COALESCE(c.email,'') ILIKE $${idx} ESCAPE '\\'
          OR COALESCE(c.phone,'') ILIKE $${idx} ESCAPE '\\')`,
      );
      params.push(like);
      idx++;
    }

    conds.push(`(${searchClauses.join(" OR ")})`);
  }

  const where = conds.join(" AND ");

  const selectExpr = `
    c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
    c.tags, c.created_at,
    ${CUSTOMER_EXISTS} AS is_customer,
    ${RECIPIENT_EXISTS} AS is_recipient,
    (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
       WHERE oc.contact_id = c.id AND oc.role = 'customer'
         AND o.workspace_owner_id = c.workspace_owner_id)::int AS orders_placed,
    (SELECT MAX(o.ordered_at) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
       WHERE oc.contact_id = c.id AND oc.role = 'customer'
         AND o.workspace_owner_id = c.workspace_owner_id) AS last_order_at,
    (SELECT cu.id FROM customers cu
       WHERE cu.workspace_owner_id = c.workspace_owner_id AND cu.deleted_at IS NULL
         AND ((c.email IS NOT NULL AND cu.email = c.email)
              OR (c.phone IS NOT NULL AND cu.phone = c.phone))
       ORDER BY cu.id ASC LIMIT 1) AS customer_id,
    (SELECT COALESCE(SUM(op.amount_usd), 0)
       FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
       JOIN order_payment op ON op.order_id = o.id
      WHERE oc.contact_id = c.id AND oc.role = 'customer'
        AND o.workspace_owner_id = c.workspace_owner_id
        AND lower(COALESCE(op.status, '')) IN ('paid', 'recorded')
        AND op.amount_usd IS NOT NULL) AS total_spent_usd,
    ${COUNTRY_RAW} AS country_raw,
    ${VIP_EXISTS} AS is_vip,
    COALESCE(NULLIF(TRIM(COALESCE(c.display_name,'')), ''),
             NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '')) AS name_sort
  `;

  const [rowsRes, countRes, tagsRes, countriesRes] = await Promise.all([
    db.query<ContactListRow & { name_sort: string | null }>(
      `SELECT ${selectExpr}
         FROM contacts c
        WHERE ${where}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, c.id DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*)::int AS total FROM contacts c WHERE ${where}`,
      params,
    ),
    db.query<{ tag: string }>(
      `SELECT DISTINCT t AS tag
         FROM contacts c, unnest(c.tags) AS t
        WHERE c.workspace_owner_id = $1
          AND lower(t) <> 'customer' AND lower(t) <> 'recipient'
        ORDER BY t ASC`,
      [wreq.workspaceOwnerId],
    ),
    db.query<{ raw: string }>(
      `SELECT DISTINCT x.raw FROM (
         SELECT ${PHONE_COUNTRY} AS raw
           FROM contacts c WHERE c.workspace_owner_id = $1
         UNION
         SELECT NULLIF(TRIM(COALESCE(c.metadata->>'country_code', '')), '')
           FROM contacts c WHERE c.workspace_owner_id = $1
         UNION
         SELECT NULLIF(TRIM(COALESCE(o.delivery_address->>'countryCode', '')), '')
           FROM orders o WHERE o.workspace_owner_id = $1
       ) x WHERE x.raw IS NOT NULL`,
      [wreq.workspaceOwnerId],
    ),
  ]);

  const availableCountries = Array.from(
    new Set(
      countriesRes.rows
        .map((r) => countryDisplayName(r.raw))
        .filter((n): n is string => !!n),
    ),
  ).sort((a, b) => a.localeCompare(b));

  res.json({
    contacts: rowsRes.rows.map((r) => ({
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      display_name: r.display_name,
      email: r.email,
      phone: r.phone,
      tags: manualTags(r.tags),
      is_customer: r.is_customer,
      is_recipient: r.is_recipient,
      orders_placed: r.orders_placed,
      last_order_at: r.last_order_at,
      customer_id: r.customer_id,
      total_spent_usd: r.total_spent_usd != null ? parseFloat(String(r.total_spent_usd)) : 0,
      country: countryDisplayName(r.country_raw),
      is_repeat: r.orders_placed >= 2,
      is_vip: r.is_vip,
      created_at: r.created_at,
    })),
    available_tags: tagsRes.rows.map((t) => t.tag),
    available_countries: availableCountries,
    total: parseInt(String(countRes.rows[0]?.total ?? "0"), 10),
    page,
    limit,
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ContactDetailRow = ContactListRow & {
  source: string | null;
  updated_at: string;
  archived_at: string | null;
  preferred_language: string | null;
  gender: string;
  gender_source: string | null;
  gender_confidence: string | null;
  gifts_received: number;
  last_gift_at: string | null;
  last_activity_at: string | null;
  customer_total_orders: number | null;
  customer_total_spent: string | null;
  customer_last_order_at: string | null;
};

/** Insert a system activity row for a contact (best-effort, never throws). */
async function logContactActivity(
  wreq: WorkspaceRequest,
  contactId: string,
  type: string,
  data: Record<string, unknown> | null,
  client?: { query: typeof db.query },
): Promise<void> {
  try {
    await (client ?? db).query(
      `INSERT INTO contact_activity (workspace_owner_id, contact_id, type, actor_user_id, actor_name, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        wreq.workspaceOwnerId,
        contactId,
        type,
        wreq.userId ?? null,
        wreq.userEmail ?? null,
        data ? JSON.stringify(data) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err, contactId, type }, "failed to log contact activity");
  }
}

/**
 * GET /api/contacts/summary — KPI counts for the Customers page header cards:
 * total contacts, customers, recipients, and repeat customers (2+ customer
 * orders), each with a percent delta vs the end of last month (null when the
 * previous value is zero).
 */
router.get("/contacts/summary", async (req, res) => {
  const wreq = workspace(req);

  const r = await db.query<{
    total: number;
    customers: number;
    recipients: number;
    repeat: number;
    prev_total: number;
    prev_customers: number;
    prev_recipients: number;
    prev_repeat: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_cust OR is_rec)::int AS total,
       COUNT(*) FILTER (WHERE is_cust)::int AS customers,
       COUNT(*) FILTER (WHERE is_rec)::int AS recipients,
       COUNT(*) FILTER (WHERE cust_orders >= 2)::int AS repeat,
       COUNT(*) FILTER (WHERE created_at < month_start AND (was_cust OR was_rec))::int AS prev_total,
       COUNT(*) FILTER (WHERE created_at < month_start AND was_cust)::int AS prev_customers,
       COUNT(*) FILTER (WHERE created_at < month_start AND was_rec)::int AS prev_recipients,
       COUNT(*) FILTER (WHERE created_at < month_start AND prev_cust_orders >= 2)::int AS prev_repeat
     FROM (
       SELECT c.id, c.created_at, date_trunc('month', now()) AS month_start,
         EXISTS (SELECT 1 FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
                  WHERE oc.contact_id = c.id AND oc.role = 'customer'
                    AND o.workspace_owner_id = c.workspace_owner_id) AS is_cust,
         EXISTS (SELECT 1 FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
                  WHERE oc.contact_id = c.id AND oc.role = 'recipient'
                    AND o.workspace_owner_id = c.workspace_owner_id) AS is_rec,
         (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
           WHERE oc.contact_id = c.id AND oc.role = 'customer'
             AND o.workspace_owner_id = c.workspace_owner_id)::int AS cust_orders,
         EXISTS (SELECT 1 FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
                  WHERE oc.contact_id = c.id AND oc.role = 'customer'
                    AND o.workspace_owner_id = c.workspace_owner_id
                    AND o.created_at < date_trunc('month', now())) AS was_cust,
         EXISTS (SELECT 1 FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
                  WHERE oc.contact_id = c.id AND oc.role = 'recipient'
                    AND o.workspace_owner_id = c.workspace_owner_id
                    AND o.created_at < date_trunc('month', now())) AS was_rec,
         (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
           WHERE oc.contact_id = c.id AND oc.role = 'customer'
             AND o.workspace_owner_id = c.workspace_owner_id
             AND o.created_at < date_trunc('month', now()))::int AS prev_cust_orders
       FROM contacts c
      WHERE c.workspace_owner_id = $1 AND c.archived_at IS NULL
     ) s`,
    [wreq.workspaceOwnerId],
  );

  const row = r.rows[0];
  const kpi = (count: number, prev: number) => ({
    count,
    delta_pct: prev > 0 ? Math.round(((count - prev) / prev) * 1000) / 10 : null,
  });

  res.json({
    total_contacts: kpi(row.total, row.prev_total),
    customers: kpi(row.customers, row.prev_customers),
    recipients: kpi(row.recipients, row.prev_recipients),
    repeat_customers: kpi(row.repeat, row.prev_repeat),
  });
});

/**
 * GET /api/contacts/:id — single contact with the same computed fields as the
 * list (roles, manual tags, order stats, matched customer id) plus the matched
 * customer's aggregates when a `customers` row matches by email/phone.
 */
router.get("/contacts/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const [r, relRes, dupRes] = await Promise.all([
    db.query<ContactDetailRow>(
      `SELECT
       c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
       c.tags, c.created_at, c.updated_at, c.source, c.archived_at,
       c.gender, c.gender_source, c.gender_confidence,
       c.metadata->>'preferred_language' AS preferred_language,
       ${CUSTOMER_EXISTS} AS is_customer,
       ${RECIPIENT_EXISTS} AS is_recipient,
       ${COUNTRY_RAW} AS country_raw,
       ${VIP_EXISTS} AS is_vip,
       (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
          WHERE oc.contact_id = c.id AND oc.role = 'customer'
            AND o.workspace_owner_id = c.workspace_owner_id)::int AS orders_placed,
       (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
          WHERE oc.contact_id = c.id AND oc.role = 'recipient'
            AND o.workspace_owner_id = c.workspace_owner_id)::int AS gifts_received,
       (SELECT MAX(o.ordered_at) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
          WHERE oc.contact_id = c.id AND oc.role = 'customer'
            AND o.workspace_owner_id = c.workspace_owner_id) AS last_order_at,
       (SELECT MAX(o.ordered_at) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
          WHERE oc.contact_id = c.id AND oc.role = 'recipient'
            AND o.workspace_owner_id = c.workspace_owner_id) AS last_gift_at,
       (SELECT MAX(COALESCE(o.ordered_at, o.created_at))
          FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
         WHERE oc.contact_id = c.id
           AND o.workspace_owner_id = c.workspace_owner_id) AS last_activity_at,
       (SELECT COALESCE(SUM(op.amount_usd), 0)
          FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
          JOIN order_payment op ON op.order_id = o.id
         WHERE oc.contact_id = c.id AND oc.role = 'customer'
           AND o.workspace_owner_id = c.workspace_owner_id
           AND lower(COALESCE(op.status, '')) IN ('paid', 'recorded')
           AND op.amount_usd IS NOT NULL) AS total_spent_usd,
       cu.id AS customer_id,
       cu.total_orders AS customer_total_orders,
       cu.total_spent AS customer_total_spent,
       cu.last_order_at AS customer_last_order_at
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT cu.id, cu.total_orders, cu.total_spent, cu.last_order_at
         FROM customers cu
        WHERE cu.workspace_owner_id = c.workspace_owner_id AND cu.deleted_at IS NULL
          AND ((c.email IS NOT NULL AND cu.email = c.email)
               OR (c.phone IS NOT NULL AND cu.phone = c.phone))
        ORDER BY cu.id ASC LIMIT 1
     ) cu ON true
     WHERE c.id = $1 AND c.workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    ),
    // Linked relationships: counterpart contacts that appear on the same
    // orders with the opposite role (record-ID based, workspace-scoped).
    db.query<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      display_name: string | null;
      their_role: string;
      shared_orders: number;
      last_order_at: string | null;
    }>(
      `SELECT c2.id, c2.first_name, c2.last_name, c2.display_name,
              oc2.role AS their_role,
              COUNT(DISTINCT o.id)::int AS shared_orders,
              MAX(COALESCE(o.ordered_at, o.created_at)) AS last_order_at
         FROM order_contacts oc
         JOIN orders o ON o.id = oc.order_id AND o.workspace_owner_id = $2
         JOIN order_contacts oc2 ON oc2.order_id = oc.order_id
              AND oc2.contact_id <> oc.contact_id
         JOIN contacts c2 ON c2.id = oc2.contact_id
              AND c2.workspace_owner_id = $2
        WHERE oc.contact_id = $1
        GROUP BY c2.id, c2.first_name, c2.last_name, c2.display_name, oc2.role
        ORDER BY shared_orders DESC, last_order_at DESC NULLS LAST
        LIMIT 10`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM contacts c2, contacts c
        WHERE c.id = $1 AND c.workspace_owner_id = $2
          AND c2.workspace_owner_id = c.workspace_owner_id
          AND c2.id <> c.id
          AND (
            (c.phone IS NOT NULL AND c2.phone IS NOT NULL
              AND regexp_replace(c.phone, '[^0-9]', '', 'g') <> ''
              AND regexp_replace(c2.phone, '[^0-9]', '', 'g') = regexp_replace(c.phone, '[^0-9]', '', 'g'))
            OR (c.email IS NOT NULL AND c2.email IS NOT NULL
              AND lower(c2.email) = lower(c.email))
          )`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);
  const row = r.rows[0];
  if (!row) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const lastActivityAt = [row.last_activity_at, row.updated_at]
    .filter((d): d is string => !!d)
    .sort()
    .pop() ?? null;

  const respondioRow = await db.query<{
    respondio_contact_id: string | null;
    whatsapp_consent: boolean | null;
  }>(
    `SELECT respondio_contact_id, whatsapp_consent FROM contacts WHERE id = $1 LIMIT 1`,
    [id],
  );
  const respondioContactId = respondioRow.rows[0]?.respondio_contact_id ?? null;
  const whatsappConsent = respondioRow.rows[0]?.whatsapp_consent ?? false;
  const respondioUrl = respondioContactId ? getRespondIoContactUrl(respondioContactId) : null;

  res.json({
    contact: {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      display_name: row.display_name,
      email: row.email,
      phone: row.phone,
      tags: manualTags(row.tags),
      is_customer: row.is_customer,
      is_recipient: row.is_recipient,
      is_vip: row.is_vip,
      orders_placed: row.orders_placed,
      gifts_received: row.gifts_received,
      last_order_at: row.last_order_at,
      last_gift_at: row.last_gift_at,
      last_activity_at: lastActivityAt,
      respondio_contact_id: respondioContactId,
      respondio_url: respondioUrl,
      whatsapp_consent: whatsappConsent,
      total_spent_usd:
        row.total_spent_usd != null ? parseFloat(String(row.total_spent_usd)) : 0,
      country: countryDisplayName(row.country_raw),
      source: row.source,
      preferred_language: row.preferred_language,
      gender: row.gender ?? "unknown",
      gender_source: row.gender_source,
      gender_confidence:
        row.gender_confidence != null ? parseFloat(String(row.gender_confidence)) : null,
      archived_at: row.archived_at,
      customer_id: row.customer_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      duplicate_count: dupRes.rows[0]?.n ?? 0,
      relationships: relRes.rows.map((rel) => ({
        id: rel.id,
        name:
          (rel.display_name ?? "").trim() ||
          `${rel.first_name ?? ""} ${rel.last_name ?? ""}`.trim() ||
          null,
        their_role: rel.their_role,
        shared_orders: rel.shared_orders,
        last_order_at: rel.last_order_at,
      })),
      customer:
        row.customer_id != null
          ? {
              id: row.customer_id,
              total_orders: row.customer_total_orders ?? 0,
              total_spent: row.customer_total_spent ?? "0",
              last_order_at: row.customer_last_order_at,
            }
          : null,
    },
  });
});

/**
 * PATCH /api/contacts/:id — edit contact identity fields. Handles the
 * per-workspace unique constraints on email and phone (409 on conflict).
 */
router.patch("/contacts/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const editable: Record<string, string> = {
    first_name: "first_name",
    last_name: "last_name",
    display_name: "display_name",
    email: "email",
    phone: "phone",
  };
  const setClauses: string[] = [];
  const params: unknown[] = [];
  const changed: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(editable)) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    const v = body[k];
    if (v !== null && typeof v !== "string") {
      res.status(400).json({ error: `${k} must be a string or null` });
      return;
    }
    let val = typeof v === "string" ? v.trim() || null : null;
    if (col === "email" && val) val = val.toLowerCase();
    params.push(val);
    setClauses.push(`${col} = $${params.length}`);
    changed[k] = val;
  }
  // preferred_language lives in the metadata jsonb (no dedicated column).
  if (Object.prototype.hasOwnProperty.call(body, "preferred_language")) {
    const v = body.preferred_language;
    if (v !== null && typeof v !== "string") {
      res.status(400).json({ error: "preferred_language must be a string or null" });
      return;
    }
    const val = typeof v === "string" ? v.trim() || null : null;
    if (val) {
      params.push(JSON.stringify(val));
      setClauses.push(
        `metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{preferred_language}', $${params.length}::jsonb)`,
      );
    } else {
      setClauses.push(`metadata = COALESCE(metadata, '{}'::jsonb) - 'preferred_language'`);
    }
    changed.preferred_language = val;
  }
  // gender: manual override — always wins over AI inference and permanently
  // stops re-inference (gender_source = 'manual'), including "unknown".
  if (Object.prototype.hasOwnProperty.call(body, "gender")) {
    const v = body.gender;
    if (v !== "male" && v !== "female" && v !== "unknown") {
      res.status(400).json({ error: "gender must be one of male, female, unknown" });
      return;
    }
    params.push(v);
    setClauses.push(`gender = $${params.length}`);
    setClauses.push(`gender_source = 'manual'`);
    setClauses.push(`gender_confidence = NULL`);
    changed.gender = v;
  }
  if (setClauses.length === 0) {
    res.status(400).json({ error: "No editable fields provided" });
    return;
  }
  setClauses.push("updated_at = now()");
  // Capture the previous gender for the activity log before overwriting it.
  let previousGender: string | null = null;
  if (Object.prototype.hasOwnProperty.call(changed, "gender")) {
    const prev = await db.query<{ gender: string | null }>(
      `SELECT gender FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    previousGender = prev.rows[0]?.gender ?? null;
  }
  params.push(id);
  params.push(wreq.workspaceOwnerId);
  try {
    const r = await db.query<{ id: string }>(
      `UPDATE contacts SET ${setClauses.join(", ")}
        WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
        RETURNING id`,
      params,
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
  } catch (err: unknown) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      const constraint = (err as { constraint?: string }).constraint ?? "";
      const field = constraint.includes("phone") ? "phone" : "email";
      res.status(409).json({
        error: `Another contact in this workspace already uses this ${field}`,
        field,
      });
      return;
    }
    throw err;
  }
  await logContactActivity(wreq, id, "contact_updated", { fields: Object.keys(changed) });
  if (Object.prototype.hasOwnProperty.call(changed, "gender")) {
    await logContactActivity(wreq, id, "gender_updated", {
      old: previousGender ?? "unknown",
      new: changed.gender,
    });
  }
  // Name, language, or phone (country-context) edits can change the inferred
  // gender — queue a re-inference (cache-first; skipped internally after a
  // manual override).
  if (
    !Object.prototype.hasOwnProperty.call(changed, "gender") &&
    ("first_name" in changed ||
      "display_name" in changed ||
      "preferred_language" in changed ||
      "phone" in changed)
  ) {
    queueGenderInference(id);
  }
  if (Object.prototype.hasOwnProperty.call(changed, "phone") && changed.phone) {
    void syncContactToRespondIo(id).catch((err: unknown) => {
      logger.warn({ err, contactId: id }, "respondio: dashboard contact sync failed");
    });
  }
  res.json({ success: true });
});

/**
 * GET /api/contacts/:id/orders — paginated orders linked to a contact through
 * order_contacts (both as customer and as recipient), with the contact's
 * role(s) per order.
 */
router.get("/contacts/:id/orders", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "25", 10)));
  const offset = (page - 1) * limit;
  // Optional role filter: "placed" → customer-role orders, "received" →
  // recipient-role orders. Anything else returns all linked orders.
  const type = ((req.query.type as string) || "").trim().toLowerCase();
  const roleFilter = type === "placed" ? "customer" : type === "received" ? "recipient" : null;

  const ok = await db.query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (ok.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const roleCond = roleFilter
    ? `AND EXISTS (SELECT 1 FROM order_contacts ocf
                    WHERE ocf.order_id = o.id AND ocf.contact_id = $2 AND ocf.role = $5)`
    : "";
  const roleCondCount = roleFilter
    ? `AND EXISTS (SELECT 1 FROM order_contacts ocf
                    WHERE ocf.order_id = o.id AND ocf.contact_id = $2 AND ocf.role = $3)`
    : "";

  const [rowsRes, countRes] = await Promise.all([
    db.query<{
      id: string;
      display_order_number: string | null;
      status: string;
      source: string;
      ordered_at: string | null;
      created_at: string;
      totals: unknown;
      roles: string[];
    }>(
      `SELECT o.id, o.display_order_number, o.status, o.source, o.ordered_at, o.created_at,
              o.totals,
              array_agg(DISTINCT oc.role ORDER BY oc.role) AS roles
         FROM orders o
         JOIN order_contacts oc ON oc.order_id = o.id
        WHERE o.workspace_owner_id = $1 AND oc.contact_id = $2
        ${roleCond}
        GROUP BY o.id
        ORDER BY o.ordered_at DESC NULLS LAST, o.created_at DESC
        LIMIT $3 OFFSET $4`,
      roleFilter
        ? [wreq.workspaceOwnerId, id, limit, offset, roleFilter]
        : [wreq.workspaceOwnerId, id, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(DISTINCT o.id)::text AS total
         FROM orders o
         JOIN order_contacts oc ON oc.order_id = o.id
        WHERE o.workspace_owner_id = $1 AND oc.contact_id = $2
        ${roleCondCount}`,
      roleFilter ? [wreq.workspaceOwnerId, id, roleFilter] : [wreq.workspaceOwnerId, id],
    ),
  ]);

  res.json({
    orders: rowsRes.rows,
    total: parseInt(countRes.rows[0]?.total ?? "0", 10),
    page,
    limit,
  });
});

/**
 * POST /api/contacts/:id/tags — add a manual tag to a contact.
 * Reserved role words (customer / recipient) are rejected.
 */
router.post("/contacts/:id/tags", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) {
    res.status(400).json({ error: "tag is required" });
    return;
  }
  if (isReservedTag(tag)) {
    res.status(400).json({ error: `"${tag}" is a reserved role tag and cannot be added manually` });
    return;
  }

  // A manual add also clears the tag from auto_tags_applied: the tag becomes
  // manual-owned, so the auto-tag engine will neither re-add nor remove it
  // (e.g. the one-time→regular swap skips a manually re-added "one-time").
  const r = await db.query<{ tags: string[]; was_present: boolean }>(
    `UPDATE contacts c
        SET tags = CASE WHEN $3 = ANY(c.tags) THEN c.tags ELSE array_append(c.tags, $3) END,
            auto_tags_applied = array_remove(c.auto_tags_applied, lower($3)),
            updated_at = now()
       FROM (SELECT id, ($3 = ANY(tags)) AS was_present FROM contacts
              WHERE id = $1 AND workspace_owner_id = $2) prev
      WHERE c.id = prev.id
      RETURNING c.tags, prev.was_present`,
    [id, wreq.workspaceOwnerId, tag],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  if (!r.rows[0].was_present) {
    await logContactActivity(wreq, id, "tag_added", { tag });
  }
  res.json({ success: true, tags: manualTags(r.rows[0].tags) });
});

/**
 * DELETE /api/contacts/:id/tags/:tag — remove a manual tag from a contact.
 */
router.delete("/contacts/:id/tags/:tag", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  const tag = String(req.params.tag || "").trim();
  if (!id || !tag) {
    res.status(400).json({ error: "Invalid contact id or tag" });
    return;
  }

  const r = await db.query<{ tags: string[]; was_present: boolean }>(
    `UPDATE contacts c
        SET tags = array_remove(c.tags, $3),
            updated_at = now()
       FROM (SELECT id, ($3 = ANY(tags)) AS was_present FROM contacts
              WHERE id = $1 AND workspace_owner_id = $2) prev
      WHERE c.id = prev.id
      RETURNING c.tags, prev.was_present`,
    [id, wreq.workspaceOwnerId, tag],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  if (r.rows[0].was_present && UUID_RE.test(id)) {
    await logContactActivity(wreq, id, "tag_removed", { tag });
  }
  res.json({ success: true, tags: manualTags(r.rows[0].tags) });
});

/**
 * PATCH /api/contacts/:id/consent — update explicit consent/suppression.
 * Reachability for Audiences derives from these flags plus channel presence —
 * never from mere possession of an email/phone.
 * Body: { email_consent?, whatsapp_consent?, unsubscribed? } (all booleans).
 */
router.patch("/contacts/:id/consent", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!id || !UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [id, wreq.workspaceOwnerId];
  let idx = 3;
  const changes: Record<string, boolean> = {};
  for (const key of ["email_consent", "whatsapp_consent"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean` });
        return;
      }
      sets.push(`${key} = $${idx++}`);
      params.push(body[key]);
      changes[key] = body[key] as boolean;
    }
  }
  if (body.unsubscribed !== undefined) {
    if (typeof body.unsubscribed !== "boolean") {
      res.status(400).json({ error: "unsubscribed must be a boolean" });
      return;
    }
    sets.push(body.unsubscribed ? `unsubscribed_at = COALESCE(unsubscribed_at, now())` : `unsubscribed_at = NULL`);
    changes.unsubscribed = body.unsubscribed;
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "no consent fields to update" });
    return;
  }
  sets.push(`consent_updated_at = now()`, `updated_at = now()`);
  const r = await db.query<{
    email_consent: boolean;
    whatsapp_consent: boolean;
    unsubscribed_at: string | null;
    consent_updated_at: string | null;
  }>(
    `UPDATE contacts SET ${sets.join(", ")}
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING email_consent, whatsapp_consent, unsubscribed_at, consent_updated_at`,
    params,
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  await logContactActivity(wreq, id, "consent_updated", changes);
  res.json({ success: true, consent: r.rows[0] });
});

/**
 * POST /api/contacts/:id/archive — owner-only soft archive. Archived contacts
 * disappear from the Customers list and summary KPIs but remain viewable at
 * their profile URL (with an Archived badge) and can be unarchived.
 */
router.post("/contacts/:id/archive", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners may archive contacts" });
    return;
  }
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const r = await db.query<{ id: string }>(
    `UPDATE contacts SET archived_at = COALESCE(archived_at, now()), updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  await logContactActivity(wreq, id, "contact_archived", null);
  res.json({ success: true });
});

/**
 * POST /api/contacts/:id/unarchive — owner-only restore of an archived contact.
 */
router.post("/contacts/:id/unarchive", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners may unarchive contacts" });
    return;
  }
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const r = await db.query<{ id: string }>(
    `UPDATE contacts SET archived_at = NULL, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  await logContactActivity(wreq, id, "contact_unarchived", null);
  res.json({ success: true });
});

/**
 * GET /api/contacts/:id/notes — list manual notes (newest first).
 */
router.get("/contacts/:id/notes", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const r = await db.query<{
    id: number;
    author_user_id: string | null;
    author_name: string | null;
    body: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, author_user_id, author_name, body, created_at, updated_at
       FROM contact_notes
      WHERE contact_id = $1 AND workspace_owner_id = $2
      ORDER BY created_at DESC, id DESC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ notes: r.rows });
});

/**
 * POST /api/contacts/:id/notes — add a manual note.
 */
router.post("/contacts/:id/notes", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  if (text.length > 5000) {
    res.status(400).json({ error: "Note is too long (max 5000 characters)" });
    return;
  }
  const ok = await db.query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (ok.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const r = await db.query<{
    id: number;
    author_user_id: string | null;
    author_name: string | null;
    body: string;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO contact_notes (workspace_owner_id, contact_id, author_user_id, author_name, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, author_user_id, author_name, body, created_at, updated_at`,
    [wreq.workspaceOwnerId, id, wreq.userId ?? null, wreq.userEmail ?? null, text],
  );
  res.status(201).json({ note: r.rows[0] });
});

/**
 * PATCH /api/contacts/:id/notes/:noteId — edit a note (author or owner only).
 */
router.patch("/contacts/:id/notes/:noteId", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  const noteId = parseInt(req.params.noteId, 10);
  if (!UUID_RE.test(id) || isNaN(noteId)) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const existing = await db.query<{ author_user_id: string | null }>(
    `SELECT author_user_id FROM contact_notes
      WHERE id = $1 AND contact_id = $2 AND workspace_owner_id = $3`,
    [noteId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  if (wreq.workspaceRole !== "owner" && existing.rows[0].author_user_id !== wreq.userId) {
    res.status(403).json({ error: "Only the note author or the workspace owner may edit this note" });
    return;
  }
  const r = await db.query<{
    id: number;
    author_user_id: string | null;
    author_name: string | null;
    body: string;
    created_at: string;
    updated_at: string;
  }>(
    `UPDATE contact_notes SET body = $1, updated_at = now()
      WHERE id = $2 AND contact_id = $3 AND workspace_owner_id = $4
      RETURNING id, author_user_id, author_name, body, created_at, updated_at`,
    [text, noteId, id, wreq.workspaceOwnerId],
  );
  res.json({ note: r.rows[0] });
});

/**
 * DELETE /api/contacts/:id/notes/:noteId — delete a note (author or owner only).
 */
router.delete("/contacts/:id/notes/:noteId", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  const noteId = parseInt(req.params.noteId, 10);
  if (!UUID_RE.test(id) || isNaN(noteId)) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  const existing = await db.query<{ author_user_id: string | null }>(
    `SELECT author_user_id FROM contact_notes
      WHERE id = $1 AND contact_id = $2 AND workspace_owner_id = $3`,
    [noteId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  if (wreq.workspaceRole !== "owner" && existing.rows[0].author_user_id !== wreq.userId) {
    res.status(403).json({ error: "Only the note author or the workspace owner may delete this note" });
    return;
  }
  await db.query(
    `DELETE FROM contact_notes WHERE id = $1 AND contact_id = $2 AND workspace_owner_id = $3`,
    [noteId, id, wreq.workspaceOwnerId],
  );
  res.json({ success: true });
});

/**
 * GET /api/contacts/:id/activity — combined timeline: manual notes, system
 * activity rows, the contact-created event, and order placed/received events.
 * Paginated, newest first.
 */
router.get("/contacts/:id/activity", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));
  const offset = (page - 1) * limit;

  const ok = await db.query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (ok.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const unionSql = `
    SELECT 'note'::text AS type, n.id::text AS ref_id, n.body AS body,
           n.author_user_id AS actor_user_id, n.author_name AS actor_name,
           NULL::jsonb AS data, n.created_at, n.updated_at
      FROM contact_notes n
     WHERE n.contact_id = $1 AND n.workspace_owner_id = $2
    UNION ALL
    SELECT a.type, a.id::text, NULL, a.actor_user_id, a.actor_name, a.data,
           a.created_at, a.created_at
      FROM contact_activity a
     WHERE a.contact_id = $1 AND a.workspace_owner_id = $2
    UNION ALL
    SELECT 'contact_created', c.id::text, NULL, NULL, NULL, NULL,
           c.created_at, c.created_at
      FROM contacts c
     WHERE c.id = $1 AND c.workspace_owner_id = $2
    UNION ALL
    SELECT CASE WHEN oc.role = 'customer' THEN 'order_placed' ELSE 'gift_received' END,
           o.id::text, NULL, NULL, NULL,
           jsonb_build_object(
             'order_id', o.id,
             'display_order_number', o.display_order_number,
             'status', o.status,
             'totals', o.totals),
           COALESCE(o.ordered_at, o.created_at), COALESCE(o.ordered_at, o.created_at)
      FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
     WHERE oc.contact_id = $1 AND o.workspace_owner_id = $2`;

  const [rowsRes, countRes] = await Promise.all([
    db.query<{
      type: string;
      ref_id: string;
      body: string | null;
      actor_user_id: string | null;
      actor_name: string | null;
      data: unknown;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM (${unionSql}) t
        ORDER BY created_at DESC, ref_id DESC
        LIMIT $3 OFFSET $4`,
      [id, wreq.workspaceOwnerId, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM (${unionSql}) t`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);

  res.json({
    items: rowsRes.rows,
    total: parseInt(countRes.rows[0]?.total ?? "0", 10),
    page,
    limit,
  });
});

/**
 * GET /api/contacts/:id/duplicates — potential duplicate contacts in the same
 * workspace (digit-normalized phone or case-normalized email match).
 */
router.get("/contacts/:id/duplicates", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const base = await db.query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (base.rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const r = await db.query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    email: string | null;
    phone: string | null;
    tags: string[];
    created_at: string;
    is_customer: boolean;
    is_recipient: boolean;
    orders_placed: number;
    gifts_received: number;
    matched_on: string;
  }>(
    `SELECT c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
            c.tags, c.created_at,
            ${CUSTOMER_EXISTS} AS is_customer,
            ${RECIPIENT_EXISTS} AS is_recipient,
            (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
              WHERE oc.contact_id = c.id AND oc.role = 'customer'
                AND o.workspace_owner_id = c.workspace_owner_id)::int AS orders_placed,
            (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
              WHERE oc.contact_id = c.id AND oc.role = 'recipient'
                AND o.workspace_owner_id = c.workspace_owner_id)::int AS gifts_received,
            CASE
              WHEN (b.phone IS NOT NULL AND c.phone IS NOT NULL
                    AND regexp_replace(b.phone, '[^0-9]', '', 'g') <> ''
                    AND regexp_replace(c.phone, '[^0-9]', '', 'g') = regexp_replace(b.phone, '[^0-9]', '', 'g'))
                   AND (b.email IS NOT NULL AND c.email IS NOT NULL AND lower(c.email) = lower(b.email))
                THEN 'both'
              WHEN (b.phone IS NOT NULL AND c.phone IS NOT NULL
                    AND regexp_replace(b.phone, '[^0-9]', '', 'g') <> ''
                    AND regexp_replace(c.phone, '[^0-9]', '', 'g') = regexp_replace(b.phone, '[^0-9]', '', 'g'))
                THEN 'phone'
              ELSE 'email'
            END AS matched_on
       FROM contacts c
       JOIN contacts b ON b.id = $1 AND b.workspace_owner_id = $2
      WHERE c.workspace_owner_id = b.workspace_owner_id
        AND c.id <> b.id
        AND (
          (b.phone IS NOT NULL AND c.phone IS NOT NULL
            AND regexp_replace(b.phone, '[^0-9]', '', 'g') <> ''
            AND regexp_replace(c.phone, '[^0-9]', '', 'g') = regexp_replace(b.phone, '[^0-9]', '', 'g'))
          OR (b.email IS NOT NULL AND c.email IS NOT NULL
            AND lower(c.email) = lower(b.email))
        )
      ORDER BY c.created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({
    duplicates: r.rows.map((d) => ({
      ...d,
      tags: manualTags(d.tags),
    })),
  });
});

/**
 * POST /api/contacts/:id/merge — merge the contact at :id (the "loser") into
 * `targetId` (the "survivor"). Owner only. Transactional:
 *   - Reassigns order_contacts rows (deduping against the survivor's existing
 *     (order_id, role) links so the unique constraint can't fire).
 *   - Moves notes and activity rows to the survivor.
 *   - Unions manual tags; fills missing survivor fields from the loser.
 *   - Deletes the loser BEFORE writing the loser's email/phone onto the
 *     survivor (the per-workspace unique indexes on email AND phone would
 *     otherwise reject the update while both rows exist).
 */
router.post("/contacts/:id/merge", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners may merge contacts" });
    return;
  }
  const loserId = String(req.params.id || "").trim();
  const body = req.body as Record<string, unknown>;
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  if (!UUID_RE.test(loserId) || !UUID_RE.test(targetId)) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }
  if (loserId === targetId) {
    res.status(400).json({ error: "Cannot merge a contact into itself" });
    return;
  }

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const both = await client.query<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        display_name: string | null;
        email: string | null;
        phone: string | null;
        tags: string[];
        addresses: unknown;
        metadata: Record<string, unknown> | null;
        source: string | null;
        account_id: string | null;
        external_contact_id: string | null;
      }>(
        `SELECT id, first_name, last_name, display_name, email, phone, tags,
                addresses, metadata, source, account_id, external_contact_id
           FROM contacts
          WHERE id = ANY($1::uuid[]) AND workspace_owner_id = $2
          FOR UPDATE`,
        [[loserId, targetId], wreq.workspaceOwnerId],
      );
      if (both.rowCount !== 2) {
        const err = new Error("CONTACT_NOT_FOUND") as Error & { httpStatus?: number };
        err.httpStatus = 404;
        throw err;
      }
      const survivor = both.rows.find((r) => r.id === targetId)!;
      const loser = both.rows.find((r) => r.id === loserId)!;

      // Reassign order links, deduping rows that would collide with the
      // survivor's existing (order_id, contact_id, role) unique constraint.
      await client.query(
        `DELETE FROM order_contacts oc
          WHERE oc.contact_id = $1
            AND EXISTS (SELECT 1 FROM order_contacts x
                         WHERE x.order_id = oc.order_id
                           AND x.contact_id = $2
                           AND x.role = oc.role)`,
        [loserId, targetId],
      );
      await client.query(
        `UPDATE order_contacts SET contact_id = $2 WHERE contact_id = $1`,
        [loserId, targetId],
      );

      // Move notes + activity history to the survivor.
      await client.query(
        `UPDATE contact_notes SET contact_id = $2
          WHERE contact_id = $1 AND workspace_owner_id = $3`,
        [loserId, targetId, wreq.workspaceOwnerId],
      );
      await client.query(
        `UPDATE contact_activity SET contact_id = $2
          WHERE contact_id = $1 AND workspace_owner_id = $3`,
        [loserId, targetId, wreq.workspaceOwnerId],
      );

      const pick = (s: string | null, l: string | null): string | null => s ?? l;
      const mergedTags = Array.from(
        new Set([...(survivor.tags ?? []), ...(loser.tags ?? [])].filter((t) => !isReservedTag(t))),
      );
      const mergedMetadata: Record<string, unknown> = {
        ...(loser.metadata && typeof loser.metadata === "object" ? loser.metadata : {}),
        ...(survivor.metadata && typeof survivor.metadata === "object" ? survivor.metadata : {}),
      };
      const survivorAddresses = Array.isArray(survivor.addresses) ? survivor.addresses : [];
      const loserAddresses = Array.isArray(loser.addresses) ? loser.addresses : [];
      const mergedAddresses = [...survivorAddresses, ...loserAddresses];

      // Delete the loser FIRST so the unique email/phone indexes cannot
      // reject copying the loser's identifiers onto the survivor.
      await client.query(`DELETE FROM contacts WHERE id = $1 AND workspace_owner_id = $2`, [
        loserId,
        wreq.workspaceOwnerId,
      ]);

      await client.query(
        `UPDATE contacts
            SET first_name = $2,
                last_name = $3,
                display_name = $4,
                email = $5,
                phone = $6,
                source = COALESCE(source, $7),
                account_id = COALESCE(account_id, $8),
                tags = $9,
                addresses = $10,
                metadata = $11,
                updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $12`,
        [
          targetId,
          pick(survivor.first_name, loser.first_name),
          pick(survivor.last_name, loser.last_name),
          pick(survivor.display_name, loser.display_name),
          pick(survivor.email, loser.email),
          pick(survivor.phone, loser.phone),
          loser.source,
          loser.account_id,
          mergedTags,
          JSON.stringify(mergedAddresses),
          JSON.stringify(mergedMetadata),
          wreq.workspaceOwnerId,
        ],
      );

      await logContactActivity(
        wreq,
        targetId,
        "contact_merged",
        {
          merged_contact_id: loserId,
          merged_name:
            (loser.display_name ?? "").trim() ||
            `${loser.first_name ?? ""} ${loser.last_name ?? ""}`.trim() ||
            null,
          merged_email: loser.email,
          merged_phone: loser.phone,
        },
        client,
      );
    });
    res.json({ success: true, survivorId: targetId });
  } catch (err: unknown) {
    const httpStatus =
      err && typeof err === "object" && "httpStatus" in err
        ? (err as { httpStatus?: number }).httpStatus
        : undefined;
    if (httpStatus === 404) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    logger.error({ err, loserId, targetId }, "contact merge failed");
    res.status(500).json({ error: "Failed to merge contacts" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/contacts/:id/respondio-sync
 * Manually link/create the contact on respond.io and persist the contact ID.
 * Returns 409 if already synced, 422 if no phone, 503 if respond.io unreachable.
 */
router.post("/contacts/:id/respondio-sync", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const contact = await db.query<{
    id: string;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    respondio_contact_id: string | null;
  }>(
    `SELECT id, phone, first_name, last_name, respondio_contact_id
       FROM contacts WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );

  const c = contact.rows[0];
  if (!c) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  if (c.respondio_contact_id) {
    res.status(409).json({
      error: "already_synced",
      contactId: c.respondio_contact_id,
      url: getRespondIoContactUrl(c.respondio_contact_id),
    });
    return;
  }

  if (!c.phone) {
    res.status(422).json({ error: "phone_required" });
    return;
  }

  const syncResult = await syncContactToRespondIo(id);
  if (syncResult.status === "synced") {
    res.json({
      contactId: syncResult.contactId,
      url: getRespondIoContactUrl(syncResult.contactId),
    });
    return;
  }
  if (syncResult.status === "already_synced") {
    res.status(409).json({
      error: "already_synced",
      contactId: syncResult.contactId,
      url: getRespondIoContactUrl(syncResult.contactId),
    });
    return;
  }
  if (syncResult.status === "disabled") {
    res.status(503).json({ error: "respond.io is not configured" });
    return;
  }
  if (syncResult.status === "contact_not_found") {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  if (syncResult.status === "phone_required") {
    res.status(422).json({ error: "phone_required" });
    return;
  }
  if (syncResult.status === "phone_format_invalid") {
    res.status(422).json({ error: "phone_format_invalid" });
    return;
  }
  res.status(503).json({ error: "respondio_unreachable" });
});

/**
 * DELETE /api/contacts/:id/respondio-sync
 * Clear the stored respond.io contact ID so the contact can be re-synced from scratch.
 * Returns 204 on success.
 */
router.delete("/contacts/:id/respondio-sync", async (req, res) => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const result = await db.query(
    `UPDATE contacts SET respondio_contact_id = NULL
     WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if ((result as { rowCount?: number }).rowCount === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  res.status(204).end();
});

export default router;
