import { Router, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { clerkClient } from "@clerk/express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { logPageAccessDenial, resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_PROVIDERS,
  STRIPE_UNSUPPORTED_CURRENCIES,
  PAYPAL_UNSUPPORTED_CURRENCIES,
  MAMO_UNSUPPORTED_CURRENCIES,
} from "@workspace/payment-constants";
import { DEFAULT_COUNTRIES, isExcludedCountry } from "../lib/defaults";
import { reconcileStripeLink, reconcileActiveStripeLinks } from "../lib/stripeReconciliation";
import {
  linkPaymentLinkToOrder,
  unlinkPaymentLinkFromOrder,
  PaymentLinkOrderError,
} from "../lib/paymentLinkOrder";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * Returns true only if the string is a strictly numeric finite positive value.
 * Rejects partial parses ("500abc"), special floats ("Infinity", "NaN"), and
 * scientific notation used to sneak in sub-cent values.
 */
function isValidPositiveDecimal(raw: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0;
}

/**
 * Reads MAX_PAYMENT_AMOUNT_USD from the environment, falling back to 999999.99.
 * Called per-request so that the value can be overridden in tests via vi.stubEnv.
 */
function getMaxPaymentAmount(): number {
  const raw = process.env.MAX_PAYMENT_AMOUNT_USD;
  if (!raw) return 999999.99;
  return Number(raw);
}

/**
 * Validates MAX_PAYMENT_AMOUNT_USD on startup so a misconfigured value fails fast.
 * Call this during server initialisation before accepting requests.
 */
export function validateMaxPaymentAmountEnv(): void {
  const raw = process.env.MAX_PAYMENT_AMOUNT_USD;
  if (raw === undefined || raw === "") return;
  if (!isValidPositiveDecimal(raw)) {
    throw new Error(
      `Invalid MAX_PAYMENT_AMOUNT_USD="${raw}": must be a positive finite number (e.g. 999999.99).`,
    );
  }
}

const paymentLinkRowSchema = z
  .object({
    id: z.number().int(),
    workspace_owner_id: z.string(),
    amount: z.union([z.string(), z.number()]),
    currency: z.string(),
    provider: z.string(),
    description: z.string().nullable(),
    country: z.string().nullable(),
    status: z.string(),
    provider_link_id: z.string().nullable(),
    provider_checkout_url: z.string().nullable(),
    public_token: z.string(),
    public_url: z.string(),
    created_at: z.union([z.string(), z.date()]),
    paid_at: z.union([z.string(), z.date()]).nullable(),
    created_by_member_id: z.number().int().nullable(),
    creator_first_name: z.string().nullable(),
    creator_image_url: z.string().nullable(),
    order_id: z.string().nullable().optional().default(null),
    order_number: z.string().nullable().optional().default(null),
    order_customer_name: z.string().nullable().optional().default(null),
  })
  .passthrough();

const paymentLinksResponseSchema = z.object({
  payment_links: z.array(paymentLinkRowSchema),
});

function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error(
      { err: parsed.error.issues, route },
      "Response validation failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}

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
  order_id: string | null;
  order_number: string | null;
  order_customer_name: string | null;
};

/**
 * Returns true if the caller is a workspace owner OR has "payment-links" in their allowed pages.
 */
function canAccessPaymentLinks(wreq: ReturnType<typeof workspace>): boolean {
  if (wreq.workspaceRole === "owner") return true;
  return Array.isArray(wreq.allowedPages) && wreq.allowedPages.includes("payment-links");
}

/**
 * The exact `country` value that routes a Stripe payment link to the separate
 * UAE Stripe account. Must match the accepted-country value validated on the
 * create route (see DEFAULT_COUNTRIES in ../lib/defaults).
 */
export const UAE_STRIPE_COUNTRY = "United Arab Emirates";

/** Returns true when the payment link's country should settle on the UAE account. */
export function isUaeStripeCountry(country: string | null | undefined): boolean {
  return country === UAE_STRIPE_COUNTRY;
}

/**
 * Result of resolving the Stripe secret key for a given country.
 * - `client` is a ready Stripe instance when the required key is configured.
 * - `missingKey` names the missing env var when the required key is absent so
 *   the caller can return a clear, specific error (no silent fallback).
 */
type StripeClientResult =
  | { client: Stripe; missingKey: null }
  | { client: null; missingKey: string };

/**
 * Picks the Stripe secret key based on the payment link's country: UAE links
 * use STRIPE_SECRET_KEY_UAE, everything else uses STRIPE_SECRET_KEY. If the
 * required key is missing, returns which env var to set — the UAE account is
 * never silently replaced by the default account.
 */
function getStripeClientForCountry(country: string | null | undefined): StripeClientResult {
  const envKey = isUaeStripeCountry(country) ? "STRIPE_SECRET_KEY_UAE" : "STRIPE_SECRET_KEY";
  const key = process.env[envKey];
  if (!key) return { client: null, missingKey: envKey };
  return { client: new Stripe(key, { apiVersion: "2026-04-22.dahlia" }), missingKey: null };
}

async function getPaypalAccessToken(): Promise<string | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const base = process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { access_token?: string };
  return data.access_token ?? null;
}

function getPaypalBase(): string {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function isMamoNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("ENOTFOUND") ||
    err.message.includes("fetch failed") ||
    err.message.includes("ECONNREFUSED") ||
    err.name === "AbortError"
  );
}

export async function fetchMamoWithRetry(url: string, options: RequestInit): Promise<globalThis.Response> {
  const TIMEOUT_MS = 12_000;
  const RETRY_DELAY_MS = 500;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return resp;
    } catch (err) {
      clearTimeout(timer);
      if (!isMamoNetworkError(err) || attempt === 1) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw new Error("fetchMamoWithRetry: unreachable");
}

/** True for Replit-provided domains (foo.replit.app / foo.replit.dev). */
function isReplitPlatformDomain(domain: string): boolean {
  return /(^|\.)replit\.(app|dev)$/i.test(domain);
}

/**
 * Builds the public customer-facing pay-page URL for a token.
 *
 * Domain resolution order:
 * - In production (REPLIT_DEPLOYMENT set):
 *   1. PAY_LINK_DOMAIN env var (explicit override), if set.
 *   2. The first custom (non-replit.app / non-replit.dev) domain in
 *      REPLIT_DOMAINS — e.g. presentail.com when connected.
 *   3. The first REPLIT_DOMAINS entry (the .replit.app deployment domain).
 *   4. PUBLIC_URL.
 * - In development: REPLIT_DEV_DOMAIN, falling back to PUBLIC_URL.
 */
export function buildPublicPayUrl(token: string): string {
  const isDeployed = Boolean(process.env.REPLIT_DEPLOYMENT);
  if (isDeployed) {
    const override = process.env.PAY_LINK_DOMAIN?.trim();
    if (override) {
      const withScheme = /^https?:\/\//i.test(override) ? override : `https://${override}`;
      return `${withScheme.replace(/\/+$/, "")}/pay/${token}`;
    }
    const domains = (process.env.REPLIT_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const customDomain = domains.find((d) => !isReplitPlatformDomain(d));
    const deployedDomain = customDomain ?? domains[0];
    if (deployedDomain) return `https://${deployedDomain}/pay/${token}`;
    if (process.env.PUBLIC_URL) return `${process.env.PUBLIC_URL}/pay/${token}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/pay/${token}`;
  }
  return `${process.env.PUBLIC_URL ?? ""}/pay/${token}`;
}

/** URL-safe alphabet for short public tokens (base62 — no ambiguity with URL encoding). */
const PUBLIC_TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Length of newly generated short public tokens (~53 bits of entropy at 9 chars). */
export const PUBLIC_TOKEN_LENGTH = 9;

/**
 * Generates a short, URL-safe, cryptographically random public token.
 * Uses rejection sampling over crypto randomBytes to avoid modulo bias.
 */
export function generatePublicToken(): string {
  const chars: string[] = [];
  // 248 = 62 * 4 — reject bytes >= 248 so each accepted byte maps uniformly.
  const limit = PUBLIC_TOKEN_ALPHABET.length * Math.floor(256 / PUBLIC_TOKEN_ALPHABET.length);
  while (chars.length < PUBLIC_TOKEN_LENGTH) {
    const bytes = randomBytes(PUBLIC_TOKEN_LENGTH * 2);
    for (const byte of bytes) {
      if (byte < limit) {
        chars.push(PUBLIC_TOKEN_ALPHABET[byte % PUBLIC_TOKEN_ALPHABET.length]);
        if (chars.length === PUBLIC_TOKEN_LENGTH) break;
      }
    }
  }
  return chars.join("");
}

const MAX_TOKEN_GENERATION_ATTEMPTS = 5;

/**
 * Generates a short public token that does not already exist in payment_links.
 * Collisions are astronomically unlikely (62^9 ≈ 1.3e16 possibilities) but are
 * handled by regenerating; the unique index on public_token is the final guard
 * against a race between the check and the INSERT.
 */
async function generateUniquePublicToken(): Promise<string> {
  for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt++) {
    const token = generatePublicToken();
    const existing = await db.query(
      `SELECT 1 FROM payment_links WHERE public_token = $1 LIMIT 1`,
      [token],
    );
    if ((existing?.rowCount ?? existing?.rows?.length ?? 0) === 0) {
      return token;
    }
  }
  throw new Error("Failed to generate a unique payment link token");
}

/**
 * GET /api/payment-links
 * List all payment links for the workspace. Owner only.
 */
router.get("/payment-links", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    logPageAccessDenial(req, wreq, ["payment-links"]);
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }

  const q = req.query.q ? String(req.query.q).trim() : null;

  // Schema sentinel: reads workspace_members.member_user_id (aliased → creator_clerk_id)
  // via LEFT JOIN on wm.id = pl.created_by_member_id. If that column is renamed,
  // update both this query and the paymentLinks test mocks.
  const queryParams: unknown[] = [wreq.workspaceOwnerId];
  let searchClause = "";
  if (q) {
    queryParams.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`);
    const pIdx = queryParams.length;
    searchClause = ` AND (
      pl.sender_first_name ILIKE $${pIdx} OR
      pl.sender_last_name ILIKE $${pIdx} OR
      (pl.sender_first_name || ' ' || pl.sender_last_name) ILIKE $${pIdx} OR
      pl.sender_email ILIKE $${pIdx} OR
      pl.sender_phone ILIKE $${pIdx} OR
       pl.description ILIKE $${pIdx} OR
       o.display_order_number ILIKE $${pIdx} OR
       c.display_name ILIKE $${pIdx} OR
       c.phone ILIKE $${pIdx}
    )`;
  }

  const result = await db.query<PaymentLinkRow & { created_by_member_id: number | null; creator_clerk_id: string | null }>(
    `SELECT pl.id, pl.workspace_owner_id, pl.amount, pl.currency, pl.provider, pl.description,
            pl.country, pl.status, pl.provider_link_id, pl.provider_checkout_url, pl.public_token,
            pl.created_at, pl.paid_at, pl.created_by_member_id,
            pl.original_amount, pl.original_currency, pl.official_exchange_rate,
            pl.markup_percentage_used, pl.converted_amount_exact, pl.final_amount_charged,
            pl.converted_currency, pl.rounding_rule_used, pl.exchange_rate_fetched_at,
            pl.sender_first_name, pl.sender_last_name, pl.sender_phone_country_code,
            pl.sender_phone, pl.sender_email, pl.sender_submitted_at,
             wm.member_user_id AS creator_clerk_id,
             pl.order_id,
             o.display_order_number AS order_number,
             c.display_name AS order_customer_name
       FROM payment_links pl
       LEFT JOIN workspace_members wm ON wm.id = pl.created_by_member_id
        LEFT JOIN orders o ON o.id = pl.order_id AND o.workspace_owner_id = pl.workspace_owner_id
        LEFT JOIN LATERAL (
          SELECT c.display_name, c.phone
            FROM order_contacts oc
            JOIN contacts c ON c.id = oc.contact_id
           WHERE oc.order_id = o.id AND oc.role = 'customer'
           ORDER BY oc.created_at
           LIMIT 1
        ) c ON true
      WHERE pl.workspace_owner_id = $1${searchClause}
      ORDER BY pl.created_at DESC`,
    queryParams,
  );

  // Self-heal stale "active" Stripe links: verify recent active links with
  // Stripe directly (bounded + best-effort) so paid links show as paid even
  // when the webhook was missed. Rows are newest-first, matching the cap.
  try {
    const flipped = await reconcileActiveStripeLinks(result.rows);
    if (flipped.size > 0) {
      for (const row of result.rows) {
        if (flipped.has(row.id)) {
          row.status = "paid";
          row.paid_at = flipped.get(row.id) ?? new Date().toISOString();
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Payment links list reconciliation failed; serving stored statuses");
  }

  const clerkIds = [...new Set(result.rows.map((r) => r.creator_clerk_id).filter((id): id is string => !!id))];
  const creatorMap = new Map<string, { first_name: string | null; image_url: string | null }>();
  if (clerkIds.length > 0) {
    try {
      const clerkUsers = await clerkClient.users.getUserList({ userId: clerkIds, limit: 100 });
      for (const u of clerkUsers.data) {
        creatorMap.set(u.id, {
          first_name: u.firstName ?? null,
          image_url: (u.hasImage && u.imageUrl) ? u.imageUrl : null,
        });
      }
    } catch { /* non-fatal */ }
  }

  const links = result.rows.map(({ creator_clerk_id, ...r }) => ({
    ...r,
    public_url: buildPublicPayUrl(r.public_token),
    creator_first_name: creator_clerk_id ? (creatorMap.get(creator_clerk_id)?.first_name ?? null) : null,
    creator_image_url: creator_clerk_id ? (creatorMap.get(creator_clerk_id)?.image_url ?? null) : null,
  }));

  sendValidated(
    req,
    res,
    paymentLinksResponseSchema,
    { payment_links: links },
    "GET /payment-links",
  );
});

/**
 * GET /api/payment-links/orders/search
 * Workspace-scoped, ranked order picker used by both payment-link workflows.
 */
router.get("/payment-links/orders/search", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json({ orders: [] });
    return;
  }
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const normalizedPhone = q.replace(/\D/g, "");
  const result = await db.query(
    `SELECT o.id, o.display_order_number, o.totals,
            COALESCE(NULLIF(c.display_name, ''), NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '')) AS customer_name,
            c.phone AS customer_phone,
            CASE
              WHEN o.display_order_number ILIKE $2 THEN 1
              WHEN COALESCE(c.display_name, '') ILIKE $2 THEN 2
              WHEN regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') = $3 AND $3 <> '' THEN 3
              ELSE 4
            END AS rank
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT c.display_name, c.first_name, c.last_name, c.phone
           FROM order_contacts oc
           JOIN contacts c ON c.id = oc.contact_id
          WHERE oc.order_id = o.id AND oc.role = 'customer'
          ORDER BY oc.created_at
          LIMIT 1
       ) c ON true
      WHERE o.workspace_owner_id = $1
        AND (o.display_order_number ILIKE $2
          OR c.display_name ILIKE $2
          OR concat_ws(' ', c.first_name, c.last_name) ILIKE $2
          OR ($3 <> '' AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%'))
      ORDER BY rank, o.created_at DESC
      LIMIT 25`,
    [wreq.workspaceOwnerId, like, normalizedPhone],
  );
  res.json({
    orders: result.rows.map((row) => ({
      id: row.id,
      display_order_number: row.display_order_number,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      totals: row.totals,
    })),
  });
});

/**
 * POST /api/payment-links/:id/order — attach or deliberately move a link.
 */
router.post("/payment-links/:id/order", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }
  const linkId = Number.parseInt(req.params.id, 10);
  const orderId = typeof req.body?.order_id === "string" ? req.body.order_id : "";
  if (!Number.isInteger(linkId) || !orderId) {
    res.status(400).json({ error: "A valid payment link and order are required" });
    return;
  }
  try {
    const result = await linkPaymentLinkToOrder({
      workspaceOwnerId: wreq.workspaceOwnerId,
      linkId,
      orderId,
      actorUserId: wreq.userId ?? null,
      confirmReassignment: req.body?.confirm_reassignment === true,
      confirmMismatch: req.body?.confirm_mismatch === true,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentLinkOrderError) {
      res.status(err.status).json({ error: err.message, ...err.details });
      return;
    }
    req.log.error({ err }, "Failed to link payment link to order");
    res.status(500).json({ error: "Failed to link payment link to order" });
  }
});

/**
 * DELETE /api/payment-links/:id/order — idempotently detach a link.
 */
router.delete("/payment-links/:id/order", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }
  const linkId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(linkId)) {
    res.status(400).json({ error: "Invalid payment link id" });
    return;
  }
  try {
    const result = await unlinkPaymentLinkFromOrder({
      workspaceOwnerId: wreq.workspaceOwnerId,
      linkId,
      actorUserId: wreq.userId ?? null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentLinkOrderError) {
      res.status(err.status).json({ error: err.message, ...err.details });
      return;
    }
    req.log.error({ err }, "Failed to unlink payment link from order");
    res.status(500).json({ error: "Failed to unlink payment link from order" });
  }
});

/**
 * POST /api/payment-links
 * Create a new payment link. Owner only.
 * Body: { amount: number (whole units), currency: string, provider: string, description?: string }
 */
router.post("/payment-links", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }

  const {
    amount: amountRaw,
    currency: currencyRaw,
    provider: providerRaw,
    description: descRaw,
    country: countryRaw,
    original_amount: originalAmountRaw,
    original_currency: originalCurrencyRaw,
    official_exchange_rate: officialExchangeRateRaw,
    markup_percentage_used: markupPctRaw,
    converted_amount_exact: convertedAmountExactRaw,
    final_amount_charged: finalAmountChargedRaw,
    converted_currency: convertedCurrencyRaw,
    rounding_rule_used: roundingRuleUsedRaw,
    exchange_rate_fetched_at: exchangeRateFetchedAtRaw,
  } = req.body ?? {};

  const amountStr = String(amountRaw ?? "");
  if (!/^\d+(\.\d{1,2})?$/.test(amountStr)) {
    if (/^\d+(\.\d{3,})?$/.test(amountStr)) {
      res.status(400).json({ error: "amount must have at most 2 decimal places" });
    } else {
      res.status(400).json({ error: "amount must be a positive number in decimal format (e.g. 10 or 10.99)" });
    }
    return;
  }

  const amountFloat = parseFloat(amountStr);
  if (!amountFloat || amountFloat <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  // Maximum allowed payment amount. Values above this threshold are almost
  // certainly typos (e.g. 100000000 instead of 100) and must be rejected
  // before they reach any payment processor.
  // The cap is read from MAX_PAYMENT_AMOUNT_USD (default 999999.99) so
  // operators can adjust it without a code change or redeploy.
  const maxPaymentAmount = getMaxPaymentAmount();
  if (amountFloat > maxPaymentAmount) {
    res.status(400).json({
      error: `amount must not exceed ${maxPaymentAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} (suspiciously large amounts are blocked for safety)`,
    });
    return;
  }

  const amountCents = Math.round(amountFloat * 100);

  const currency = String(currencyRaw ?? "").toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency as typeof SUPPORTED_CURRENCIES[number])) {
    res.status(400).json({ error: `currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}` });
    return;
  }

  const provider = String(providerRaw ?? "").toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider as typeof SUPPORTED_PROVIDERS[number])) {
    res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}` });
    return;
  }

  if (provider === "stripe" && STRIPE_UNSUPPORTED_CURRENCIES.has(currency)) {
    res.status(422).json({
      error: `${currency} is not supported by Stripe. Please choose a different currency or use PayPal if PayPal supports it.`,
    });
    return;
  }

  if (provider === "paypal" && PAYPAL_UNSUPPORTED_CURRENCIES.has(currency)) {
    const supported = SUPPORTED_CURRENCIES.filter((c) => !PAYPAL_UNSUPPORTED_CURRENCIES.has(c));
    res.status(422).json({
      error: `${currency} is not supported by PayPal. Supported currencies for PayPal are: ${supported.join(", ")}.`,
    });
    return;
  }

  if (provider === "mamo" && MAMO_UNSUPPORTED_CURRENCIES.has(currency)) {
    const supported = SUPPORTED_CURRENCIES.filter((c) => !MAMO_UNSUPPORTED_CURRENCIES.has(c));
    res.status(422).json({
      error: `${currency} is not supported by Mamo. Supported currencies for Mamo are: ${supported.join(", ")}.`,
    });
    return;
  }

  const description = descRaw ? String(descRaw).trim().slice(0, 500) || null : null;
  const country = countryRaw ? String(countryRaw).trim().slice(0, 100) || null : null;
  if (!country) {
    res.status(400).json({ error: "country is required" });
    return;
  }

  if (isExcludedCountry(country)) {
    res.status(400).json({ error: "country is not supported" });
    return;
  }

  const settingsResult = await db.query<{ available_countries: string[] | null }>(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const rawCountries = settingsResult.rows[0]?.available_countries;
  const filteredSavedCountries = (rawCountries ?? []).filter((c) => !isExcludedCountry(c));
  const acceptedCountries = filteredSavedCountries.length > 0 ? filteredSavedCountries : DEFAULT_COUNTRIES;
  if (!acceptedCountries.includes(country)) {
    res.status(400).json({
      error: `country must be one of the accepted values: ${acceptedCountries.join(", ")}`,
    });
    return;
  }

  let publicToken: string;
  try {
    publicToken = await generateUniquePublicToken();
  } catch (err) {
    logger.error({ err }, "Failed to generate a unique payment link token");
    res.status(500).json({ error: "Failed to create payment link. Please try again." });
    return;
  }

  let providerLinkId: string | null = null;
  let checkoutUrl: string | null = null;

  if (provider === "stripe") {
    const { client: stripe, missingKey } = getStripeClientForCountry(country);
    if (!stripe) {
      const message = missingKey === "STRIPE_SECRET_KEY_UAE"
        ? `The UAE Stripe account is not configured. Please add ${missingKey} to your environment secrets to create payment links for United Arab Emirates.`
        : `Stripe is not configured. Please add ${missingKey} to your environment secrets.`;
      res.status(503).json({ error: message });
      return;
    }
    try {
      const successUrl = buildPublicPayUrl(publicToken) + "?paid=1";
      const cancelUrl = buildPublicPayUrl(publicToken);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: currency.toLowerCase(),
              product_data: {
                name: description ?? "Payment",
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          public_token: publicToken,
          workspace_owner_id: wreq.workspaceOwnerId,
        },
      });
      providerLinkId = session.id;
      checkoutUrl = session.url;
    } catch (err) {
      logger.error({ err }, "Stripe session creation failed");
      const stripeMessage = (err instanceof Error) ? err.message : null;
      res.status(502).json({
        error: stripeMessage
          ? `Stripe rejected this request: ${stripeMessage}`
          : "Failed to create Stripe checkout session",
      });
      return;
    }
  } else if (provider === "mamo") {
    const mamoEnabled = process.env.MAMO_ENABLED;
    if (mamoEnabled === "false") {
      req.log.warn({ country, currency }, "Mamo payment link attempted but MAMO_ENABLED=false");
      res.status(503).json({ error: "Mamo is currently disabled. Please enable it in your payment settings." });
      return;
    }
    const mamoApiKey = process.env.MAMO_API_KEY;
    if (!mamoApiKey) {
      res.status(503).json({ error: "Mamo is not configured. Please add MAMO_API_KEY to your environment secrets." });
      return;
    }
    req.log.info({ country, currency }, "Attempting Mamo payment link creation");
    try {
      const returnUrl = buildPublicPayUrl(publicToken) + "?paid=1";
      const cancelUrl = buildPublicPayUrl(publicToken);
      const amountDecimal = (amountCents / 100).toFixed(2);
      const mamoResp = await fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mamoApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: description ?? "Payment",
          description: description ?? undefined,
          amount: parseFloat(amountDecimal),
          currency: currency.toUpperCase(),
          return_url: returnUrl,
          cancel_url: cancelUrl,
          reference_id: publicToken,
        }),
      });
      if (!mamoResp.ok) {
        const errText = await mamoResp.text();
        req.log.error({ errText, status: mamoResp.status, country, currency }, "Mamo payment link creation failed");
        let mamoMessage: string | null = null;
        try {
          const errJson = JSON.parse(errText) as { message?: string; error?: string; errors?: { message?: string }[] };
          mamoMessage = errJson.errors?.[0]?.message ?? errJson.message ?? errJson.error ?? null;
        } catch { /* non-parseable body */ }
        res.status(502).json({
          error: mamoMessage
            ? `Mamo rejected this request: ${mamoMessage}`
            : "Failed to create Mamo payment link",
        });
        return;
      }
      const mamoData = await mamoResp.json() as {
        id?: string;
        data?: { id?: string; url?: string; checkout_url?: string };
        url?: string;
        checkout_url?: string;
      };
      const linkId = mamoData.data?.id ?? mamoData.id ?? null;
      const linkUrl = mamoData.data?.url ?? mamoData.data?.checkout_url ?? mamoData.url ?? mamoData.checkout_url ?? null;
      providerLinkId = linkId ? String(linkId) : null;
      checkoutUrl = linkUrl ? String(linkUrl) : null;
    } catch (err) {
      req.log.error({ err, country, currency }, "Mamo payment link creation failed");
      if (isMamoNetworkError(err)) {
        res.status(503).json({
          error: "The Mamo API is not reachable from this server. Please try again or use Stripe or PayPal instead.",
        });
      } else {
        res.status(502).json({ error: "Failed to create Mamo payment link. Please try again or use a different payment method." });
      }
      return;
    }
  } else if (provider === "paypal") {
    const paypalAccessToken = await getPaypalAccessToken();
    if (!paypalAccessToken) {
      res.status(503).json({ error: "PayPal is not configured. Please add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to your environment secrets." });
      return;
    }
    try {
      const base = getPaypalBase();
      const successUrl = buildPublicPayUrl(publicToken) + "?paid=1";
      const cancelUrl = buildPublicPayUrl(publicToken);
      const amountStr = (amountCents / 100).toFixed(2);
      const orderResp = await fetch(`${base}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paypalAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              amount: {
                currency_code: currency,
                value: amountStr,
              },
              description: description ?? undefined,
              custom_id: publicToken,
            },
          ],
          application_context: {
            return_url: successUrl,
            cancel_url: cancelUrl,
            brand_name: "Presentail OS",
            landing_page: "BILLING",
            user_action: "PAY_NOW",
          },
        }),
      });
      if (!orderResp.ok) {
        const errText = await orderResp.text();
        logger.error({ errText }, "PayPal order creation failed");
        let paypalMessage: string | null = null;
        try {
          const errJson = JSON.parse(errText) as { message?: string; details?: { description?: string }[] };
          paypalMessage = errJson.details?.[0]?.description ?? errJson.message ?? null;
        } catch { /* non-parseable body */ }
        res.status(502).json({
          error: paypalMessage
            ? `PayPal rejected this request: ${paypalMessage}`
            : "Failed to create PayPal order",
        });
        return;
      }
      const order = await orderResp.json() as {
        id: string;
        links?: { rel: string; href: string }[];
      };
      providerLinkId = order.id;
      const approveLink = order.links?.find((l) => l.rel === "approve");
      checkoutUrl = approveLink?.href ?? null;
    } catch (err) {
      logger.error({ err }, "PayPal order creation failed");
      res.status(502).json({ error: "Failed to create PayPal order" });
      return;
    }
  }

  const originalAmount = originalAmountRaw != null ? Number(originalAmountRaw) : null;
  const originalCurrency = originalCurrencyRaw ? String(originalCurrencyRaw).toUpperCase() : null;
  const officialExchangeRate = officialExchangeRateRaw != null ? Number(officialExchangeRateRaw) : null;
  const markupPct = markupPctRaw != null ? Number(markupPctRaw) : null;
  const convertedAmountExact = convertedAmountExactRaw != null ? Number(convertedAmountExactRaw) : null;
  const finalAmountCharged = finalAmountChargedRaw != null ? Number(finalAmountChargedRaw) : null;
  const convertedCurrency = convertedCurrencyRaw ? String(convertedCurrencyRaw).toUpperCase() : null;
  const roundingRuleUsed = roundingRuleUsedRaw ? String(roundingRuleUsedRaw) : null;
  const exchangeRateFetchedAt = exchangeRateFetchedAtRaw ? String(exchangeRateFetchedAtRaw) : null;

  const insertResult = await db.query<PaymentLinkRow>(
    `INSERT INTO payment_links
       (workspace_owner_id, amount, currency, provider, description, country, status,
        provider_link_id, provider_checkout_url, public_token, created_by_member_id,
        original_amount, original_currency, official_exchange_rate, markup_percentage_used,
        converted_amount_exact, final_amount_charged, converted_currency, rounding_rule_used,
        exchange_rate_fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [wreq.workspaceOwnerId, amountCents, currency, provider, description, country,
      providerLinkId, checkoutUrl, publicToken, wreq.memberDbId ?? null,
      originalAmount, originalCurrency, officialExchangeRate, markupPct,
      convertedAmountExact, finalAmountCharged, convertedCurrency, roundingRuleUsed,
      exchangeRateFetchedAt],
  );

  const link = insertResult.rows[0];
  res.status(201).json({
    payment_link: {
      ...link,
      public_url: buildPublicPayUrl(link.public_token),
    },
  });
});

/**
 * GET /api/payment-links/:id
 * Get a single payment link detail. Owner only.
 */
router.get("/payment-links/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid payment link id" });
    return;
  }

  const result = await db.query<PaymentLinkRow>(
    `SELECT * FROM payment_links WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Payment link not found" });
    return;
  }

  const link = result.rows[0];

  // Self-heal a stale "active" Stripe link on detail view (best-effort).
  try {
    const reconciled = await reconcileStripeLink(link);
    if (reconciled.paid) {
      link.status = "paid";
      link.paid_at = reconciled.paidAt ?? new Date().toISOString();
    }
  } catch (err) {
    logger.warn({ err, linkId: link.id }, "Payment link detail reconciliation failed; serving stored status");
  }

  res.json({
    payment_link: {
      ...link,
      public_url: buildPublicPayUrl(link.public_token),
    },
  });
});

/**
 * DELETE /api/payment-links/:id
 * Deactivate (soft-delete) a payment link. Owner only.
 */
router.delete("/payment-links/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canAccessPaymentLinks(wreq)) {
    res.status(403).json({ error: "Access denied: payment-links not in your role permissions" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid payment link id" });
    return;
  }

  const result = await db.query(
    `UPDATE payment_links SET status = 'expired'
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'active'
     RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Payment link not found or already deactivated" });
    return;
  }

  res.json({ ok: true });
});

/**
 * GET /api/payment-methods/status
 * Returns which payment providers are configured and enabled.
 * Requires auth (resolveWorkspace already applied by this router).
 */
router.get("/payment-methods/status", (_req, res) => {
  const stripe = !!process.env.STRIPE_SECRET_KEY;
  const paypal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  const mamoConfigured = !!process.env.MAMO_API_KEY;
  const mamoEnabled = process.env.MAMO_ENABLED !== "false";
  res.json({
    stripe,
    paypal,
    mamo: mamoConfigured,
    mamo_enabled: mamoEnabled,
  });
});

export default router;
