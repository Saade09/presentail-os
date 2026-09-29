import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  DEFAULT_COUNTRIES,
  isExcludedCountry,
  getCountryMetadata,
  getCountryMetadataByCode,
} from "../lib/defaults";
import {
  fireDeliveryWebhookAsync,
  buildDeliveryLocationsPayload,
  fireDeliveryConfigUpdated,
} from "../lib/deliveryWebhook";
import { fireDeliveryConfigWebhook } from "../lib/catalogWebhook";
import { resolveApiKeyWorkspace } from "../lib/apiKeyAuth";

/**
 * Task #83 — Delivery cities management.
 *
 * Two routers are exported from this module:
 *   - `adminRouter` (default export): owner-gated `/admin/settings/...` admin
 *     endpoints (Clerk session + workspace membership required).
 *   - `publicRouter`: unauthenticated `GET /delivery-locations` consumed by
 *     the customer app, resolved by `?workspace=<owner_id>`.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function getAvailableCountryNames(ownerId: string): Promise<string[]> {
  const result = await db.query<{ available_countries: string[] | null }>(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const raw = result.rows[0]?.available_countries ?? null;
  const source = raw && raw.length > 0 ? raw : DEFAULT_COUNTRIES;
  return source.filter((c) => !isExcludedCountry(c));
}

/**
 * Returns the uppercase ISO 3166-1 alpha-2 codes for the workspace's
 * available countries (filtered through the metadata helper so unknown
 * names are silently dropped).
 */
async function getAvailableCountryCodes(ownerId: string): Promise<string[]> {
  const names = await getAvailableCountryNames(ownerId);
  const codes: string[] = [];
  for (const n of names) {
    const m = getCountryMetadata(n);
    if (m) codes.push(m.code.toUpperCase());
  }
  return codes;
}

function isOwner(req: Request): boolean {
  return workspace(req).workspaceRole === "owner";
}

function normaliseCountryCode(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return upper;
}

type DeliveryCityRow = {
  id: number;
  workspace_owner_id: string;
  country_code: string;
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
  created_at: string;
  updated_at: string;
};

const DELIVERY_CITY_COLS = `id, workspace_owner_id, country_code, name, slug, sort_order,
  is_active, delivery_fee, free_delivery_enabled, free_delivery_threshold,
  express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time,
  created_at, updated_at`;

function parseFee(raw: unknown, fieldName: string): { value: number; error?: string } {
  const n = parseFloat(String(raw ?? 0));
  if (!Number.isFinite(n) || n < 0) {
    return { value: 0, error: `${fieldName} must be a non-negative number` };
  }
  return { value: n };
}

function parseOptionalDecimal(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(String(val));
  return Number.isFinite(n) ? n : null;
}

// ── Admin router ─────────────────────────────────────────────────────────────

const adminRouter = Router();
adminRouter.use(requireAuth, resolveWorkspace);

/**
 * GET /admin/settings/countries
 * Returns the workspace's available_countries, decorated with delivery state
 * (delivery_active, delivery_sort_order) and active-cities count, plus the
 * metadata helper output (code, currency, flag emoji).
 */
adminRouter.get("/admin/settings/countries", async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;
  const names = await getAvailableCountryNames(ownerId);
  if (names.length === 0) {
    res.json({ countries: [] });
    return;
  }

  const codes = names
    .map((n) => getCountryMetadata(n)?.code.toUpperCase())
    .filter((c): c is string => !!c);

  const settingsResult = await db.query<{
    country_code: string;
    delivery_active: boolean;
    delivery_sort_order: number;
  }>(
    `SELECT UPPER(country_code) AS country_code, delivery_active, delivery_sort_order
       FROM delivery_country_settings
      WHERE workspace_owner_id = $1
        AND UPPER(country_code) = ANY($2)`,
    [ownerId, codes],
  );
  const settingsByCode = new Map<string, { delivery_active: boolean; delivery_sort_order: number }>();
  for (const r of settingsResult.rows) {
    settingsByCode.set(r.country_code, {
      delivery_active: r.delivery_active,
      delivery_sort_order: r.delivery_sort_order,
    });
  }

  const counts = await db.query<{ country_code: string; active_count: string }>(
    `SELECT UPPER(country_code) AS country_code, COUNT(*)::text AS active_count
       FROM delivery_cities
      WHERE workspace_owner_id = $1
        AND UPPER(country_code) = ANY($2)
        AND is_active = true
      GROUP BY UPPER(country_code)`,
    [ownerId, codes],
  );
  const countByCode = new Map<string, number>();
  for (const r of counts.rows) countByCode.set(r.country_code, parseInt(r.active_count, 10));

  const countries = names.map((name) => {
    const meta = getCountryMetadata(name);
    const code = meta?.code.toUpperCase() ?? "";
    const cfg = settingsByCode.get(code);
    return {
      name,
      code,
      flag_emoji: meta?.flagEmoji ?? "",
      currency: meta?.currency ?? null,
      delivery_active: cfg?.delivery_active ?? false,
      delivery_sort_order: cfg?.delivery_sort_order ?? 0,
      active_cities_count: countByCode.get(code) ?? 0,
    };
  });

  res.json({ countries });
});

/**
 * PATCH /admin/settings/countries/reorder
 * Owner-only. Accepts { codes: string[] } — the ordered list of country codes.
 * Sets delivery_sort_order on delivery_country_settings for each code (0-indexed).
 * Codes not in the list are unaffected.
 */
adminRouter.patch("/admin/settings/countries/reorder", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  const ReorderSchema = z.object({
    codes: z.array(z.string()).min(2, "codes must contain at least 2 entries to reorder"),
  });
  const parsed = ReorderSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const normalised = parsed.data.codes.map(normaliseCountryCode);
  if (normalised.some((c) => !c)) {
    res.status(400).json({ error: "Invalid country code in list" });
    return;
  }
  const codes = normalised as string[];

  const allowed = await getAvailableCountryCodes(ownerId);
  for (const code of codes) {
    if (!allowed.includes(code)) {
      res.status(400).json({ error: `Country ${code} is not in available_countries` });
      return;
    }
  }

  await db.query("BEGIN");
  try {
    for (let i = 0; i < codes.length; i++) {
      await db.query(
        `INSERT INTO delivery_country_settings
           (workspace_owner_id, country_code, delivery_sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_owner_id, country_code) DO UPDATE
           SET delivery_sort_order = EXCLUDED.delivery_sort_order,
               updated_at = now()`,
        [ownerId, codes[i], i],
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }

  res.json({ ok: true });
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.city.updated", ownerId, { action: "bulk_update" });
  void fireDeliveryConfigUpdated(ownerId);
});

/**
 * PATCH /admin/settings/countries/:countryCode/cities/reorder
 * Owner-only. Accepts { ids: number[] } — all city ids for the country in
 * desired order. Sets sort_order (0-indexed) on each city.
 */
adminRouter.patch(
  "/admin/settings/countries/:countryCode/cities/reorder",
  async (req, res) => {
    if (!isOwner(req)) {
      res.status(403).json({ error: "owner_only" });
      return;
    }
    const ownerId = workspace(req).workspaceOwnerId;
    const code = normaliseCountryCode(req.params.countryCode);
    if (!code) {
      res.status(400).json({ error: "Invalid country code" });
      return;
    }

    const ReorderCitiesSchema = z.object({
      ids: z.array(z.number().int()).min(1),
    });
    const parsed = ReorderCitiesSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const { ids } = parsed.data;

    const existing = await db.query<{ id: number }>(
      `SELECT id FROM delivery_cities
        WHERE workspace_owner_id = $1 AND country_code = $2`,
      [ownerId, code],
    );
    const existingIds = new Set(existing.rows.map((r) => r.id));

    if (ids.length !== existingIds.size) {
      res.status(400).json({ error: "ids must contain exactly all cities for this country" });
      return;
    }
    if (new Set(ids).size !== ids.length) {
      res.status(400).json({ error: "ids must not contain duplicates" });
      return;
    }
    for (const id of ids) {
      if (!existingIds.has(id)) {
        res.status(400).json({ error: `City ${id} not found in ${code}` });
        return;
      }
    }

    await db.query("BEGIN");
    try {
      for (let i = 0; i < ids.length; i++) {
        await db.query(
          `UPDATE delivery_cities SET sort_order = $1, updated_at = now()
            WHERE id = $2 AND workspace_owner_id = $3`,
          [i, ids[i], ownerId],
        );
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }

    res.json({ ok: true });
    fireDeliveryWebhookAsync(ownerId);
    void fireDeliveryConfigWebhook("delivery.city.updated", ownerId, { action: "reorder" });
  void fireDeliveryConfigUpdated(ownerId);
  },
);

const DeliveryToggleSchema = z.object({
  delivery_active: z.boolean(),
  delivery_sort_order: z.number().int().optional(),
});

/**
 * PATCH /admin/settings/countries/:countryCode/delivery
 * Owner-only. Upserts the per-country delivery activation flag.
 */
adminRouter.patch(
  "/admin/settings/countries/:countryCode/delivery",
  async (req, res) => {
    if (!isOwner(req)) {
      res.status(403).json({ error: "owner_only" });
      return;
    }
    const ownerId = workspace(req).workspaceOwnerId;
    const code = normaliseCountryCode(req.params.countryCode);
    if (!code) {
      res.status(400).json({ error: "Invalid country code" });
      return;
    }
    const meta = getCountryMetadataByCode(code);
    if (!meta) {
      res.status(400).json({ error: "Unknown country code" });
      return;
    }
    const allowed = await getAvailableCountryCodes(ownerId);
    if (!allowed.includes(code)) {
      res.status(400).json({ error: "Country is not in available_countries" });
      return;
    }

    const parsed = DeliveryToggleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const { delivery_active, delivery_sort_order } = parsed.data;

    const result = await db.query<{
      country_code: string;
      delivery_active: boolean;
      delivery_sort_order: number;
    }>(
      `INSERT INTO delivery_country_settings
         (workspace_owner_id, country_code, delivery_active, delivery_sort_order)
       VALUES ($1, $2, $3, COALESCE($4, 0))
       ON CONFLICT (workspace_owner_id, country_code) DO UPDATE
         SET delivery_active = EXCLUDED.delivery_active,
             delivery_sort_order = COALESCE($4, delivery_country_settings.delivery_sort_order),
             updated_at = now()
       RETURNING country_code, delivery_active, delivery_sort_order`,
      [ownerId, code, delivery_active, delivery_sort_order ?? null],
    );
    const row = result.rows[0];
    res.json({
      country_code: row.country_code,
      delivery_active: row.delivery_active,
      delivery_sort_order: row.delivery_sort_order,
    });
    fireDeliveryWebhookAsync(ownerId);
    void fireDeliveryConfigWebhook("delivery.city.updated", ownerId, { action: "delivery_toggle" });
  void fireDeliveryConfigUpdated(ownerId);
  },
);

const CityPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(80).optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
  delivery_fee: z.number().min(0).optional(),
  free_delivery_enabled: z.boolean().optional(),
  free_delivery_threshold: z.number().min(0).nullable().optional(),
  express_delivery_enabled: z.boolean().optional(),
  express_delivery_fee: z.number().min(0).nullable().optional(),
  express_delivery_cutoff_time: z.string().max(20).nullable().optional(),
});

/**
 * PATCH /admin/settings/cities/:id
 * Owner-only. Updates editable fields on a delivery city. Slug uniqueness
 * is enforced within (workspace, country).
 */
adminRouter.patch("/admin/settings/cities/:id", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = CityPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const existing = await db.query<DeliveryCityRow>(
    `SELECT ${DELIVERY_CITY_COLS}
       FROM delivery_cities
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, ownerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "City not found" });
    return;
  }
  const prev = existing.rows[0];

  const name =
    parsed.data.name !== undefined ? parsed.data.name.trim() : prev.name;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  let slug = prev.slug;
  if (parsed.data.slug !== undefined) {
    slug = slugify(parsed.data.slug);
    if (!slug) {
      res.status(400).json({ error: "slug could not be derived" });
      return;
    }
  } else if (parsed.data.name !== undefined) {
    slug = slugify(name);
  }
  const sortOrder =
    parsed.data.sort_order !== undefined ? parsed.data.sort_order : prev.sort_order;
  const isActive =
    parsed.data.is_active !== undefined ? parsed.data.is_active : prev.is_active;

  let deliveryFee = parseFloat(prev.delivery_fee);
  if (parsed.data.delivery_fee !== undefined) {
    const r = parseFee(parsed.data.delivery_fee, "delivery_fee");
    if (r.error) { res.status(400).json({ error: r.error }); return; }
    deliveryFee = r.value;
  }
  const freeDeliveryEnabled =
    parsed.data.free_delivery_enabled !== undefined ? parsed.data.free_delivery_enabled : prev.free_delivery_enabled;
  const freeDeliveryThreshold =
    parsed.data.free_delivery_threshold !== undefined
      ? parsed.data.free_delivery_threshold
      : (prev.free_delivery_threshold != null ? parseFloat(prev.free_delivery_threshold) : null);
  const expressDeliveryEnabled =
    parsed.data.express_delivery_enabled !== undefined ? parsed.data.express_delivery_enabled : prev.express_delivery_enabled;
  const expressDeliveryFee =
    parsed.data.express_delivery_fee !== undefined
      ? parsed.data.express_delivery_fee
      : (prev.express_delivery_fee != null ? parseFloat(prev.express_delivery_fee) : null);
  const expressDeliveryCutoffTime =
    parsed.data.express_delivery_cutoff_time !== undefined
      ? parsed.data.express_delivery_cutoff_time
      : prev.express_delivery_cutoff_time ?? null;

  try {
    const updated = await db.query<DeliveryCityRow>(
      `UPDATE delivery_cities
          SET name = $1, slug = $2, sort_order = $3, is_active = $4,
              delivery_fee = $5, free_delivery_enabled = $6, free_delivery_threshold = $7,
              express_delivery_enabled = $8, express_delivery_fee = $9,
              express_delivery_cutoff_time = $10, updated_at = now()
        WHERE id = $11 AND workspace_owner_id = $12
        RETURNING ${DELIVERY_CITY_COLS}`,
      [name, slug, sortOrder, isActive,
       deliveryFee, freeDeliveryEnabled, freeDeliveryThreshold,
       expressDeliveryEnabled, expressDeliveryFee, expressDeliveryCutoffTime,
       id, ownerId],
    );
    res.json({ city: updated.rows[0] });
    fireDeliveryWebhookAsync(ownerId);
    void fireDeliveryConfigWebhook("delivery.city.updated", ownerId, { action: "city_updated", city_id: id });
  void fireDeliveryConfigUpdated(ownerId);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({
        error: `A city with slug "${slug}" already exists in ${prev.country_code}`,
      });
      return;
    }
    throw err;
  }
});

/**
 * DELETE /admin/settings/cities/:id
 * Owner-only. Removes a delivery city.
 */
adminRouter.delete("/admin/settings/cities/:id", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.query(
    `DELETE FROM delivery_cities WHERE id = $1 AND workspace_owner_id = $2`,
    [id, ownerId],
  );
  res.json({ ok: true });
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.city.updated", ownerId, { action: "city_deleted", city_id: id });
  void fireDeliveryConfigUpdated(ownerId);
});

// ── Public router ────────────────────────────────────────────────────────────

const publicRouter = Router();

function resolveWorkspaceParam(req: Request): string | null {
  const raw = req.query.workspace;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
}

/**
 * GET /delivery-locations[?workspace=<owner_id>]
 * Public, unauthenticated. Returns the active delivery countries (each with
 * delivery_active=true and at least one is_active=true city) and their active
 * cities, including pricing fields. Supports Last-Modified/ETag for efficient
 * polling — responds with 304 when the payload hasn't changed.
 * Sorted: countries by delivery_sort_order ASC then name; cities by
 * sort_order ASC then name.
 */
publicRouter.get("/delivery-locations", async (req: Request, res: Response) => {
  // Resolve workspace owner ID: API key takes highest priority, then slug/param.
  let ownerId: string | null = await resolveApiKeyWorkspace(req);
  if (!ownerId) {
    const param = resolveWorkspaceParam(req);
    if (param) {
      if (param.startsWith("user_")) {
        // Direct Clerk user ID — use as-is.
        ownerId = param;
      } else {
        // Treat as a workspace slug — look it up.
        const slugResult = await db.query<{ workspace_owner_id: string }>(
          `SELECT workspace_owner_id FROM workspace_settings WHERE workspace_slug = $1 LIMIT 1`,
          [param],
        );
        ownerId = slugResult.rows[0]?.workspace_owner_id ?? null;
      }
    }
  }
  if (!ownerId) {
    res.status(400).json({ error: "workspace query parameter is required" });
    return;
  }

  // Derive country codes directly from delivery_cities (active or inactive).
  // A country appears if it has at least one city (active or inactive) — no
  // delivery_country_settings gate required.
  const activeCityCodesResult = await db.query<{ country_code: string }>(
    `SELECT DISTINCT country_code
       FROM delivery_cities
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  if (activeCityCodesResult.rowCount === 0) {
    res.json({ countries: [] });
    return;
  }

  const activeCodes = activeCityCodesResult.rows.map((r) => r.country_code);

  // Fetch sort order and delivery_active from delivery_country_settings when available.
  const settings = await db.query<{
    country_code: string;
    delivery_sort_order: number;
    delivery_active: boolean;
  }>(
    `SELECT country_code, delivery_sort_order, delivery_active
       FROM delivery_country_settings
      WHERE workspace_owner_id = $1
        AND country_code = ANY($2)`,
    [ownerId, activeCodes],
  );
  const deliverySettingsByCode = new Map<string, { delivery_sort_order: number; delivery_active: boolean }>();
  for (const r of settings.rows) {
    deliverySettingsByCode.set(r.country_code, {
      delivery_sort_order: r.delivery_sort_order,
      delivery_active: r.delivery_active,
    });
  }

  const flagByCode = new Map<string, string>();
  try {
    const flagOverridesResult = await db.query<{ country_code: string; image_url: string }>(
      `SELECT country_code, image_url FROM country_flag_overrides WHERE workspace_owner_id = $1 AND country_code = ANY($2)`,
      [ownerId, activeCodes],
    );
    for (const r of flagOverridesResult.rows) flagByCode.set(r.country_code.toLowerCase(), r.image_url);
  } catch (err) {
    req.log.warn({ err }, "country_flag_overrides query failed — returning empty flag map");
  }

  const cities = await db.query<{
    id: number;
    country_code: string;
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
    updated_at: string;
  }>(
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

  // Fetch enabled weekly delivery slots for all returned cities
  type SlotPublicRow = {
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
      const slotsResult = await db.query<SlotPublicRow>(
        `SELECT city_id, id, day_of_week, label, start_time, end_time,
                fee_override, cutoff_time, capacity, sort_order
           FROM district_weekly_delivery_slots
          WHERE workspace_owner_id = $1
            AND city_id = ANY($2)
            AND is_enabled = true
          ORDER BY city_id ASC, day_of_week ASC, sort_order ASC, id ASC`,
        [ownerId, cityIds],
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
      req.log.warn({ err }, "district_weekly_delivery_slots query failed — returning empty slots");
    }
  }

  // Compute Last-Modified as the latest updated_at across all returned cities
  let lastModified = new Date(0);
  for (const r of cities.rows) {
    const d = new Date(r.updated_at);
    if (d > lastModified) lastModified = d;
  }
  const etag = `"${lastModified.getTime().toString(16)}"`;

  // 304 short-circuit
  const ifNoneMatch = req.headers["if-none-match"];
  const ifModifiedSince = req.headers["if-modified-since"];
  if (
    (ifNoneMatch && ifNoneMatch === etag) ||
    (ifModifiedSince && lastModified <= new Date(ifModifiedSince))
  ) {
    res.status(304).end();
    return;
  }

  res.setHeader("Last-Modified", lastModified.toUTCString());
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

  type DeliverySlotOut = {
    id: number;
    day_of_week: number;
    label: string;
    start_time: string;
    end_time: string;
    fee_override: number | null;
    cutoff_time: string | null;
    capacity: number | null;
    sort_order: number;
  };
  type CityOut = {
    id: number;
    name: string;
    slug: string;
    sort_order: number;
    is_active: boolean;
    delivery_fee: number;
    free_delivery_enabled: boolean;
    free_delivery_threshold: number | null;
    express_delivery_enabled: boolean;
    express_delivery_fee: number | null;
    express_delivery_cutoff_time: string | null;
    delivery_slots: DeliverySlotOut[];
  };
  const grouped = new Map<string, Array<CityOut>>();
  for (const r of cities.rows) {
    const list = grouped.get(r.country_code) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      slug: r.slug,
      sort_order: r.sort_order,
      is_active: r.is_active,
      delivery_fee: parseFloat(r.delivery_fee),
      free_delivery_enabled: r.free_delivery_enabled,
      free_delivery_threshold: r.free_delivery_threshold != null ? parseFloat(r.free_delivery_threshold) : null,
      express_delivery_enabled: r.express_delivery_enabled,
      express_delivery_fee: r.express_delivery_fee != null ? parseFloat(r.express_delivery_fee) : null,
      express_delivery_cutoff_time: r.express_delivery_cutoff_time ?? null,
      delivery_slots: slotsByCity.get(r.id) ?? [],
    });
    grouped.set(r.country_code, list);
  }

  const countries = activeCodes
    .map((code) => {
      const meta = getCountryMetadataByCode(code);
      const cs = grouped.get(code) ?? [];
      if (cs.length === 0) return null;
      const dSettings = deliverySettingsByCode.get(code);
      const lowerCode = code.toLowerCase();
      return {
        // Integration contract fields (camelCase / lowercase)
        id: lowerCode,
        code: lowerCode,
        isActive: dSettings?.delivery_active ?? true,
        // Legacy snake_case fields kept for backward compatibility
        country_code: code,
        name: meta?.name ?? code,
        flag_emoji: meta?.flagEmoji ?? "",
        flag_image_url: flagByCode.get(lowerCode) ?? null,
        currency: meta?.currency ?? null,
        delivery_sort_order: dSettings?.delivery_sort_order ?? 0,
        cities: cs.map((city) => ({
          ...city,
          // Integration contract: id is the slug string, isActive mirrors is_active
          id: city.slug,
          isActive: city.is_active,
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

  res.json({ countries });
});

export { adminRouter, publicRouter };
export default adminRouter;
