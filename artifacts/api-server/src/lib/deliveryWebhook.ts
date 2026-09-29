import { randomUUID, createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import { logger } from "./logger";
import { isPrivateUrl } from "./urlValidator";
import { publicWebhookFetch } from "./publicWebhookFetch";
import {
  DEFAULT_COUNTRIES,
  isExcludedCountry,
  getCountryMetadata,
  getCountryMetadataByCode,
} from "./defaults";

// ── Helpers ───────────────────────────────────────────────────────────────────

type DeliveryPayloadQueryable = Pick<PoolClient, "query">;

async function getAvailableCountryCodes(
  queryable: DeliveryPayloadQueryable,
  ownerId: string,
): Promise<string[]> {
  const result = await queryable.query<{ available_countries: string[] | null }>(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const raw = result.rows[0]?.available_countries ?? null;
  const source = raw && raw.length > 0 ? raw : DEFAULT_COUNTRIES;
  const filtered = source.filter((c) => !isExcludedCountry(c));
  const codes: string[] = [];
  for (const name of filtered) {
    const m = getCountryMetadata(name);
    if (m) codes.push(m.code.toUpperCase());
  }
  return codes;
}

type DeliveryCity = {
  id: number;
  name: string;
  slug: string;
  sort_order: number;
  is_active: boolean;
  delivery_fee: string;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: string | null;
  express_delivery_cutoff_time: string | null;
  country_code: string;
};

type DeliverySlot = {
  city_id: number;
  id: number;
  day_of_week: number;
  label: string;
  start_time: string;
  end_time: string;
  fee_override: string | null;
  cutoff_time: string | null;
  capacity: number | null;
  sort_order: number;
};

export async function buildDeliveryLocationsPayload(ownerId: string): Promise<{
  countries: unknown[];
  lastModified: Date;
}> {
  return buildDeliveryLocationsPayloadForQuery(db, ownerId);
}

/**
 * Build the same payload against a caller-provided connection. Cleanup and
 * rollback use a transaction client so their before/after comparisons see one
 * consistent database snapshot instead of racing normal application traffic.
 *
 * excludedSlotIds is only used by the reviewed cleanup tool to construct the
 * expected post-removal payload before rows are deleted.
 */
export async function buildDeliveryLocationsPayloadForQuery(
  queryable: DeliveryPayloadQueryable,
  ownerId: string,
  excludedSlotIds: number[] = [],
): Promise<{ countries: unknown[]; lastModified: Date }> {
  const availableCodes = await getAvailableCountryCodes(queryable, ownerId);
  if (availableCodes.length === 0) {
    return { countries: [], lastModified: new Date(0) };
  }

  const settings = await queryable.query<{
    country_code: string;
    delivery_sort_order: number;
    updated_at: string;
  }>(
    `SELECT country_code, delivery_sort_order, updated_at
       FROM delivery_country_settings
      WHERE workspace_owner_id = $1
        AND delivery_active = true
        AND country_code = ANY($2)`,
    [ownerId, availableCodes],
  );
  if (settings.rowCount === 0) {
    return { countries: [], lastModified: new Date(0) };
  }

  const activeCodes = settings.rows.map((r) => r.country_code);
  const sortByCode = new Map<string, number>();
  let latestMs = 0;
  for (const r of settings.rows) {
    sortByCode.set(r.country_code, r.delivery_sort_order);
    const t = new Date(r.updated_at).getTime();
    if (t > latestMs) latestMs = t;
  }

  const flagByCode = new Map<string, string>();
  try {
    const flagOverridesResult = await queryable.query<{ country_code: string; image_url: string }>(
      `SELECT country_code, image_url FROM country_flag_overrides WHERE workspace_owner_id = $1 AND country_code = ANY($2)`,
      [ownerId, activeCodes],
    );
    for (const r of flagOverridesResult.rows) {
      flagByCode.set(r.country_code.toLowerCase(), r.image_url);
    }
  } catch (err) {
    logger.warn({ err }, "country_flag_overrides query failed — returning empty flag map");
  }

  const cities = await queryable.query<DeliveryCity>(
    `SELECT id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled, free_delivery_threshold,
            express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time,
            updated_at
       FROM delivery_cities
      WHERE workspace_owner_id = $1
        AND country_code = ANY($2)
      ORDER BY country_code ASC, sort_order ASC, name ASC`,
    [ownerId, activeCodes],
  );

  const cityUpdatedAt = (cities.rows as Array<DeliveryCity & { updated_at: string }>);
  for (const c of cityUpdatedAt) {
    const t = new Date((c as unknown as { updated_at: string }).updated_at).getTime();
    if (t > latestMs) latestMs = t;
  }

  // ── Delivery slots (optional — degrade gracefully if table unavailable) ────
  const cityIds = cities.rows.map((c) => c.id);
  const slotsByCity = new Map<number, Array<{
    id: number;
    day_of_week: number;
    label: string;
    start_time: string;
    end_time: string;
    fee_override: number | null;
    cutoff_time: string | null;
    capacity: number | null;
    sort_order: number;
  }>>();
  if (cityIds.length > 0) {
    try {
      const slotsResult = await queryable.query<DeliverySlot>(
        `SELECT city_id, id, day_of_week, label, start_time, end_time,
                fee_override, cutoff_time, capacity, sort_order
           FROM district_weekly_delivery_slots
          WHERE workspace_owner_id = $1
            AND city_id = ANY($2)
            AND is_enabled = true
            AND id <> ALL($3::integer[])
          ORDER BY city_id ASC, day_of_week ASC, sort_order ASC, id ASC`,
        [ownerId, cityIds, excludedSlotIds],
      );
      for (const s of slotsResult.rows) {
        const list = slotsByCity.get(s.city_id) ?? [];
        list.push({
          id: s.id,
          day_of_week: s.day_of_week,
          label: s.label,
          start_time: s.start_time,
          end_time: s.end_time,
          fee_override: s.fee_override !== null ? parseFloat(s.fee_override) : null,
          cutoff_time: s.cutoff_time,
          capacity: s.capacity,
          sort_order: s.sort_order,
        });
        slotsByCity.set(s.city_id, list);
      }
    } catch (err) {
      logger.warn({ err }, "district_weekly_delivery_slots query failed in webhook — returning empty slots");
    }
  }

  const grouped = new Map<string, DeliveryCity[]>();
  for (const r of cities.rows) {
    const list = grouped.get(r.country_code) ?? [];
    list.push(r);
    grouped.set(r.country_code, list);
  }

  const countries = activeCodes
    .map((code) => {
      const meta = getCountryMetadataByCode(code);
      const cs = grouped.get(code) ?? [];
      if (cs.length === 0) return null;
      return {
        country_code: code,
        name: meta?.name ?? code,
        flag_emoji: meta?.flagEmoji ?? "",
        flag_image_url: flagByCode.get(code.toLowerCase()) ?? null,
        currency: meta?.currency ?? null,
        delivery_sort_order: sortByCode.get(code) ?? 0,
        cities: cs.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          is_active: c.is_active,
          delivery_fee: parseFloat(c.delivery_fee),
          free_delivery_enabled: c.free_delivery_enabled,
          free_delivery_threshold:
            c.free_delivery_threshold != null ? parseFloat(c.free_delivery_threshold) : null,
          express_delivery_enabled: c.express_delivery_enabled,
          express_delivery_fee:
            c.express_delivery_fee != null ? parseFloat(c.express_delivery_fee) : null,
          express_delivery_cutoff_time: c.express_delivery_cutoff_time ?? null,
          delivery_slots: slotsByCity.get(c.id) ?? [],
        })),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => {
      if (a.delivery_sort_order !== b.delivery_sort_order) {
        return a.delivery_sort_order - b.delivery_sort_order;
      }
      return a.name.localeCompare(b.name);
    });

  return { countries, lastModified: new Date(latestMs) };
}

// ── Retry logic ───────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1000, 3000, 9000];

async function dispatchWithRetry(url: string, body: unknown): Promise<boolean> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const res = await publicWebhookFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      logger.warn(
        { status: res.status, attempt: attempt + 1 },
        "delivery webhook non-2xx, will retry",
      );
    } catch (err) {
      logger.warn({ err, attempt: attempt + 1 }, "delivery webhook fetch error, will retry");
    }
  }
  logger.error({ url }, "delivery webhook failed after 3 attempts");
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Dispatch the delivery config webhook for the given workspace owner.
 * Returns true if at least one attempt succeeded.
 * Safe to call fire-and-forget via `fireDeliveryWebhookAsync`.
 */
export async function fireDeliveryWebhook(
  ownerId: string,
  event: "delivery.config.updated" | "delivery.config.test" = "delivery.config.updated",
): Promise<boolean> {
  const wsResult = await db.query<{ delivery_webhook_url: string | null }>(
    `SELECT delivery_webhook_url FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const url = wsResult.rows[0]?.delivery_webhook_url ?? null;
  if (!url) return false;

  let payload: { countries: unknown[] };
  try {
    const { countries } = await buildDeliveryLocationsPayload(ownerId);
    payload = { countries };
  } catch (err) {
    logger.error({ err }, "delivery webhook: failed to build payload");
    return false;
  }

  const body = {
    event,
    workspace: ownerId,
    timestamp: new Date().toISOString(),
    data: payload,
  };

  return dispatchWithRetry(url, body);
}

/**
 * Fire-and-forget wrapper — call after a successful API response so that
 * webhook delivery never delays the owner's request.
 */
export function fireDeliveryWebhookAsync(ownerId: string): void {
  fireDeliveryWebhook(ownerId).catch((err) => {
    logger.error({ err }, "unexpected error in fireDeliveryWebhook");
  });
}

/**
 * Fire `delivery_config.updated` to all active endpoints subscribed to that
 * event for the given workspace. Payload is the full delivery locations data
 * so the receiver can update its cache without a round-trip.
 * Safe to call fire-and-forget; errors are caught and logged.
 */
export async function fireDeliveryConfigUpdated(ownerId: string): Promise<void> {
  const { fireWebhookEvent } = await import("./catalogWebhook");

  let countries: unknown[];
  try {
    ({ countries } = await buildDeliveryLocationsPayload(ownerId));
  } catch (err) {
    logger.error({ err, ownerId }, "fireDeliveryConfigUpdated: failed to build payload");
    return;
  }

  // Dispatch to workspace-registered webhook endpoints subscribed to the event.
  try {
    await fireWebhookEvent("delivery_config.updated", ownerId, { countries } as Record<string, unknown>);
  } catch (err) {
    logger.error({ err, ownerId }, "fireDeliveryConfigUpdated: registered-endpoint dispatch failed");
  }

  // Dispatch the full snapshot to the fixed Presentail OS webhook destination.
  try {
    await fireOsDeliveryConfigWebhook(countries);
  } catch (err) {
    logger.error({ err, ownerId }, "fireDeliveryConfigUpdated: OS webhook dispatch failed");
  }
}

// ── Presentail OS webhook (fixed destination) ──────────────────────────────────

const OS_WEBHOOK_DEFAULT_URL = "https://new.presentail.com/api/os/webhook";

// Shape of a country object as produced by buildDeliveryLocationsPayload.
type BuiltCountry = {
  country_code: string;
  name: string;
  cities: Array<{
    name: string;
    slug: string;
    is_active: boolean;
    delivery_fee: number;
    free_delivery_enabled: boolean;
    free_delivery_threshold: number | null;
    express_delivery_enabled: boolean;
    express_delivery_fee: number | null;
    express_delivery_cutoff_time: string | null;
    delivery_slots: Array<{
      label: string;
      start_time: string;
      end_time: string;
      fee_override: number | null;
      cutoff_time: string | null;
    }>;
  }>;
};

/** Normalize a stored time string ("HH:MM" or "HH:MM:SS") to "HH:MM". */
function toHHMM(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return t;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** Derive an integer cutoff hour (0–23) from a stored time string, else null. */
function cutoffTimeToHour(t: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2})/.exec(t.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : null;
}

/**
 * Transform the internal delivery-locations payload into the Presentail OS
 * webhook contract. The OS contract is day-agnostic, so per-weekday slots are
 * de-duplicated by their definition (label/start/end/cutoff/fee).
 */
export function buildOsDeliveryConfigCountries(countries: unknown[]): unknown[] {
  const typed = countries as BuiltCountry[];
  return typed.map((c) => ({
    code: c.country_code,
    name: c.name,
    is_active: true,
    cities: c.cities.map((city) => {
      const seen = new Set<string>();
      const slots: Array<{
        label: string;
        start_time: string;
        end_time: string;
        cutoff_hour: number | null;
        extra_fee: number;
      }> = [];
      for (const s of city.delivery_slots) {
        const start_time = toHHMM(s.start_time);
        const end_time = toHHMM(s.end_time);
        const cutoff_hour = cutoffTimeToHour(s.cutoff_time);
        const extra_fee = s.fee_override ?? 0;
        const key = `${s.label}|${start_time}|${end_time}|${cutoff_hour}|${extra_fee}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({ label: s.label, start_time, end_time, cutoff_hour, extra_fee });
      }
      slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
      return {
        slug: city.slug,
        name: city.name,
        is_active: city.is_active,
        delivery_fee: city.delivery_fee,
        express_available: city.express_delivery_enabled,
        express_fee: city.express_delivery_fee ?? 0,
        express_cutoff_hour: cutoffTimeToHour(city.express_delivery_cutoff_time),
        free_delivery_threshold: city.free_delivery_threshold ?? 0,
        free_delivery_enabled: city.free_delivery_enabled,
        delivery_slots: slots,
      };
    }),
  }));
}

/**
 * Fire the `delivery_config.updated` webhook to the fixed Presentail OS
 * destination with the full snapshot of every country and city. Signs the
 * request with PRESENTAIL_OS_WEBHOOK_SECRET using the shared OS mechanism:
 *   signature = sha256=HMAC-SHA256("{delivery-id}.{timestamp}.{raw body}", secret)
 * No-ops (with a warning) when the secret is not configured.
 */
export async function fireOsDeliveryConfigWebhook(countries: unknown[]): Promise<boolean> {
  const secret = process.env.PRESENTAIL_OS_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("fireOsDeliveryConfigWebhook: PRESENTAIL_OS_WEBHOOK_SECRET not set — skipping OS webhook");
    return false;
  }
  const url = process.env.OS_DELIVERY_WEBHOOK_URL || OS_WEBHOOK_DEFAULT_URL;

  // Guard the destination: only ever POST to a public HTTPS address. The
  // default is the fixed Presentail OS endpoint; any override must clear the
  // same private/non-HTTPS check used for workspace webhooks to avoid SSRF.
  if (isPrivateUrl(url)) {
    logger.error({ url }, "fireOsDeliveryConfigWebhook: refusing to POST to non-public/non-HTTPS URL");
    return false;
  }

  const body = {
    event: "delivery_config.updated",
    data: { countries: buildOsDeliveryConfigCountries(countries) },
  };
  const rawBody = JSON.stringify(body);

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    const deliveryId = randomUUID();
    const timestamp = Date.now().toString();
    const signature =
      "sha256=" + createHmac("sha256", secret).update(`${deliveryId}.${timestamp}.${rawBody}`).digest("hex");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-presentail-event": "delivery_config.updated",
          "x-presentail-delivery-id": deliveryId,
          "x-presentail-timestamp": timestamp,
          "x-presentail-signature": signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      logger.warn({ status: res.status, attempt: attempt + 1 }, "OS delivery webhook non-2xx, will retry");
    } catch (err) {
      logger.warn({ err, attempt: attempt + 1 }, "OS delivery webhook fetch error, will retry");
    }
  }
  logger.error({ url }, "OS delivery webhook failed after retries");
  return false;
}
