/**
 * Presentail Storefront — Marketing Attribution Module
 *
 * Captures Google Ads click IDs (gclid/gbraid/wbraid) and UTM parameters on
 * every page load, maintains first-touch and last-touch in localStorage with a
 * 90-day TTL, and exposes a helper that returns the full attribution block
 * ready to attach to a POST /api/orders request.
 *
 * ── Integration (copy these two snippets into your storefront) ───────────────
 *
 * 1. Call once on every page load, e.g. in _app.tsx or a top-level layout:
 *
 *   import { captureAttribution } from './attribution';
 *   // Inside component or useEffect with no deps:
 *   captureAttribution();
 *
 * 2. At order submission, attach the attribution block to the POST /api/orders
 *    request body. The field is omitted entirely for direct traffic:
 *
 *   import { getAttributionPayload } from './attribution';
 *
 *   async function submitOrder(orderData: OrderPayload) {
 *     const attribution = getAttributionPayload({
 *       orderTotal: orderData.payment.totalUsd,
 *       currency: orderData.payment.currencyCode ?? 'USD',
 *     });
 *     const body = {
 *       ...orderData,
 *       ...(attribution ? { marketing_attribution: attribution } : {}),
 *     };
 *     const res = await fetch('/api/orders', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
 *       body: JSON.stringify(body),
 *     });
 *     return res.json();
 *   }
 *
 * ── Design principles ────────────────────────────────────────────────────────
 * - All localStorage reads/writes are wrapped in try/catch — blocked or
 *   unavailable storage never throws and never blocks checkout.
 * - Attribution capture/retrieval failure never blocks order placement.
 * - Direct traffic (no UTM/gclid params) does not write to localStorage and
 *   returns undefined from getAttributionPayload so the field is omitted.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AttributionTouch {
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_id: string | null;
  utm_term: string | null;
  utm_content: string | null;
  referrer: string | null;
  landing_page_url: string | null;
  landing_page_path: string | null;
  captured_at: string;
}

export interface AttributionConversion {
  order_total: number | null;
  currency: string | null;
  converted_at: string;
}

export interface MarketingAttribution {
  /** Top-level channel: "google_ads" when gclid/gbraid/wbraid present, otherwise utm_source value. */
  source: string | null;
  first_touch?: AttributionTouch;
  last_touch?: AttributionTouch;
  conversion?: AttributionConversion;
}

interface GetAttributionOptions {
  orderTotal?: number | null;
  currency?: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const FIRST_TOUCH_KEY = "presentail_attribution_first";
const LAST_TOUCH_KEY = "presentail_attribution_last";
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ── Internal helpers ───────────────────────────────────────────────────────────

function readStorage(key: string): AttributionTouch | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AttributionTouch;
    if (!parsed.captured_at) return null;
    const age = Date.now() - new Date(parsed.captured_at).getTime();
    if (age > TTL_MS) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStorage(key: string, touch: AttributionTouch): void {
  try {
    localStorage.setItem(key, JSON.stringify(touch));
  } catch {
    // localStorage unavailable or full — silently skip
  }
}

/**
 * Derive a top-level channel name from the URL params.
 * - Google Ads click IDs (gclid/gbraid/wbraid) → "google_ads"
 * - utm_source value otherwise (e.g. "instagram", "facebook", "email")
 */
function deriveSource(
  gclid: string | null,
  gbraid: string | null,
  wbraid: string | null,
  utmSource: string | null,
): string | null {
  if (gclid || gbraid || wbraid) return "google_ads";
  return utmSource ?? null;
}

function buildTouch(): AttributionTouch | null {
  try {
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );

    const gclid = params.get("gclid");
    const gbraid = params.get("gbraid");
    const wbraid = params.get("wbraid");
    const utm_source = params.get("utm_source");
    const utm_medium = params.get("utm_medium");
    const utm_campaign = params.get("utm_campaign");
    const utm_id = params.get("utm_id");
    const utm_term = params.get("utm_term");
    const utm_content = params.get("utm_content");

    // A "marketing visit" requires at least one of these signals.
    const isMarketingVisit =
      gclid != null || gbraid != null || wbraid != null || utm_source != null;

    if (!isMarketingVisit) return null;

    return {
      gclid: gclid ?? null,
      gbraid: gbraid ?? null,
      wbraid: wbraid ?? null,
      utm_source: utm_source ?? null,
      utm_medium: utm_medium ?? null,
      utm_campaign: utm_campaign ?? null,
      utm_id: utm_id ?? null,
      utm_term: utm_term ?? null,
      utm_content: utm_content ?? null,
      referrer:
        typeof document !== "undefined" ? document.referrer || null : null,
      landing_page_url:
        typeof window !== "undefined" ? window.location.href : null,
      landing_page_path:
        typeof window !== "undefined" ? window.location.pathname : null,
      captured_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call once on every page load (e.g. in a top-level layout component or _app).
 *
 * - If marketing parameters are present, stores/overwrites `last_touch`.
 * - Only writes `first_touch` if it has never been set (or has expired).
 * - Does nothing for direct traffic (no UTM / gclid signals).
 */
export function captureAttribution(): void {
  try {
    const touch = buildTouch();
    if (!touch) return;

    // Always update last_touch on a marketing visit.
    writeStorage(LAST_TOUCH_KEY, touch);

    // Only write first_touch when it is absent or expired.
    const existingFirst = readStorage(FIRST_TOUCH_KEY);
    if (!existingFirst) {
      writeStorage(FIRST_TOUCH_KEY, touch);
    }
  } catch {
    // Capture must never throw.
  }
}

/**
 * Reads both touch-points from localStorage, validates their TTL, and returns
 * the full `marketing_attribution` object ready for the POST /api/orders body.
 *
 * Returns `undefined` when both touches are missing or expired — callers should
 * omit the field entirely in that case so direct-traffic orders are clean:
 *
 *   const ma = getAttributionPayload({ orderTotal: 49.99, currency: 'USD' });
 *   const body = { ...orderData, ...(ma ? { marketing_attribution: ma } : {}) };
 *
 * The returned object shape matches the API's `MarketingAttribution` schema:
 *   { source, first_touch?, last_touch?, conversion? }
 */
export function getAttributionPayload(
  opts: GetAttributionOptions = {},
): MarketingAttribution | undefined {
  try {
    const firstTouch = readStorage(FIRST_TOUCH_KEY);
    const lastTouch = readStorage(LAST_TOUCH_KEY);

    if (!firstTouch && !lastTouch) return undefined;

    // Derive the top-level source from whichever touch we have.
    const refTouch = firstTouch ?? lastTouch!;
    const source = deriveSource(
      refTouch.gclid,
      refTouch.gbraid,
      refTouch.wbraid,
      refTouch.utm_source,
    );

    const result: MarketingAttribution = { source };

    if (firstTouch) result.first_touch = firstTouch;
    if (lastTouch) result.last_touch = lastTouch;

    result.conversion = {
      order_total: opts.orderTotal ?? null,
      currency: opts.currency ?? null,
      converted_at: new Date().toISOString(),
    };

    return result;
  } catch {
    return undefined;
  }
}

/**
 * Clear all stored attribution data (e.g. after a successful order, if the
 * storefront wants to avoid re-attributing a follow-up order to the same click).
 *
 * Calling this is optional — the 90-day TTL handles expiry automatically.
 */
export function clearAttribution(): void {
  try { localStorage.removeItem(FIRST_TOUCH_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(LAST_TOUCH_KEY); } catch { /* ignore */ }
}
