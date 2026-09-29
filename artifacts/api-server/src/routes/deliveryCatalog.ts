import { Router, type Request, type Response } from "express";
import { db } from "../lib/db";
import { resolveApiKeyWorkspace } from "../lib/apiKeyAuth";

const router = Router();

/**
 * GET /api/delivery-catalog
 *
 * Public read-only endpoint returning all active delivery cities for the
 * workspace, including weekly timeslots, special date overrides, and the
 * override-specific slot configurations within each override period.
 *
 * Authentication (in priority order):
 *   1. `Authorization: Bearer pk_live_...` header (API key)
 *   2. `?workspace=<slug>` query param (workspace slug or owner ID)
 *
 * Response shape:
 *   {
 *     cities: [{
 *       ...cityFields,
 *       timeslots: [...],
 *       special_overrides: [{
 *         ...overrideFields,
 *         slots: [...]   ← per-override slot configurations
 *       }]
 *     }]
 *   }
 */
router.get("/delivery-catalog", async (req: Request, res: Response) => {
  let ownerId: string | null = await resolveApiKeyWorkspace(req);

  if (!ownerId) {
    const workspaceParam = req.query.workspace;
    if (typeof workspaceParam === "string" && workspaceParam.trim()) {
      const param = workspaceParam.trim();
      if (param.startsWith("user_")) {
        ownerId = param;
      } else {
        const slugResult = await db.query<{ workspace_owner_id: string }>(
          `SELECT workspace_owner_id FROM workspace_settings WHERE workspace_slug = $1 LIMIT 1`,
          [param],
        );
        ownerId = slugResult.rows[0]?.workspace_owner_id ?? null;
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

  const citiesResult = await db.query<CityRow>(
    `SELECT id, name, slug, country_code, sort_order, is_active,
            delivery_fee, free_delivery_enabled, free_delivery_threshold,
            express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time
       FROM delivery_cities
      WHERE workspace_owner_id = $1
        AND is_active = true
      ORDER BY sort_order ASC, name ASC`,
    [ownerId],
  );

  if (citiesResult.rowCount === 0) {
    res.json({ cities: [] });
    return;
  }

  const cityIds = citiesResult.rows.map((c) => c.id);

  type SlotRow = {
    city_id: number;
    id: number;
    day_of_week: number;
    start_time: string;
    end_time: string;
    label: string;
    is_enabled: boolean;
    delivery_type: string;
    fee_override: string | null;
    capacity: number | null;
    sort_order: number;
  };

  type OverrideRow = {
    id: number;
    city_id: number | null;
    name: string;
    start_date: string;
    end_date: string;
    override_type: string;
    is_active: boolean;
  };

  type OverrideSlotRow = {
    override_id: number;
    id: number;
    label: string;
    start_time: string;
    end_time: string;
    is_enabled: boolean;
    fee_override: string | null;
    cutoff_time: string | null;
    capacity: number | null;
    sort_order: number;
  };

  const [slotsResult, overridesResult] = await Promise.all([
    db.query<SlotRow>(
      `SELECT city_id, id, day_of_week, start_time, end_time, label,
              is_enabled, delivery_type, fee_override, capacity, sort_order
         FROM district_weekly_delivery_slots
        WHERE workspace_owner_id = $1
          AND city_id = ANY($2)
        ORDER BY city_id ASC, day_of_week ASC, sort_order ASC, id ASC`,
      [ownerId, cityIds],
    ),
    db.query<OverrideRow>(
      `SELECT id, city_id, name, start_date, end_date, override_type, is_active
         FROM district_special_date_overrides
        WHERE workspace_owner_id = $1
          AND city_id = ANY($2)
          AND is_active = true
        ORDER BY city_id ASC, start_date ASC`,
      [ownerId, cityIds],
    ),
  ]);

  const slotsByCity = new Map<number, SlotRow[]>();
  for (const s of slotsResult.rows) {
    const list = slotsByCity.get(s.city_id) ?? [];
    list.push(s);
    slotsByCity.set(s.city_id, list);
  }

  const overrideIds = overridesResult.rows.map((o) => o.id);
  let overrideSlotsByOverride = new Map<number, OverrideSlotRow[]>();

  if (overrideIds.length > 0) {
    const overrideSlotsResult = await db.query<OverrideSlotRow>(
      `SELECT override_id, id, label, start_time, end_time, is_enabled,
              fee_override, cutoff_time, capacity, sort_order
         FROM district_special_date_override_slots
        WHERE override_id = ANY($1)
        ORDER BY override_id ASC, sort_order ASC, id ASC`,
      [overrideIds],
    );
    for (const s of overrideSlotsResult.rows) {
      const list = overrideSlotsByOverride.get(s.override_id) ?? [];
      list.push(s);
      overrideSlotsByOverride.set(s.override_id, list);
    }
  }

  const overridesByCity = new Map<number, OverrideRow[]>();
  for (const o of overridesResult.rows) {
    if (o.city_id == null) continue;
    const list = overridesByCity.get(o.city_id) ?? [];
    list.push(o);
    overridesByCity.set(o.city_id, list);
  }

  const cities = citiesResult.rows.map((city) => ({
    id: city.id,
    name: city.name,
    slug: city.slug,
    country_code: city.country_code,
    sort_order: city.sort_order,
    is_active: city.is_active,
    delivery_fee: parseFloat(city.delivery_fee),
    free_delivery_enabled: city.free_delivery_enabled,
    free_delivery_threshold: city.free_delivery_threshold != null ? parseFloat(city.free_delivery_threshold) : null,
    express_delivery_enabled: city.express_delivery_enabled,
    express_delivery_fee: city.express_delivery_fee != null ? parseFloat(city.express_delivery_fee) : null,
    express_delivery_cutoff_time: city.express_delivery_cutoff_time ?? null,
    timeslots: (slotsByCity.get(city.id) ?? []).map((s) => ({
      id: s.id,
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
      label: s.label,
      is_enabled: s.is_enabled,
      delivery_type: s.delivery_type,
      fee_override: s.fee_override != null ? parseFloat(s.fee_override) : null,
      capacity: s.capacity,
      sort_order: s.sort_order,
    })),
    special_overrides: (overridesByCity.get(city.id) ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      start_date: o.start_date,
      end_date: o.end_date,
      override_type: o.override_type,
      is_active: o.is_active,
      slots: (overrideSlotsByOverride.get(o.id) ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        start_time: s.start_time,
        end_time: s.end_time,
        is_enabled: s.is_enabled,
        fee_override: s.fee_override != null ? parseFloat(s.fee_override) : null,
        cutoff_time: s.cutoff_time ?? null,
        capacity: s.capacity,
        sort_order: s.sort_order,
      })),
    })),
  }));

  res.json({ cities });
});

export default router;
