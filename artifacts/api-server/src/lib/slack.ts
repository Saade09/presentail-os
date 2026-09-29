import { WebClient } from "@slack/web-api";
import { db } from "./db";
import { logger } from "./logger";
import { findCountryByCode } from "./defaults";

/**
 * Slack new-order notifications for Presentail OS.
 *
 * When a new order is created for the UAE (country code `ae`) we post a message
 * to a Slack channel routed by the delivery city:
 *   - Abu Dhabi  -> the Abu Dhabi channel
 *   - every other UAE city (Dubai + the rest) -> the Dubai channel
 *
 * The two channels are configured via env (never hard-coded):
 *   - SLACK_ABU_DHABI_CHANNEL_ID
 *   - SLACK_DUBAI_CHANNEL_ID
 *
 * The bot token is provided by the Replit Slack connector at runtime (fetched
 * fresh on every call — never cached, tokens expire).
 *
 * Everything here is best-effort by contract: a Slack or network failure is
 * logged and swallowed, never propagated, so it can never roll back or block
 * order creation (mirrors the Tookan / email side-effect helpers).
 */

export type SlackOrderLineItem = {
  name: string;
  quantity: number;
};

export type SlackNewOrderFields = {
  orderNumber: string;
  deliveryDate: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  lineItems: SlackOrderLineItem[];
};

export type SlackRouting =
  | { skip: true; reason: string }
  | { skip: false; channelId: string; channelLabel: "abu_dhabi" | "dubai" };

/** True when the country code refers to the United Arab Emirates (`ae`). */
export function isUaeCountryCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return findCountryByCode(code)?.code === "ae";
}

/** Configured Abu Dhabi channel id, or null when unset. */
function abuDhabiChannelId(): string | null {
  const v = process.env.SLACK_ABU_DHABI_CHANNEL_ID?.trim();
  return v ? v : null;
}

/** Configured Dubai (default UAE) channel id, or null when unset. */
function dubaiChannelId(): string | null {
  const v = process.env.SLACK_DUBAI_CHANNEL_ID?.trim();
  return v ? v : null;
}

/**
 * True when at least one target channel is configured. Used to short-circuit
 * before doing any DB work or hitting the Slack connector.
 */
export function isSlackConfigured(): boolean {
  return abuDhabiChannelId() !== null || dubaiChannelId() !== null;
}

/**
 * Pure routing decision: given the order's country code and resolved delivery
 * city name/slug, decide whether to notify and which channel to use.
 *
 * - Non-UAE orders are skipped entirely.
 * - Abu Dhabi routes only to the Abu Dhabi channel.
 * - Every other UAE city routes only to the Dubai channel.
 *
 * A missing target channel is a skip, not a fallback. Sending an Abu Dhabi
 * order to the Dubai channel (or vice versa) is worse than dropping a
 * best-effort notification.
 */
export function resolveSlackRouting(args: {
  countryCode: string | null | undefined;
  cityName: string | null | undefined;
  citySlug: string | null | undefined;
  district?: string | null | undefined;
  cityId?: string | number | null | undefined;
}): SlackRouting {
  if (!isUaeCountryCode(args.countryCode)) {
    return { skip: true, reason: "not_uae" };
  }

  const normalizeLocation = (value: string | number | null | undefined): string =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");
  const isAbuDhabiValue = (value: string | number | null | undefined): boolean => {
    const normalized = normalizeLocation(value);
    return normalized === "abu dhabi" || normalized === "abu dhabi city";
  };
  const normalizedCityId = normalizeLocation(args.cityId);
  const hasAuthoritativeCity =
    normalizeLocation(args.citySlug) !== "" ||
    normalizeLocation(args.cityName) !== "" ||
    (normalizedCityId !== "" && !/^\d+$/.test(normalizedCityId));
  const isAbuDhabi =
    isAbuDhabiValue(args.citySlug) ||
    isAbuDhabiValue(args.cityName) ||
    isAbuDhabiValue(args.cityId) ||
    (!hasAuthoritativeCity && isAbuDhabiValue(args.district));

  const adId = abuDhabiChannelId();
  const dubaiId = dubaiChannelId();

  if (isAbuDhabi) {
    if (adId) return { skip: false, channelId: adId, channelLabel: "abu_dhabi" };
    return { skip: true, reason: "abu_dhabi_channel_not_configured" };
  }

  if (dubaiId) return { skip: false, channelId: dubaiId, channelLabel: "dubai" };
  return { skip: true, reason: "dubai_channel_not_configured" };
}

/**
 * Format a delivery date for the Slack message. Prefers the inbound calendar
 * date string (e.g. `2026-06-30`); otherwise formats a UTC ISO timestamp to
 * `DD Month YYYY`. Returns null when nothing usable is present.
 */
export function formatSlackDeliveryDate(
  rawDate: string | null | undefined,
  windowStart: string | null | undefined,
): string | null {
  const raw = rawDate?.trim();
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(d);
    }
    return raw;
  }
  if (windowStart) {
    const d = new Date(windowStart);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(d);
    }
  }
  return null;
}

/** Build the human-readable Slack message text for a new UAE order. */
export function buildNewOrderSlackText(fields: SlackNewOrderFields): string {
  const lines: string[] = [];
  lines.push(`:package: *New order ${fields.orderNumber}*`);
  lines.push(`*Delivery date:* ${fields.deliveryDate ?? "—"}`);
  lines.push(`*Recipient:* ${fields.recipientName ?? "—"}`);
  lines.push(`*Phone:* ${fields.recipientPhone ?? "—"}`);
  if (fields.lineItems.length > 0) {
    lines.push("*Items:*");
    for (const item of fields.lineItems) {
      const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      lines.push(`• ${qty} × ${item.name}`);
    }
  } else {
    lines.push("*Items:* —");
  }
  return lines.join("\n");
}

let _warnedNoConnectorHost = false;

/**
 * Build a Slack Web API client using the Replit Slack connector. Fetches the
 * bot token fresh on every call (tokens expire — never cache the client).
 * Throws when the connector is not connected; callers must treat that as a
 * best-effort failure.
 */
export async function getUncachableSlackClient(): Promise<WebClient> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    if (!_warnedNoConnectorHost) {
      logger.warn("slack: REPLIT_CONNECTORS_HOSTNAME is not set — Slack connector unavailable");
      _warnedNoConnectorHost = true;
    }
    throw new Error("REPLIT_CONNECTORS_HOSTNAME is not set");
  }
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
  if (!xReplitToken) {
    throw new Error("X_REPLIT_TOKEN not found for repl/depl");
  }

  const response = await fetch(
    "https://" +
      hostname +
      "/api/v2/connection?include_secrets=true&connector_names=slack",
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    },
  );
  const data = (await response.json()) as {
    items?: Array<{ settings?: { access_token?: string; bot_token?: string } }>;
  };
  const settings = data.items?.[0]?.settings;
  const accessToken = settings?.access_token || settings?.bot_token;
  if (!accessToken) {
    throw new Error("Slack not connected (no bot token from connector)");
  }
  return new WebClient(accessToken);
}

// ---------------------------------------------------------------------------
// Florist photo verification notifications
// ---------------------------------------------------------------------------

/**
 * Channel that receives florist photo-verification uploads
 * (#proj-operations-orders). Overridable via env for testing/staging.
 */
export function floristVerificationChannelId(): string {
  const v = process.env.SLACK_FLORIST_VERIFICATION_CHANNEL_ID?.trim();
  return v || "C043TTNESN4";
}

export type FloristVerificationPhoto = {
  /** Absolute, auth-free public URL Slack can fetch to render the image. */
  imageUrl: string;
  /** Alt text; carries the revision-specific delivery key for reconcile. */
  altText: string;
};

/**
 * Post the available florist verification photos to the operations channel as a
 * single `chat.postMessage` with image blocks whose fallback text is the
 * prefixed order number (e.g. `#LB-2122`).
 *
 * Image blocks (not `files.uploadV2` uploads) are used because the Slack
 * connector token has `chat:write` but NOT `files:write`; the caller copies
 * the photos to the auth-free public bucket and passes their public URLs.
 *
 * UNLIKE the best-effort order notifications above, this THROWS on any
 * failure — the caller surfaces the error to the operator with a Retry
 * action; the notification must never be silently dropped.
 */
export async function postFloristVerificationPhotos(args: {
  orderNumber: string;
  photos: FloristVerificationPhoto[];
}): Promise<void> {
  const client = await getUncachableSlackClient();
  const channelId = floristVerificationChannelId();
  const text = args.orderNumber.startsWith("#")
    ? args.orderNumber
    : `#${args.orderNumber}`;
  const result = (await client.chat.postMessage({
    channel: channelId,
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${text}*` } },
      ...args.photos.map((p) => ({
        type: "image" as const,
        image_url: p.imageUrl,
        alt_text: p.altText,
      })),
    ],
  })) as { ok?: boolean; error?: string };
  if (result?.ok === false) {
    throw new Error(`Slack chat.postMessage failed: ${result.error ?? "unknown error"}`);
  }
  logger.info(
    { orderNumber: args.orderNumber, channelId, photos: args.photos.length },
    "slack: florist verification photos posted",
  );
}

/**
 * Check whether a florist verification message for the given order number AND
 * photo-set delivery key was already delivered to the operations channel
 * (used to reconcile a retry after a crash between Slack accepting the upload
 * and our sent-marker persisting — a plain DB claim alone is only
 * at-least-once across the external call).
 *
 * The delivery key is a photo-set-revision-specific token embedded in the
 * image URLs / alt text (and, for legacy upload-style messages, filenames),
 * so a match is unique to the exact photo set being retried — an older
 * notification for the same order (pre-replacement) can never satisfy the
 * reconcile.
 *
 * Scans recent channel history (bounded lookback) for a message whose text is
 * the prefixed order number and whose image blocks or files carry the key.
 * THROWS on any Slack failure so callers fail closed (no blind re-upload, no
 * false "sent").
 */
export async function findFloristVerificationMessage(args: {
  orderNumber: string;
  deliveryKey: string;
  lookbackSeconds?: number;
}): Promise<boolean> {
  const client = await getUncachableSlackClient();
  const channelId = floristVerificationChannelId();
  const text = args.orderNumber.startsWith("#")
    ? args.orderNumber
    : `#${args.orderNumber}`;
  const lookback = args.lookbackSeconds ?? 72 * 3600;
  const oldest = String(Math.floor(Date.now() / 1000) - lookback);
  const result = (await client.conversations.history({
    channel: channelId,
    oldest,
    limit: 200,
  })) as {
    ok?: boolean;
    error?: string;
    messages?: Array<{
      text?: string;
      blocks?: Array<{ type?: string; image_url?: string; alt_text?: string }>;
      files?: Array<{ name?: string; title?: string }>;
    }>;
  };
  if (result?.ok === false) {
    throw new Error(`Slack conversations.history failed: ${result.error ?? "unknown error"}`);
  }
  return (result.messages ?? []).some(
    (m) =>
      (m.text ?? "").trim() === text &&
      ((m.blocks ?? []).some(
        (b) =>
          (b.image_url ?? "").includes(args.deliveryKey) ||
          (b.alt_text ?? "").includes(args.deliveryKey),
      ) ||
        (m.files ?? []).some(
          (f) => (f.name ?? "").includes(args.deliveryKey) || (f.title ?? "").includes(args.deliveryKey),
        )),
  );
}

type OrderRow = {
  display_order_number: string | null;
  delivery_address: Record<string, unknown> | null;
  window_start: string | null;
};

function readStr(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function readLocationValue(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readFirstStr(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = readStr(obj, key);
    if (value) return value;
  }
  return null;
}

/**
 * Best-effort: post a Slack notification for a newly created UAE order. Resolves
 * all message fields from the DB (order, delivery city, recipient contact, line
 * items). Non-UAE orders and unconfigured channels are skipped. Never throws —
 * any failure is logged and swallowed so order creation is unaffected.
 */
export async function notifyNewUaeOrderToSlack(args: {
  orderId: string;
  workspaceOwnerId: string;
}): Promise<void> {
  const { orderId, workspaceOwnerId } = args;
  try {
    if (!isSlackConfigured()) {
      logger.warn(
        { orderId },
        "slack: skipping new-order notification — no UAE order channel is configured",
      );
      return;
    }

    const orderRes = await db.query<OrderRow>(
      `SELECT display_order_number, delivery_address, window_start
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2
        LIMIT 1`,
      [orderId, workspaceOwnerId],
    );
    const order = orderRes.rows[0];
    if (!order) {
      logger.warn({ orderId }, "slack: order not found for notification");
      return;
    }

    const addr = order.delivery_address ?? null;
    const countryCode = readFirstStr(addr, ["countryCode", "country_code"]);
    if (!isUaeCountryCode(countryCode)) {
      logger.debug({ orderId, countryCode }, "slack: skipping — order is not UAE");
      return;
    }

    // Older storefront payloads used city_id/city, while current payloads use
    // cityId and may send either the numeric catalog id or its slug. Keep the
    // raw value as a routing hint even when it cannot be resolved in the
    // catalog; this is what prevents "abu-dhabi" from being lost by parseInt.
    const cityId = readLocationValue(addr, ["cityId", "city_id"]);
    let cityName = readFirstStr(addr, ["cityName", "city_name", "city"]);
    let citySlug = readFirstStr(addr, ["citySlug", "city_slug"]);
    if (cityId || cityName || citySlug) {
      const cityKey = cityId ?? citySlug ?? cityName;
      const cityRes = await db.query<{ name: string; slug: string }>(
        `SELECT name, slug FROM delivery_cities
          WHERE workspace_owner_id = $2
            AND (
              id::text = $1
              OR lower(slug) = lower($1)
              OR lower(name) = lower($1)
            )
          LIMIT 1`,
        [cityKey, workspaceOwnerId],
      );
      if (cityRes.rows[0]) {
        cityName = cityRes.rows[0].name;
        citySlug = cityRes.rows[0].slug;
      }
    }

    const routing = resolveSlackRouting({
      countryCode,
      cityName,
      citySlug,
      cityId,
      district: readFirstStr(addr, ["district", "deliveryDistrict", "delivery_district"]),
    });
    if (routing.skip) {
      logger.warn(
        { orderId, reason: routing.reason, countryCode },
        "slack: skipping new-order notification — target channel is not configured",
      );
      return;
    }

    const recipientRes = await db.query<{ display_name: string | null; phone: string | null }>(
      `SELECT c.display_name, c.phone
         FROM order_contacts oc
         JOIN contacts c ON c.id = oc.contact_id
        WHERE oc.order_id = $1 AND oc.role = 'recipient'
        LIMIT 1`,
      [orderId],
    );
    const recipientName = recipientRes.rows[0]?.display_name ?? null;
    const recipientPhone =
      recipientRes.rows[0]?.phone ?? readStr(addr, "phone") ?? null;

    const itemsRes = await db.query<{ name: string; quantity: string | null }>(
      `SELECT name, quantity FROM order_line_items WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );
    const lineItems: SlackOrderLineItem[] = itemsRes.rows.map((r) => {
      const q = r.quantity != null ? Number(r.quantity) : NaN;
      return { name: r.name, quantity: Number.isFinite(q) ? q : 1 };
    });

    const orderNumber = order.display_order_number?.trim() || orderId;
    const deliveryDate = formatSlackDeliveryDate(readStr(addr, "date"), order.window_start);

    const text = buildNewOrderSlackText({
      orderNumber,
      deliveryDate,
      recipientName,
      recipientPhone,
      lineItems,
    });

    const client = await getUncachableSlackClient();
    const result = await client.chat.postMessage({ channel: routing.channelId, text });
    if (result.ok === false) {
      throw new Error(`Slack chat.postMessage failed: ${result.error ?? "unknown error"}`);
    }
    logger.info(
      { orderId, channel: routing.channelLabel },
      "slack: new UAE order notification posted",
    );
  } catch (err) {
    logger.warn(
      { err, orderId },
      "slack: failed to post new-order notification; order is unaffected",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Salary expense approval DMs
// ─────────────────────────────────────────────────────────────────────────────

const OS_DASHBOARD_URL = "https://os.presentail.com";

export type SalaryApprovalRequestFields = {
  payee: string;
  amount: string;
  currency: string;
  requesterName: string;
  paymentTypeLabel: string | null;
  sessionNumber: string | null;
  transactionId: number;
};

/** Resolve a workspace member's OS email, or null when unknown. */
async function lookupMemberEmail(workspaceOwnerId: string, clerkUserId: string | null): Promise<string | null> {
  if (!clerkUserId) return null;
  const row = await db.query<{ member_email: string | null }>(
    `SELECT member_email FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $2 LIMIT 1`,
    [workspaceOwnerId, clerkUserId],
  );
  return row.rows[0]?.member_email?.trim() || null;
}

export type SalaryDecisionFields = {
  payee: string;
  amount: string;
  currency: string;
  approved: boolean;
  reason?: string | null;
};

/** Deep link that opens the salary approval view in Presentail OS. */
export function salaryApprovalLink(transactionId: number): string {
  return `${OS_DASHBOARD_URL}/cash-approvals?tx=${transactionId}`;
}

/** Slack DM text asking an approver to review a pending salary expense. */
export function buildSalaryApprovalRequestText(f: SalaryApprovalRequestFields): string {
  const lines: string[] = [];
  lines.push(":moneybag: *Salary expense approval needed*");
  lines.push(`*Type:* Salaries & Wages${f.paymentTypeLabel ? ` — ${f.paymentTypeLabel}` : ""}`);
  lines.push(`*Payee:* ${f.payee}`);
  lines.push(`*Requested by:* ${f.requesterName}`);
  lines.push(`*Amount:* ${f.amount} ${f.currency}`);
  if (f.sessionNumber) lines.push(`*Cash session:* ${f.sessionNumber}`);
  lines.push(`<${salaryApprovalLink(f.transactionId)}|Review in Presentail OS>`);
  return lines.join("\n");
}

/** Slack DM text informing the requester of the approve/decline outcome. */
export function buildSalaryDecisionText(f: SalaryDecisionFields): string {
  const verdict = f.approved ? "approved :white_check_mark:" : "declined :x:";
  let text = `Your salary expense request for ${f.payee}, ${f.amount} ${f.currency} was ${verdict}`;
  if (!f.approved && f.reason?.trim()) text += `\n*Reason:* ${f.reason.trim()}`;
  return text;
}

/**
 * Look up a Slack user id by email (requires users:read.email). Returns null
 * when the email has no Slack account or on any error — never throws.
 */
export async function findSlackUserIdByEmail(
  client: WebClient,
  email: string,
): Promise<string | null> {
  try {
    const res = await client.users.lookupByEmail({ email });
    return res.ok && res.user?.id ? res.user.id : null;
  } catch (err) {
    logger.debug({ err, email }, "slack: users.lookupByEmail failed (no match or error)");
    return null;
  }
}

/**
 * Best-effort: DM a Slack user matched by OS email. Opens the DM channel via
 * conversations.open (im:write) then posts. Returns true when delivered.
 * Never throws.
 */
export async function sendSlackDmByEmail(email: string, text: string): Promise<boolean> {
  try {
    const trimmed = email.trim();
    if (!trimmed) return false;
    const client = await getUncachableSlackClient();
    const userId = await findSlackUserIdByEmail(client, trimmed);
    if (!userId) {
      logger.debug({ email: trimmed }, "slack: no Slack user matches email; skipping DM");
      return false;
    }
    const opened = await client.conversations.open({ users: userId });
    const channelId = opened.channel?.id;
    if (!channelId) {
      logger.warn({ email: trimmed }, "slack: conversations.open returned no channel");
      return false;
    }
    await client.chat.postMessage({ channel: channelId, text });
    return true;
  } catch (err) {
    logger.warn({ err, email }, "slack: failed to send DM; flow is unaffected");
    return false;
  }
}

/**
 * Resolve the emails of members who can approve salary expenses: everyone
 * holding the "Business Development" custom role, falling back to workspace
 * owner(s)/admin(s) when nobody holds the role.
 */
export async function findSalaryApproverEmails(workspaceOwnerId: string): Promise<string[]> {
  const bd = await db.query<{ member_email: string | null }>(
    `SELECT DISTINCT wm.member_email
       FROM workspace_members wm
       JOIN workspace_member_roles wmr ON wmr.member_id = wm.id
       JOIN workspace_roles wr ON wr.id = wmr.role_id
      WHERE wm.workspace_owner_id = $1
        AND LOWER(wr.name) = 'business development'
        AND wm.member_email IS NOT NULL`,
    [workspaceOwnerId],
  );
  const emails = bd.rows.map((r) => (r.member_email ?? "").trim()).filter(Boolean);
  if (emails.length > 0) return emails;
  // Fallback: workspace owners/admins.
  const owners = await db.query<{ member_email: string | null }>(
    `SELECT DISTINCT member_email FROM workspace_members
      WHERE workspace_owner_id = $1 AND role IN ('owner', 'admin') AND member_email IS NOT NULL`,
    [workspaceOwnerId],
  );
  return owners.rows.map((r) => (r.member_email ?? "").trim()).filter(Boolean);
}

/**
 * Best-effort: DM every salary approver about a new pending request.
 * Failures (including "no Slack match") are logged and swallowed.
 */
export async function notifySalaryApprovalRequested(args: {
  workspaceOwnerId: string;
  /** Clerk id of the requester; used to resolve a display name when fields.requesterName is empty. */
  requesterClerkId?: string | null;
  fields: SalaryApprovalRequestFields;
}): Promise<void> {
  try {
    if (!args.fields.requesterName && args.requesterClerkId) {
      args.fields.requesterName =
        (await lookupMemberEmail(args.workspaceOwnerId, args.requesterClerkId)) ?? args.requesterClerkId;
    }
    const emails = await findSalaryApproverEmails(args.workspaceOwnerId);
    if (emails.length === 0) {
      logger.warn(
        { workspaceOwnerId: args.workspaceOwnerId },
        "slack: no salary approver emails found; skipping approval DMs",
      );
      return;
    }
    const text = buildSalaryApprovalRequestText(args.fields);
    for (const email of emails) {
      await sendSlackDmByEmail(email, text);
    }
  } catch (err) {
    logger.warn({ err }, "slack: failed to notify salary approvers; request is unaffected");
  }
}

/**
 * Best-effort: DM the requester about the approve/decline outcome when their
 * OS email matches a Slack account. Never throws.
 */
export async function notifySalaryDecisionToRequester(args: {
  /** Resolve the requester's email from their workspace membership. */
  workspaceOwnerId?: string;
  requesterClerkId?: string | null;
  /** Pre-resolved email (takes precedence over the clerk-id lookup). */
  requesterEmail?: string | null;
  fields: SalaryDecisionFields;
}): Promise<void> {
  try {
    let email = args.requesterEmail?.trim() || null;
    if (!email && args.workspaceOwnerId) {
      email = await lookupMemberEmail(args.workspaceOwnerId, args.requesterClerkId ?? null);
    }
    if (!email) return;
    await sendSlackDmByEmail(email, buildSalaryDecisionText(args.fields));
  } catch (err) {
    logger.warn({ err }, "slack: failed to notify requester of salary decision");
  }
}
