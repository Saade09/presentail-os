import { db } from "./db";
import { logger } from "./logger";
import { completeFloristAssignmentForOrder } from "./floristOrderCompletion";
import { finalizeAddressCollectionForOrder } from "./addressCollector/service";
import { withOrderDestinationLock } from "./orderDestinationLock";
import type { PoolClient } from "pg";

export type TookanResult = {
  jobId: string;
  taskId: string;
  debugPayload: Record<string, unknown>;
};

export function isTookanEnabled(): boolean {
  if (process.env.TOOKAN_ENABLED === "false") return false;
  return !!process.env.TOOKAN_API_KEY;
}

function getTookanBaseUrl(): string {
  return (process.env.TOOKAN_BASE_URL ?? "https://api.tookanapp.com").replace(/\/+$/, "");
}

/**
 * Format a UTC ISO timestamp to `MM/DD/YYYY HH:mm:ss` in the configured
 * workspace timezone (env TOOKAN_TIMEZONE, default UTC). Tookan requires
 * this exact format. Returns null on invalid input.
 */
export function formatTookanDatetime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = process.env.TOOKAN_TIMEZONE ?? "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const rawHour = get("hour");
    const hour = rawHour === "24" ? "00" : rawHour;
    const minute = get("minute");
    const second = get("second");
    return `${month}/${day}/${year} ${hour}:${minute}:${second}`;
  } catch {
    return null;
  }
}

/**
 * Compute the numeric GMT offset (in minutes) for the configured
 * `TOOKAN_TIMEZONE` (default UTC), using JavaScript's `Date.getTimezoneOffset`
 * convention that Tookan's `create_task` `timezone` field expects: the offset
 * is the difference between UTC and local time, so zones ahead of UTC are
 * NEGATIVE (e.g. Asia/Beirut = GMT+3 → -180; Asia/Kolkata = GMT+5:30 → -330).
 * DST is accounted for by evaluating against the supplied date. Falls back to 0
 * (UTC) on an unrecognized zone.
 */
export function getTookanTimezoneOffsetMinutes(date: Date = new Date()): number {
  const tz = process.env.TOOKAN_TIMEZONE ?? "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hour,
      Number(map.minute),
      Number(map.second),
    );
    const aheadMinutes = Math.round((asUtc - date.getTime()) / 60000);
    // Normalize -0 → 0 (getTimezoneOffset convention: ahead of UTC is negative).
    return aheadMinutes === 0 ? 0 : -aheadMinutes;
  } catch {
    return 0;
  }
}

/**
 * Extract the api_key-stripped Tookan request body that a failed
 * `createTookanDeliveryTask` attached to its thrown error, so callers can
 * persist the exact rejected payload for debugging. Returns null when the error
 * carries no payload (e.g. the missing-API-key guard that throws before the
 * payload is built).
 */
export function extractTookanFailurePayload(err: unknown): Record<string, unknown> | null {
  if (err && typeof err === "object" && "debugPayload" in err) {
    const payload = (err as { debugPayload?: unknown }).debugPayload;
    if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  }
  return null;
}

export type OrderForTookan = {
  id: string;
  display_order_number: string | null;
  external_order_id: string | null;
  delivery_address: Record<string, unknown> | null;
  window_start: string | null;
  window_end: string | null;
  delivery_instructions: string | null;
  card_message: string | null;
  /** Optional pickup stop. When provided, `has_pickup: 1` is sent to Tookan. */
  pickup?: {
    address: string;
    name: string;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
};

export type RecipientForTookan = {
  display_name: string | null;
  phone: string | null;
  email: string | null;
};

export type LineItemForTookan = {
  name: string;
  quantity: number;
};

type DeliverySlotTime = { h: number; m: number };

/**
 * Parse a time token from a delivery slot. The checkout sends both
 * human-readable slots ("11:00 PM - 1:00 AM") and 24-hour slots
 * ("23:00–01:00").
 */
function parseDeliverySlotTime(token: string): DeliverySlotTime | null {
  const m = token.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const meridiem = (m[3] ?? "").toLowerCase();
  if (meridiem === "pm" && h !== 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * Parse the start and end times in a delivery slot. A slot with only a start
 * time has the same three-hour inferred end used by parseDeliveryWindow.
 */
function parseDeliverySlot(
  slot: string,
): { start: DeliverySlotTime; end: DeliverySlotTime } | null {
  const parts = slot
    .split(/\s*(?:-|–|—|\bto\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const start = parseDeliverySlotTime(parts[0] ?? "");
  if (!start) return null;

  const end = parts.length > 1 ? parseDeliverySlotTime(parts[1] ?? "") : null;
  if (end) return { start, end };

  const totalMin = start.h * 60 + start.m + 180;
  return {
    start,
    end: {
      h: Math.floor(totalMin / 60) % 24,
      m: totalMin % 60,
    },
  };
}

/**
 * Whether a delivery slot's end time is on the calendar day after its start.
 * This is used when the storefront represents an overnight slot by assigning
 * it the next calendar date.
 */
export function isOvernightDeliverySlot(slot: string | null | undefined): boolean {
  if (!slot) return false;
  const parsed = parseDeliverySlot(slot);
  if (!parsed) return false;
  const startMinutes = parsed.start.h * 60 + parsed.start.m;
  const endMinutes = parsed.end.h * 60 + parsed.end.m;
  return endMinutes < startMinutes;
}

/**
 * Parse a delivery date string (e.g. "2024-01-15") and optional slot string
 * (e.g. "9am - 12pm" or "09:00-13:00") into ISO timestamps for Tookan's
 * `job_delivery_datetime`. Returns { window_start, window_end }.
 * Both values are null when no date is provided.
 */
export function parseDeliveryWindow(
  date: string | null | undefined,
  slot: string | null | undefined,
): { window_start: string | null; window_end: string | null } {
  if (!date) return { window_start: null, window_end: null };

  // Extract hour/minute from a time token like "9am", "12pm", "09:00", "9:30am"
  function toIso(dateStr: string, h: number, m: number): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dateStr}T${pad(h)}:${pad(m)}:00.000Z`;
  }

  // Default to 9:00 start, 21:00 end when no slot
  let startH = 9;
  let startM = 0;
  let endH = 21;
  let endM = 0;
  let hasSlot = false;
  let endDayOffset = 0;

  if (slot) {
    const parsed = parseDeliverySlot(slot);
    if (parsed) {
      startH = parsed.start.h;
      startM = parsed.start.m;
      hasSlot = true;
      endH = parsed.end.h;
      endM = parsed.end.m;
      endDayOffset =
        parsed.end.h * 60 + parsed.end.m < parsed.start.h * 60 + parsed.start.m ? 1 : 0;
    }
  }

  const window_start = toIso(date, startH, startM);
  const endDate =
    endDayOffset === 0
      ? date
      : (() => {
          const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
          if (!dateMatch) return date;
          const next = new Date(
            Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]) + 1),
          );
          return next.toISOString().slice(0, 10);
        })();
  const window_end = hasSlot || !slot ? toIso(endDate, endH, endM) : null;
  return { window_start, window_end };
}

/**
 * Human-readable error persisted (as `tookan_error`) when task creation is
 * skipped because the order carries neither delivery address text nor usable
 * coordinates. Tookan would otherwise reject the task with the cryptic
 * "HTTP 502: Please select either Pickup or Delivery with your work flow".
 * Keep this string stable — the address-save auto-retry and the dashboard's
 * friendly messaging both match on it.
 */
export const TOOKAN_MISSING_ADDRESS_ERROR =
  "Delivery address missing — add an address and retry";

/**
 * Build the Tookan create_task payload and POST it to the Tookan API.
 * Returns { jobId, taskId, debugPayload } on success. debugPayload is the
 * request body with the api_key stripped — safe to store for debugging.
 * Throws with a descriptive message on any failure.
 */
export async function createTookanDeliveryTask(
  order: OrderForTookan,
  recipient: RecipientForTookan | null,
  lineItems: LineItemForTookan[],
): Promise<TookanResult> {
  const apiKey = process.env.TOOKAN_API_KEY;
  if (!apiKey) throw new Error("TOOKAN_API_KEY is not configured");

  const addr = (order.delivery_address ?? {}) as Record<string, unknown>;

  const deliveryDatetime = formatTookanDatetime(order.window_start);

  const itemsDescription = lineItems.map((i) => `${i.quantity}x ${i.name}`).join(", ");

  const autoAssignment = process.env.TOOKAN_AUTO_ASSIGNMENT === "true" ? 1 : 0;

  // The street line may live under `address` (external ingest) or `address_1`
  // (legacy rows saved via the dashboard order editor). Accept both so a
  // dashboard-edited address isn't invisible to the missing-address check.
  const streetLine =
    (typeof addr.address === "string" && addr.address.trim()) ||
    (typeof addr.address_1 === "string" && addr.address_1.trim()) ||
    "";
  const deliveryAddress = [streetLine, addr.district].filter(Boolean).join(", ") || "";

  const descParts: string[] = [];
  if (itemsDescription) descParts.push(`Items: ${itemsDescription}`);
  if (deliveryAddress) descParts.push(`Address: ${deliveryAddress}`);
  if (order.delivery_instructions) descParts.push(`Instructions: ${order.delivery_instructions}`);

  const customerPhone = String(addr.phone ?? recipient?.phone ?? "").trim();

  // Tookan only geocodes from `customer_address` text when no coordinates are
  // supplied; passing latitude/longitude = 0 (or null) makes it treat the task
  // as having a real location at the equator, so only include them when the
  // order actually carries coordinates.
  const latRaw = addr.lat ?? addr.latitude ?? null;
  const lngRaw = addr.lng ?? addr.longitude ?? null;
  const latNum = latRaw == null || latRaw === "" ? NaN : Number(latRaw);
  const lngNum = lngRaw == null || lngRaw === "" ? NaN : Number(lngRaw);
  const hasCoords =
    Number.isFinite(latNum) && Number.isFinite(lngNum) && (latNum !== 0 || lngNum !== 0);

  // Optional pickup stop (e.g. stock/branch requests with a source location).
  const pickup = order.pickup ?? null;
  const hasPickup = pickup != null ? 1 : 0;
  const pickupAddress = (pickup?.address ?? "").trim();
  const pkLatNum = pickup?.latitude != null ? Number(pickup.latitude) : NaN;
  const pkLngNum = pickup?.longitude != null ? Number(pickup.longitude) : NaN;
  const pickupHasCoords =
    Number.isFinite(pkLatNum) && Number.isFinite(pkLngNum) && (pkLatNum !== 0 || pkLngNum !== 0);

  // Delivery-only tasks with no address text AND no coordinates cannot form a
  // delivery leg — Tookan rejects them with a misleading 502 ("Please select
  // either Pickup or Delivery with your work flow"). Skip the API call and
  // surface an actionable error instead; the order stays retryable once an
  // address is added.
  if (!hasPickup && !deliveryAddress && !hasCoords) {
    logger.info(
      { orderId: order.id },
      "tookan: skipping task creation — order has no delivery address or coordinates",
    );
    throw Object.assign(new Error(TOOKAN_MISSING_ADDRESS_ERROR), {
      code: "MISSING_ADDRESS",
    });
  }

  // Pickup-carrying tasks (stock/branch requests) must have BOTH legs usable —
  // Tookan rejects a task whose pickup or delivery stop has neither address
  // text nor real coordinates with the same misleading 502. Validate each leg
  // up front and throw an actionable, retryable error naming the branch.
  if (hasPickup) {
    if (!pickupAddress && !pickupHasCoords) {
      const name = (pickup?.name ?? "").trim();
      logger.info(
        { orderId: order.id },
        "tookan: skipping task creation — pickup (source branch) has no address or coordinates",
      );
      throw Object.assign(
        new Error(
          `Source branch${name ? ` '${name}'` : ""} has no address — add one in Locations and retry`,
        ),
        { code: "MISSING_ADDRESS" },
      );
    }
    if (!deliveryAddress && !hasCoords) {
      const name = (recipient?.display_name ?? "").trim();
      logger.info(
        { orderId: order.id },
        "tookan: skipping task creation — delivery (destination branch) has no address or coordinates",
      );
      throw Object.assign(
        new Error(
          `Destination branch${name ? ` '${name}'` : ""} has no address — add one in Locations and retry`,
        ),
        { code: "MISSING_ADDRESS" },
      );
    }
  }

  // Tookan rejects has_pickup tasks whose pickup/delivery datetimes are empty
  // ("Incorrect date format. Please use as MM/DD/YYYY mm:ss"). When a pickup
  // stop is present and the order carries no scheduled window, fall back to a
  // near-future timestamp (1 hour out) formatted in the configured timezone —
  // mirroring the non-empty-datetime fallback used in the ingest path.
  let effectiveDeliveryDatetime = deliveryDatetime ?? "";
  if (hasPickup && !effectiveDeliveryDatetime) {
    effectiveDeliveryDatetime =
      formatTookanDatetime(new Date(Date.now() + 60 * 60 * 1000).toISOString()) ?? "";
  }

  const debugPayload: Record<string, unknown> = {
    order_id: order.display_order_number ?? order.external_order_id ?? order.id,
    customer_username: recipient?.display_name ?? "",
    customer_phone: customerPhone,
    customer_email: recipient?.email ?? "",
    customer_address: deliveryAddress,
    job_delivery_datetime: effectiveDeliveryDatetime,
    timezone: getTookanTimezoneOffsetMinutes(),
    auto_assignment: autoAssignment,
    job_description: descParts.join("\n"),
    has_pickup: hasPickup,
    has_delivery: 1,
    layout_type: 0,
  };

  if (hasCoords) {
    debugPayload.latitude = latNum;
    debugPayload.longitude = lngNum;
  }

  if (pickup != null) {
    // Tookan's create_task API expects job_pickup_* field names for the pickup
    // stop; the bare pickup_* names are silently ignored, which made Tookan see
    // an empty job_pickup_datetime and reject every has_pickup task.
    debugPayload.job_pickup_address = pickup.address;
    debugPayload.job_pickup_name = pickup.name;
    debugPayload.job_pickup_phone = customerPhone;
    debugPayload.job_pickup_datetime = effectiveDeliveryDatetime;
    if (pickupHasCoords) {
      debugPayload.job_pickup_latitude = pkLatNum;
      debugPayload.job_pickup_longitude = pkLngNum;
    }
  }

  const fullPayload = { api_key: apiKey, ...debugPayload };

  const baseUrl = getTookanBaseUrl();
  logger.info({ orderId: order.id }, "tookan: attempting task creation");

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v2/create_task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fullPayload),
    });
  } catch (fetchErr) {
    throw Object.assign(
      new Error(
        `Tookan network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
      ),
      { debugPayload },
    );
  }

  let json: {
    status?: number;
    message?: string;
    data?: { job_id?: number | string; task_id?: number | string };
  };
  try {
    json = (await resp.json()) as typeof json;
  } catch {
    throw Object.assign(
      new Error(`Tookan API returned non-JSON response (HTTP ${resp.status})`),
      { debugPayload },
    );
  }

  if (!resp.ok || (json.status !== undefined && json.status !== 200)) {
    throw Object.assign(
      new Error(json.message ?? `Tookan API error: HTTP ${resp.status}`),
      { debugPayload },
    );
  }

  const jobId = String(json.data?.job_id ?? "");
  const taskId = String(json.data?.task_id ?? "");

  if (!jobId) throw Object.assign(new Error("Tookan returned no job_id"), { debugPayload });

  logger.info({ orderId: order.id, jobId, taskId }, "tookan: task created successfully");

  return { jobId, taskId, debugPayload };
}

/**
 * Re-assign an existing Tookan job to a specific fleet agent via the
 * `re_assign_agent` endpoint. Used by the quick-assign dropdown on the Orders
 * list. Throws with a descriptive message on any failure.
 */
export async function assignTookanAgent(jobId: string, agentId: number): Promise<void> {
  const apiKey = process.env.TOOKAN_API_KEY;
  if (!apiKey) throw new Error("TOOKAN_API_KEY is not configured");

  const fullPayload = {
    api_key: apiKey,
    job_id: Number(jobId),
    fleet_id: agentId,
  };

  const baseUrl = getTookanBaseUrl();
  logger.info({ jobId, agentId }, "tookan: attempting agent assignment (re_assign_agent)");

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v2/re_assign_agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fullPayload),
    });
  } catch (fetchErr) {
    throw new Error(
      `Tookan network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
    );
  }

  let json: { status?: number; message?: string };
  try {
    json = (await resp.json()) as typeof json;
  } catch {
    throw new Error(`Tookan API returned non-JSON response (HTTP ${resp.status})`);
  }

  if (!resp.ok || (json.status !== undefined && json.status !== 200)) {
    throw new Error(json.message ?? `Tookan API error: HTTP ${resp.status}`);
  }

  logger.info({ jobId, agentId }, "tookan: agent assigned successfully");
}

/** Optional address fields that can be pushed alongside (or instead of) a rescheduled datetime. */
export type EditTookanAddressOpts = {
  address?: string;
  latitude?: number;
  longitude?: number;
  /** Public, auth-free image URLs shown to the driver as task references. */
  referenceImages?: string[];
};

type DestinationAddress = Record<string, unknown> | null | undefined;

function nonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/**
 * Convert the address shapes accepted by OS into the fields understood by
 * Tookan. Legacy dashboard rows use address_1 and lat/lng while newer rows use
 * address and latitude/longitude. A partial or invalid coordinate pair is
 * omitted rather than sending a misleading location to the provider.
 */
export function buildTookanAddressUpdate(
  address: DestinationAddress,
): EditTookanAddressOpts | null {
  if (!address) return null;
  const street = nonEmptyText(address.address, address.address_1);
  const district = nonEmptyText(address.district);
  const text = [street, district].filter(Boolean).join(", ");
  const latitude =
    finiteCoordinate(address.latitude, -90, 90)
    ?? finiteCoordinate(address.lat, -90, 90);
  const longitude =
    finiteCoordinate(address.longitude, -180, 180)
    ?? finiteCoordinate(address.lng, -180, 180);
  const hasCoordinatePair =
    latitude !== null
    && longitude !== null
    && (latitude !== 0 || longitude !== 0);

  if (!text && !hasCoordinatePair) return null;
  return {
    ...(text ? { address: text } : {}),
    ...(hasCoordinatePair ? { latitude, longitude } : {}),
  };
}

/**
 * Compare destinations by the actual payload that would be sent to Tookan.
 * This treats address/ address_1 and coordinate aliases as equivalent and
 * prevents idempotent OS upserts from producing duplicate provider edits.
 */
export function tookanDestinationsEqual(
  left: DestinationAddress,
  right: DestinationAddress,
): boolean {
  return JSON.stringify(buildTookanAddressUpdate(left))
    === JSON.stringify(buildTookanAddressUpdate(right));
}

type TookanDestinationOrder = {
  tookan_job_id: string | null;
  window_start: string | null;
  delivery_address: DestinationAddress;
};

/**
 * Reload the workspace-scoped canonical order destination while the caller
 * holds the destination lock, then update only an existing Tookan task.
 */
export async function syncTookanDestinationWithClient(
  client: Pick<PoolClient, "query">,
  orderId: string,
  workspaceOwnerId: string,
): Promise<"updated" | "skipped"> {
  const result = await client.query<TookanDestinationOrder>(
    `SELECT tookan_job_id, window_start, delivery_address
       FROM orders
      WHERE id = $1 AND workspace_owner_id = $2
      LIMIT 1`,
    [orderId, workspaceOwnerId],
  );
  const order = result.rows[0];
  if (!order) {
    logger.warn({ orderId, workspaceOwnerId }, "tookan: destination sync skipped; order not found");
    return "skipped";
  }
  if (!order.tookan_job_id) {
    logger.info({ orderId }, "tookan: destination sync skipped; order has no existing task");
    return "skipped";
  }

  const address = buildTookanAddressUpdate(order.delivery_address);
  if (!address) {
    logger.warn(
      { orderId, tookanJobId: order.tookan_job_id, deliveryAddress: order.delivery_address },
      "tookan: destination sync skipped; address has no usable text or coordinates",
    );
    return "skipped";
  }

  await editTookanDeliveryTask(order.tookan_job_id, order.window_start, address);
  return "updated";
}

/**
 * Best-effort OS-to-Tookan destination synchronization. The lock is held
 * across the canonical reload and provider call so a newer address cannot be
 * overtaken by an older edit. Callers intentionally catch failures so the OS
 * address write remains authoritative.
 */
export async function syncTookanDestinationForOrder(
  orderId: string,
  workspaceOwnerId: string,
): Promise<"updated" | "skipped" | "disabled"> {
  if (!isTookanEnabled()) return "disabled";
  return withOrderDestinationLock(orderId, (client) =>
    syncTookanDestinationWithClient(client, orderId, workspaceOwnerId));
}

/**
 * Push an updated delivery datetime and/or delivery address to an existing
 * Tookan task via the `edit_task` endpoint.
 *
 * - Window-only (existing path): supply `windowStart`; `addressOpts` omitted.
 *   Throws when `windowStart` is null/invalid.
 * - Address-bearing path: supply `addressOpts`; `windowStart` may be null and
 *   is omitted from the payload when it cannot be formatted.
 * - Combined: both may be supplied together.
 *
 * Best-effort by contract: callers should catch and log failures so the
 * OS-side save is never blocked. Throws with a descriptive message on any
 * failure.
 */
export async function editTookanDeliveryTask(
  jobId: string,
  windowStart: string | null,
  addressOpts?: EditTookanAddressOpts,
): Promise<void> {
  const apiKey = process.env.TOOKAN_API_KEY;
  if (!apiKey) throw new Error("TOOKAN_API_KEY is not configured");

  const deliveryDatetime = formatTookanDatetime(windowStart);

  // When no address override is supplied this is a pure reschedule call —
  // a valid datetime is required (existing behaviour).
  if (!deliveryDatetime && !addressOpts) {
    throw new Error("Cannot reschedule Tookan task: invalid or missing window_start");
  }

  const payload: Record<string, unknown> = {
    api_key: apiKey,
    job_id: jobId,
  };

  if (deliveryDatetime) {
    payload.job_delivery_datetime = deliveryDatetime;
  }

  if (addressOpts) {
    if (addressOpts.address !== undefined) {
      payload.customer_address = addressOpts.address;
    }
    if (addressOpts.latitude !== undefined) {
      payload.latitude = addressOpts.latitude;
    }
    if (addressOpts.longitude !== undefined) {
      payload.longitude = addressOpts.longitude;
    }
    if (addressOpts.referenceImages !== undefined) {
      payload.ref_images = addressOpts.referenceImages;
    }
  }

  const baseUrl = getTookanBaseUrl();
  logger.info(
    { jobId, hasAddress: !!addressOpts, hasReferenceImages: addressOpts?.referenceImages !== undefined },
    "tookan: attempting task update (edit_task)",
  );

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v2/edit_task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (fetchErr) {
    throw new Error(
      `Tookan network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
    );
  }

  let json: { status?: number; message?: string };
  try {
    json = (await resp.json()) as typeof json;
  } catch {
    throw new Error(`Tookan API returned non-JSON response (HTTP ${resp.status})`);
  }

  if (!resp.ok || (json.status !== undefined && json.status !== 200)) {
    throw new Error(json.message ?? `Tookan API error: HTTP ${resp.status}`);
  }

  logger.info({ jobId, deliveryDatetime, hasAddress: !!addressOpts }, "tookan: task updated successfully");
}

export type TookanJobStatusInfo = {
  jobId: string;
  jobStatus: number;
  /** ISO completion timestamp reported by Tookan, when present/parseable. */
  completedAt: string | null;
};

/**
 * Extract a completion timestamp from a Tookan payload (webhook body or a
 * `get_job_details` row). Tookan reports completion under several field names
 * (`completed_datetime_gmt`, `completed_datetime`, `completed_date_time`) in
 * either ISO or `YYYY-MM-DD HH:mm:ss` form. GMT-suffixed fields (and bare
 * `YYYY-MM-DD HH:mm:ss` strings, which Tookan sends in GMT for the `_gmt`
 * variant only) are interpreted as UTC; ISO strings carry their own offset.
 * Returns an ISO string or null when nothing parseable is present — callers
 * fall back to the sync time.
 */
export function parseTookanCompletionDatetime(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) return null;
  const candidates: Array<{ key: string; assumeUtc: boolean }> = [
    { key: "completed_datetime_gmt", assumeUtc: true },
    { key: "completed_datetime", assumeUtc: false },
    { key: "completed_date_time", assumeUtc: false },
    { key: "completedDatetime", assumeUtc: false },
  ];
  for (const { key, assumeUtc } of candidates) {
    const raw = payload[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const s = raw.trim();
    // `YYYY-MM-DD HH:mm:ss` (no zone info): trust only the GMT variant.
    const plain = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
    if (plain) {
      if (!assumeUtc) continue; // zone-ambiguous local time — skip
      const d = new Date(`${plain[1]}T${plain[2]}Z`);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
      continue;
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * Fetch the current job_status for a batch of Tookan jobs via the
 * `get_job_details` endpoint. Used by the status poll job as a safety net for
 * status transitions Tookan never sends a webhook for (notably manual agent
 * assignment — Tookan's Delivery Notifications have no "Agent Assigned"
 * webhook event). Returns only jobs Tookan reported with a numeric job_status;
 * throws on network/API errors so the caller can log and retry next tick.
 */
export async function getTookanJobStatuses(
  jobIds: string[],
): Promise<TookanJobStatusInfo[]> {
  const apiKey = process.env.TOOKAN_API_KEY;
  if (!apiKey) throw new Error("TOOKAN_API_KEY is not configured");

  const numericIds = jobIds
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) return [];

  const baseUrl = getTookanBaseUrl();

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v2/get_job_details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        job_ids: numericIds,
        include_task_history: 0,
      }),
    });
  } catch (fetchErr) {
    throw new Error(
      `Tookan network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
    );
  }

  let json: {
    status?: number;
    message?: string;
    data?: Array<
      { job_id?: number | string; job_status?: number | string } & Record<string, unknown>
    >;
  };
  try {
    json = (await resp.json()) as typeof json;
  } catch {
    throw new Error(`Tookan API returned non-JSON response (HTTP ${resp.status})`);
  }

  if (!resp.ok || (json.status !== undefined && json.status !== 200)) {
    throw new Error(json.message ?? `Tookan API error: HTTP ${resp.status}`);
  }

  const rows = Array.isArray(json.data) ? json.data : [];
  const out: TookanJobStatusInfo[] = [];
  for (const row of rows) {
    const jobId = row.job_id === null || row.job_id === undefined ? "" : String(row.job_id);
    const jobStatus = Number(row.job_status);
    if (!jobId || Number.isNaN(jobStatus)) continue;
    out.push({ jobId, jobStatus, completedAt: parseTookanCompletionDatetime(row) });
  }
  return out;
}

/**
 * Tookan job_status codes → human-readable labels stored in orders.tookan_status.
 * Reference: Tookan task webhook `job_status` field.
 */
const TOOKAN_STATUS_LABELS: Record<number, string> = {
  0: "assigned",
  1: "started",
  2: "successful",
  3: "failed",
  4: "in_progress",
  6: "unassigned",
  7: "accepted",
  8: "declined",
  9: "cancelled",
  10: "deleted",
};

/** Tookan job_status value that means the delivery completed successfully. */
export const TOOKAN_STATUS_SUCCESSFUL = 2;

/** Tookan job_status value that means a driver has been assigned to the job. */
export const TOOKAN_STATUS_ASSIGNED = 0;

/**
 * The family of Tookan job_status codes that all mean "a driver is now handling
 * this delivery" and should move the OS order to `out_for_delivery`. Tookan does
 * not emit a single clean code on assignment: depending on how the manager
 * assigns (or the driver picks up) the job it may report `assigned` (0),
 * `started` (1), `in_progress` (4), or `accepted` (7). Treating the whole family
 * as `out_for_delivery` makes assignment reliably flip the order regardless of
 * which code Tookan chooses.
 */
export const TOOKAN_OUT_FOR_DELIVERY_STATUSES = new Set<number>([
  0, // assigned
  1, // started
  4, // in_progress
  7, // accepted
]);

/** Map a numeric Tookan job_status to a stable label (falls back to `status_<n>`). */
export function tookanStatusLabel(jobStatus: number): string {
  return TOOKAN_STATUS_LABELS[jobStatus] ?? `status_${jobStatus}`;
}

export type TookanSyncResult = {
  /** True when an order with this tookan_job_id exists. */
  matched: boolean;
  /**
   * The new OS order status applied by this call, or null when only the
   * tookan_status label was recorded with no order-status transition.
   */
  newStatus: string | null;
  /** The order status before this call (null when no order matched). */
  previousStatus: string | null;
  orderId: string | null;
  externalOrderId: string | null;
  workspaceOwnerId: string | null;
};

/** Order statuses we will NOT override when a Tookan update arrives. */
const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled", "refunded"]);

/**
 * Map a Tookan job_status to the OS order status it should drive the order to,
 * or null when the status has no mapping. The "driver is handling this delivery"
 * family (assigned, started, in_progress, accepted) maps to `out_for_delivery`
 * and `successful` maps to `completed`; every other Tookan status just updates
 * the stored label.
 */
function mapTookanStatusToOrderStatus(jobStatus: number): string | null {
  if (jobStatus === TOOKAN_STATUS_SUCCESSFUL) return "completed";
  if (TOOKAN_OUT_FOR_DELIVERY_STATUSES.has(jobStatus)) return "out_for_delivery";
  return null;
}

/**
 * Sync a Tookan task status update back onto the matching OS order (looked up
 * by tookan_job_id). Always records the latest Tookan status label on the
 * order. When the Tookan status is in the assignment family (assigned,
 * started, in_progress, accepted) the order is moved to `out_for_delivery`,
 * and when it is "Successful" (code 2) the order is marked `completed` — in
 * both cases only when the order is not already in a terminal state.
 *
 * Returns metadata so the webhook route can fire downstream side effects only
 * when an actual status change happened. Never throws on a missing order.
 */
export async function syncTookanOrderStatus(
  jobId: string,
  jobStatus: number,
  deliveredAtIso?: string | null,
): Promise<TookanSyncResult> {
  const label = tookanStatusLabel(jobStatus);

  // When the job reached "successful", record the actual delivered timestamp:
  // prefer Tookan's reported completion datetime, else the sync time. The
  // UPDATE uses COALESCE(tookan_delivered_at, $ts) so a repeat webhook/poll
  // never overwrites an already-recorded value.
  let deliveredAt: string | null = null;
  if (jobStatus === TOOKAN_STATUS_SUCCESSFUL) {
    const parsed = deliveredAtIso ? new Date(deliveredAtIso) : null;
    deliveredAt =
      parsed && !Number.isNaN(parsed.getTime())
        ? parsed.toISOString()
        : new Date().toISOString();
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query<{
      id: string;
      status: string;
      workspace_owner_id: string;
      external_order_id: string | null;
    }>(
      `SELECT id, status, workspace_owner_id, external_order_id
         FROM orders
        WHERE tookan_job_id = $1
        ORDER BY id
        LIMIT 2
        FOR UPDATE`,
      [jobId],
    );
    if (orderRes.rows.length > 1) {
      throw new Error(`Multiple orders share Tookan job id ${jobId}; refusing ambiguous sync`);
    }
    const order = orderRes.rows[0];
    if (!order) {
      await client.query("COMMIT");
      return {
        matched: false,
        newStatus: null,
        previousStatus: null,
        orderId: null,
        externalOrderId: null,
        workspaceOwnerId: null,
      };
    }

    const mappedStatus = mapTookanStatusToOrderStatus(jobStatus);
    const nextStatus =
      mappedStatus && !TERMINAL_ORDER_STATUSES.has(order.status) && order.status !== mappedStatus
        ? mappedStatus
        : null;

    if (nextStatus) {
      await client.query(
        `UPDATE orders
            SET status = $1,
                tookan_status = $2,
                tookan_delivered_at = COALESCE(tookan_delivered_at, $3),
                updated_at = now()
          WHERE id = $4 AND workspace_owner_id = $5`,
        [nextStatus, label, deliveredAt, order.id, order.workspace_owner_id],
      );
      logger.info(
        { orderId: order.id, jobId, newStatus: nextStatus },
        "tookan: order status updated via webhook",
      );
    } else {
      await client.query(
        `UPDATE orders
            SET tookan_status = $1,
                tookan_delivered_at = COALESCE(tookan_delivered_at, $2),
                updated_at = now()
          WHERE id = $3 AND workspace_owner_id = $4`,
        [label, deliveredAt, order.id, order.workspace_owner_id],
      );
    }

    // A Successful Tookan update can complete an order without going through
    // the dashboard transition route. Keep both writes in one transaction for
    // the first completion and repeated Successful updates.
    if (jobStatus === TOOKAN_STATUS_SUCCESSFUL) {
      await completeFloristAssignmentForOrder(
        client,
        order.id,
        order.workspace_owner_id,
      );
      await finalizeAddressCollectionForOrder(client, {
        orderId: order.id,
        workspaceOwnerId: order.workspace_owner_id,
        outcome: "order_delivered",
        reason: "Delivery confirmed by Tookan",
        source: "tookan",
      });
    }

    await client.query("COMMIT");
    return {
      matched: true,
      newStatus: nextStatus,
      previousStatus: order.status,
      orderId: order.id,
      externalOrderId: order.external_order_id,
      workspaceOwnerId: order.workspace_owner_id,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Load the order (+ recipient contact + line items), guard against duplicates,
 * call createTookanDeliveryTask, and persist the result. Throws:
 * - { code: "NOT_FOUND" } if the order doesn't belong to the workspace
 * - { code: "ALREADY_CREATED" } if tookan_job_id is already set
 * - Any other error from createTookanDeliveryTask (after persisting the failure)
 */
export async function retryTookanDeliveryTask(
  orderId: string,
  workspaceOwnerId: string,
  options: { requireMissingAddressFailure?: boolean } = {},
): Promise<void> {
  const orderRes = await db.query<{
    id: string;
    display_order_number: string | null;
    external_order_id: string | null;
    delivery_address: Record<string, unknown> | null;
    window_start: string | null;
    window_end: string | null;
    delivery_instructions: string | null;
    card_message: string | null;
    tookan_job_id: string | null;
    tookan_status: string | null;
    tookan_error: string | null;
    status: string;
  }>(
    `SELECT id, display_order_number, external_order_id, delivery_address, window_start, window_end,
            delivery_instructions, card_message, tookan_job_id, tookan_status, tookan_error, status
       FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [orderId, workspaceOwnerId],
  );
  const order = orderRes.rows[0];
  if (!order) throw Object.assign(new Error("Order not found"), { code: "NOT_FOUND" });

  if (order.tookan_job_id) {
    throw Object.assign(new Error("Tookan task already created"), { code: "ALREADY_CREATED" });
  }
  if (options.requireMissingAddressFailure) {
    const status = order.status.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (
      order.tookan_status !== "failed"
      || order.tookan_error !== TOOKAN_MISSING_ADDRESS_ERROR
      || ["out_for_delivery", "completed", "cancelled", "refunded"].includes(status)
    ) {
      return;
    }
  }

  const recipientRes = await db.query<{
    display_name: string | null;
    phone: string | null;
    email: string | null;
  }>(
    `SELECT c.display_name, c.phone, c.email
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
      WHERE oc.order_id = $1 AND oc.role = 'recipient'
      LIMIT 1`,
    [orderId],
  );
  const recipient = recipientRes.rows[0] ?? null;

  const lineItemsRes = await db.query<{ name: string; quantity: number }>(
    `SELECT name, quantity FROM order_line_items WHERE order_id = $1 ORDER BY id`,
    [orderId],
  );
  const lineItems = lineItemsRes.rows;

  // Affected orders store the delivery date/slot in delivery_address JSON but
  // never wrote window_start/window_end at ingest. Derive the window from the
  // stored date/slot when the dedicated columns are empty so the retry path
  // sends a non-empty job_delivery_datetime (mirrors the ingest path). Never
  // block the retry on a missing date — Tookan still accepts a task without a
  // scheduled time.
  let windowStart = order.window_start;
  let windowEnd = order.window_end;
  if (!windowStart) {
    const addr = (order.delivery_address ?? {}) as Record<string, unknown>;
    const dateVal = typeof addr.date === "string" ? addr.date : null;
    const slotVal = typeof addr.slot === "string" ? addr.slot : null;
    const derived = parseDeliveryWindow(dateVal, slotVal);
    windowStart = derived.window_start;
    windowEnd = derived.window_end;
  }

  const tookanOrder: OrderForTookan = {
    id: order.id,
    display_order_number: order.display_order_number,
    external_order_id: order.external_order_id,
    delivery_address: order.delivery_address,
    window_start: windowStart,
    window_end: windowEnd,
    delivery_instructions: order.delivery_instructions,
    card_message: order.card_message,
  };

  logger.info({ orderId }, "tookan: retry attempt started");

  try {
    const result = await createTookanDeliveryTask(tookanOrder, recipient, lineItems);
    await db.query(
      `UPDATE orders
          SET tookan_job_id    = $1,
              tookan_task_id   = $2,
              tookan_status    = 'created',
              tookan_created_at = now(),
              tookan_error     = NULL,
              tookan_payload   = $3::jsonb,
              updated_at       = now()
        WHERE id = $4`,
      [result.jobId, result.taskId, JSON.stringify(result.debugPayload), orderId],
    );
    logger.info({ orderId, jobId: result.jobId }, "tookan: retry succeeded");
    void import("./floristTookanPhotoSync")
      .then(({ syncApprovedFloristPhotoForOrderToTookan }) =>
        syncApprovedFloristPhotoForOrderToTookan(orderId, workspaceOwnerId),
      )
      .catch((err) => {
        logger.warn(
          { orderId, err },
          "tookan: approved florist photo sync after task creation failed (non-blocking)",
        );
      });
    void recordTookanInvitationComm({
      workspaceOwnerId,
      orderId,
      recipientName: recipient?.display_name ?? null,
      recipientEmail: recipient?.email ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPayload = extractTookanFailurePayload(err);
    await db.query(
      `UPDATE orders
          SET tookan_status = 'failed',
              tookan_error  = $1,
              tookan_payload = COALESCE($2::jsonb, tookan_payload),
              updated_at    = now()
        WHERE id = $3`,
      [message, failedPayload ? JSON.stringify(failedPayload) : null, orderId],
    );
    logger.warn({ orderId, err }, "tookan: retry failed");
    throw err;
  }
}

export type TookanBackfillResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};

/**
 * Best-effort recording of a Tookan invitation email in order_communications.
 * Tookan sends this email directly to the recipient when a delivery task is
 * created (using the customer_email field). Fail-open: a tracking failure
 * never blocks the calling flow. No-ops when recipientEmail is empty.
 */
export async function recordTookanInvitationComm(opts: {
  workspaceOwnerId: string;
  orderId: string;
  recipientName: string | null;
  recipientEmail: string | null;
}): Promise<void> {
  if (!opts.recipientEmail) return;
  try {
    await db.query(
      `INSERT INTO order_communications
         (workspace_owner_id, order_id, template_type, recipient_role,
          recipient_name, recipient_email, provider, status, attempt,
          sent_at, last_event_at)
       VALUES ($1, $2, 'tookan_invitation', 'recipient', $3, $4, 'tookan', 'sent',
               COALESCE((SELECT MAX(attempt) FROM order_communications
                          WHERE order_id = $2 AND template_type = 'tookan_invitation'
                            AND recipient_role = 'recipient'), 0) + 1,
               now(), now())`,
      [opts.workspaceOwnerId, opts.orderId, opts.recipientName ?? null, opts.recipientEmail],
    );
  } catch (err) {
    logger.warn(
      { err, orderId: opts.orderId },
      "tookan: failed to record invitation communication",
    );
  }
}

/**
 * Push every workspace order that has no Tookan job yet to Tookan, reusing the
 * exact single-order create path (`retryTookanDeliveryTask`) so per-order
 * success/failure is persisted (`tookan_status` = `created` or `failed`).
 *
 * Orders that already have a `tookan_job_id` are skipped by the SELECT, so an
 * order is never sent twice. Processing is sequential to bound load on the
 * Tookan API; a single order failure is recorded and counted, never aborting
 * the run. Returns a summary of how many orders were attempted, succeeded, and
 * failed.
 */
export async function backfillTookanDeliveryTasks(
  workspaceOwnerId: string,
): Promise<TookanBackfillResult> {
  const idsRes = await db.query<{ id: string }>(
    `SELECT id FROM orders
       WHERE workspace_owner_id = $1
         AND tookan_job_id IS NULL
       ORDER BY created_at ASC`,
    [workspaceOwnerId],
  );
  const ids = idsRes.rows.map((r) => r.id);

  logger.info(
    { workspaceOwnerId, count: ids.length },
    "tookan: backfill starting",
  );

  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await retryTookanDeliveryTask(id, workspaceOwnerId);
      succeeded += 1;
    } catch (err) {
      // retryTookanDeliveryTask already persisted tookan_status='failed' with
      // the error message; just tally it and keep going.
      failed += 1;
      logger.warn({ orderId: id, err }, "tookan: backfill order failed");
    }
  }

  logger.info(
    { workspaceOwnerId, attempted: ids.length, succeeded, failed },
    "tookan: backfill complete",
  );

  return { attempted: ids.length, succeeded, failed };
}

/**
 * Fire-and-forget: create a Tookan delivery task for a newly created CMC POS
 * stock request. Loads the request, its line items, and destination location
 * from the DB, derives a delivery window from `needed_by` (falls back to
 * next-day 09:00–21:00 when absent), calls `createTookanDeliveryTask`, and
 * persists the returned job/task IDs on the `cmc_requests` row. Failures are
 * logged and swallowed so the 201 response is never blocked.
 */
/**
 * Fire-and-forget helper: create a Tookan delivery task for a CMC return and
 * persist the job_id / task_id back to cmc_returns. Logs errors without
 * throwing so callers are never blocked. Uses the return's return_to location
 * as the delivery address and collection_date for the delivery datetime.
 */
export async function createTookanReturnTask(
  returnId: string,
  workspaceOwnerId: string,
): Promise<void> {
  logger.info({ returnId }, "tookan: creating cmc-return task");
  try {
    // Atomically claim the slot by setting a sentinel 'pending' value.
    const claimResult = await db.query(
      `UPDATE cmc_returns
          SET tookan_job_id = 'pending', updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND tookan_job_id IS NULL
        RETURNING id, collection_date, return_to_location_id`,
      [returnId, workspaceOwnerId],
    );
    if (claimResult.rowCount === 0) {
      logger.warn({ returnId }, "tookan cmc-return: slot already claimed or return not found, skipping");
      return;
    }
    const ret = claimResult.rows[0] as {
      id: string;
      collection_date: string | Date | null;
      return_to_location_id: number;
    };

    // Load line items
    const liResult = await db.query(
      `SELECT name_snapshot, quantity FROM cmc_return_line_items WHERE return_id = $1`,
      [returnId],
    );
    const lineItems: LineItemForTookan[] = (
      liResult.rows as Array<{ name_snapshot: string; quantity: number }>
    ).map((li) => ({ name: li.name_snapshot, quantity: li.quantity }));

    // Load return-to location address
    const locResult = await db.query(
      `SELECT name, address, latitude, longitude FROM locations WHERE id = $1`,
      [ret.return_to_location_id],
    );
    const location = (locResult.rows[0] ?? null) as {
      name: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
    } | null;

    // Build delivery window from collection_date. initDb declares the column
    // as text but the Drizzle schema declares it as `date`, so the driver may
    // hand back either a "YYYY-MM-DD" string or a JS Date object. A Date's
    // toString() starts with "Wed Aug 13", so normalize explicitly instead.
    const rawCollectionDate = ret.collection_date as string | Date | null;
    let collectionDateStr: string | null = null;
    if (rawCollectionDate instanceof Date) {
      // node-postgres parses `date` columns at local midnight — use local
      // date parts so the calendar day is preserved.
      const pad = (n: number) => String(n).padStart(2, "0");
      collectionDateStr = `${rawCollectionDate.getFullYear()}-${pad(rawCollectionDate.getMonth() + 1)}-${pad(rawCollectionDate.getDate())}`;
    } else if (rawCollectionDate) {
      collectionDateStr = String(rawCollectionDate).slice(0, 10);
    }
    const { window_start, window_end } = parseDeliveryWindow(collectionDateStr, null);

    const deliveryAddress: Record<string, unknown> = {
      address: location?.address ?? "",
    };
    if (location?.latitude != null) deliveryAddress.latitude = location.latitude;
    if (location?.longitude != null) deliveryAddress.longitude = location.longitude;

    const description = lineItems.map((li) => `${li.quantity} x ${li.name}`).join("\n");

    const order: OrderForTookan = {
      id: ret.id,
      display_order_number: `RET-${ret.id.slice(0, 8).toUpperCase()}`,
      external_order_id: null,
      delivery_address: deliveryAddress,
      window_start,
      window_end,
      delivery_instructions: description || null,
      card_message: null,
    };
    const recipient: RecipientForTookan = {
      display_name: location?.name ?? null,
      phone: null,
      email: null,
    };

    let result: TookanResult;
    try {
      result = await createTookanDeliveryTask(order, recipient, lineItems);
    } catch (tookanErr) {
      // Release the sentinel so a future retry can re-claim the slot.
      await db.query(
        `UPDATE cmc_returns SET tookan_job_id = NULL, updated_at = now() WHERE id = $1`,
        [returnId],
      );
      throw tookanErr;
    }

    await db.query(
      `UPDATE cmc_returns
          SET tookan_job_id = $1, tookan_task_id = $2, updated_at = now()
        WHERE id = $3`,
      [result.jobId, result.taskId, returnId],
    );
    logger.info(
      { returnId, jobId: result.jobId, taskId: result.taskId },
      "tookan: cmc-return task created and persisted",
    );
  } catch (err) {
    logger.error({ returnId, err }, "tookan: cmc-return task creation failed (non-blocking)");
  }
}

export async function createTookanStockRequestTask(
  requestId: string,
  workspaceOwnerId: string,
): Promise<{ ok: true; jobId: string | number; taskId: string | number } | { ok: false; error: string }> {
  logger.info({ requestId }, "tookan: creating stock-request task");
  try {
    // Atomically claim the Tookan slot by setting a sentinel value only when no
    // job has been recorded yet.  This prevents concurrent submit retries from
    // each reading null and then both calling the external Tookan API.
    const claimResult = await db.query(
      `UPDATE cmc_requests
          SET tookan_job_id = 'pending', updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND tookan_job_id IS NULL
        RETURNING id, needed_by, destination_location_id, source_location_id`,
      [requestId, workspaceOwnerId],
    );
    if (claimResult.rowCount === 0) {
      // Either the row doesn't exist or another caller already claimed the slot.
      logger.warn({ requestId }, "tookan stock-request: slot already claimed or request not found, skipping");
      return { ok: false, error: "slot already claimed or request not found" };
    }
    const request = claimResult.rows[0] as {
      id: string;
      needed_by: string | null;
      destination_location_id: number;
      source_location_id: number | null;
    };

    // Load line items — join products so catalog items (name=null, product_id set) get their name
    const liResult = await db.query(
      `SELECT COALESCE(li.name, p.name) AS name, li.requested_qty
         FROM cmc_request_line_items li
         LEFT JOIN products p ON p.id = li.product_id
        WHERE li.request_id = $1`,
      [requestId],
    );
    const lineItems: LineItemForTookan[] = (
      liResult.rows as Array<{ name: string | null; requested_qty: number }>
    )
      .filter((li) => li.name)
      .map((li) => ({ name: li.name!, quantity: li.requested_qty }));

    // Load destination location (delivery stop)
    const destLocResult = await db.query(
      `SELECT name, address, latitude, longitude FROM locations WHERE id = $1`,
      [request.destination_location_id],
    );
    const destLocation = (destLocResult.rows[0] ?? null) as {
      name: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
    } | null;

    // Load source location (pickup stop) when available
    type LocRow = { name: string | null; address: string | null; latitude: number | null; longitude: number | null };
    let srcLocation: LocRow | null = null;
    if (request.source_location_id) {
      const srcLocResult = await db.query(
        `SELECT name, address, latitude, longitude FROM locations WHERE id = $1`,
        [request.source_location_id],
      );
      srcLocation = (srcLocResult.rows[0] as LocRow | undefined) ?? null;
    }

    // Pass needed_by directly as window_start so createTookanDeliveryTask can
    // call formatTookanDatetime on the original ISO string, preserving the
    // actual time of day and applying the correct TOOKAN_TIMEZONE offset.
    // When needed_by is null, window_start is null → job_delivery_datetime = ""
    // (same behaviour as regular orders without a delivery window).
    const window_start: string | null = request.needed_by ?? null;

    const defaultPhone = (process.env.TOOKAN_DEFAULT_PHONE ?? "").trim() || "";

    // Build the delivery address payload from the destination location.
    const deliveryAddressPayload: Record<string, unknown> = {
      address: destLocation?.address ?? "",
    };
    if (destLocation?.latitude != null) deliveryAddressPayload.latitude = destLocation.latitude;
    if (destLocation?.longitude != null) deliveryAddressPayload.longitude = destLocation.longitude;

    // Description: one line per item
    const itemsDescription = lineItems.map((li) => `${li.quantity}x ${li.name}`).join(", ");

    // Build the OrderForTookan struct so we re-use the same createTookanDeliveryTask
    // path as regular orders — identical date formatting, payload shape, and error
    // handling with no risk of the two implementations drifting apart.
    const tookanOrder: OrderForTookan = {
      id: requestId,
      display_order_number: `BR-${request.id.slice(0, 8).toUpperCase()}`,
      external_order_id: null,
      delivery_address: deliveryAddressPayload,
      window_start,
      window_end: null,
      delivery_instructions: itemsDescription || null,
      card_message: null,
      // Optional pickup stop (present when a source location is configured).
      pickup: srcLocation != null
        ? {
            address: srcLocation.address ?? "",
            name: srcLocation.name ?? "",
            latitude: srcLocation.latitude,
            longitude: srcLocation.longitude,
          }
        : null,
    };

    const recipient: RecipientForTookan = {
      display_name: destLocation?.name ?? null,
      phone: defaultPhone || null,
      email: null,
    };

    logger.info({ requestId, hasPickup: srcLocation != null }, "tookan: attempting stock-request task creation");

    let tookanResult: TookanResult;
    try {
      tookanResult = await createTookanDeliveryTask(tookanOrder, recipient, lineItems);
    } catch (tookanErr) {
      // Release the sentinel so a future retry can re-claim the slot.
      await db.query(
        `UPDATE cmc_requests SET tookan_job_id = NULL, updated_at = now() WHERE id = $1`,
        [requestId],
      );
      const errMsg = tookanErr instanceof Error ? tookanErr.message : String(tookanErr);
      const failPayload = extractTookanFailurePayload(tookanErr);
      logger.error({ requestId, err: tookanErr, failPayload }, "tookan: stock-request task creation failed");
      return { ok: false, error: errMsg };
    }

    const { jobId, taskId } = tookanResult;

    await db.query(
      `UPDATE cmc_requests
          SET tookan_job_id = $1, tookan_task_id = $2, updated_at = now()
        WHERE id = $3`,
      [jobId, taskId, requestId],
    );

    logger.info(
      { requestId, jobId, taskId },
      "tookan: stock-request task created and persisted",
    );
    return { ok: true, jobId, taskId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ requestId, err }, "tookan: stock-request task creation failed");
    return { ok: false, error: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch-request status sync (from Tookan webhook / poll)
// ─────────────────────────────────────────────────────────────────────────────

export type TookanBranchRequestSyncResult = {
  matched: boolean;
  newStatus: string | null;
  previousStatus: string | null;
  requestId: string | null;
  workspaceOwnerId: string | null;
};

/**
 * Tookan status codes that mean "a driver has been assigned to this task".
 * Maps to branch-request status `dispatched`.
 */
const BRANCH_REQUEST_DISPATCHED_CODES = new Set<number>([0, 7]);

/**
 * Sync a Tookan task-status update back onto the matching CMC branch request
 * (looked up by tookan_job_id).
 *
 * Mapping:
 *   0 (assigned) or 7 (accepted) → `dispatched`
 *   2 (successful)               → `received`
 *
 * Only transitions forward — never moves a terminal/later status backward.
 * Writes a cmc_request_events audit row with the supplied source label.
 * Returns metadata so callers know whether an actual transition happened.
 * Never throws on a missing request.
 */
export async function syncTookanBranchRequestStatus(
  jobId: string,
  jobStatus: number,
  source: "tookan_webhook" | "tookan_poll" = "tookan_webhook",
): Promise<TookanBranchRequestSyncResult> {
  const reqRes = await db.query<{
    id: string;
    status: string;
    workspace_owner_id: string;
  }>(
    `SELECT id, status, workspace_owner_id FROM cmc_requests WHERE tookan_job_id = $1 LIMIT 1`,
    [jobId],
  );
  const req = reqRes.rows[0];
  if (!req) {
    return {
      matched: false,
      newStatus: null,
      previousStatus: null,
      requestId: null,
      workspaceOwnerId: null,
    };
  }

  // Terminal statuses — never transition out of these
  const TERMINAL_STATUSES = new Set(["received", "cancelled"]);
  if (TERMINAL_STATUSES.has(req.status)) {
    return {
      matched: true,
      newStatus: null,
      previousStatus: req.status,
      requestId: req.id,
      workspaceOwnerId: req.workspace_owner_id,
    };
  }

  let nextStatus: string | null = null;
  if (jobStatus === TOOKAN_STATUS_SUCCESSFUL) {
    // Only advance when not already at received
    if (req.status !== "received") nextStatus = "received";
  } else if (BRANCH_REQUEST_DISPATCHED_CODES.has(jobStatus)) {
    // Only advance when not already at dispatched or beyond
    if (req.status === "submitted" || req.status === "accepted") nextStatus = "dispatched";
  }

  if (nextStatus) {
    await db.query(
      `UPDATE cmc_requests SET status = $1, updated_at = now() WHERE id = $2`,
      [nextStatus, req.id],
    );
    await db.query(
      `INSERT INTO cmc_request_events (request_id, actor_user_id, from_status, to_status, notes)
       VALUES ($1, NULL, $2, $3, $4)`,
      [req.id, req.status, nextStatus, `source: ${source}`],
    );
    logger.info(
      { requestId: req.id, jobId, from: req.status, to: nextStatus, source },
      "tookan: branch request status updated",
    );
  }

  return {
    matched: true,
    newStatus: nextStatus,
    previousStatus: req.status,
    requestId: req.id,
    workspaceOwnerId: req.workspace_owner_id,
  };
}
