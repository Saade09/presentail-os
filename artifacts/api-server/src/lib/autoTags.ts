import { db } from "./db";
import { logger } from "./logger";

/**
 * Automatic contact tagging engine.
 *
 * Computes system-generated tags for a contact from its confirmed order
 * activity and identity signals, then applies them to `contacts.tags` in an
 * idempotent, user-respecting way:
 *
 *  - `vip`       — total confirmed spend (USD) over $1,000 (customer role only)
 *  - `corporate` — company-style email domain OR corporate keywords in the
 *                  contact's name/address fields (customer role only)
 *  - `one-time`  — exactly 1 customer order
 *  - `regular`   — 2+ customer orders
 *
 * The `contacts.auto_tags_applied` column records every tag the engine has
 * ever applied. A tag in that set is never added again — so a user removal
 * sticks permanently. The only removal the engine performs is the
 * `one-time` → `regular` upgrade, and only while `one-time` is still
 * auto-owned (present in tags AND in the applied set). When a user manually
 * adds a tag that carries an auto-tag name, it is dropped from the applied
 * set (see the tags route), making it manual-owned: the engine will neither
 * re-add nor remove it afterwards.
 */

export const VIP_SPEND_THRESHOLD_USD = 1000;

export const AUTO_TAG_NAMES = ["vip", "corporate", "one-time", "regular"] as const;
export type AutoTagName = (typeof AUTO_TAG_NAMES)[number];

/** Free/personal email providers that never count as a corporate signal. */
export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "outlook.com",
  "outlook.fr",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "mail.ru",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
]);

/**
 * Corporate keywords matched (case-insensitive, word-boundary) against the
 * contact's name/display/address text. Covers common legal suffixes plus the
 * Lebanese/regional SAL / SARL forms called out in the product spec.
 */
const CORPORATE_KEYWORD_RE =
  /(^|[^a-z0-9])(llc|l\.l\.c|inc|ltd|limited|corp|corporation|company|co\.|office|offices|group|holding|holdings|enterprise|enterprises|trading|sal|s\.a\.l|sarl|s\.a\.r\.l|fzco|fze|fzc|dmcc|plc|gmbh)($|[^a-z0-9])/i;

/**
 * The same corporate-keyword pattern as a POSIX regex string for use in
 * Postgres (`~*` case-insensitive match) — used by the initDb backfill so the
 * SQL and JS rules stay in sync.
 */
export const CORPORATE_KEYWORD_POSIX_RE =
  "(^|[^a-z0-9])(llc|l\\.l\\.c|inc|ltd|limited|corp|corporation|company|co\\.|office|offices|group|holding|holdings|enterprise|enterprises|trading|sal|s\\.a\\.l|sarl|s\\.a\\.r\\.l|fzco|fze|fzc|dmcc|plc|gmbh)($|[^a-z0-9])";

/** True when the email's domain looks like a company domain (not a free provider). */
export function isCorporateEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return false;
  return !FREE_EMAIL_DOMAINS.has(domain);
}

/** True when any of the given text fields carries a corporate keyword. */
export function hasCorporateKeyword(texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => typeof t === "string" && t.trim() !== "" && CORPORATE_KEYWORD_RE.test(t));
}

export type AutoTagStats = {
  /** Number of orders where this contact holds the `customer` role. */
  customerOrders: number;
  /** Confirmed (paid/recorded) USD spend across those orders. */
  totalSpentUsd: number;
  email: string | null;
  /** Free-text fields scanned for corporate keywords (names, addresses…). */
  corporateTexts: Array<string | null | undefined>;
};

/** Pure rule evaluation: which auto tags does this contact deserve right now? */
export function computeAutoTags(stats: AutoTagStats): AutoTagName[] {
  const out: AutoTagName[] = [];
  const isCustomer = stats.customerOrders > 0;
  if (!isCustomer) return out;
  if (stats.totalSpentUsd > VIP_SPEND_THRESHOLD_USD) out.push("vip");
  if (isCorporateEmail(stats.email) || hasCorporateKeyword(stats.corporateTexts)) {
    out.push("corporate");
  }
  if (stats.customerOrders === 1) out.push("one-time");
  else if (stats.customerOrders >= 2) out.push("regular");
  return out;
}

export type AutoTagPlan = {
  /** Tags to append to contacts.tags. */
  toAdd: string[];
  /** Tags to remove from contacts.tags (only the one-time→regular swap). */
  toRemove: string[];
  /** New value for auto_tags_applied (monotonic union). */
  newApplied: string[];
};

/**
 * Decide the tag changes for a contact given its current state and the
 * desired auto tags. Case-insensitive on tag names. Never re-adds a tag that
 * is already in the applied set (user removals stick); the only removal is
 * the one-time→regular upgrade while `one-time` is still auto-owned.
 */
export function planAutoTagChanges(opts: {
  currentTags: string[];
  autoApplied: string[];
  desired: AutoTagName[];
}): AutoTagPlan {
  const lowerTags = new Set(opts.currentTags.map((t) => t.trim().toLowerCase()));
  const applied = new Set(opts.autoApplied.map((t) => t.trim().toLowerCase()));
  const desired = new Set<string>(opts.desired);

  const toAdd = [...desired].filter((t) => !lowerTags.has(t) && !applied.has(t));

  const toRemove: string[] = [];
  // one-time → regular upgrade: drop the stale one-time tag only while it is
  // still auto-owned (in tags AND in the applied set — a manual re-add clears
  // it from the applied set, making it untouchable).
  if (desired.has("regular") && lowerTags.has("one-time") && applied.has("one-time")) {
    toRemove.push("one-time");
  }

  const newApplied = [...new Set([...applied, ...toAdd])];
  return { toAdd, toRemove, newApplied };
}

type ContactAutoTagRow = {
  id: string;
  tags: string[];
  auto_tags_applied: string[];
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  addresses_text: string | null;
  customer_orders: number;
  total_spent_usd: string | null;
};

const STATS_SELECT = `
  SELECT c.id, c.tags, c.auto_tags_applied, c.email,
         c.first_name, c.last_name, c.display_name,
         c.addresses::text AS addresses_text,
         (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
           WHERE oc.contact_id = c.id AND oc.role = 'customer'
             AND o.workspace_owner_id = c.workspace_owner_id)::int AS customer_orders,
         (SELECT COALESCE(SUM(op.amount_usd), 0)
            FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
            JOIN order_payment op ON op.order_id = o.id
           WHERE oc.contact_id = c.id AND oc.role = 'customer'
             AND o.workspace_owner_id = c.workspace_owner_id
             AND lower(COALESCE(op.status, '')) IN ('paid', 'recorded')
             AND op.amount_usd IS NOT NULL) AS total_spent_usd
    FROM contacts c
   WHERE c.id = $1 AND c.workspace_owner_id = $2`;

/**
 * Recompute and apply auto tags for one contact. Best-effort: DB errors are
 * logged and swallowed (callers fire-and-forget this after order commits).
 */
export async function applyAutoTagsForContact(
  workspaceOwnerId: string,
  contactId: string | null | undefined,
): Promise<void> {
  if (!contactId) return;
  try {
    const r = await db.query<ContactAutoTagRow>(STATS_SELECT, [contactId, workspaceOwnerId]);
    const row = r.rows[0];
    if (!row) return;

    const desired = computeAutoTags({
      customerOrders: row.customer_orders,
      totalSpentUsd: row.total_spent_usd != null ? parseFloat(String(row.total_spent_usd)) : 0,
      email: row.email,
      corporateTexts: [row.first_name, row.last_name, row.display_name, row.addresses_text],
    });

    const plan = planAutoTagChanges({
      currentTags: row.tags ?? [],
      autoApplied: row.auto_tags_applied ?? [],
      desired,
    });
    if (plan.toAdd.length === 0 && plan.toRemove.length === 0) return;

    // Rebuild tags: keep everything except removed tags (case-insensitive),
    // then append the new ones.
    await db.query(
      `UPDATE contacts
          SET tags = (
                SELECT COALESCE(array_agg(t), '{}'::text[]) FROM (
                  SELECT t FROM unnest(tags) WITH ORDINALITY AS u(t, ord)
                   WHERE NOT (lower(t) = ANY($3::text[]))
                   ORDER BY ord
                ) kept
              ) || $2::text[],
              auto_tags_applied = $4::text[],
              updated_at = now()
        WHERE id = $1`,
      [contactId, plan.toAdd, plan.toRemove, plan.newApplied],
    );
  } catch (err) {
    logger.warn({ err, contactId, workspaceOwnerId }, "autoTags: failed to apply auto tags");
  }
}

/**
 * Apply auto tags to every customer-role contact linked to an order.
 * Fire-and-forget helper for the order-creation / payment paths.
 */
export async function applyAutoTagsForOrder(
  workspaceOwnerId: string,
  orderId: string,
): Promise<void> {
  try {
    const r = await db.query<{ contact_id: string }>(
      `SELECT DISTINCT oc.contact_id
         FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
        WHERE oc.order_id = $1 AND oc.role = 'customer'
          AND o.workspace_owner_id = $2`,
      [orderId, workspaceOwnerId],
    );
    for (const row of r.rows) {
      await applyAutoTagsForContact(workspaceOwnerId, row.contact_id);
    }
  } catch (err) {
    logger.warn({ err, orderId, workspaceOwnerId }, "autoTags: failed to apply auto tags for order");
  }
}
