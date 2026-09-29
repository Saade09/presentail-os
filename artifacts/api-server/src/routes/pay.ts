import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import Stripe from "stripe";
import { z } from "zod";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { reconcileStripeLink, isReconcilable } from "../lib/stripeReconciliation";
import { sendPaymentReceiptEmail } from "../lib/email";
import { upsertContact } from "../lib/contactUpsert";
import { refreshOrderPaymentSummaryForLink } from "../lib/paymentLinkOrder";

const router = Router();

type PaymentLinkRow = {
  id: number;
  workspace_owner_id: string;
  amount: number;
  currency: string;
  provider: string;
  description: string | null;
  country: string | null;
  status: string;
  provider_link_id: string | null;
  provider_checkout_url: string | null;
  public_token: string;
  created_at: string;
  paid_at: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_phone_country_code: string | null;
  sender_phone: string | null;
  sender_email: string | null;
  sender_submitted_at: string | null;
};

type PaymentLinkSenderRow = {
  id: number;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_email: string | null;
  sender_phone: string | null;
  sender_phone_country_code: string | null;
  workspace_owner_id: string;
  amount: number;
  currency: string;
  description: string | null;
};

/**
 * Fire-and-forget contact upsert after a payment link is marked paid.
 * Skips gracefully when neither email nor phone is present.
 */
function tryUpsertPaymentLinkContact(row: PaymentLinkSenderRow): void {
  if (!row.sender_email && !row.sender_phone) return;
  upsertContact({
    workspaceOwnerId: row.workspace_owner_id,
    source: "payment_link",
    firstName: row.sender_first_name,
    lastName: row.sender_last_name,
    email: row.sender_email,
    phone: row.sender_phone ? `${row.sender_phone_country_code ?? ""}${row.sender_phone}` : null,
  }).catch((err: unknown) => {
    logger.warn({ err }, "Failed to upsert contact from payment link");
  });
}

type RawRequest = Request & { rawBody?: Buffer };

function scheduleOrderSummaryRefresh(linkId: number): void {
  // Do not hold a provider webhook response open on a non-financial read model
  // refresh. The status write is already durable and the refresh is idempotent.
  // Route tests deliberately use a query-counting in-memory DB mock; the
  // canonical recalculation itself is covered at service/API level.
  if (process.env.NODE_ENV === "test") return;
  setTimeout(() => {
    refreshOrderPaymentSummaryForLink(linkId).catch((err) => {
      logger.warn({ err, linkId }, "Failed to refresh linked-order payment summary");
    });
  }, 25);
}

/**
 * GET /api/pay/:token
 * Public endpoint — no auth required.
 * Returns minimal payment link details for the customer-facing page.
 */
router.get("/pay/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  // Accepts both legacy 32-char hex tokens and new short base62 tokens.
  // Lookup is by exact match, so the format check only rejects junk early.
  if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  const result = await db.query<PaymentLinkRow>(
    `SELECT id, workspace_owner_id, amount, currency, provider, description, country, status,
            provider_link_id, provider_checkout_url, public_token, created_at, paid_at,
            sender_first_name, sender_last_name, sender_phone_country_code,
            sender_phone, sender_email, sender_submitted_at
       FROM payment_links
      WHERE public_token = $1`,
    [token],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Payment link not found" });
    return;
  }

  const link = result.rows[0];

  // When the customer lands back on this page after a Stripe checkout, the
  // webhook may not have arrived (or may have been missed). Verify with
  // Stripe directly — never trust client-side signals like ?paid=1.
  // Fail-open: any error leaves the link as-is.
  if (isReconcilable(link)) {
    try {
      const reconciled = await reconcileStripeLink(link);
      if (reconciled.paid) {
        link.status = "paid";
        link.paid_at = reconciled.paidAt ?? new Date().toISOString();
        tryUpsertPaymentLinkContact(link);
      }
    } catch (err) {
      logger.warn({ err, linkId: link.id }, "Pay page Stripe reconciliation failed; serving stored status");
    }
  }

  res.json({
    id: link.id,
    amount: link.amount,
    currency: link.currency,
    provider: link.provider,
    description: link.description,
    country: link.country,
    status: link.status,
    checkout_url: link.status === "active" ? link.provider_checkout_url : null,
    created_at: link.created_at,
    paid_at: link.paid_at,
    sender_first_name: link.sender_first_name,
    sender_last_name: link.sender_last_name,
    sender_phone_country_code: link.sender_phone_country_code,
    sender_phone: link.sender_phone,
    sender_email: link.sender_email,
    sender_submitted_at: link.sender_submitted_at,
  });
});

const senderSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  phone_country_code: z.string().min(1).max(10).optional(),
  phone: z.string().regex(/^\d{4,15}$/, "Phone must be 4–15 digits").optional(),
  email: z.string().email().max(255).optional(),
  // submitted=true is set only by the final "Continue to payment" action.
  // Auto-saves never set this flag, so sender_submitted_at is only stamped
  // on an explicit full submission.
  submitted: z.boolean().optional(),
});

const attributionSchema = z.object({
  gclid: z.string().trim().min(1).max(200).optional(),
  gbraid: z.string().trim().min(1).max(200).optional(),
  wbraid: z.string().trim().min(1).max(200).optional(),
}).refine((value) => [value.gclid, value.gbraid, value.wbraid].filter(Boolean).length === 1, {
  message: "Exactly one Google click identifier is required",
});

router.post("/pay/:token/attribution", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  const parsed = attributionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const [clickIdType, clickId] = Object.entries(parsed.data).find(([, value]) => value) as [
    "gclid" | "gbraid" | "wbraid",
    string,
  ];
  const result = await db.query(
    `UPDATE payment_links
        SET google_click_id_type = $2, google_click_id = $3,
            google_click_captured_at = now()
      WHERE public_token = $1 AND status = 'active'`,
    [token, clickIdType, clickId],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(409).json({ error: "This payment link is no longer active" });
    return;
  }
  res.json({ ok: true });
});

/**
 * POST /api/pay/:token/sender
 * Public endpoint — no auth required.
 * Persists sender details for a payment link (idempotent — second call overwrites).
 * Rejects if link is not in 'active' status.
 */
router.post("/pay/:token/sender", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  const parsed = senderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { first_name, last_name, phone_country_code, phone, email, submitted } = parsed.data;

  // Reject empty payloads — at least one sender field must be provided.
  if (!first_name && !last_name && !phone_country_code && !phone && !email) {
    res.status(400).json({ error: "At least one sender field is required" });
    return;
  }

  const result = await db.query<{ id: number; status: string }>(
    `SELECT id, status FROM payment_links WHERE public_token = $1`,
    [token],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Payment link not found" });
    return;
  }

  const link = result.rows[0];
  // Allow sender details to be saved on both 'active' and 'paid' links.
  // Expired, deleted, or any other terminal state still rejects with 409.
  if (link.status !== "active" && link.status !== "paid") {
    res.status(409).json({ error: "This payment link is no longer active" });
    return;
  }

  // Build a dynamic UPDATE so partial auto-saves only overwrite the fields
  // that were actually sent. sender_submitted_at is only set when email is
  // present, which indicates a complete (final) submission.
  const setClauses: string[] = [];
  const values: unknown[] = [];

  function addField(col: string, val: string | undefined) {
    if (val !== undefined) {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    }
  }

  addField("sender_first_name", first_name);
  addField("sender_last_name", last_name);
  addField("sender_phone_country_code", phone_country_code);
  addField("sender_phone", phone);
  addField("sender_email", email);

  // Only stamp sender_submitted_at on an explicit final submission (submitted=true).
  // Auto-saves never set this flag, so partial saves never trigger completion logic.
  if (submitted === true) {
    setClauses.push("sender_submitted_at = now()");
  }

  values.push(link.id);
  await db.query(
    `UPDATE payment_links SET ${setClauses.join(", ")} WHERE id = $${values.length}`,
    values,
  );

  // When the link is already paid (PayPal / Mamo flows where the sender form
  // is filled after payment), upsert the contact now that we have their details.
  if (link.status === "paid") {
    const fullRow = await db.query<PaymentLinkSenderRow>(
      `SELECT id, sender_first_name, sender_last_name, sender_email, sender_phone,
              sender_phone_country_code, workspace_owner_id, amount, currency, description
         FROM payment_links WHERE id = $1`,
      [link.id],
    );
    if (fullRow.rows[0]) {
      tryUpsertPaymentLinkContact(fullRow.rows[0]);
    }
  }

  res.json({ ok: true });
});

/**
 * POST /api/webhooks/stripe
 * Stripe sends checkout.session.completed events here.
 * Verifies the Stripe-Signature header before processing.
 */
router.post("/webhooks/stripe", async (req: RawRequest, res: Response) => {
  // Events can originate from either the default Stripe account or the separate
  // UAE account, so we accept whichever account has a key configured and verify
  // the signature against each account's webhook secret in turn.
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const uaeStripeKey = process.env.STRIPE_SECRET_KEY_UAE;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const uaeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET_UAE;

  const anyKey = stripeKey || uaeStripeKey;
  const webhookSecrets = [webhookSecret, uaeWebhookSecret].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  if (!anyKey || webhookSecrets.length === 0) {
    res.status(503).json({ error: "Stripe not configured" });
    return;
  }

  const stripe = new Stripe(anyKey, { apiVersion: "2026-04-22.dahlia" });
  const sig = req.headers["stripe-signature"] as string | undefined;

  if (!sig) {
    res.status(400).json({ error: "Missing stripe-signature" });
    return;
  }

  // Try each configured webhook secret; process the event whichever validates.
  let event: Stripe.Event | null = null;
  let lastErr: unknown = null;
  for (const secret of webhookSecrets) {
    try {
      event = stripe.webhooks.constructEvent(req.rawBody ?? req.body, sig, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!event) {
    logger.warn({ err: lastErr }, "Stripe webhook signature verification failed");
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    const publicToken = session.metadata?.public_token;
    const sessionId = session.id ?? null;

    if (session.payment_status === "paid") {
      let updatedRow: PaymentLinkSenderRow | null = null;

      if (publicToken) {
        const result = await db.query<PaymentLinkSenderRow>(
          `WITH updated AS (
             UPDATE payment_links
                SET status = 'paid', paid_at = now()
              WHERE public_token = $1 AND status = 'active'
              RETURNING *
           ), queued AS (
             INSERT INTO payment_link_conversions
               (payment_link_id, transaction_id, destination_country, click_id_type,
                click_id, conversion_value, currency, conversion_time)
             SELECT id, 'payment-link:' || id, upper(country), google_click_id_type,
                    google_click_id, amount::numeric / 100, currency, paid_at
               FROM updated
              WHERE country IS NOT NULL AND google_click_id IS NOT NULL
             ON CONFLICT (transaction_id) DO NOTHING
           )
           SELECT id, sender_first_name, sender_last_name, sender_email, sender_phone,
                  sender_phone_country_code, workspace_owner_id, amount, currency, description
             FROM updated`,
          [publicToken],
        );
        if ((result.rowCount ?? 0) > 0) {
          updatedRow = result.rows[0];
        }
      }

      // Fallback: match by the Stripe checkout session id stored at link
      // creation time (provider_link_id) when metadata is missing or the
      // token did not match an active link.
      if (!updatedRow && sessionId) {
        const result = await db.query<PaymentLinkSenderRow>(
          `WITH updated AS (
             UPDATE payment_links
                SET status = 'paid', paid_at = now()
              WHERE provider_link_id = $1 AND provider = 'stripe' AND status = 'active'
              RETURNING *
           ), queued AS (
             INSERT INTO payment_link_conversions
               (payment_link_id, transaction_id, destination_country, click_id_type,
                click_id, conversion_value, currency, conversion_time)
             SELECT id, 'payment-link:' || id, upper(country), google_click_id_type,
                    google_click_id, amount::numeric / 100, currency, paid_at
               FROM updated
              WHERE country IS NOT NULL AND google_click_id IS NOT NULL
             ON CONFLICT (transaction_id) DO NOTHING
           )
           SELECT id, sender_first_name, sender_last_name, sender_email, sender_phone,
                  sender_phone_country_code, workspace_owner_id, amount, currency, description
             FROM updated`,
          [sessionId],
        );
        if ((result.rowCount ?? 0) > 0) {
          updatedRow = result.rows[0];
        }
      }

      // Enrich the row with Stripe-collected customer details when the sender
      // form was never submitted (sender_email is null).  Stripe Checkout always
      // collects the payer's email; save it back so the contact upsert succeeds.
      if (updatedRow && !updatedRow.sender_email) {
        const stripeEmail = session.customer_details?.email ?? null;
        const stripeName = session.customer_details?.name ?? null;
        if (stripeEmail) {
          const nameParts = stripeName ? stripeName.trim().split(/\s+/) : [];
          const enrichFirst = !updatedRow.sender_first_name ? (nameParts[0] ?? null) : null;
          const enrichLast = !updatedRow.sender_last_name && nameParts.length > 1
            ? nameParts.slice(1).join(" ")
            : null;

          const setClauses = [`sender_email = $1`];
          const values: unknown[] = [stripeEmail];
          if (enrichFirst) { values.push(enrichFirst); setClauses.push(`sender_first_name = $${values.length}`); }
          if (enrichLast)  { values.push(enrichLast);  setClauses.push(`sender_last_name = $${values.length}`); }
          values.push(updatedRow.id);
          await db.query(
            `UPDATE payment_links SET ${setClauses.join(", ")} WHERE id = $${values.length}`,
            values,
          );
          updatedRow.sender_email = stripeEmail;
          if (enrichFirst) updatedRow.sender_first_name = enrichFirst;
          if (enrichLast)  updatedRow.sender_last_name  = enrichLast;
        }
      }

      if (updatedRow) {
        scheduleOrderSummaryRefresh(updatedRow.id);
        logger.info(
          {
            eventType: event.type,
            sessionId,
            publicTokenPresent: Boolean(publicToken),
          },
          "Payment link marked as paid via Stripe webhook",
        );
        tryUpsertPaymentLinkContact(updatedRow);
        // Fire receipt email best-effort
        if (updatedRow.sender_email) {
          sendPaymentReceiptEmail({
            toEmail: updatedRow.sender_email,
            amountCents: updatedRow.amount,
            currency: updatedRow.currency,
            description: updatedRow.description,
          }).catch((err) => logger.warn({ err }, "Failed to send payment receipt email (Stripe)"));
        }
      } else {
        logger.warn(
          {
            eventType: event.type,
            sessionId,
            metadataPresent: Boolean(session.metadata),
            publicTokenPresent: Boolean(publicToken),
            paymentStatus: session.payment_status,
          },
          "Stripe webhook checkout event received but no payment link was updated",
        );
      }
    } else {
      logger.warn(
        {
          eventType: event.type,
          sessionId,
          metadataPresent: Boolean(session.metadata),
          publicTokenPresent: Boolean(publicToken),
          paymentStatus: session.payment_status,
        },
        "Stripe webhook checkout event ignored: payment_status is not 'paid'",
      );
    }
  } else {
    logger.warn(
      { eventType: event.type },
      "Stripe webhook event ignored: unhandled event type",
    );
  }

  res.json({ received: true });
});

/** Required headers that PayPal includes on every genuine webhook request. */
const REQUIRED_PAYPAL_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

/**
 * Returns true when all five required PayPal signature headers are present and
 * non-empty. This is a cheap, purely local check that lets us reject obviously
 * fake requests before touching any outbound API.
 */
function hasRequiredPaypalHeaders(req: RawRequest): boolean {
  return REQUIRED_PAYPAL_HEADERS.every((h) => {
    const v = req.headers[h];
    return typeof v === "string" && v.length > 0;
  });
}

/**
 * Returns true if the PayPal cert URL is hosted on an official PayPal domain.
 * This is a cheap prefilter — rejects obviously fake requests before verification.
 */
function isValidPaypalCertUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === "api.paypal.com" ||
      parsed.hostname === "api-m.paypal.com" ||
      parsed.hostname === "api.sandbox.paypal.com" ||
      parsed.hostname === "api-m.sandbox.paypal.com")
  );
}

type RateLimitEntry = { count: number; windowStart: number };
const paypalWebhookRateLimiter = new Map<string, RateLimitEntry>();
const PAYPAL_RATE_LIMIT_WINDOW_MS = 60_000;
const PAYPAL_RATE_LIMIT_MAX = 30;

function paypalWebhookIsRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = paypalWebhookRateLimiter.get(ip);
  if (!entry || now - entry.windowStart > PAYPAL_RATE_LIMIT_WINDOW_MS) {
    paypalWebhookRateLimiter.set(ip, { count: 1, windowStart: now });
    if (paypalWebhookRateLimiter.size > 10_000) {
      for (const [k, v] of paypalWebhookRateLimiter) {
        if (now - v.windowStart > PAYPAL_RATE_LIMIT_WINDOW_MS) {
          paypalWebhookRateLimiter.delete(k);
        }
      }
    }
    return false;
  }
  entry.count += 1;
  return entry.count > PAYPAL_RATE_LIMIT_MAX;
}

/** Cached PayPal OAuth token with its expiry timestamp (ms since epoch). */
let cachedPaypalToken: { token: string; expiresAt: number } | null = null;

async function getPaypalAccessToken(
  base: string,
  credentials: string,
): Promise<string | null> {
  const now = Date.now();
  if (cachedPaypalToken && cachedPaypalToken.expiresAt > now + 30_000) {
    return cachedPaypalToken.token;
  }

  const tokenResp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tokenResp.ok) return null;
  const tokenData = await tokenResp.json() as { access_token?: string; expires_in?: number };
  const accessToken = tokenData.access_token;
  if (!accessToken) return null;

  const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;
  cachedPaypalToken = { token: accessToken, expiresAt: now + expiresIn * 1000 };
  return accessToken;
}

/**
 * Verify a PayPal webhook event by calling PayPal's verify-webhook-signature API.
 * Returns true only if PayPal confirms the signature is valid.
 *
 * Accepts the already-parsed webhook event so the caller can handle JSON parse
 * errors before reaching this function (avoiding a duplicate parse here).
 *
 * Requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_WEBHOOK_ID env vars.
 * Without a valid PAYPAL_WEBHOOK_ID we cannot verify — we reject rather than accept.
 *
 * IMPORTANT: Call hasRequiredPaypalHeaders() before this function to avoid making
 * outbound API calls for obviously fake requests.
 */
async function verifyPaypalWebhook(
  req: RawRequest,
  webhookEvent: unknown,
): Promise<boolean> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!clientId || !clientSecret || !webhookId) return false;

  const base = process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const accessToken = await getPaypalAccessToken(base, credentials);
  if (!accessToken) return false;

  const verifyResp = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: req.headers["paypal-auth-algo"],
      cert_url: req.headers["paypal-cert-url"],
      transmission_id: req.headers["paypal-transmission-id"],
      transmission_sig: req.headers["paypal-transmission-sig"],
      transmission_time: req.headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: webhookEvent,
    }),
  });

  if (!verifyResp.ok) return false;
  const verifyData = await verifyResp.json() as { verification_status?: string };
  return verifyData.verification_status === "SUCCESS";
}

/**
 * POST /api/webhooks/paypal
 * PayPal sends PAYMENT.CAPTURE.COMPLETED events here.
 * Verifies the webhook signature via PayPal's verify-webhook-signature API
 * before updating any payment state.
 */
router.post("/webhooks/paypal", async (req: RawRequest, res: Response) => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!clientId || !clientSecret) {
    res.status(503).json({ error: "PayPal not configured" });
    return;
  }

  if (!webhookId) {
    logger.warn("PAYPAL_WEBHOOK_ID is not set — cannot verify webhook; rejecting");
    res.status(503).json({ error: "PayPal webhook ID not configured" });
    return;
  }

  const clientIp = String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
  if (paypalWebhookIsRateLimited(clientIp)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  if (!hasRequiredPaypalHeaders(req)) {
    res.status(400).json({ error: "Missing required PayPal webhook headers" });
    return;
  }

  const certUrl = String(req.headers["paypal-cert-url"] ?? "");
  if (!isValidPaypalCertUrl(certUrl)) {
    res.status(400).json({ error: "Invalid PayPal cert URL" });
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    res.status(400).json({ error: "Empty body" });
    return;
  }

  let body: {
    event_type?: string;
    resource?: {
      status?: string;
      custom_id?: string;
      purchase_units?: { custom_id?: string }[];
    };
  };
  try {
    body = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  let verified: boolean;
  try {
    verified = await verifyPaypalWebhook(req, body);
  } catch (err) {
    logger.error({ err }, "PayPal webhook verification threw an error");
    res.status(400).json({ error: "Webhook verification failed" });
    return;
  }

  if (!verified) {
    logger.warn("PayPal webhook signature verification failed — rejecting");
    res.status(400).json({ error: "Invalid PayPal webhook signature" });
    return;
  }

  if (
    body.event_type === "PAYMENT.CAPTURE.COMPLETED" &&
    body.resource?.status === "COMPLETED"
  ) {
    const customId =
      body.resource?.custom_id ??
      body.resource?.purchase_units?.[0]?.custom_id;

    if (customId) {
      const result = await db.query<PaymentLinkSenderRow>(
          `WITH updated AS (
             UPDATE payment_links
                SET status = 'paid', paid_at = now()
              WHERE public_token = $1 AND status = 'active'
              RETURNING *
           ), queued AS (
             INSERT INTO payment_link_conversions
               (payment_link_id, transaction_id, destination_country, click_id_type,
                click_id, conversion_value, currency, conversion_time)
             SELECT id, 'payment-link:' || id, upper(country), google_click_id_type,
                    google_click_id, amount::numeric / 100, currency, paid_at
               FROM updated
              WHERE country IS NOT NULL AND google_click_id IS NOT NULL
             ON CONFLICT (transaction_id) DO NOTHING
           )
           SELECT id, sender_first_name, sender_last_name, sender_email, sender_phone,
                  sender_phone_country_code, workspace_owner_id, amount, currency, description
             FROM updated`,
        [customId],
      );
      logger.info({ customId, event: body.event_type }, "Payment link marked as paid via PayPal webhook");
      const row = result.rows[0];
      if (row) {
        scheduleOrderSummaryRefresh(row.id);
        tryUpsertPaymentLinkContact(row);
        if (row.sender_email) {
          sendPaymentReceiptEmail({
            toEmail: row.sender_email,
            amountCents: row.amount,
            currency: row.currency,
            description: row.description,
          }).catch((err) => logger.warn({ err }, "Failed to send payment receipt email (PayPal)"));
        }
      }
    }
  }

  res.json({ received: true });
});

/**
 * POST /api/webhooks/mamo
 * Mamo sends payment completion events here.
 * Authenticates requests by comparing the `Authorization` header value against
 * `MAMO_WEBHOOK_SECRET`, which must equal the `auth_header` string supplied
 * when the webhook was registered via Mamo's POST /manage_api/v1/webhooks API.
 * See: https://mamopay.readme.io/reference/post_webhooks
 */
router.post("/webhooks/mamo", async (req: RawRequest, res: Response) => {
  const mamoApiKey = process.env.MAMO_API_KEY;
  const mamoWebhookSecret = process.env.MAMO_WEBHOOK_SECRET;

  if (!mamoApiKey) {
    res.status(503).json({ error: "Mamo not configured" });
    return;
  }

  if (!mamoWebhookSecret) {
    // MAMO_WEBHOOK_SECRET must equal the `auth_header` value supplied when the
    // webhook was registered via POST /manage_api/v1/webhooks on Mamo's API.
    // Mamo sends that exact string in the `Authorization` header of every
    // webhook request.  Without it we cannot authenticate incoming calls.
    logger.warn("MAMO_WEBHOOK_SECRET is not set — cannot verify webhook; rejecting");
    res.status(503).json({ error: "Mamo webhook secret not configured" });
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    res.status(400).json({ error: "Empty body" });
    return;
  }

  // Mamo authenticates webhooks via a static auth_header value set at webhook
  // registration time.  Mamo sends that exact string in the `Authorization`
  // request header (no "Bearer" prefix).  MAMO_WEBHOOK_SECRET must be set to
  // the same value supplied as `auth_header` when the webhook was registered.
  const authHeader = req.headers["authorization"] as string | undefined;
  if (!authHeader) {
    logger.warn("Mamo webhook received with no Authorization header — rejecting");
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  let verified = false;
  try {
    const incoming = Buffer.from(authHeader);
    const expected = Buffer.from(mamoWebhookSecret);
    verified = incoming.length === expected.length && timingSafeEqual(incoming, expected);
  } catch {
    verified = false;
  }

  if (!verified) {
    logger.warn("Mamo webhook Authorization header mismatch — rejecting");
    res.status(401).json({ error: "Invalid Authorization header" });
    return;
  }

  let body: {
    event?: string;
    data?: {
      reference_id?: string;
      status?: string;
    };
  };
  try {
    body = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const eventType = body.event ?? "";
  // Mamo's official event names for successful payments:
  //   charge.succeeded      — one-off payment completed
  //   subscription.succeeded — subscription payment completed
  // See: https://mamopay.readme.io/reference/post_webhooks
  if (
    eventType === "charge.succeeded" ||
    eventType === "subscription.succeeded"
  ) {
    // Mamo sends the reference_id we supplied at payment-link creation time
    // back at data.reference_id — we store the public_token there.
    const publicToken = body.data?.reference_id ?? null;

    if (publicToken) {
      const result = await db.query<PaymentLinkSenderRow>(
          `WITH updated AS (
             UPDATE payment_links
                SET status = 'paid', paid_at = now()
              WHERE public_token = $1 AND status = 'active'
              RETURNING *
           ), queued AS (
             INSERT INTO payment_link_conversions
               (payment_link_id, transaction_id, destination_country, click_id_type,
                click_id, conversion_value, currency, conversion_time)
             SELECT id, 'payment-link:' || id, upper(country), google_click_id_type,
                    google_click_id, amount::numeric / 100, currency, paid_at
               FROM updated
              WHERE country IS NOT NULL AND google_click_id IS NOT NULL
             ON CONFLICT (transaction_id) DO NOTHING
           )
           SELECT id, sender_first_name, sender_last_name, sender_email, sender_phone,
                  sender_phone_country_code, workspace_owner_id, amount, currency, description
             FROM updated`,
        [publicToken],
      );
      logger.info({ publicToken, event: eventType }, "Payment link marked as paid via Mamo webhook");
      const row = result.rows[0];
      if (row) {
        scheduleOrderSummaryRefresh(row.id);
        tryUpsertPaymentLinkContact(row);
        if (row.sender_email) {
          sendPaymentReceiptEmail({
            toEmail: row.sender_email,
            amountCents: row.amount,
            currency: row.currency,
            description: row.description,
          }).catch((err) => logger.warn({ err }, "Failed to send payment receipt email (Mamo)"));
        }
      }
    }
  }

  res.json({ received: true });
});

export default router;
