import { Router } from "express";
import { z } from "zod/v4";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  createOrResolveContact,
  normalizeEmail,
  normalizePhone,
} from "../lib/contactUpsert";
import { logger } from "../lib/logger";
import {
  buildSearchTerms,
  buildPhoneSearchTokens,
  escapeLike,
  normalizePhoneDigits,
  normalizeQueryDigits,
} from "../lib/contactSearchNormalize";

/**
 * Contact search / duplicate-check / create endpoints backing the search-first
 * Customer & Recipient steps of the dashboard Create Order wizard.
 *
 * Mounted BEFORE `contactsDashboard` so `/contacts/wizard-*` is matched before
 * the dashboard's `GET /contacts/:id` catch-all.
 */

const router = Router();

router.use("/contacts", requireAuth, resolveWorkspace);

type WizardContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  orders_placed: number;
  last_order_at: string | null;
  is_saved_recipient?: boolean;
  deliveries_count?: number;
  last_delivery_city?: string | null;
  last_delivery_address?: string | null;
};

/** Customer-role order count for a contact (same shape the dashboard uses). */
const ORDERS_PLACED = `(SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
   WHERE oc.contact_id = c.id AND oc.role = 'customer'
     AND o.workspace_owner_id = c.workspace_owner_id)::int`;
const LAST_ORDER_AT = `(SELECT MAX(o.ordered_at) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
   WHERE oc.contact_id = c.id AND oc.role = 'customer'
     AND o.workspace_owner_id = c.workspace_owner_id)`;
const DELIVERIES_COUNT = `(SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
   WHERE oc.contact_id = c.id AND oc.role = 'recipient'
     AND o.workspace_owner_id = c.workspace_owner_id)::int`;
/** Most recent delivery city for a recipient-role contact. */
const LAST_DELIVERY_CITY = `(SELECT NULLIF(TRIM(COALESCE(o.delivery_address->>'city',
                                                          o.delivery_address->>'cityName',
                                                          o.delivery_address->>'cityId')), '')
   FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
  WHERE oc.contact_id = c.id AND oc.role = 'recipient'
    AND o.workspace_owner_id = c.workspace_owner_id
    AND NULLIF(TRIM(COALESCE(o.delivery_address->>'city',
                             o.delivery_address->>'cityName',
                             o.delivery_address->>'cityId')), '') IS NOT NULL
  ORDER BY o.ordered_at DESC NULLS LAST, o.created_at DESC
  LIMIT 1)`;

/** Most recent delivery address (formatted single line) for a recipient-role contact. */
const LAST_DELIVERY_ADDRESS = `(SELECT NULLIF(TRIM(
     CONCAT_WS(', ',
       NULLIF(TRIM(COALESCE(NULLIF(o.delivery_address->>'address', ''),
                            o.delivery_address->>'address_1', '')), ''),
       NULLIF(TRIM(COALESCE(o.delivery_address->>'address_2', '')), ''),
       NULLIF(TRIM(COALESCE(o.delivery_address->>'city',
                            o.delivery_address->>'cityName', '')), ''),
       NULLIF(TRIM(COALESCE(o.delivery_address->>'state', '')), ''),
       NULLIF(TRIM(COALESCE(o.delivery_address->>'postcode', '')), ''),
       NULLIF(TRIM(COALESCE(o.delivery_address->>'country', '')), '')
     )), '')
   FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
  WHERE oc.contact_id = c.id AND oc.role = 'recipient'
    AND o.workspace_owner_id = c.workspace_owner_id
    AND o.delivery_address IS NOT NULL
  ORDER BY o.ordered_at DESC NULLS LAST, o.created_at DESC
  LIMIT 1)`;

function serializeContact(r: WizardContactRow, recipientMode: boolean) {
  return {
    id: r.id,
    first_name: r.first_name,
    last_name: r.last_name,
    display_name: r.display_name,
    email: r.email,
    phone: r.phone,
    orders_placed: r.orders_placed,
    last_order_at: r.last_order_at,
    ...(recipientMode
      ? {
          is_saved_recipient: r.is_saved_recipient ?? false,
          deliveries_count: r.deliveries_count ?? 0,
          last_delivery_city: r.last_delivery_city ?? null,
          last_delivery_address: r.last_delivery_address ?? null,
        }
      : {}),
  };
}

/**
 * GET /api/contacts/wizard-search?q=&customer_contact_id=&limit=
 *
 * Searches the workspace contact pool by normalized phone, email, or partial
 * name. When `customer_contact_id` is supplied (recipient step), each result
 * additionally carries the saved-relationship flag, delivery count, and the
 * most recent delivery city, and saved recipients of that customer sort first.
 *
 * Phone matching uses token-based multi-form matching so that a local-format
 * query (e.g. "03257") matches a contact stored as "+9613257533".
 */
router.get("/contacts/wizard-search", async (req, res) => {
  const wreq = workspace(req);
  const rawQ = typeof req.query.q === "string" ? req.query.q : "";
  const customerContactId =
    typeof req.query.customer_contact_id === "string" && req.query.customer_contact_id.trim()
      ? req.query.customer_contact_id.trim()
      : null;
  const limit = Math.min(20, Math.max(1, parseInt((req.query.limit as string) || "8", 10) || 8));

  const terms = buildSearchTerms(rawQ);
  if (!terms.phoneDigits && !terms.emailQuery && !terms.nameQuery) {
    res.json({ results: [] });
    return;
  }

  const params: unknown[] = [wreq.workspaceOwnerId];
  let idx = 2;
  const matches: string[] = [];

  if (terms.phoneDigits) {
    const queryDigits = normalizeQueryDigits(terms.phoneDigits);
    const likePattern = `${escapeLike(queryDigits)}%`;
    // Token-based matching: check if any token in phone_search_tokens starts
    // with the query digits. Falls back to the legacy regex clause (OR branch)
    // for contacts that haven't been backfilled yet (phone_search_tokens IS NULL).
    matches.push(
      `(EXISTS (SELECT 1 FROM unnest(c.phone_search_tokens) AS _t WHERE _t LIKE $${idx} ESCAPE '\\')
        OR (c.phone_search_tokens IS NULL
            AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $${idx + 1} ESCAPE '\\'))`,
    );
    params.push(likePattern);
    params.push(`%${escapeLike(queryDigits)}%`);
    idx += 2;
  }
  if (terms.emailQuery) {
    matches.push(`lower(COALESCE(c.email, '')) LIKE $${idx} ESCAPE '\\'`);
    params.push(`%${escapeLike(terms.emailQuery)}%`);
    idx++;
  }
  if (terms.nameQuery) {
    const like = `%${escapeLike(terms.nameQuery)}%`;
    matches.push(
      `(COALESCE(c.first_name,'') ILIKE $${idx} ESCAPE '\\'
        OR COALESCE(c.last_name,'') ILIKE $${idx} ESCAPE '\\'
        OR COALESCE(c.display_name,'') ILIKE $${idx} ESCAPE '\\'
        OR TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${idx} ESCAPE '\\'
        OR COALESCE(c.email,'') ILIKE $${idx} ESCAPE '\\')`,
    );
    params.push(like);
    idx++;
  }

  let savedRecipientExpr = "false";
  if (customerContactId) {
    savedRecipientExpr = `EXISTS (
      SELECT 1 FROM order_contacts ocr
        JOIN orders o2 ON o2.id = ocr.order_id
        JOIN order_contacts occ ON occ.order_id = o2.id AND occ.role = 'customer'
       WHERE ocr.contact_id = c.id AND ocr.role = 'recipient'
         AND occ.contact_id = $${idx}
         AND o2.workspace_owner_id = c.workspace_owner_id
    )`;
    params.push(customerContactId);
    idx++;
  }

  const recipientCols = customerContactId
    ? `, ${savedRecipientExpr} AS is_saved_recipient,
         ${DELIVERIES_COUNT} AS deliveries_count,
         ${LAST_DELIVERY_CITY} AS last_delivery_city,
         ${LAST_DELIVERY_ADDRESS} AS last_delivery_address`
    : "";

  const orderBy = customerContactId
    ? "is_saved_recipient DESC, deliveries_count DESC, orders_placed DESC, last_order_at DESC NULLS LAST, c.created_at DESC"
    : "orders_placed DESC, last_order_at DESC NULLS LAST, c.created_at DESC";

  params.push(limit);
  const rows = await db.query<WizardContactRow>(
    `SELECT c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
            ${ORDERS_PLACED} AS orders_placed,
            ${LAST_ORDER_AT} AS last_order_at
            ${recipientCols}
       FROM contacts c
      WHERE c.workspace_owner_id = $1
        AND c.archived_at IS NULL
        AND (${matches.join(" OR ")})
      ORDER BY ${orderBy}
      LIMIT $${idx}`,
    params,
  );

  res.json({
    results: rows.rows.map((r) => serializeContact(r, !!customerContactId)),
  });
});

/**
 * GET /api/contacts/wizard-duplicate-check?phone=&email=
 *
 * Lightweight exact-match duplicate check for the wizard's create-new forms.
 * Phone comparison checks phone_search_tokens (for format-invariant matching)
 * with a fallback to the legacy digits-only regex equality check. Email
 * comparison is trimmed + case-insensitive. Phone matches take priority.
 */
router.get("/contacts/wizard-duplicate-check", async (req, res) => {
  const wreq = workspace(req);
  const phone = normalizePhone(typeof req.query.phone === "string" ? req.query.phone : null);
  const email = normalizeEmail(typeof req.query.email === "string" ? req.query.email : null);

  if (!phone && !email) {
    res.json({ match: null, matched_field: null });
    return;
  }

  const phoneDigits = normalizePhoneDigits(phone);
  if (phoneDigits.length >= 4) {
    // Build all token forms for the query phone so we can match against stored tokens.
    const queryTokens = buildPhoneSearchTokens(phone);
    // Match if any query token equals any stored token (exact, not prefix).
    // Also keep the legacy regex fallback for un-backfilled rows.
    const r = await db.query<WizardContactRow>(
      `SELECT c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
              ${ORDERS_PLACED} AS orders_placed,
              ${LAST_ORDER_AT} AS last_order_at
         FROM contacts c
        WHERE c.workspace_owner_id = $1
          AND c.archived_at IS NULL
          AND (
            (c.phone_search_tokens IS NOT NULL
             AND c.phone_search_tokens && $2::text[])
            OR
            (c.phone_search_tokens IS NULL
             AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $3)
          )
        ORDER BY c.created_at ASC LIMIT 1`,
      [wreq.workspaceOwnerId, `{${queryTokens.map((t) => `"${t.replace(/"/g, '\\"')}"`)}}`, phoneDigits],
    );
    if (r.rows[0]) {
      res.json({ match: serializeContact(r.rows[0], false), matched_field: "phone" });
      return;
    }
  }

  if (email) {
    const r = await db.query<WizardContactRow>(
      `SELECT c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
              ${ORDERS_PLACED} AS orders_placed,
              ${LAST_ORDER_AT} AS last_order_at
         FROM contacts c
        WHERE c.workspace_owner_id = $1
          AND c.archived_at IS NULL
          AND lower(COALESCE(c.email, '')) = $2
        ORDER BY c.created_at ASC LIMIT 1`,
      [wreq.workspaceOwnerId, email],
    );
    if (r.rows[0]) {
      res.json({ match: serializeContact(r.rows[0], false), matched_field: "email" });
      return;
    }
  }

  res.json({ match: null, matched_field: null });
});

const wizardCreateSchema = z
  .object({
    first_name: z.string().trim().max(300).nullish(),
    last_name: z.string().trim().max(300).nullish(),
    display_name: z.string().trim().max(300).nullish(),
    email: z.string().trim().max(300).nullish(),
    phone: z.string().trim().max(100).nullish(),
  })
  .strict();

/**
 * POST /api/contacts/wizard-create
 *
 * Creates (or resolves) a contact for the wizard using the shared
 * `upsertContact` logic — the same normalization and duplicate handling as
 * order ingest, including the dual email/phone unique-constraint fallback. If
 * a matching contact already exists (including one created concurrently by
 * another agent mid-flow), the existing record is returned with
 * `existing: true` instead of erroring or duplicating.
 */
router.post("/contacts/wizard-create", async (req, res) => {
  const wreq = workspace(req);
  const parsed = wizardCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const hasName = !!(
    body.display_name?.trim() ||
    body.first_name?.trim() ||
    body.last_name?.trim()
  );
  const phone = normalizePhone(body.phone);
  const email = normalizeEmail(body.email);
  if (!phone && !email) {
    res.status(400).json({ error: "A phone number or email is required" });
    return;
  }
  if (!hasName && !phone) {
    res.status(400).json({ error: "A name or phone number is required" });
    return;
  }

  let stage = "create_or_resolve";
  let resolution: Awaited<ReturnType<typeof createOrResolveContact>>;
  let row: { rows: WizardContactRow[] };
  try {
    resolution = await createOrResolveContact({
      workspaceOwnerId: wreq.workspaceOwnerId,
      source: "dashboard_wizard",
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      displayName: body.display_name ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
    });
    if (!resolution) {
      res.status(400).json({
        error: "contact_identity_required",
        message: "A phone number or email is required",
      });
      return;
    }

    stage = "load_resolved_contact";
    row = await db.query<WizardContactRow>(
      `SELECT c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
              ${ORDERS_PLACED} AS orders_placed,
              ${LAST_ORDER_AT} AS last_order_at
         FROM contacts c
        WHERE c.workspace_owner_id = $1 AND c.id = $2`,
      [wreq.workspaceOwnerId, resolution.contactId],
    );
    if (!row.rows[0]) {
      throw new Error("Resolved contact was not found");
    }
  } catch (err) {
    const pgError = err && typeof err === "object"
      ? err as { code?: string; constraint?: string; column?: string; name?: string }
      : null;
    logger.error(
      {
        stage,
        workspaceOwnerId: wreq.workspaceOwnerId,
        pgCode: pgError?.code ?? null,
        constraint: pgError?.constraint ?? null,
        dbColumn: pgError?.column ?? null,
        errorName: pgError?.name ?? "Error",
      },
      "wizard contact persistence failed",
    );
    res.status(500).json({
      error: "contact_persistence_failed",
      message: "The contact could not be saved. Please retry.",
    });
    return;
  }

  res.status(resolution.existing ? 200 : 201).json({
    contact: serializeContact(row.rows[0], false),
    existing: resolution.existing,
  });
});

export default router;
