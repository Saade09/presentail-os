import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { fireDeliveryWebhookAsync, fireDeliveryConfigUpdated } from "../lib/deliveryWebhook";
import { fireDeliveryConfigWebhook } from "../lib/catalogWebhook";

/**
 * Task #652 — District-level delivery scheduling engine.
 *
 * Extends `cities` (delivery districts) with:
 *   - Extended express settings  (GET/PATCH /cities/:id/express-settings)
 *   - Weekly day-of-week slots   (CRUD /cities/:id/weekly-slots)
 *   - Slot copy utility          (POST /cities/:id/weekly-slots/copy)
 *   - Special date overrides     (CRUD /delivery-overrides)
 *   - Override slots             (CRUD /delivery-overrides/:overrideId/slots)
 *   - Availability query         (GET /delivery-availability?districtId=&date=)
 */

const router = Router();

// ── Auth guard for admin routes ──────────────────────────────────────────────
router.use(requireAuth, resolveWorkspace);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOwnerOrCitiesAdmin(req: Parameters<typeof workspace>[0]): boolean {
  const wreq = workspace(req);
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.includes("cities.manage") ?? false)
  );
}

async function getCityOwner(
  cityId: number,
  ownerId: string,
): Promise<{ id: number } | null> {
  const r = await db.query<{ id: number }>(
    `SELECT id FROM delivery_cities WHERE id = $1 AND workspace_owner_id = $2`,
    [cityId, ownerId],
  );
  return r.rows[0] ?? null;
}

// ── Shared slot row schema ─────────────────────────────────────────────────────

const SlotWriteSchema = z.object({
  label: z.string().max(200).optional(),
  start_time: z.string().regex(/^\d{1,2}:\d{2}$/, "start_time must be HH:MM").min(1),
  end_time: z.string().regex(/^\d{1,2}:\d{2}$/, "end_time must be HH:MM").min(1),
  is_enabled: z.boolean().optional(),
  fee_override: z.number().min(0).nullable().optional(),
  cutoff_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  capacity: z.number().int().min(1).nullable().optional(),
  internal_note: z.string().max(1000).nullable().optional(),
  sort_order: z.number().int().optional(),
  delivery_type: z.enum(["standard", "express"]).optional(),
  same_day_available: z.boolean().optional(),
  next_day_available: z.boolean().optional(),
});

type SlotRow = {
  id: number;
  city_id?: number;
  override_id?: number;
  day_of_week?: number;
  label: string;
  start_time: string;
  end_time: string;
  is_enabled: boolean;
  fee_override: string | null;
  cutoff_time: string | null;
  capacity: number | null;
  internal_note: string | null;
  sort_order: number;
  delivery_type: string;
  same_day_available: boolean;
  next_day_available: boolean;
  created_at: string;
  updated_at?: string | null;
};

// ── Express settings ──────────────────────────────────────────────────────────

router.get("/cities/:id/express-settings", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  if (Number.isNaN(cityId)) { res.status(400).json({ error: "Invalid city id" }); return; }

  const cityCheck = await getCityOwner(cityId, ownerId);
  if (!cityCheck) { res.status(404).json({ error: "City not found" }); return; }

  const r = await db.query<{
    city_id: number;
    express_enabled: boolean;
    express_start_time: string | null;
    express_end_time: string | null;
    express_min_prep_minutes: number | null;
    express_daily_capacity: number | null;
    express_fee: string | null;
    express_cutoff_time: string | null;
  }>(
    `SELECT city_id, express_enabled, express_start_time, express_end_time,
            express_min_prep_minutes, express_daily_capacity,
            express_fee, express_cutoff_time
       FROM district_delivery_settings
      WHERE city_id = $1`,
    [cityId],
  );

  const row = r.rows[0] ?? {
    city_id: cityId,
    express_enabled: true,
    express_start_time: null,
    express_end_time: null,
    express_min_prep_minutes: null,
    express_daily_capacity: null,
    express_fee: null,
    express_cutoff_time: null,
  };
  res.json({ express_settings: row });
});

const ExpressSettingsPatchSchema = z.object({
  express_enabled: z.boolean().optional(),
  express_start_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  express_end_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  express_min_prep_minutes: z.number().int().min(0).nullable().optional(),
  express_daily_capacity: z.number().int().min(1).nullable().optional(),
  express_fee: z.number().min(0).nullable().optional(),
  express_cutoff_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
});

router.patch("/cities/:id/express-settings", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may update express settings" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  if (Number.isNaN(cityId)) { res.status(400).json({ error: "Invalid city id" }); return; }

  const cityCheck = await getCityOwner(cityId, ownerId);
  if (!cityCheck) { res.status(404).json({ error: "City not found" }); return; }

  const parsed = ExpressSettingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const d = parsed.data;
  const r = await db.query<{
    city_id: number;
    express_enabled: boolean;
    express_start_time: string | null;
    express_end_time: string | null;
    express_min_prep_minutes: number | null;
    express_daily_capacity: number | null;
    express_fee: string | null;
    express_cutoff_time: string | null;
  }>(
    `INSERT INTO district_delivery_settings
       (city_id, workspace_owner_id, express_enabled, express_start_time, express_end_time,
        express_min_prep_minutes, express_daily_capacity, express_fee, express_cutoff_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (city_id) DO UPDATE
       SET express_enabled          = COALESCE($3, district_delivery_settings.express_enabled),
           express_start_time       = COALESCE($4, district_delivery_settings.express_start_time),
           express_end_time         = COALESCE($5, district_delivery_settings.express_end_time),
           express_min_prep_minutes = COALESCE($6, district_delivery_settings.express_min_prep_minutes),
           express_daily_capacity   = COALESCE($7, district_delivery_settings.express_daily_capacity),
           express_fee              = COALESCE($8, district_delivery_settings.express_fee),
           express_cutoff_time      = COALESCE($9, district_delivery_settings.express_cutoff_time),
           updated_at               = now()
     RETURNING city_id, express_enabled, express_start_time, express_end_time,
               express_min_prep_minutes, express_daily_capacity, express_fee, express_cutoff_time`,
    [
      cityId, ownerId,
      d.express_enabled ?? null,
      d.express_start_time ?? null,
      d.express_end_time ?? null,
      d.express_min_prep_minutes ?? null,
      d.express_daily_capacity ?? null,
      d.express_fee ?? null,
      d.express_cutoff_time ?? null,
    ],
  );
  void fireDeliveryConfigUpdated(ownerId);
  res.json({ express_settings: r.rows[0] });
});

// ── Schedule summary ─────────────────────────────────────────────────────────

router.get("/cities/:id/schedule-summary", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  if (Number.isNaN(cityId)) { res.status(400).json({ error: "Invalid city id" }); return; }

  const cityCheck = await getCityOwner(cityId, ownerId);
  if (!cityCheck) { res.status(404).json({ error: "City not found" }); return; }

  const [slotsResult, sundayResult, overridesResult, expressResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM district_weekly_delivery_slots WHERE city_id = $1 AND is_enabled = true`,
      [cityId],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM district_weekly_delivery_slots WHERE city_id = $1 AND day_of_week = 0 AND is_enabled = true`,
      [cityId],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM district_special_date_overrides WHERE city_id = $1 AND is_active = true`,
      [cityId],
    ),
    db.query<{ express_start_time: string | null }>(
      `SELECT express_start_time FROM district_delivery_settings WHERE city_id = $1`,
      [cityId],
    ),
  ]);

  res.json({
    enabled_weekly_slots: parseInt(slotsResult.rows[0]?.count ?? "0", 10),
    sunday_enabled_slots: parseInt(sundayResult.rows[0]?.count ?? "0", 10),
    active_overrides: parseInt(overridesResult.rows[0]?.count ?? "0", 10),
    express_window_configured: expressResult.rows[0]?.express_start_time != null,
  });
});

// ── Weekly slots ──────────────────────────────────────────────────────────────

const SLOT_COLS = `id, city_id, day_of_week, label, start_time, end_time,
  is_enabled, fee_override, cutoff_time, capacity, internal_note, sort_order,
  delivery_type, same_day_available, next_day_available,
  created_at, updated_at`;

function normalizeSlotTime(time: string): string {
  const [hours, minutes] = time.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

type WeeklySlotIdentity = Pick<
  SlotRow,
  "city_id" | "day_of_week" | "start_time" | "end_time" | "delivery_type"
>;

export function weeklySlotNaturalKey(slot: WeeklySlotIdentity): string {
  return [
    slot.city_id ?? "",
    slot.day_of_week ?? "",
    (slot.delivery_type ?? "standard").trim().toLowerCase(),
    normalizeSlotTime(slot.start_time),
    normalizeSlotTime(slot.end_time),
  ].join("|");
}

/**
 * Never copy historical repetition into a clean target. If legacy rows with
 * the same identity disagree, preserve public availability first, then the
 * most recently edited representation, then stable sort/id order.
 */
export function dedupeWeeklySlots(slots: SlotRow[]): SlotRow[] {
  const selected = new Map<string, SlotRow>();
  for (const slot of slots) {
    const key = weeklySlotNaturalKey(slot);
    const previous = selected.get(key);
    const slotUpdated = Date.parse(slot.updated_at ?? slot.created_at);
    const previousUpdated = previous
      ? Date.parse(previous.updated_at ?? previous.created_at)
      : Number.NEGATIVE_INFINITY;
    if (
      !previous ||
      (!previous.is_enabled && slot.is_enabled) ||
      (previous.is_enabled === slot.is_enabled && slotUpdated > previousUpdated) ||
      (previous.is_enabled === slot.is_enabled &&
        slotUpdated === previousUpdated &&
        (slot.sort_order < previous.sort_order ||
          (slot.sort_order === previous.sort_order && slot.id < previous.id)))
    ) {
      selected.set(key, slot);
    }
  }
  return [...selected.values()].sort(
    (a, b) =>
      (a.day_of_week ?? 0) - (b.day_of_week ?? 0) ||
      a.sort_order - b.sort_order ||
      a.id - b.id,
  );
}

function respondToWeeklySlotConflict(error: unknown, res: Response): boolean {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  ) {
    res.status(409).json({
      error: "A weekly delivery slot with this day, delivery type, and time already exists",
    });
    return true;
  }
  return false;
}

router.get("/cities/:id/weekly-slots", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  if (Number.isNaN(cityId)) { res.status(400).json({ error: "Invalid city id" }); return; }

  const cityCheck = await getCityOwner(cityId, ownerId);
  if (!cityCheck) { res.status(404).json({ error: "City not found" }); return; }

  const dayFilter = req.query.day_of_week !== undefined
    ? parseInt(String(req.query.day_of_week), 10)
    : null;

  if (dayFilter !== null && (Number.isNaN(dayFilter) || dayFilter < 0 || dayFilter > 6)) {
    res.status(400).json({ error: "day_of_week must be 0–6" });
    return;
  }

  const conds = ["city_id = $1", "workspace_owner_id = $2"];
  const params: unknown[] = [cityId, ownerId];
  if (dayFilter !== null) {
    params.push(dayFilter);
    conds.push(`day_of_week = $${params.length}`);
  }

  const rows = await db.query<SlotRow>(
    `SELECT ${SLOT_COLS}
       FROM district_weekly_delivery_slots
      WHERE ${conds.join(" AND ")}
      ORDER BY day_of_week ASC, sort_order ASC, id ASC`,
    params,
  );
  res.json({ slots: rows.rows });
});

const WeeklySlotCreateSchema = SlotWriteSchema.extend({
  day_of_week: z.number().int().min(0).max(6),
});

router.post("/cities/:id/weekly-slots", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  if (Number.isNaN(cityId)) { res.status(400).json({ error: "Invalid city id" }); return; }

  const cityCheck = await getCityOwner(cityId, ownerId);
  if (!cityCheck) { res.status(404).json({ error: "City not found" }); return; }

  const parsed = WeeklySlotCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const d = parsed.data;
  const nextSort = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
       FROM district_weekly_delivery_slots
      WHERE city_id = $1 AND day_of_week = $2`,
    [cityId, d.day_of_week],
  );
  const sortOrder = d.sort_order ?? nextSort.rows[0]?.next ?? 0;

  let r;
  try {
    r = await db.query<SlotRow>(
      `INSERT INTO district_weekly_delivery_slots
         (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
          is_enabled, fee_override, cutoff_time, capacity, internal_note, sort_order,
          delivery_type, same_day_available, next_day_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${SLOT_COLS}`,
      [
        cityId, ownerId, d.day_of_week, d.label ?? "",
        normalizeSlotTime(d.start_time), normalizeSlotTime(d.end_time), d.is_enabled ?? true,
        d.fee_override ?? null, d.cutoff_time ?? null, d.capacity ?? null,
        d.internal_note ?? null, sortOrder,
        d.delivery_type ?? "standard", d.same_day_available ?? false, d.next_day_available ?? true,
      ],
    );
  } catch (error) {
    if (respondToWeeklySlotConflict(error, res)) return;
    throw error;
  }
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { city_id: cityId });
  void fireDeliveryConfigUpdated(ownerId);
  res.status(201).json({ slot: r.rows[0] });
});

router.patch("/cities/:id/weekly-slots/:slotId", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  const slotId = parseInt(req.params.slotId, 10);
  if (Number.isNaN(cityId) || Number.isNaN(slotId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const existing = await db.query<SlotRow>(
    `SELECT ${SLOT_COLS} FROM district_weekly_delivery_slots
      WHERE id = $1 AND city_id = $2 AND workspace_owner_id = $3`,
    [slotId, cityId, ownerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Slot not found" }); return; }
  const prev = existing.rows[0];

  const parsed = SlotWriteSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;

  let r;
  try {
    r = await db.query<SlotRow>(
      `UPDATE district_weekly_delivery_slots
        SET label              = $1,
            start_time         = $2,
            end_time           = $3,
            is_enabled         = $4,
            fee_override       = $5,
            cutoff_time        = $6,
            capacity           = $7,
            internal_note      = $8,
            sort_order         = $9,
            delivery_type      = $10,
            same_day_available = $11,
            next_day_available = $12,
            updated_at         = now()
      WHERE id = $13 AND city_id = $14 AND workspace_owner_id = $15
      RETURNING ${SLOT_COLS}`,
      [
      d.label ?? prev.label,
      normalizeSlotTime(d.start_time ?? prev.start_time),
      normalizeSlotTime(d.end_time ?? prev.end_time),
      d.is_enabled ?? prev.is_enabled,
      "fee_override" in d ? d.fee_override : (prev.fee_override !== null ? parseFloat(prev.fee_override) : null),
      "cutoff_time" in d ? d.cutoff_time : prev.cutoff_time,
      "capacity" in d ? d.capacity : prev.capacity,
      "internal_note" in d ? d.internal_note : prev.internal_note,
      d.sort_order ?? prev.sort_order,
      d.delivery_type ?? prev.delivery_type,
      d.same_day_available ?? prev.same_day_available,
      d.next_day_available ?? prev.next_day_available,
      slotId, cityId, ownerId,
      ],
    );
  } catch (error) {
    if (respondToWeeklySlotConflict(error, res)) return;
    throw error;
  }
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { city_id: cityId });
  void fireDeliveryConfigUpdated(ownerId);
  res.json({ slot: r.rows[0] });
});

router.delete("/cities/:id/weekly-slots/:slotId", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  const slotId = parseInt(req.params.slotId, 10);
  if (Number.isNaN(cityId) || Number.isNaN(slotId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const check = await db.query(
    `SELECT id FROM district_weekly_delivery_slots
      WHERE id = $1 AND city_id = $2 AND workspace_owner_id = $3`,
    [slotId, cityId, ownerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Slot not found" }); return; }

  await db.query(
    `DELETE FROM district_weekly_delivery_slots WHERE id = $1`,
    [slotId],
  );
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { city_id: cityId });
  void fireDeliveryConfigUpdated(ownerId);
  res.json({ ok: true });
});

// ── Weekly slots — bulk copy ──────────────────────────────────────────────────

const CopySchema = z.union([
  z
    .object({
      from_day: z.number().int().min(0).max(6),
      to_days: z.array(z.number().int().min(0).max(6)).optional().default([]),
      to_city_ids: z.array(z.number().int()).optional().default([]),
    })
    .refine((d) => d.to_days.length > 0 || d.to_city_ids.length > 0, {
      message: "Select at least one target day or city",
    }),
  z.object({
    from_city_id: z.number().int(),
    to_city_id: z.number().int(),
  }),
]);

router.post("/cities/:id/weekly-slots/copy", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may copy slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const cityId = parseInt(req.params.id, 10);
  if (Number.isNaN(cityId)) { res.status(400).json({ error: "Invalid city id" }); return; }

  const cityCheck = await getCityOwner(cityId, ownerId);
  if (!cityCheck) { res.status(404).json({ error: "City not found" }); return; }

  const parsed = CopySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const data = parsed.data;

  if ("from_day" in data) {
    // Copy from one day to other days within the same city and/or to the
    // same weekday in other cities.
    const sourceSlots = await db.query<SlotRow>(
      `SELECT ${SLOT_COLS} FROM district_weekly_delivery_slots
        WHERE city_id = $1 AND day_of_week = $2 AND workspace_owner_id = $3
        ORDER BY sort_order ASC, id ASC`,
      [cityId, data.from_day, ownerId],
    );

    // Refuse to copy an empty source — otherwise we would silently wipe the
    // target day(s)/city(ies) and leave them with no slots.
    if (sourceSlots.rows.length === 0) {
      res.status(400).json({ error: "Source day has no slots to copy" });
      return;
    }
    const dedupedSourceSlots = dedupeWeeklySlots(sourceSlots.rows);

    // Validate any target cities up front (must belong to this workspace).
    const targetCityIds = data.to_city_ids.filter((id) => id !== cityId);
    if (targetCityIds.length > 0) {
      const owned = await db.query<{ id: number }>(
        `SELECT id FROM delivery_cities WHERE id = ANY($1::int[]) AND workspace_owner_id = $2`,
        [targetCityIds, ownerId],
      );
      const ownedIds = new Set(owned.rows.map((r) => r.id));
      const missing = targetCityIds.find((id) => !ownedIds.has(id));
      if (missing !== undefined) {
        res.status(404).json({ error: "Target city not found" });
        return;
      }
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      let totalInserted = 0;
      for (const targetDay of data.to_days) {
        if (targetDay === data.from_day) continue;
        // Remove existing slots for the target day
        await client.query(
          `DELETE FROM district_weekly_delivery_slots WHERE city_id = $1 AND day_of_week = $2 AND workspace_owner_id = $3`,
          [cityId, targetDay, ownerId],
        );
        // Copy source slots
        for (const s of dedupedSourceSlots) {
          await client.query(
            `INSERT INTO district_weekly_delivery_slots
               (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
                is_enabled, fee_override, cutoff_time, capacity, internal_note, sort_order,
                delivery_type, same_day_available, next_day_available)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              cityId, ownerId, targetDay, s.label,
              normalizeSlotTime(s.start_time), normalizeSlotTime(s.end_time), s.is_enabled,
              s.fee_override !== null ? parseFloat(s.fee_override) : null,
              s.cutoff_time, s.capacity, s.internal_note, s.sort_order,
              s.delivery_type ?? "standard", s.same_day_available ?? false, s.next_day_available ?? true,
            ],
          );
          totalInserted++;
        }
      }
      // Copy the source day's slots to the same weekday in other cities.
      for (const targetCityId of targetCityIds) {
        // Remove existing slots for that weekday in the target city
        await client.query(
          `DELETE FROM district_weekly_delivery_slots WHERE city_id = $1 AND day_of_week = $2 AND workspace_owner_id = $3`,
          [targetCityId, data.from_day, ownerId],
        );
        for (const s of dedupedSourceSlots) {
          await client.query(
            `INSERT INTO district_weekly_delivery_slots
               (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
                is_enabled, fee_override, cutoff_time, capacity, internal_note, sort_order,
                delivery_type, same_day_available, next_day_available)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              targetCityId, ownerId, data.from_day, s.label,
              normalizeSlotTime(s.start_time), normalizeSlotTime(s.end_time), s.is_enabled,
              s.fee_override !== null ? parseFloat(s.fee_override) : null,
              s.cutoff_time, s.capacity, s.internal_note, s.sort_order,
              s.delivery_type ?? "standard", s.same_day_available ?? false, s.next_day_available ?? true,
            ],
          );
          totalInserted++;
        }
      }
      await client.query("COMMIT");
      fireDeliveryWebhookAsync(ownerId);
      void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { city_id: cityId });
      void fireDeliveryConfigUpdated(ownerId);
      res.json({ ok: true, inserted: totalInserted });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (respondToWeeklySlotConflict(err, res)) return;
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Copy all slots from one city to another
    const toCityCheck = await getCityOwner(data.to_city_id, ownerId);
    if (!toCityCheck) { res.status(404).json({ error: "Target city not found" }); return; }

    const sourceSlots = await db.query<SlotRow>(
      `SELECT ${SLOT_COLS} FROM district_weekly_delivery_slots
        WHERE city_id = $1 AND workspace_owner_id = $2
        ORDER BY day_of_week ASC, sort_order ASC, id ASC`,
      [data.from_city_id, ownerId],
    );

    const dedupedSourceSlots = dedupeWeeklySlots(sourceSlots.rows);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM district_weekly_delivery_slots WHERE city_id = $1 AND workspace_owner_id = $2`,
        [data.to_city_id, ownerId],
      );
      for (const s of dedupedSourceSlots) {
        await client.query(
          `INSERT INTO district_weekly_delivery_slots
             (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
              is_enabled, fee_override, cutoff_time, capacity, internal_note, sort_order,
              delivery_type, same_day_available, next_day_available)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            data.to_city_id, ownerId, s.day_of_week, s.label,
            normalizeSlotTime(s.start_time), normalizeSlotTime(s.end_time), s.is_enabled,
            s.fee_override !== null ? parseFloat(s.fee_override) : null,
            s.cutoff_time, s.capacity, s.internal_note, s.sort_order,
            s.delivery_type ?? "standard", s.same_day_available ?? false, s.next_day_available ?? true,
          ],
        );
      }
      await client.query("COMMIT");
      fireDeliveryWebhookAsync(ownerId);
      void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { target_city_id: data.to_city_id });
      void fireDeliveryConfigUpdated(ownerId);
      res.json({ ok: true, inserted: dedupedSourceSlots.length });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (respondToWeeklySlotConflict(err, res)) return;
      throw err;
    } finally {
      client.release();
    }
  }
});

// ── Special date overrides ────────────────────────────────────────────────────

const OVERRIDE_COLS = `id, workspace_owner_id, city_id, country_code, name,
  start_date, end_date, override_type,
  express_enabled, express_start_time, express_end_time, express_cutoff_time,
  express_fee, express_min_prep_minutes, express_daily_capacity,
  internal_note, is_active, created_at, updated_at`;

const OverrideWriteSchema = z.object({
  name: z.string().min(1).max(200),
  city_id: z.number().int().nullable().optional(),
  country_code: z.string().max(10).nullable().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start_date must be YYYY-MM-DD"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date must be YYYY-MM-DD"),
  override_type: z.enum(["replace_regular_schedule", "add_to_regular_schedule"]).optional(),
  express_enabled: z.boolean().optional(),
  express_start_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  express_end_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  express_cutoff_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  express_fee: z.number().min(0).nullable().optional(),
  express_min_prep_minutes: z.number().int().min(0).nullable().optional(),
  express_daily_capacity: z.number().int().min(1).nullable().optional(),
  internal_note: z.string().max(1000).nullable().optional(),
  is_active: z.boolean().optional(),
});

type OverrideRow = {
  id: number;
  workspace_owner_id: string;
  city_id: number | null;
  country_code: string | null;
  name: string;
  start_date: string;
  end_date: string;
  override_type: string;
  express_enabled: boolean;
  express_start_time: string | null;
  express_end_time: string | null;
  express_cutoff_time: string | null;
  express_fee: string | null;
  express_min_prep_minutes: number | null;
  express_daily_capacity: number | null;
  internal_note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

router.get("/delivery-overrides", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const conds = ["workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  if (req.query.city_id) {
    const cid = parseInt(String(req.query.city_id), 10);
    if (!Number.isNaN(cid)) { params.push(cid); conds.push(`city_id = $${params.length}`); }
  }
  if (req.query.country_code) {
    params.push(String(req.query.country_code).toUpperCase());
    conds.push(`country_code = $${params.length}`);
  }
  if (req.query.date) {
    params.push(req.query.date);
    conds.push(`start_date <= $${params.length}::date AND end_date >= $${params.length}::date`);
  }
  if (req.query.active_only === "true") {
    conds.push(`is_active = true`);
  }

  const rows = await db.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLS} FROM district_special_date_overrides
      WHERE ${conds.join(" AND ")}
      ORDER BY start_date ASC, name ASC`,
    params,
  );
  res.json({ overrides: rows.rows });
});

router.post("/delivery-overrides", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage overrides" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const parsed = OverrideWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;

  if (d.city_id != null) {
    const check = await getCityOwner(d.city_id, ownerId);
    if (!check) { res.status(404).json({ error: "City not found" }); return; }
  }

  if (d.start_date > d.end_date) {
    res.status(400).json({ error: "start_date must be on or before end_date" });
    return;
  }

  const r = await db.query<OverrideRow>(
    `INSERT INTO district_special_date_overrides
       (workspace_owner_id, city_id, country_code, name, start_date, end_date,
        override_type, express_enabled, express_start_time, express_end_time,
        express_cutoff_time, express_fee, express_min_prep_minutes,
        express_daily_capacity, internal_note, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${OVERRIDE_COLS}`,
    [
      ownerId, d.city_id ?? null, d.country_code ?? null,
      d.name, d.start_date, d.end_date,
      d.override_type ?? "replace_regular_schedule",
      d.express_enabled ?? false,
      d.express_start_time ?? null, d.express_end_time ?? null,
      d.express_cutoff_time ?? null, d.express_fee ?? null,
      d.express_min_prep_minutes ?? null, d.express_daily_capacity ?? null,
      d.internal_note ?? null, d.is_active ?? true,
    ],
  );
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, {
    override_id: r.rows[0]?.id,
    city_id: d.city_id ?? null,
    action: "created",
  });
  res.status(201).json({ override: r.rows[0] });
});

router.get("/delivery-overrides/:overrideId", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  if (Number.isNaN(overrideId)) { res.status(400).json({ error: "Invalid override id" }); return; }

  const r = await db.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLS} FROM district_special_date_overrides
      WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (r.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }
  res.json({ override: r.rows[0] });
});

router.patch("/delivery-overrides/:overrideId", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage overrides" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  if (Number.isNaN(overrideId)) { res.status(400).json({ error: "Invalid override id" }); return; }

  const existing = await db.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLS} FROM district_special_date_overrides
      WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }
  const prev = existing.rows[0];

  const parsed = OverrideWriteSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;

  const startDate = d.start_date ?? prev.start_date;
  const endDate = d.end_date ?? prev.end_date;
  if (startDate > endDate) {
    res.status(400).json({ error: "start_date must be on or before end_date" });
    return;
  }

  if (d.city_id !== undefined && d.city_id !== null) {
    const check = await getCityOwner(d.city_id, ownerId);
    if (!check) { res.status(404).json({ error: "City not found" }); return; }
  }

  const r = await db.query<OverrideRow>(
    `UPDATE district_special_date_overrides
        SET name                    = $1,
            city_id                 = $2,
            country_code            = $3,
            start_date              = $4,
            end_date                = $5,
            override_type           = $6,
            express_enabled         = $7,
            express_start_time      = $8,
            express_end_time        = $9,
            express_cutoff_time     = $10,
            express_fee             = $11,
            express_min_prep_minutes = $12,
            express_daily_capacity  = $13,
            internal_note           = $14,
            is_active               = $15,
            updated_at              = now()
      WHERE id = $16 AND workspace_owner_id = $17
      RETURNING ${OVERRIDE_COLS}`,
    [
      d.name ?? prev.name,
      "city_id" in d ? d.city_id : prev.city_id,
      "country_code" in d ? d.country_code : prev.country_code,
      startDate, endDate,
      d.override_type ?? prev.override_type,
      d.express_enabled ?? prev.express_enabled,
      "express_start_time" in d ? d.express_start_time : prev.express_start_time,
      "express_end_time" in d ? d.express_end_time : prev.express_end_time,
      "express_cutoff_time" in d ? d.express_cutoff_time : prev.express_cutoff_time,
      "express_fee" in d ? d.express_fee : (prev.express_fee !== null ? parseFloat(prev.express_fee) : null),
      "express_min_prep_minutes" in d ? d.express_min_prep_minutes : prev.express_min_prep_minutes,
      "express_daily_capacity" in d ? d.express_daily_capacity : prev.express_daily_capacity,
      "internal_note" in d ? d.internal_note : prev.internal_note,
      d.is_active ?? prev.is_active,
      overrideId, ownerId,
    ],
  );
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, {
    override_id: overrideId,
    city_id: r.rows[0]?.city_id ?? prev.city_id ?? null,
    action: "updated",
  });
  res.json({ override: r.rows[0] });
});

router.delete("/delivery-overrides/:overrideId", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage overrides" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  if (Number.isNaN(overrideId)) { res.status(400).json({ error: "Invalid override id" }); return; }

  const check = await db.query(
    `SELECT id FROM district_special_date_overrides WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }

  await db.query(`DELETE FROM district_special_date_overrides WHERE id = $1`, [overrideId]);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, {
    override_id: overrideId,
    action: "deleted",
  });
  res.json({ ok: true });
});

// ── Override slots ────────────────────────────────────────────────────────────

const OVERRIDE_SLOT_COLS = `id, override_id, label, start_time, end_time,
  is_enabled, fee_override, cutoff_time, capacity, internal_note, sort_order,
  delivery_type, same_day_available, next_day_available, created_at`;

router.get("/delivery-overrides/:overrideId/slots", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  if (Number.isNaN(overrideId)) { res.status(400).json({ error: "Invalid override id" }); return; }

  const overrideCheck = await db.query(
    `SELECT id FROM district_special_date_overrides WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (overrideCheck.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }

  const rows = await db.query(
    `SELECT ${OVERRIDE_SLOT_COLS} FROM district_special_date_override_slots
      WHERE override_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [overrideId],
  );
  res.json({ slots: rows.rows });
});

router.post("/delivery-overrides/:overrideId/slots", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage override slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  if (Number.isNaN(overrideId)) { res.status(400).json({ error: "Invalid override id" }); return; }

  const overrideCheck = await db.query(
    `SELECT id FROM district_special_date_overrides WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (overrideCheck.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }

  const parsed = SlotWriteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;

  const nextSort = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM district_special_date_override_slots WHERE override_id = $1`,
    [overrideId],
  );
  const sortOrder = d.sort_order ?? nextSort.rows[0]?.next ?? 0;

  const r = await db.query(
    `INSERT INTO district_special_date_override_slots
       (override_id, label, start_time, end_time, is_enabled,
        fee_override, cutoff_time, capacity, internal_note, sort_order,
        delivery_type, same_day_available, next_day_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${OVERRIDE_SLOT_COLS}`,
    [
      overrideId, d.label ?? "", d.start_time, d.end_time,
      d.is_enabled ?? true, d.fee_override ?? null, d.cutoff_time ?? null,
      d.capacity ?? null, d.internal_note ?? null, sortOrder,
      d.delivery_type ?? "standard", d.same_day_available ?? false, d.next_day_available ?? true,
    ],
  );
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { override_id: overrideId });
  res.status(201).json({ slot: r.rows[0] });
});

router.patch("/delivery-overrides/:overrideId/slots/:slotId", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage override slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  const slotId = parseInt(req.params.slotId, 10);
  if (Number.isNaN(overrideId) || Number.isNaN(slotId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const overrideCheck = await db.query(
    `SELECT id FROM district_special_date_overrides WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (overrideCheck.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }

  const existing = await db.query<{
    id: number; label: string; start_time: string; end_time: string;
    is_enabled: boolean; fee_override: string | null; cutoff_time: string | null;
    capacity: number | null; internal_note: string | null; sort_order: number;
    delivery_type: string; same_day_available: boolean; next_day_available: boolean;
  }>(
    `SELECT id, label, start_time, end_time, is_enabled, fee_override,
            cutoff_time, capacity, internal_note, sort_order,
            delivery_type, same_day_available, next_day_available
       FROM district_special_date_override_slots
      WHERE id = $1 AND override_id = $2`,
    [slotId, overrideId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Slot not found" }); return; }
  const prev = existing.rows[0];

  const parsed = SlotWriteSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;

  const r = await db.query(
    `UPDATE district_special_date_override_slots
        SET label              = $1,
            start_time         = $2,
            end_time           = $3,
            is_enabled         = $4,
            fee_override       = $5,
            cutoff_time        = $6,
            capacity           = $7,
            internal_note      = $8,
            sort_order         = $9,
            delivery_type      = $10,
            same_day_available = $11,
            next_day_available = $12
      WHERE id = $13 AND override_id = $14
      RETURNING ${OVERRIDE_SLOT_COLS}`,
    [
      d.label ?? prev.label,
      d.start_time ?? prev.start_time,
      d.end_time ?? prev.end_time,
      d.is_enabled ?? prev.is_enabled,
      "fee_override" in d ? d.fee_override : (prev.fee_override !== null ? parseFloat(prev.fee_override) : null),
      "cutoff_time" in d ? d.cutoff_time : prev.cutoff_time,
      "capacity" in d ? d.capacity : prev.capacity,
      "internal_note" in d ? d.internal_note : prev.internal_note,
      d.sort_order ?? prev.sort_order,
      d.delivery_type ?? prev.delivery_type,
      d.same_day_available ?? prev.same_day_available,
      d.next_day_available ?? prev.next_day_available,
      slotId, overrideId,
    ],
  );
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { override_id: overrideId });
  res.json({ slot: r.rows[0] });
});

router.delete("/delivery-overrides/:overrideId/slots/:slotId", async (req, res) => {
  if (!isOwnerOrCitiesAdmin(req)) {
    res.status(403).json({ error: "Only owners or cities admins may manage override slots" });
    return;
  }
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const overrideId = parseInt(req.params.overrideId, 10);
  const slotId = parseInt(req.params.slotId, 10);
  if (Number.isNaN(overrideId) || Number.isNaN(slotId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const overrideCheck = await db.query(
    `SELECT id FROM district_special_date_overrides WHERE id = $1 AND workspace_owner_id = $2`,
    [overrideId, ownerId],
  );
  if (overrideCheck.rowCount === 0) { res.status(404).json({ error: "Override not found" }); return; }

  const check = await db.query(
    `SELECT id FROM district_special_date_override_slots WHERE id = $1 AND override_id = $2`,
    [slotId, overrideId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Slot not found" }); return; }

  await db.query(`DELETE FROM district_special_date_override_slots WHERE id = $1`, [slotId]);
  fireDeliveryWebhookAsync(ownerId);
  void fireDeliveryConfigWebhook("delivery.timeslots.updated", ownerId, { override_id: overrideId });
  res.json({ ok: true });
});

// ── Delivery availability API (public) ───────────────────────────────────────

/**
 * GET /delivery-availability?districtId=<id>&date=<YYYY-MM-DD>[&workspace=<ownerId>]
 *
 * Public endpoint. Returns available time slots and express rules for a
 * district on a given date, applying any active special date overrides.
 *
 * Authentication: If the user is authenticated with a valid workspace session,
 * their workspace is used. Otherwise the `workspace` query param is required.
 */
export const deliveryAvailabilityRouter = Router();

export async function handleDeliveryAvailability(
  queryable: Pick<PoolClient, "query">,
  req: Request,
  res: Response,
  excludedWeeklySlotIds: number[] = [],
): Promise<void> {
  const rawDistrictId = req.query.districtId ?? req.query.district_id;
  const rawDate = req.query.date;

  if (!rawDistrictId) {
    res.status(400).json({ error: "districtId is required" });
    return;
  }
  if (!rawDate || typeof rawDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    return;
  }

  const districtId = parseInt(String(rawDistrictId), 10);
  if (Number.isNaN(districtId)) {
    res.status(400).json({ error: "districtId must be a number" });
    return;
  }

  // Resolve workspace owner — support both auth'd session and ?workspace param
  let ownerId: string | null = null;
  try {
    const wreq = workspace(req);
    ownerId = wreq.workspaceOwnerId ?? null;
  } catch {
    // not authenticated — fall through to workspace param
  }
  if (!ownerId && typeof req.query.workspace === "string") {
    ownerId = req.query.workspace.trim() || null;
  }
  if (!ownerId) {
    res.status(400).json({ error: "workspace is required when not authenticated" });
    return;
  }

  // Verify the district exists and belongs to this workspace
  const cityRow = await queryable.query<{
    id: number;
    is_active: boolean;
    express_delivery_enabled: boolean;
    express_delivery_fee: string | null;
    express_delivery_cutoff_time: string | null;
  }>(
    `SELECT id, is_active, express_delivery_enabled, express_delivery_fee, express_delivery_cutoff_time
       FROM delivery_cities WHERE id = $1 AND workspace_owner_id = $2`,
    [districtId, ownerId],
  );
  if (cityRow.rowCount === 0) {
    res.status(404).json({ error: "District not found" });
    return;
  }
  const city = cityRow.rows[0];
  if (!city.is_active) {
    res.json({ available: false, reason: "district_inactive" });
    return;
  }

  // Determine day of week (0=Sunday) from the requested date
  const dateParts = rawDate.split("-").map(Number);
  const jsDate = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
  const dayOfWeek = jsDate.getUTCDay();

  // Check for an active override covering this district and date
  const overrideRows = await queryable.query<{
    id: number;
    override_type: string;
    express_enabled: boolean;
    express_start_time: string | null;
    express_end_time: string | null;
    express_cutoff_time: string | null;
    express_fee: string | null;
    express_min_prep_minutes: number | null;
    express_daily_capacity: number | null;
  }>(
    `SELECT id, override_type, express_enabled, express_start_time, express_end_time,
            express_cutoff_time, express_fee, express_min_prep_minutes, express_daily_capacity
       FROM district_special_date_overrides
      WHERE workspace_owner_id = $1
        AND is_active = true
        AND start_date <= $2::date
        AND end_date   >= $2::date
        AND (city_id IS NULL OR city_id = $3)
      ORDER BY city_id NULLS LAST, id ASC
      LIMIT 1`,
    [ownerId, rawDate, districtId],
  );
  const activeOverride = overrideRows.rows[0] ?? null;

  // Fetch extended express settings from district_delivery_settings
  const extExpressRow = await queryable.query<{
    express_start_time: string | null;
    express_end_time: string | null;
    express_min_prep_minutes: number | null;
    express_daily_capacity: number | null;
  }>(
    `SELECT express_start_time, express_end_time, express_min_prep_minutes, express_daily_capacity
       FROM district_delivery_settings WHERE city_id = $1`,
    [districtId],
  );
  const extExpress = extExpressRow.rows[0] ?? null;

  // Build express rules
  const baseExpress = city.express_delivery_enabled
    ? {
        enabled: true,
        fee: city.express_delivery_fee != null ? parseFloat(city.express_delivery_fee) : null,
        cutoff_time: city.express_delivery_cutoff_time ?? null,
        start_time: extExpress?.express_start_time ?? null,
        end_time: extExpress?.express_end_time ?? null,
        min_prep_minutes: extExpress?.express_min_prep_minutes ?? null,
        daily_capacity: extExpress?.express_daily_capacity ?? null,
      }
    : { enabled: false };

  // Determine which slots to use
  let slots: Array<{
    id: number;
    label: string;
    start_time: string;
    end_time: string;
    is_enabled: boolean;
    fee_override: number | null;
    cutoff_time: string | null;
    capacity: number | null;
    sort_order: number;
  }> = [];

  let expressRules = baseExpress;
  let overrideApplied: null | { id: number; name?: string; override_type: string } = null;

  if (activeOverride) {
    overrideApplied = { id: activeOverride.id, override_type: activeOverride.override_type };

    // Fetch override slots
    const overrideSlotsRows = await queryable.query<{
      id: number; label: string; start_time: string; end_time: string;
      is_enabled: boolean; fee_override: string | null; cutoff_time: string | null;
      capacity: number | null; sort_order: number;
    }>(
      `SELECT id, label, start_time, end_time, is_enabled, fee_override, cutoff_time, capacity, sort_order
         FROM district_special_date_override_slots
        WHERE override_id = $1 AND is_enabled = true
        ORDER BY sort_order ASC, id ASC`,
      [activeOverride.id],
    );
    const overrideSlots = overrideSlotsRows.rows.map((s) => ({
      ...s,
      fee_override: s.fee_override !== null ? parseFloat(s.fee_override) : null,
    }));

    if (activeOverride.override_type === "replace_regular_schedule") {
      slots = overrideSlots;
    } else {
      // add_to_regular_schedule — merge weekly + override
      const weeklyRows = await queryable.query<{
        id: number; label: string; start_time: string; end_time: string;
        is_enabled: boolean; fee_override: string | null; cutoff_time: string | null;
        capacity: number | null; sort_order: number;
      }>(
        `SELECT id, label, start_time, end_time, is_enabled, fee_override, cutoff_time, capacity, sort_order
           FROM district_weekly_delivery_slots
          WHERE city_id = $1 AND day_of_week = $2 AND is_enabled = true
            AND id <> ALL($3::integer[])
          ORDER BY sort_order ASC, id ASC`,
        [districtId, dayOfWeek, excludedWeeklySlotIds],
      );
      const weeklySlots = weeklyRows.rows.map((s) => ({
        ...s,
        fee_override: s.fee_override !== null ? parseFloat(s.fee_override) : null,
      }));
      slots = [...weeklySlots, ...overrideSlots].sort((a, b) => a.sort_order - b.sort_order);
    }

    // Override express rules if specified
    if (activeOverride.express_enabled) {
      expressRules = {
        enabled: true,
        fee: activeOverride.express_fee !== null ? parseFloat(activeOverride.express_fee) : null,
        cutoff_time: activeOverride.express_cutoff_time ?? null,
        start_time: activeOverride.express_start_time ?? null,
        end_time: activeOverride.express_end_time ?? null,
        min_prep_minutes: activeOverride.express_min_prep_minutes ?? null,
        daily_capacity: activeOverride.express_daily_capacity ?? null,
      };
    }
  } else {
    // Use weekly slots for this day of week
    const weeklyRows = await queryable.query<{
      id: number; label: string; start_time: string; end_time: string;
      is_enabled: boolean; fee_override: string | null; cutoff_time: string | null;
      capacity: number | null; sort_order: number;
    }>(
      `SELECT id, label, start_time, end_time, is_enabled, fee_override, cutoff_time, capacity, sort_order
         FROM district_weekly_delivery_slots
        WHERE city_id = $1 AND day_of_week = $2 AND is_enabled = true
          AND id <> ALL($3::integer[])
        ORDER BY sort_order ASC, id ASC`,
      [districtId, dayOfWeek, excludedWeeklySlotIds],
    );
    slots = weeklyRows.rows.map((s) => ({
      ...s,
      fee_override: s.fee_override !== null ? parseFloat(s.fee_override) : null,
    }));
  }

  res.json({
    available: true,
    district_id: districtId,
    date: rawDate,
    day_of_week: dayOfWeek,
    slots,
    express: expressRules,
    override_applied: overrideApplied,
  });
}

deliveryAvailabilityRouter.get("/delivery-availability", async (req, res) => {
  await handleDeliveryAvailability(db, req, res);
});

export default router;
