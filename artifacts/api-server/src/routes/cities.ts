import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { logPageAccessDenial, resolveWorkspace, workspace } from "../lib/workspace";
import { DEFAULT_COUNTRIES, isExcludedCountry, findCountryByName, findCountryByCode } from "../lib/defaults";

const router = Router();

router.use(requireAuth, resolveWorkspace);

type DbCityRow = {
  id: number;
  workspace_owner_id: string;
  country_code: string;
  name: string;
  slug: string;
  is_active: boolean;
  sort_order: number;
  delivery_fee: string;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: string | null;
  express_delivery_cutoff_time: string | null;
  standard_delivery_available: boolean;
  express_delivery_available: boolean;
  express_free_delivery_threshold: string | null;
  cutoff_time: string | null;
  max_standard_orders_per_slot: number | null;
  max_express_orders_per_slot: number | null;
  created_at: string;
  updated_at: string;
};

type CityRow = DbCityRow & { country: string; currency: "AED" | "USD" };

const CITY_COLS = `id, workspace_owner_id, country_code, name, slug, is_active, sort_order,
  delivery_fee, free_delivery_enabled, free_delivery_threshold,
  express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time,
  standard_delivery_available, express_delivery_available, express_free_delivery_threshold,
  cutoff_time, max_standard_orders_per_slot, max_express_orders_per_slot,
  created_at, updated_at`;

function toCityRow(row: DbCityRow): CityRow {
  return {
    ...row,
    country: findCountryByCode(row.country_code)?.name ?? row.country_code,
    currency: row.country_code.trim().toUpperCase() === "AE" ? "AED" : "USD",
  };
}

async function getWorkspaceCountries(ownerId: string): Promise<string[]> {
  const result = await db.query<{ available_countries: string[] | null }>(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  if (result.rowCount === 0) return DEFAULT_COUNTRIES;
  const arr = result.rows[0].available_countries ?? [];
  const filtered = arr.filter((c) => !isExcludedCountry(c));
  return filtered.length > 0 ? filtered : DEFAULT_COUNTRIES;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function canManageCities(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.includes("cities.manage") ?? false)
  );
}

function canViewCities(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.some((page) => page === "cities" || page === "cities.manage") ?? false)
  );
}

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

router.get("/cities", async (req, res) => {
  const wreq = workspace(req);
  if (!canViewCities(wreq)) {
    logPageAccessDenial(req, wreq, ["cities", "cities.manage"]);
    res.status(403).json({ error: "Access denied: cities not in your role permissions" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const countryName = typeof req.query.country === "string" && req.query.country.trim()
    ? req.query.country.trim() : null;
  const search = typeof req.query.q === "string" && req.query.q.trim()
    ? req.query.q.trim() : null;

  const conds: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  if (countryName) {
    const countryCode = findCountryByName(countryName)?.code;
    if (countryCode) {
      params.push(countryCode);
      conds.push(`country_code = $${params.length}`);
    } else {
      const countries = await getWorkspaceCountries(ownerId);
      res.json({ cities: [], countries });
      return;
    }
  }
  if (search) {
    params.push(`%${search.replace(/([%_\\])/g, "\\$1")}%`);
    conds.push(`name ILIKE $${params.length} ESCAPE '\\'`);
  }

  const result = await db.query<DbCityRow>(
    `SELECT ${CITY_COLS}
       FROM delivery_cities
      WHERE ${conds.join(" AND ")}
      ORDER BY country_code ASC, sort_order ASC, name ASC`,
    params,
  );

  const countries = await getWorkspaceCountries(ownerId);
  res.json({ cities: result.rows.map(toCityRow), countries });
});

router.post("/cities", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCities(wreq)) {
    res.status(403).json({ error: "Only workspace owners or admins with cities.manage may manage cities" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const name = String(req.body?.name ?? "").trim();
  const countryName = String(req.body?.country ?? "").trim();
  const slugInput = String(req.body?.slug ?? "").trim();
  const isActive = req.body?.is_active === undefined ? true : !!req.body.is_active;
  const sortOrder = Number.isFinite(Number(req.body?.sort_order)) ? parseInt(String(req.body.sort_order), 10) : 0;

  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  if (!countryName) { res.status(400).json({ error: "country is required" }); return; }

  const validCountries = await getWorkspaceCountries(ownerId);
  if (!validCountries.includes(countryName)) {
    res.status(400).json({ error: `country must be one of: ${validCountries.join(", ")}` });
    return;
  }

  const countryCode = findCountryByName(countryName)?.code.toUpperCase();
  if (!countryCode) {
    res.status(400).json({ error: `Unknown country: ${countryName}` });
    return;
  }

  const slug = slugInput ? slugify(slugInput) : slugify(name);
  if (!slug) { res.status(400).json({ error: "slug could not be derived from name" }); return; }

  const deliveryFeeResult = parseFee(req.body?.delivery_fee ?? req.body?.deliveryFee, "delivery_fee");
  if (deliveryFeeResult.error) { res.status(400).json({ error: deliveryFeeResult.error }); return; }
  const deliveryFee = deliveryFeeResult.value;

  const freeDeliveryEnabled = !!(req.body?.free_delivery_enabled ?? req.body?.freeDeliveryEnabled);
  const freeDeliveryThreshold = freeDeliveryEnabled
    ? parseOptionalDecimal(req.body?.free_delivery_threshold ?? req.body?.freeDeliveryThreshold)
    : 0;

  const expressDeliveryEnabled = !!(req.body?.express_delivery_enabled ?? req.body?.expressDeliveryEnabled);
  const expressDeliveryFee = expressDeliveryEnabled
    ? (parseOptionalDecimal(req.body?.express_delivery_fee ?? req.body?.expressDeliveryFee) ?? 0)
    : 0;
  let expressDeliveryCutoffTime: string | null = null;
  if (expressDeliveryEnabled) {
    const cutoff = String(req.body?.express_delivery_cutoff_time ?? req.body?.expressDeliveryCutoffTime ?? "").trim();
    expressDeliveryCutoffTime = cutoff || null;
  }
  const standardDeliveryAvailable = req.body?.standard_delivery_available !== undefined
    ? !!req.body.standard_delivery_available
    : true;
  const expressDeliveryAvailable = !!(req.body?.express_delivery_available ?? req.body?.expressDeliveryAvailable);
  const expressFreeDeliveryThreshold = parseOptionalDecimal(req.body?.express_free_delivery_threshold ?? req.body?.expressFreeDeliveryThreshold);
  const standardCutoffTime = typeof (req.body?.cutoff_time ?? req.body?.cutoffTime) === "string"
    ? (String(req.body.cutoff_time ?? req.body.cutoffTime).trim() || null)
    : null;
  const maxStandardOrdersPerSlot = req.body?.max_standard_orders_per_slot != null
    ? parseInt(String(req.body.max_standard_orders_per_slot), 10) || null
    : null;
  const maxExpressOrdersPerSlot = req.body?.max_express_orders_per_slot != null
    ? parseInt(String(req.body.max_express_orders_per_slot), 10) || null
    : null;

  try {
    const r = await db.query<DbCityRow>(
      `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, is_active, sort_order,
          delivery_fee, free_delivery_enabled, free_delivery_threshold,
          express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time,
          standard_delivery_available, express_delivery_available, express_free_delivery_threshold,
          cutoff_time, max_standard_orders_per_slot, max_express_orders_per_slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING ${CITY_COLS}`,
      [ownerId, countryCode, name, slug, isActive, sortOrder,
       deliveryFee, freeDeliveryEnabled, freeDeliveryThreshold,
       expressDeliveryEnabled, expressDeliveryFee, expressDeliveryCutoffTime,
       standardDeliveryAvailable, expressDeliveryAvailable, expressFreeDeliveryThreshold,
       standardCutoffTime, maxStandardOrdersPerSlot, maxExpressOrdersPerSlot],
    );
    res.status(201).json({ city: toCityRow(r.rows[0]) });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: `A city with slug "${slug}" already exists in ${countryName}` });
      return;
    }
    throw err;
  }
});

router.patch("/cities/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCities(wreq)) {
    res.status(403).json({ error: "Only workspace owners or admins with cities.manage may manage cities" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await db.query<DbCityRow>(
    `SELECT ${CITY_COLS} FROM delivery_cities WHERE id = $1 AND workspace_owner_id = $2`,
    [id, ownerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "City not found" }); return; }
  const prev = existing.rows[0];
  const prevCountryName = findCountryByCode(prev.country_code)?.name ?? prev.country_code;

  const body = req.body ?? {};
  const name = "name" in body ? String(body.name ?? "").trim() : prev.name;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }

  const countryName = "country" in body ? String(body.country ?? "").trim() : prevCountryName;
  if (!countryName) { res.status(400).json({ error: "country is required" }); return; }

  let countryCode = prev.country_code;
  if ("country" in body && body.country !== prevCountryName) {
    const validCountries = await getWorkspaceCountries(ownerId);
    if (!validCountries.includes(countryName)) {
      res.status(400).json({ error: `country must be one of: ${validCountries.join(", ")}` });
      return;
    }
    const found = findCountryByName(countryName)?.code;
    if (!found) {
      res.status(400).json({ error: `Unknown country: ${countryName}` });
      return;
    }
    countryCode = found;
  }

  const slug = "slug" in body && String(body.slug ?? "").trim()
    ? slugify(String(body.slug))
    : ("name" in body ? slugify(name) : prev.slug);
  const isActive = "is_active" in body ? !!body.is_active : prev.is_active;
  const sortOrder = "sort_order" in body && Number.isFinite(Number(body.sort_order))
    ? parseInt(String(body.sort_order), 10)
    : prev.sort_order;

  let deliveryFee = parseFloat(prev.delivery_fee);
  if ("delivery_fee" in body || "deliveryFee" in body) {
    const r = parseFee(body.delivery_fee ?? body.deliveryFee, "delivery_fee");
    if (r.error) { res.status(400).json({ error: r.error }); return; }
    deliveryFee = r.value;
  }

  const freeDeliveryEnabled = "free_delivery_enabled" in body || "freeDeliveryEnabled" in body
    ? !!(body.free_delivery_enabled ?? body.freeDeliveryEnabled)
    : prev.free_delivery_enabled;

  const rawFreeDeliveryThreshold = "free_delivery_threshold" in body || "freeDeliveryThreshold" in body
    ? parseOptionalDecimal(body.free_delivery_threshold ?? body.freeDeliveryThreshold)
    : (prev.free_delivery_threshold != null ? parseFloat(prev.free_delivery_threshold) : null);
  const freeDeliveryThreshold = freeDeliveryEnabled ? rawFreeDeliveryThreshold : 0;

  const expressDeliveryEnabled = "express_delivery_enabled" in body || "expressDeliveryEnabled" in body
    ? !!(body.express_delivery_enabled ?? body.expressDeliveryEnabled)
    : prev.express_delivery_enabled;

  const rawExpressDeliveryFee = "express_delivery_fee" in body || "expressDeliveryFee" in body
    ? parseOptionalDecimal(body.express_delivery_fee ?? body.expressDeliveryFee)
    : (prev.express_delivery_fee != null ? parseFloat(prev.express_delivery_fee) : 0);
  const expressDeliveryFee = expressDeliveryEnabled ? (rawExpressDeliveryFee ?? 0) : 0;

  let expressDeliveryCutoffTime: string | null = prev.express_delivery_cutoff_time ?? null;
  if ("express_delivery_cutoff_time" in body || "expressDeliveryCutoffTime" in body) {
    const cutoff = String(body.express_delivery_cutoff_time ?? body.expressDeliveryCutoffTime ?? "").trim();
    expressDeliveryCutoffTime = cutoff || null;
  }

  const standardDeliveryAvailable = "standard_delivery_available" in body
    ? !!body.standard_delivery_available
    : prev.standard_delivery_available;
  const expressDeliveryAvailable = "express_delivery_available" in body || "expressDeliveryAvailable" in body
    ? !!(body.express_delivery_available ?? body.expressDeliveryAvailable)
    : prev.express_delivery_available;
  const expressFreeDeliveryThreshold = "express_free_delivery_threshold" in body || "expressFreeDeliveryThreshold" in body
    ? parseOptionalDecimal(body.express_free_delivery_threshold ?? body.expressFreeDeliveryThreshold)
    : (prev.express_free_delivery_threshold != null ? parseFloat(prev.express_free_delivery_threshold) : null);
  const standardCutoffTime = "cutoff_time" in body || "cutoffTime" in body
    ? (String(body.cutoff_time ?? body.cutoffTime ?? "").trim() || null)
    : prev.cutoff_time;
  const maxStandardOrdersPerSlot = "max_standard_orders_per_slot" in body
    ? (parseInt(String(body.max_standard_orders_per_slot), 10) || null)
    : prev.max_standard_orders_per_slot;
  const maxExpressOrdersPerSlot = "max_express_orders_per_slot" in body
    ? (parseInt(String(body.max_express_orders_per_slot), 10) || null)
    : prev.max_express_orders_per_slot;

  try {
    const r = await db.query<DbCityRow>(
      `UPDATE delivery_cities
          SET name = $1, country_code = $2, slug = $3, is_active = $4, sort_order = $5,
              delivery_fee = $6, free_delivery_enabled = $7, free_delivery_threshold = $8,
              express_delivery_enabled = $9, express_delivery_fee = $10, express_delivery_cutoff_time = $11,
              standard_delivery_available = $12, express_delivery_available = $13,
              express_free_delivery_threshold = $14, cutoff_time = $15,
              max_standard_orders_per_slot = $16, max_express_orders_per_slot = $17,
              updated_at = now()
        WHERE id = $18 AND workspace_owner_id = $19
        RETURNING ${CITY_COLS}`,
      [name, countryCode, slug, isActive, sortOrder,
       deliveryFee, freeDeliveryEnabled, freeDeliveryThreshold,
       expressDeliveryEnabled, expressDeliveryFee, expressDeliveryCutoffTime,
       standardDeliveryAvailable, expressDeliveryAvailable, expressFreeDeliveryThreshold,
       standardCutoffTime, maxStandardOrdersPerSlot, maxExpressOrdersPerSlot,
       id, ownerId],
    );
    res.json({ city: toCityRow(r.rows[0]) });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: `A city with slug "${slug}" already exists in ${countryName}` });
      return;
    }
    throw err;
  }
});

router.delete("/cities/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCities(wreq)) {
    res.status(403).json({ error: "Only workspace owners or admins with cities.manage may manage cities" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const countResult = await db.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM delivery_cities WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);
  if (total <= 1) {
    res.status(400).json({ error: "Cannot delete the last city. A workspace must have at least one city." });
    return;
  }

  await db.query(`DELETE FROM delivery_cities WHERE id = $1 AND workspace_owner_id = $2`, [id, ownerId]);
  res.json({ ok: true });
});

export default router;
