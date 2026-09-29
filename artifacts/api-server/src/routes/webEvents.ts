import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireApiKey, type ApiKeyAuthedRequest } from "../lib/apiKeyAuth";

const router = Router();

/**
 * Single behavioral event pushed from the public website (presentail.com).
 *
 * All fields except `type` are optional so the website can send whatever
 * context it has for a given event. `occurredAt` defaults to the ingest time
 * when omitted. Unrecognized keys the website may add are preserved under
 * `properties` (merged with any explicit `properties` object).
 *
 * Recommended `type` values (free-text, not enforced, so the website is never
 * blocked): page_view, country_selected, city_selected, category_view,
 * occasion_view, product_view, add_to_cart, remove_from_cart, checkout_step,
 * payment_started, payment_failed, payment_completed, promo_applied,
 * promo_failed, search, search_no_result.
 */
const eventSchema = z
  .object({
    type: z.string().min(1).max(100),
    sessionId: z.string().max(200).nullish(),
    visitorId: z.string().max(200).nullish(),
    occurredAt: z.string().datetime().nullish(),
    url: z.string().max(2000).nullish(),
    path: z.string().max(2000).nullish(),
    referrer: z.string().max(2000).nullish(),
    trafficSource: z.string().max(200).nullish(),
    utmSource: z.string().max(200).nullish(),
    utmMedium: z.string().max(200).nullish(),
    utmCampaign: z.string().max(200).nullish(),
    utmTerm: z.string().max(200).nullish(),
    utmContent: z.string().max(200).nullish(),
    deviceType: z.string().max(50).nullish(),
    language: z.string().max(20).nullish(),
    country: z.string().max(100).nullish(),
    city: z.string().max(100).nullish(),
    productRef: z.string().max(200).nullish(),
    category: z.string().max(200).nullish(),
    occasion: z.string().max(200).nullish(),
    brand: z.string().max(200).nullish(),
    searchQuery: z.string().max(500).nullish(),
    resultCount: z.number().int().nullish(),
    value: z.number().nullish(),
    currency: z.string().max(10).nullish(),
    properties: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

const bodySchema = z.union([
  eventSchema,
  z.object({ events: z.array(eventSchema).min(1).max(500) }),
]);

/**
 * POST /api/web-events
 *
 * Ingestion endpoint for website behavioral events. Authenticated with a
 * workspace API key (`pk_live_…`, via `Authorization: Bearer`, `x-api-key`, or
 * `?apiKey=`), mirroring the external order webhook. The website pushes events
 * to OS (push model), so OS never has to poll the website.
 *
 * Accepts either a single event object or `{ events: [...] }` (batched, up to
 * 500). All events are scoped to the API key's workspace owner and inserted
 * into `web_events`. Returns `{ received: <count> }`.
 */
router.post("/web-events", requireApiKey, async (req: ApiKeyAuthedRequest, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const ownerId = req.userId;
  type EventInput = z.infer<typeof eventSchema> & Record<string, unknown>;
  const raw = parsed.data as Record<string, unknown>;
  const events: EventInput[] = (
    Array.isArray(raw.events) ? raw.events : [raw]
  ) as EventInput[];

  // Build a single multi-row INSERT for efficiency.
  const COLS = [
    "workspace_owner_id",
    "event_type",
    "session_id",
    "visitor_id",
    "occurred_at",
    "url",
    "path",
    "referrer",
    "traffic_source",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "device_type",
    "language",
    "country",
    "city",
    "product_ref",
    "category",
    "occasion",
    "brand",
    "search_query",
    "result_count",
    "value",
    "currency",
    "properties",
  ];

  const values: unknown[] = [];
  const rowPlaceholders: string[] = [];

  for (const e of events) {
    // Pull known keys out; everything else the website sent lands in properties.
    const {
      type,
      sessionId,
      visitorId,
      occurredAt,
      url,
      path,
      referrer,
      trafficSource,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      deviceType,
      language,
      country,
      city,
      productRef,
      category,
      occasion,
      brand,
      searchQuery,
      resultCount,
      value,
      currency,
      properties,
      ...rest
    } = e as z.infer<typeof eventSchema> & Record<string, unknown>;

    const mergedProps = { ...(properties ?? {}), ...rest };

    // Search-typed events historically arrive with the term inside the
    // properties payload (e.g. `query`, `search_term`, `q`) instead of the
    // top-level `searchQuery`. Map the first term-like property into the
    // dedicated `search_query` column so analytics reads clean data going
    // forward. The property is kept in `properties` untouched.
    let effectiveSearchQuery = searchQuery ?? null;
    if (!effectiveSearchQuery && /search/i.test(type)) {
      for (const key of ["query", "search_term", "searchTerm", "searchQuery", "search_query", "term", "q"]) {
        const v = mergedProps[key];
        if (typeof v === "string" && v.trim()) {
          effectiveSearchQuery = v.trim().slice(0, 500);
          break;
        }
      }
    }

    const row = [
      ownerId,
      type,
      sessionId ?? null,
      visitorId ?? null,
      occurredAt ?? new Date().toISOString(),
      url ?? null,
      path ?? null,
      referrer ?? null,
      trafficSource ?? null,
      utmSource ?? null,
      utmMedium ?? null,
      utmCampaign ?? null,
      utmTerm ?? null,
      utmContent ?? null,
      deviceType ?? null,
      language ?? null,
      country ?? null,
      city ?? null,
      productRef ?? null,
      category ?? null,
      occasion ?? null,
      brand ?? null,
      effectiveSearchQuery,
      resultCount ?? null,
      value ?? null,
      currency ?? null,
      JSON.stringify(mergedProps),
    ];

    const base = values.length;
    rowPlaceholders.push(`(${row.map((_, i) => `$${base + i + 1}`).join(", ")})`);
    values.push(...row);
  }

  try {
    await db.query(
      `INSERT INTO web_events (${COLS.join(", ")}) VALUES ${rowPlaceholders.join(", ")}`,
      values,
    );
  } catch (err) {
    req.log.error({ err }, "web-events: failed to insert events");
    res.status(500).json({ error: "Failed to record events" });
    return;
  }

  res.status(201).json({ received: events.length });
});

export default router;
