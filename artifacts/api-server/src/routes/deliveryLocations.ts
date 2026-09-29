import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { db } from "../lib/db";
import { resolveApiKeyWorkspace } from "../lib/apiKeyAuth";

const router = Router();

const COUNTRY_META: Record<string, { name: string; currency: string }> = {
  LB: { name: "Lebanon",                  currency: "USD" },
  AE: { name: "United Arab Emirates",     currency: "AED" },
  SA: { name: "Saudi Arabia",             currency: "SAR" },
  KW: { name: "Kuwait",                   currency: "KWD" },
  BH: { name: "Bahrain",                  currency: "BHD" },
  QA: { name: "Qatar",                    currency: "QAR" },
  OM: { name: "Oman",                     currency: "OMR" },
  CY: { name: "Cyprus",                   currency: "EUR" },
  EG: { name: "Egypt",                    currency: "EGP" },
  JO: { name: "Jordan",                   currency: "JOD" },
  GB: { name: "United Kingdom",           currency: "GBP" },
  US: { name: "United States",            currency: "USD" },
  FR: { name: "France",                   currency: "EUR" },
  DE: { name: "Germany",                  currency: "EUR" },
};

function parseHour(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const h = parseInt(timeStr.split(":")[0] ?? "", 10);
  return Number.isFinite(h) ? h : null;
}

/**
 * GET /api/delivery-locations
 *
 * Returns all active delivery cities grouped by country in camelCase format,
 * including timeslots as startHour/endHour/cutoffHour integers.
 *
 * expressSurchargeUsd = express_delivery_fee − delivery_fee (the add-on charge).
 * All monetary values are in the country's native currency (see `currency` field).
 *
 * Authentication: Bearer pk_live_... API key  OR  ?workspace=<slug>
 */
export async function handleDeliveryLocationsExt(
  queryable: Pick<PoolClient, "query">,
  req: Request,
  res: Response,
  excludedWeeklySlotIds: number[] = [],
  forcedOwnerId?: string,
): Promise<void> {
  let ownerId: string | null = forcedOwnerId ?? await resolveApiKeyWorkspace(req);

  if (!ownerId) {
    const wp = req.query.workspace;
    if (typeof wp === "string" && wp.trim()) {
      const param = wp.trim();
      if (param.startsWith("user_")) {
        ownerId = param;
      } else {
        const r = await queryable.query<{ workspace_owner_id: string }>(
          `SELECT workspace_owner_id FROM workspace_settings WHERE workspace_slug = $1 LIMIT 1`,
          [param],
        );
        ownerId = r.rows[0]?.workspace_owner_id ?? null;
      }
    }
  }

  if (!ownerId) {
    res.status(401).json({ error: "API key or workspace parameter required" });
    return;
  }

  type CityRow = {
    id: number;
    name: string;
    slug: string;
    country_code: string;
    sort_order: number;
    is_active: boolean;
    delivery_fee: string;
    free_delivery_enabled: boolean;
    free_delivery_threshold: string | null;
    express_delivery_enabled: boolean;
    express_delivery_fee: string | null;
    express_delivery_cutoff_time: string | null;
  };

  const citiesResult = await queryable.query<CityRow>(
    `SELECT id, name, slug, country_code, sort_order, is_active,
            delivery_fee, free_delivery_enabled, free_delivery_threshold,
            express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time
       FROM delivery_cities
      WHERE workspace_owner_id = $1
        AND is_active = true
      ORDER BY country_code ASC, sort_order ASC, name ASC`,
    [ownerId],
  );

  if (citiesResult.rowCount === 0) {
    res.json({ countries: [] });
    return;
  }

  const cityIds = citiesResult.rows.map((c) => c.id);

  type SlotRow = {
    city_id: number;
    label: string;
    start_time: string;
    end_time: string;
    cutoff_time: string | null;
    fee_override: string | null;
    sort_order: number;
  };

  // Distinct slot definitions per city (deduplicated by label+start+end+cutoff+fee).
  const slotsResult = await queryable.query<SlotRow>(
    `SELECT DISTINCT ON (city_id, label, start_time, end_time, cutoff_time, fee_override)
            city_id, label, start_time, end_time, cutoff_time, fee_override, sort_order
       FROM district_weekly_delivery_slots
      WHERE workspace_owner_id = $1
        AND city_id = ANY($2)
        AND is_enabled = true
        AND id <> ALL($3::integer[])
      ORDER BY city_id ASC, label ASC, start_time ASC, end_time ASC,
               cutoff_time ASC, fee_override ASC, sort_order ASC`,
    [ownerId, cityIds, excludedWeeklySlotIds],
  );

  const slotsByCity = new Map<number, SlotRow[]>();
  for (const s of slotsResult.rows) {
    const list = slotsByCity.get(s.city_id) ?? [];
    list.push(s);
    slotsByCity.set(s.city_id, list);
  }

  // Group cities by country_code.
  const byCountry = new Map<string, CityRow[]>();
  for (const c of citiesResult.rows) {
    const code = (c.country_code ?? "").toUpperCase();
    const list = byCountry.get(code) ?? [];
    list.push(c);
    byCountry.set(code, list);
  }

  const countries = Array.from(byCountry.entries()).map(([code, cities]) => {
    const meta = COUNTRY_META[code] ?? { name: code, currency: "USD" };

    // Prefer the country-level free delivery settings from the most prominent city.
    const firstCity = cities[0]!;
    const countryFreeDelivery = cities.some((c) => c.free_delivery_enabled);
    const countryFreeThreshold = cities
      .map((c) => (c.free_delivery_threshold != null ? parseFloat(c.free_delivery_threshold) : null))
      .find((v) => v != null) ?? null;

    return {
      id: code.toLowerCase(),
      name: meta.name,
      code: code.toLowerCase(),
      currency: meta.currency,
      isActive: true,
      preferredDefaultCityId: firstCity.slug,
      freeDeliveryEnabled: countryFreeDelivery,
      freeDeliveryThreshold: countryFreeThreshold,
      cities: cities.map((city) => {
        const deliveryFee = parseFloat(city.delivery_fee);
        const expressFeeTotal = city.express_delivery_fee != null
          ? parseFloat(city.express_delivery_fee) : null;
        const expressSurcharge = expressFeeTotal != null
          ? Math.max(0, expressFeeTotal - deliveryFee) : null;

        const slots = (slotsByCity.get(city.id) ?? []).map((s) => {
          const startHour = parseHour(s.start_time);
          const endHour = parseHour(s.end_time);
          const cutoffHour = parseHour(s.cutoff_time);
          const extraFee = s.fee_override != null
            ? Math.max(0, parseFloat(s.fee_override) - deliveryFee) : 0;
          return {
            label: s.label,
            startHour,
            endHour,
            cutoffHour,
            extraFee,
          };
        });

        return {
          id: city.slug,
          name: city.name,
          isActive: city.is_active,
          deliveryFee,
          expressSurcharge,
          expressFeeTotal,
          expressAvailable: city.express_delivery_enabled,
          sameDayCutoffHour: parseHour(city.express_delivery_cutoff_time),
          freeDeliveryEnabled: city.free_delivery_enabled,
          freeDeliveryThreshold: city.free_delivery_threshold != null
            ? parseFloat(city.free_delivery_threshold) : null,
          timeSlots: slots,
        };
      }),
    };
  });

  res.json({ countries });
}

router.get("/delivery-locations-ext", async (req: Request, res: Response) => {
  await handleDeliveryLocationsExt(db, req, res);
});

export default router;
