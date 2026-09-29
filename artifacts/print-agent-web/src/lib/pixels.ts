/**
 * Meta Pixel + Google gtag (GA4 + Google Ads) loaders for the PUBLIC pay page.
 *
 * These scripts are injected at runtime only when `initPixels()` is called
 * (from the Pay page mount), so authenticated dashboard routes never load any
 * third-party tracking code.
 *
 * Each pixel is enabled only when its env var is present; missing IDs make the
 * corresponding track calls silent no-ops.
 */

const META_PIXEL_ID = (import.meta.env.VITE_META_PIXEL_ID as string | undefined)?.trim() || "";
const GA4_ID = (import.meta.env.VITE_GTAG_GA4_ID as string | undefined)?.trim() || "";

type GoogleAdsMarket = {
  accountId: string;
  label: string;
};

type GoogleAdsMarkets = Readonly<Record<string, GoogleAdsMarket>>;

function parseGoogleAdsMarkets(raw: string | undefined): GoogleAdsMarkets {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const markets: Record<string, GoogleAdsMarket> = {};
    for (const [rawCountryCode, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const countryCode = rawCountryCode.trim().toUpperCase();
      const { accountId, label } = value as Partial<GoogleAdsMarket>;
      if (
        !/^[A-Z]{2}$/.test(countryCode) ||
        typeof accountId !== "string" ||
        !/^AW-\d+$/.test(accountId.trim()) ||
        typeof label !== "string" ||
        !label.trim()
      ) {
        continue;
      }
      markets[countryCode] = {
        accountId: accountId.trim(),
        label: label.trim(),
      };
    }
    return markets;
  } catch {
    return {};
  }
}

const GOOGLE_ADS_MARKETS = parseGoogleAdsMarkets(
  (import.meta.env.VITE_GOOGLE_ADS_MARKETS as string | undefined),
);

type FbqFn = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  push: FbqFn;
  loaded: boolean;
  version: string;
};

declare global {
  interface Window {
    fbq?: FbqFn;
    _fbq?: FbqFn;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let initialized = false;
const configuredGtagIds = new Set<string>();

function injectScript(src: string): void {
  const s = document.createElement("script");
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

function initMetaPixel(): void {
  if (!META_PIXEL_ID || window.fbq) return;
  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) {
      fbq.callMethod(...args);
    } else {
      fbq.queue.push(args);
    }
  } as FbqFn;
  fbq.queue = [];
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  window.fbq = fbq;
  window._fbq = fbq;
  injectScript("https://connect.facebook.net/en_US/fbevents.js");
  window.fbq("init", META_PIXEL_ID);
}

function initGtag(): void {
  const adsAccountIds = [
    ...new Set(Object.values(GOOGLE_ADS_MARKETS).map(({ accountId }) => accountId)),
  ];
  const primaryId = GA4_ID || adsAccountIds[0];
  if (!primaryId) return;
  if (!window.gtag) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      // gtag requires the Arguments object, not a spread array.
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
    injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primaryId)}`);
    window.gtag("js", new Date());
  }
  if (GA4_ID && !configuredGtagIds.has(GA4_ID)) {
    window.gtag("config", GA4_ID);
    configuredGtagIds.add(GA4_ID);
  }
  for (const accountId of adsAccountIds) {
    if (!configuredGtagIds.has(accountId)) {
      window.gtag("config", accountId);
      configuredGtagIds.add(accountId);
    }
  }
}

/**
 * Injects the pixel scripts (once) and fires the initial page view.
 * Safe to call multiple times; only the first call does anything.
 */
export function initPixels(): void {
  if (initialized) return;
  initialized = true;
  try {
    initMetaPixel();
    initGtag();
    if (window.fbq && META_PIXEL_ID) window.fbq("track", "PageView");
    // GA4 config above already records the initial page_view.
  } catch {
    // Tracking must never break the pay page.
  }
}

/** Fired right before redirecting the customer to the provider checkout. */
export function trackInitiateCheckout(amountCents: number, currency: string): void {
  const value = amountCents / 100;
  try {
    if (window.fbq && META_PIXEL_ID) {
      window.fbq("track", "InitiateCheckout", { value, currency });
    }
    if (window.gtag && GA4_ID) {
      window.gtag("event", "begin_checkout", { value, currency });
    }
  } catch {
    // no-op
  }
}

/**
 * Fired once per payment link when the payment is confirmed paid.
 * De-duplication (per token) is the caller's responsibility.
 */
export function trackPurchase(
  amountCents: number,
  currency: string,
  transactionId: string,
  destinationCountry: string | null | undefined,
): void {
  const value = amountCents / 100;
  try {
    if (window.fbq && META_PIXEL_ID) {
      window.fbq("track", "Purchase", { value, currency });
    }
    if (window.gtag && GA4_ID) {
      window.gtag("event", "purchase", {
        value,
        currency,
        transaction_id: transactionId,
      });
    }
    // Google Ads purchase conversions are uploaded by the payment webhook.
    // Keeping the browser conversion here would double-count because gtag's
    // transaction_id dedupe is not shared with offline order_id dedupe.
    void destinationCountry;
  } catch {
    // no-op
  }
}

/** sessionStorage guard so refreshes/polling never double-fire Purchase. */
const PURCHASE_FIRED_PREFIX = "pl_purchase_fired:";

export function hasFiredPurchase(token: string): boolean {
  try {
    return sessionStorage.getItem(PURCHASE_FIRED_PREFIX + token) === "1";
  } catch {
    return false;
  }
}

export function markPurchaseFired(token: string): void {
  try {
    sessionStorage.setItem(PURCHASE_FIRED_PREFIX + token, "1");
  } catch {
    // sessionStorage unavailable — worst case a duplicate event on refresh.
  }
}
