/**
 * Presentail Storefront — Behavioral Event Tracking Module
 *
 * Pushes behavioral events (product_view, add_to_cart, checkout_step,
 * payment_started, payment_completed, …) to Presentail OS at
 * `POST /api/web-events`, authenticated with the workspace `pk_live_` API key.
 * These events power the Cart & Checkout Analytics dashboard (funnel,
 * abandonment/conversion rates, free-delivery bar impact, checkout drop-off by
 * city/slot, delivery-fee → conversion).
 *
 * ── Integration (copy this file into your storefront) ────────────────────────
 *
 * 1. Configure once at app startup (e.g. _app.tsx / root layout):
 *
 *   import { configureTracking, trackPageView } from './tracking';
 *
 *   configureTracking({
 *     endpoint: 'https://<your-os-domain>/api/web-events',
 *     apiKey: process.env.NEXT_PUBLIC_OS_API_KEY!, // pk_live_…
 *   });
 *
 * 2. Fire events at the relevant user actions:
 *
 *   // On every route change:
 *   trackPageView();
 *
 *   // On the product detail page:
 *   trackProductView({ productRef: product.slug, brand: product.brand,
 *     category: product.category, occasion });
 *
 *   // When an item is added to the cart — `value` must be the CART TOTAL
 *   // after the add (used for the free-delivery-bar + average-cart charts).
 *   // Send it in whatever currency the shopper sees, with `currency` set;
 *   // OS converts to USD using the workspace FX rates.
 *   trackAddToCart({ value: cartTotal, currency: 'AED',
 *     productRef: product.slug, brand: product.brand });
 *
 *   // When the shopper reaches checkout / advances a checkout step.
 *   // Include the destination city, the chosen delivery slot label, and the
 *   // delivery fee (0 for free delivery) whenever they are known — these
 *   // drive the drop-off-by-city, drop-off-by-slot, and delivery-fee →
 *   // conversion charts:
 *   trackCheckoutStep({ step: 'delivery_details', city: 'Beirut',
 *     slot: '10:00 - 13:00', deliveryFee: 0 });
 *
 *   // When the shopper starts paying (redirect to gateway / submits card):
 *   trackPaymentStarted({ city, slot, deliveryFee, value: orderTotal,
 *     currency });
 *
 *   // On payment failure / success (thank-you page):
 *   trackPaymentFailed({ provider: 'stripe' });
 *   trackPaymentCompleted({ value: orderTotal, currency, city, slot,
 *     deliveryFee });
 *
 *   // Optional extras that light up other analytics sections:
 *   trackPromoApplied({ code });      trackPromoFailed({ code });
 *   trackSearch({ query, resultCount });
 *   trackEvent('remove_from_cart', { productRef });
 *
 * ── Design principles ────────────────────────────────────────────────────────
 * - Tracking must NEVER break the storefront: every function is wrapped in
 *   try/catch and network failures are silently dropped.
 * - Events are queued and flushed in small batches (max ~4s latency) to keep
 *   network chatter low; `navigator.sendBeacon` is used on page hide so
 *   end-of-session events (payment_completed on redirect) are not lost.
 * - `session_id` is a per-browser-session id (sessionStorage, 30-min idle
 *   renewal) — the analytics funnel groups events by this. `visitor_id` is a
 *   long-lived id (localStorage) for returning-visitor analysis.
 * - All fields except `type` are optional server-side; send whatever context
 *   you have. Unknown keys are preserved under `properties`.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TrackingConfig {
  /** Absolute URL of the ingest endpoint, e.g. https://os.example.com/api/web-events */
  endpoint: string;
  /** Workspace API key (pk_live_…). Sent as the `x-api-key` header. */
  apiKey: string;
  /** Max queue flush interval in ms. Default 4000. */
  flushIntervalMs?: number;
  /** Disable all tracking (e.g. per cookie-consent). Default false. */
  disabled?: boolean;
}

/** Common optional context accepted by every helper. */
export interface EventContext {
  /** Cart/order total in `currency` (add_to_cart: cart total AFTER the add). */
  value?: number | null;
  /** ISO 4217 code of `value` (e.g. "USD", "AED"). */
  currency?: string | null;
  /** Destination city (drives checkout drop-off by city). */
  city?: string | null;
  country?: string | null;
  productRef?: string | null;
  category?: string | null;
  occasion?: string | null;
  brand?: string | null;
  searchQuery?: string | null;
  resultCount?: number | null;
  /** Chosen delivery slot label (drives drop-off by slot). Sent as properties.slot. */
  slot?: string | null;
  /** Delivery fee shown to the shopper; 0 = free. Sent as properties.deliveryFee. */
  deliveryFee?: number | null;
  /** Any extra keys — merged into the event's `properties`. */
  [key: string]: unknown;
}

interface QueuedEvent {
  type: string;
  sessionId: string | null;
  visitorId: string | null;
  occurredAt: string;
  url: string | null;
  path: string | null;
  referrer: string | null;
  deviceType: string | null;
  language: string | null;
  [key: string]: unknown;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SESSION_KEY = "presentail_session";
const VISITOR_KEY = "presentail_visitor_id";
const SESSION_IDLE_MS = 30 * 60 * 1000; // renew session after 30 min idle
const MAX_QUEUE = 100;
const MAX_BATCH = 50;

// ── Module state ───────────────────────────────────────────────────────────────

let config: TrackingConfig | null = null;
let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

// ── Internal helpers ───────────────────────────────────────────────────────────

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Per-browser-session id with a 30-minute idle renewal, kept in sessionStorage. */
function getSessionId(): string | null {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id: string; lastSeen: number };
      if (parsed.id && now - parsed.lastSeen < SESSION_IDLE_MS) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: parsed.id, lastSeen: now }));
        return parsed.id;
      }
    }
    const id = randomId();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, lastSeen: now }));
    return id;
  } catch {
    return null;
  }
}

/** Long-lived visitor id in localStorage (returning-visitor analysis). */
function getVisitorId(): string | null {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const id = randomId();
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return null;
  }
}

function deviceType(): string | null {
  try {
    const ua = navigator.userAgent;
    if (/Mobi|Android|iPhone/i.test(ua)) return "mobile";
    if (/iPad|Tablet/i.test(ua)) return "tablet";
    return "desktop";
  } catch {
    return null;
  }
}

function scheduleFlush(): void {
  if (flushTimer || !config) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, config.flushIntervalMs ?? 4000);
}

function installLifecycleListeners(): void {
  if (listenersInstalled || typeof document === "undefined") return;
  listenersInstalled = true;
  try {
    // Flush with sendBeacon when the page is hidden/unloaded so events fired
    // right before a payment-gateway redirect are not lost.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush(true);
    });
    window.addEventListener("pagehide", () => flush(true));
  } catch {
    /* tracking must never throw */
  }
}

/**
 * Send queued events. Uses `fetch(..., keepalive)` normally and
 * `navigator.sendBeacon` on page hide. Failures drop the batch silently —
 * analytics loss is always preferable to storefront breakage or retry storms.
 */
function flush(useBeacon = false): void {
  try {
    if (!config || queue.length === 0) return;
    const batch = queue.slice(0, MAX_BATCH);
    queue = queue.slice(batch.length);
    const body = JSON.stringify({ events: batch });

    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      // sendBeacon cannot set headers, so the API key goes in the query string
      // (the ingest route accepts `?apiKey=`).
      const url = `${config.endpoint}${config.endpoint.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(config.apiKey)}`;
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      if (queue.length > 0) flush(true);
      return;
    }

    void fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
      body,
      keepalive: true,
    }).catch(() => {
      /* drop silently */
    });

    if (queue.length > 0) scheduleFlush();
  } catch {
    /* tracking must never throw */
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Call once at app startup before any track* call. */
export function configureTracking(cfg: TrackingConfig): void {
  config = cfg;
  installLifecycleListeners();
}

/**
 * Generic event emitter. Prefer the typed helpers below; use this for extra
 * event types (`remove_from_cart`, `country_selected`, `category_view`, …).
 *
 * Context keys the analytics reads:
 * - `value` + `currency` — cart total on add_to_cart (free-delivery bar, avg cart)
 * - `city` — checkout drop-off by city
 * - `slot` — checkout drop-off by delivery slot (stored as properties.slot)
 * - `deliveryFee` — free-vs-paid delivery conversion (properties.deliveryFee;
 *   only zero vs non-zero matters, any currency)
 * - `brand` — the shared analytics brand filter
 */
export function trackEvent(type: string, ctx: EventContext = {}): void {
  try {
    if (!config || config.disabled) return;

    const { value, currency, city, country, productRef, category, occasion, brand,
      searchQuery, resultCount, slot, deliveryFee, ...extraProps } = ctx;

    const event: QueuedEvent = {
      type,
      sessionId: getSessionId(),
      visitorId: getVisitorId(),
      occurredAt: new Date().toISOString(),
      url: typeof window !== "undefined" ? window.location.href : null,
      path: typeof window !== "undefined" ? window.location.pathname : null,
      referrer: typeof document !== "undefined" ? document.referrer || null : null,
      deviceType: deviceType(),
      language: typeof navigator !== "undefined" ? navigator.language || null : null,
    };

    if (value != null) event.value = value;
    if (currency != null) event.currency = currency;
    if (city != null) event.city = city;
    if (country != null) event.country = country;
    if (productRef != null) event.productRef = productRef;
    if (category != null) event.category = category;
    if (occasion != null) event.occasion = occasion;
    if (brand != null) event.brand = brand;
    if (searchQuery != null) event.searchQuery = searchQuery;
    if (resultCount != null) event.resultCount = resultCount;

    const properties: Record<string, unknown> = { ...extraProps };
    if (slot != null) properties.slot = slot;
    if (deliveryFee != null) properties.deliveryFee = deliveryFee;
    if (Object.keys(properties).length > 0) event.properties = properties;

    queue.push(event);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);

    // Conversion-critical events flush immediately; the rest batch up.
    if (type === "payment_completed" || type === "payment_failed" || type === "payment_started") {
      flush();
    } else {
      scheduleFlush();
    }
  } catch {
    /* tracking must never throw */
  }
}

/** Fire on every route change. */
export function trackPageView(ctx: EventContext = {}): void {
  trackEvent("page_view", ctx);
}

/** Fire on the product detail page. Pass productRef/brand/category/occasion. */
export function trackProductView(ctx: EventContext = {}): void {
  trackEvent("product_view", ctx);
}

/**
 * Fire when an item is added to the cart. `value` MUST be the cart total after
 * the add (in `currency`) — it feeds the free-delivery-bar and average-cart
 * charts.
 */
export function trackAddToCart(ctx: EventContext = {}): void {
  trackEvent("add_to_cart", ctx);
}

/**
 * Fire when the shopper reaches checkout or advances a checkout step. Include
 * `city`, `slot`, and `deliveryFee` (0 for free) as soon as they are known.
 * Pass a `step` label (e.g. 'delivery_details', 'payment') as extra context.
 */
export function trackCheckoutStep(ctx: EventContext = {}): void {
  trackEvent("checkout_step", ctx);
}

/** Fire when the shopper initiates payment (submits card / gateway redirect). */
export function trackPaymentStarted(ctx: EventContext = {}): void {
  trackEvent("payment_started", ctx);
}

/** Fire when payment fails. Include `provider` as extra context if known. */
export function trackPaymentFailed(ctx: EventContext = {}): void {
  trackEvent("payment_failed", ctx);
}

/**
 * Fire on payment success (thank-you page / gateway return). Completes the
 * funnel for the session — include `value` + `currency` (order total) and the
 * same `city`/`slot`/`deliveryFee` context sent during checkout.
 */
export function trackPaymentCompleted(ctx: EventContext = {}): void {
  trackEvent("payment_completed", ctx);
}

/** Fire when a promo code is applied successfully. Pass `{ code }`. */
export function trackPromoApplied(ctx: EventContext = {}): void {
  trackEvent("promo_applied", ctx);
}

/** Fire when a promo code is rejected. Pass `{ code }`. */
export function trackPromoFailed(ctx: EventContext = {}): void {
  trackEvent("promo_failed", ctx);
}

/** Fire on a search. Pass `{ query, resultCount }`. */
export function trackSearch(ctx: EventContext & { query?: string } = {}): void {
  const { query, ...rest } = ctx;
  const type = rest.resultCount === 0 ? "search_no_result" : "search";
  trackEvent(type, { ...rest, searchQuery: rest.searchQuery ?? query ?? null });
}

/** Force-send anything still queued (e.g. right before a hard redirect). */
export function flushTracking(): void {
  flush();
}
