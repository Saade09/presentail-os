import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { DEFAULT_COUNTRIES, isExcludedCountry } from "../lib/defaults";
import { maybeAutoActivateLocation } from "../lib/locationSetup";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const locationRowSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    country: z.string(),
    location_type: z.string(),
    device_count: z.number().int(),
    job_count: z.number().int(),
    page_sum: z.number().int(),
    has_operating_hours: z.boolean(),
    has_routing: z.boolean(),
    has_capacity: z.boolean(),
  })
  .passthrough();

const locationsResponseSchema = z.object({
  locations: z.array(locationRowSchema),
});

function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error(
      { err: parsed.error.issues, route },
      "Response validation failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}

async function getWorkspaceCountries(ownerId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  if (result.rowCount === 0) return DEFAULT_COUNTRIES;
  const arr = result.rows[0].available_countries as string[] | null;
  const filtered = (arr ?? []).filter((c) => !isExcludedCountry(c));
  return filtered.length > 0 ? filtered : DEFAULT_COUNTRIES;
}

const VALID_LOCATION_TYPES = ["Point of Sale", "Central Warehouse"] as const;
type LocationType = (typeof VALID_LOCATION_TYPES)[number];

function parseLocationType(value: unknown): LocationType {
  return VALID_LOCATION_TYPES.includes(value as LocationType)
    ? (value as LocationType)
    : "Point of Sale";
}

const VALID_RENT_CURRENCIES = ["USD", "AED"] as const;
type RentCurrency = (typeof VALID_RENT_CURRENCIES)[number];

function parseRentCurrency(value: unknown): RentCurrency | null {
  if (value === null || value === undefined || value === "") return null;
  if (VALID_RENT_CURRENCIES.includes(value as RentCurrency)) return value as RentCurrency;
  return null;
}

function parseNullableNumeric(value: unknown): { value: number | null; invalid: boolean } {
  if (value === null || value === undefined || value === "") return { value: null, invalid: false };
  const n = Number(value);
  if (!Number.isFinite(n)) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

function parseNullableInt(value: unknown): { value: number | null; invalid: boolean } {
  if (value === null || value === undefined || value === "") return { value: null, invalid: false };
  const s = String(value);
  if (!/^-?\d+$/.test(s.trim())) return { value: null, invalid: true };
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

/**
 * Parse the optional `florist_member_ids` field from a request body.
 * Returns { provided: false } when the field is absent, { invalid: true }
 * when it is present but malformed, or the parsed list of ids.
 */
function parseFloristMemberIds(body: unknown): {
  provided: boolean;
  invalid: boolean;
  ids: number[];
} {
  const raw = (body as Record<string, unknown> | null | undefined)?.florist_member_ids;
  if (raw === undefined) return { provided: false, invalid: false, ids: [] };
  if (!Array.isArray(raw)) return { provided: true, invalid: true, ids: [] };
  const ids: number[] = [];
  for (const v of raw) {
    let n: number;
    if (typeof v === "number") {
      n = v;
    } else if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      n = Number(v.trim());
    } else {
      return { provided: true, invalid: true, ids: [] };
    }
    if (!Number.isInteger(n)) return { provided: true, invalid: true, ids: [] };
    if (!ids.includes(n)) ids.push(n);
  }
  return { provided: true, invalid: false, ids };
}

/**
 * Validate that every id is a non-owner workspace member whose custom role
 * grants the `florist_orders` page. Returns the ids that failed validation.
 */
async function findInvalidFloristMemberIds(
  ownerId: string,
  memberIds: number[],
): Promise<number[]> {
  if (memberIds.length === 0) return [];
  // A valid florist member is one whose union of roles grants the florist_orders page.
  const result = await db.query<{ id: number }>(
    `SELECT wm.id
       FROM workspace_members wm
      WHERE wm.id = ANY($1::int[])
        AND wm.workspace_owner_id = $2
        AND wm.role <> 'owner'
        AND EXISTS (
          SELECT 1
            FROM workspace_member_roles wmr
            JOIN workspace_roles wr ON wr.id = wmr.role_id
           WHERE wmr.member_id = wm.id
             AND wr.allowed_pages @> '["florist_orders"]'::jsonb
        )`,
    [memberIds, ownerId],
  );
  const validIds = new Set(result.rows.map((r) => r.id));
  return memberIds.filter((id) => !validIds.has(id));
}

/**
 * Set `florist_location_id` for the selected members and clear it for
 * members previously assigned to this location that were deselected.
 * A florist has exactly one florist location, so assigning here moves
 * florists that were assigned to another location.
 */
async function applyFloristAssignments(
  ownerId: string,
  locationId: number,
  memberIds: number[],
): Promise<void> {
  if (memberIds.length > 0) {
    await db.query(
      `UPDATE workspace_members
          SET florist_location_id = $1
        WHERE workspace_owner_id = $2
          AND id = ANY($3::int[])
          AND florist_location_id IS DISTINCT FROM $1`,
      [locationId, ownerId, memberIds],
    );
  }
  await db.query(
    `UPDATE workspace_members
        SET florist_location_id = NULL
      WHERE workspace_owner_id = $1
        AND florist_location_id = $2
        AND NOT (id = ANY($3::int[]))`,
    [ownerId, locationId, memberIds],
  );
}

function ownerOnly(wreq: ReturnType<typeof workspace>, res: Parameters<Parameters<typeof router.get>[1]>[1]): boolean {
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage locations" });
    return false;
  }
  return true;
}

const LOCATION_DETAIL_FIELDS = `
  l.id, l.name, l.country, l.location_type, l.annual_rent, l.rent_currency, l.payments_per_year,
  l.status, l.daily_capacity, l.same_day_cutoff_time, l.express_cutoff_time,
  l.operating_hours, l.timezone, l.backup_location_id, l.auto_routing_enabled,
  l.served_area_ids, l.paused_at, l.paused_by, l.pause_reason, l.internal_notes, l.address, l.created_at,
  l.latitude, l.longitude, l.geofence_radius_meters, l.attendance_enabled, l.grace_period_minutes
`;

router.get("/locations", async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;
  const result = await db.query(
    `SELECT
       l.id, l.name, l.country, l.location_type,
       l.annual_rent, l.rent_currency, l.payments_per_year, l.created_at,
       l.status, l.paused_at, l.daily_capacity, l.address,
       l.latitude, l.longitude, l.geofence_radius_meters, l.attendance_enabled,
       l.grace_period_minutes,
       COALESCE(dev.device_count, 0)::int    AS device_count,
       COALESCE(dev.devices_online, 0)::int  AS devices_online,
       COALESCE(dev.devices_offline, 0)::int AS devices_offline,
       COALESCE(dev.job_count, 0)::int       AS job_count,
       COALESCE(dev.page_sum, 0)::int        AS page_sum,
       COALESCE(br.brands_count, 0)::int     AS brands_count,
       COALESCE(pr.products_count, 0)::int   AS products_count,
       COALESCE(ord.orders_today, 0)::int    AS orders_today,
       COALESCE(ord.pending_prep, 0)::int    AS pending_prep,
       (
         l.operating_hours IS NOT NULL
         AND jsonb_typeof(l.operating_hours) = 'object'
         AND l.operating_hours != '{}'::jsonb
         AND EXISTS (
           SELECT 1
           FROM jsonb_each(l.operating_hours) AS day(key, val)
           WHERE (val->>'closed') IS DISTINCT FROM 'true'
             AND val->>'open'  IS NOT NULL AND val->>'open'  != ''
             AND val->>'close' IS NOT NULL AND val->>'close' != ''
         )
       )::boolean AS has_operating_hours,
       (l.auto_routing_enabled = true OR l.backup_location_id IS NOT NULL OR
        (l.served_area_ids IS NOT NULL AND jsonb_array_length(l.served_area_ids) > 0))::boolean AS has_routing,
       (l.daily_capacity IS NOT NULL AND l.daily_capacity > 0)::boolean AS has_capacity
     FROM locations l
     LEFT JOIN LATERAL (
       SELECT
         COUNT(DISTINCT d.id)::int AS device_count,
         COUNT(DISTINCT d.id) FILTER (WHERE d.last_seen_at >= now() - INTERVAL '10 minutes')::int AS devices_online,
         COUNT(DISTINCT d.id) FILTER (WHERE d.last_seen_at < now() - INTERVAL '10 minutes' OR d.last_seen_at IS NULL)::int AS devices_offline,
         COUNT(pj.id)::int AS job_count,
         COALESCE(SUM(pj.pages), 0)::int AS page_sum
       FROM devices d
       LEFT JOIN print_jobs pj ON pj.device_id = d.id AND pj.deleted_at IS NULL AND pj.status = 'done'
       WHERE d.location_id = l.id
     ) dev ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT lb.brand_id)::int AS brands_count
       FROM location_brands lb
       WHERE lb.location_id = l.id AND lb.workspace_owner_id = l.workspace_owner_id
     ) br ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT p.id)::int AS products_count
       FROM location_brands lb
       JOIN brands b ON b.id = lb.brand_id
       JOIN products p ON p.workspace_owner_id = l.workspace_owner_id
                      AND p.brand = b.name
                      AND p.status != 'not_available'
       WHERE lb.location_id = l.id AND lb.workspace_owner_id = l.workspace_owner_id
     ) pr ON true
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (WHERE o.ordered_at >= CURRENT_DATE
                            AND o.status NOT IN ('cancelled','failed','refunded','trash'))::int AS orders_today,
         COUNT(*) FILTER (WHERE o.status IN ('pending','processing','on-hold')
                            AND o.ordered_at >= CURRENT_DATE)::int AS pending_prep
       FROM orders o
       WHERE o.location_id = l.id
     ) ord ON true
     WHERE l.workspace_owner_id = $1
     ORDER BY l.created_at ASC`,
    [ownerId],
  );
  sendValidated(
    req,
    res,
    locationsResponseSchema,
    { locations: result.rows },
    "GET /locations",
  );
});

router.post("/locations", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const name = ((req.body?.name as string) || "").trim();
  const rawCountry = (req.body?.country as string) || "";
  const locationType = parseLocationType(req.body?.location_type);
  const annualRentParsed = parseNullableNumeric(req.body?.annual_rent);
  const rentCurrency = parseRentCurrency(req.body?.rent_currency);
  const paymentsPerYearParsed = parseNullableInt(req.body?.payments_per_year);

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  if (isExcludedCountry(rawCountry)) {
    res.status(400).json({ error: "country is not supported" });
    return;
  }
  const validCountries = await getWorkspaceCountries(ownerId);
  if (!validCountries.includes(rawCountry)) {
    res.status(400).json({ error: `country must be one of: ${validCountries.join(", ")}` });
    return;
  }
  const country = rawCountry;

  if (req.body?.rent_currency && rentCurrency === null) {
    res.status(400).json({ error: "rent_currency must be USD or AED" });
    return;
  }
  if (annualRentParsed.invalid) {
    res.status(400).json({ error: "annual_rent must be a valid number" });
    return;
  }
  if (paymentsPerYearParsed.invalid) {
    res.status(400).json({ error: "payments_per_year must be a valid integer" });
    return;
  }

  const gracePeriodParsed = parseNullableInt(req.body?.grace_period_minutes);
  if (gracePeriodParsed.invalid) {
    res.status(400).json({ error: "grace_period_minutes must be a valid integer" });
    return;
  }

  const floristIds = parseFloristMemberIds(req.body);
  if (floristIds.invalid) {
    res.status(400).json({ error: "florist_member_ids must be an array of member ids" });
    return;
  }
  if (floristIds.provided) {
    const invalidIds = await findInvalidFloristMemberIds(ownerId, floristIds.ids);
    if (invalidIds.length > 0) {
      res.status(400).json({
        error: "florist_member_ids must reference workspace members whose role grants the Florist Orders page",
      });
      return;
    }
  }

  const result = await db.query(
    `INSERT INTO locations (workspace_owner_id, name, country, location_type, annual_rent, rent_currency, payments_per_year, grace_period_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, country, location_type, annual_rent, rent_currency, payments_per_year, grace_period_minutes, created_at`,
    [ownerId, name, country, locationType, annualRentParsed.value, rentCurrency, paymentsPerYearParsed.value, gracePeriodParsed.value],
  );
  if (floristIds.provided) {
    await applyFloristAssignments(ownerId, (result.rows[0] as { id: number }).id, floristIds.ids);
  }
  res.json({ location: { ...result.rows[0], device_count: 0, job_count: 0, page_sum: 0 } });
});

router.patch("/locations/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Partial update: attendance/geofence/grace fields (no name/country required)
  if (req.body?.name === undefined) {
    const geofenceRadiusParsed = parseNullableInt(req.body?.geofence_radius_meters);
    const attendanceEnabled = req.body?.attendance_enabled !== undefined
      ? Boolean(req.body.attendance_enabled)
      : undefined;
    const partialGraceParsed = parseNullableInt(req.body?.grace_period_minutes);

    if (geofenceRadiusParsed.invalid) {
      res.status(400).json({ error: "geofence_radius_meters must be a valid integer" });
      return;
    }
    if (partialGraceParsed.invalid) {
      res.status(400).json({ error: "grace_period_minutes must be a valid integer" });
      return;
    }

    const partialResult = await db.query(
      `UPDATE locations l SET
        geofence_radius_meters = COALESCE($1::integer, geofence_radius_meters),
        attendance_enabled = COALESCE($2::boolean, attendance_enabled),
        grace_period_minutes = CASE WHEN $3::boolean THEN $4::integer ELSE grace_period_minutes END
       WHERE id = $5 AND workspace_owner_id = $6
       RETURNING ${LOCATION_DETAIL_FIELDS}`,
      [
        geofenceRadiusParsed.value,
        attendanceEnabled !== undefined ? attendanceEnabled : null,
        req.body?.grace_period_minutes !== undefined,
        partialGraceParsed.value,
        id, ownerId,
      ],
    );
    if (partialResult.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ location: partialResult.rows[0] });
    return;
  }

  const name = ((req.body?.name as string) || "").trim();
  const rawCountry = (req.body?.country as string) || "";
  const locationType = parseLocationType(req.body?.location_type);
  const annualRentParsed = parseNullableNumeric(req.body?.annual_rent);
  const rentCurrency = parseRentCurrency(req.body?.rent_currency);
  const paymentsPerYearParsed = parseNullableInt(req.body?.payments_per_year);

  // Operations settings fields (all optional)
  const dailyCapacityParsed = parseNullableInt(req.body?.daily_capacity);
  const sameDayCutoff = (req.body?.same_day_cutoff_time as string | undefined) ?? undefined;
  const expressCutoff = (req.body?.express_cutoff_time as string | undefined) ?? undefined;
  const operatingHours = req.body?.operating_hours ?? undefined;
  const timezone = (req.body?.timezone as string | undefined) ?? undefined;
  const backupLocationIdParsed = parseNullableInt(req.body?.backup_location_id);
  const autoRoutingEnabled = req.body?.auto_routing_enabled !== undefined
    ? Boolean(req.body.auto_routing_enabled)
    : undefined;
  const servedAreaIds = req.body?.served_area_ids !== undefined
    ? (Array.isArray(req.body.served_area_ids) ? req.body.served_area_ids as number[] : null)
    : undefined;
  const internalNotes = (req.body?.internal_notes as string | undefined) ?? undefined;
  const address = (req.body?.address as string | undefined) ?? undefined;
  const gracePeriodMinutesParsed = parseNullableInt(req.body?.grace_period_minutes);

  if (!name) { res.status(400).json({ error: "name is required" }); return; }

  if (isExcludedCountry(rawCountry)) {
    res.status(400).json({ error: "country is not supported" });
    return;
  }
  const validCountries = await getWorkspaceCountries(ownerId);
  if (!validCountries.includes(rawCountry)) {
    res.status(400).json({ error: `country must be one of: ${validCountries.join(", ")}` });
    return;
  }
  const country = rawCountry;

  if (req.body?.rent_currency && rentCurrency === null) {
    res.status(400).json({ error: "rent_currency must be USD or AED" });
    return;
  }
  if (annualRentParsed.invalid) {
    res.status(400).json({ error: "annual_rent must be a valid number" });
    return;
  }
  if (paymentsPerYearParsed.invalid) {
    res.status(400).json({ error: "payments_per_year must be a valid integer" });
    return;
  }
  if (dailyCapacityParsed.invalid) {
    res.status(400).json({ error: "daily_capacity must be a valid integer" });
    return;
  }
  if (backupLocationIdParsed.invalid) {
    res.status(400).json({ error: "backup_location_id must be a valid integer" });
    return;
  }
  if (gracePeriodMinutesParsed.invalid) {
    res.status(400).json({ error: "grace_period_minutes must be a valid integer" });
    return;
  }

  // Validate backup location belongs to workspace
  if (backupLocationIdParsed.value !== null && backupLocationIdParsed.value !== undefined) {
    const backupCheck = await db.query(
      `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [backupLocationIdParsed.value, ownerId],
    );
    if (backupCheck.rowCount === 0) {
      res.status(404).json({ error: "Backup location not found" });
      return;
    }
  }

  const floristIds = parseFloristMemberIds(req.body);
  if (floristIds.invalid) {
    res.status(400).json({ error: "florist_member_ids must be an array of member ids" });
    return;
  }
  if (floristIds.provided) {
    const invalidIds = await findInvalidFloristMemberIds(ownerId, floristIds.ids);
    if (invalidIds.length > 0) {
      res.status(400).json({
        error: "florist_member_ids must reference workspace members whose role grants the Florist Orders page",
      });
      return;
    }
  }

  const result = await db.query(
    `UPDATE locations l SET
      name = $1, country = $2, location_type = $3,
      annual_rent = $4, rent_currency = $5, payments_per_year = $6,
      daily_capacity = COALESCE($7, daily_capacity),
      same_day_cutoff_time = COALESCE($8::text, same_day_cutoff_time),
      express_cutoff_time = COALESCE($9::text, express_cutoff_time),
      operating_hours = COALESCE($10::jsonb, operating_hours),
      timezone = COALESCE($11::text, timezone),
      backup_location_id = CASE WHEN $12::boolean THEN $13::integer ELSE backup_location_id END,
      auto_routing_enabled = COALESCE($14::boolean, auto_routing_enabled),
      served_area_ids = CASE WHEN $15::boolean THEN $16::jsonb ELSE served_area_ids END,
      internal_notes = COALESCE($17::text, internal_notes),
      address = COALESCE($18::text, address),
      grace_period_minutes = CASE WHEN $19::boolean THEN $20::integer ELSE grace_period_minutes END
     WHERE id = $21 AND workspace_owner_id = $22
     RETURNING ${LOCATION_DETAIL_FIELDS}`,
    [
      name, country, locationType,
      annualRentParsed.value, rentCurrency, paymentsPerYearParsed.value,
      dailyCapacityParsed.value,
      sameDayCutoff ?? null,
      expressCutoff ?? null,
      operatingHours !== undefined ? JSON.stringify(operatingHours) : null,
      timezone ?? null,
      req.body?.backup_location_id !== undefined,
      backupLocationIdParsed.value,
      autoRoutingEnabled !== undefined ? autoRoutingEnabled : null,
      servedAreaIds !== undefined,
      servedAreaIds !== undefined ? JSON.stringify(servedAreaIds) : null,
      internalNotes ?? null,
      address ?? null,
      req.body?.grace_period_minutes !== undefined,
      gracePeriodMinutesParsed.value,
      id, ownerId,
    ],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
  if (floristIds.provided) {
    await applyFloristAssignments(ownerId, id, floristIds.ids);
  }
  await maybeAutoActivateLocation(ownerId, id, req.log);
  res.json({ location: result.rows[0] });
});

// ── Pause / Resume ────────────────────────────────────────────────────────────

router.post("/locations/:id/pause", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const userId = wreq.userId;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pauseReason = ((req.body?.reason as string) || "").trim() || null;

  const result = await db.query(
    `UPDATE locations l SET status = 'paused', paused_at = now(), paused_by = $1, pause_reason = $2
     WHERE id = $3 AND workspace_owner_id = $4
     RETURNING ${LOCATION_DETAIL_FIELDS}`,
    [userId, pauseReason, id, ownerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ location: result.rows[0] });
});

router.post("/locations/:id/resume", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await db.query(
    `UPDATE locations l SET status = 'active', paused_at = NULL, paused_by = NULL, pause_reason = NULL
     WHERE id = $1 AND workspace_owner_id = $2
     RETURNING ${LOCATION_DETAIL_FIELDS}`,
    [id, ownerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ location: result.rows[0] });
});

router.delete("/locations/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.query(
    `DELETE FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [id, ownerId],
  );
  res.json({ ok: true });
});

router.get("/locations/:id/devices", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const assignedLocationIds = wreq.assignedLocationIds;

  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Enforce location-based access: members with assigned locations may only
  // view location detail pages for locations they are assigned to.
  if (assignedLocationIds !== null && assignedLocationIds.length > 0) {
    if (!assignedLocationIds.includes(locationId)) {
      res.status(403).json({ error: "You do not have access to this location" });
      return;
    }
  }

  const locResult = await db.query(
    `SELECT ${LOCATION_DETAIL_FIELDS} FROM locations l WHERE l.id = $1 AND l.workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locResult.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }

  const devResult = await db.query(
    `SELECT id, name, machine_id, os, agent_version, printers, last_seen_at, created_at, location_id
     FROM devices WHERE user_id = $1 AND location_id = $2
     ORDER BY last_seen_at DESC`,
    [ownerId, locationId],
  );

  // Fetch backup location name if set
  const loc = locResult.rows[0];
  let backupLocationName: string | null = null;
  if (loc.backup_location_id) {
    const bkResult = await db.query(
      `SELECT name FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [loc.backup_location_id, ownerId],
    );
    backupLocationName = bkResult.rows[0]?.name ?? null;
  }

  res.json({ location: { ...loc, backup_location_name: backupLocationName }, devices: devResult.rows });
});

router.get("/locations/:id/stats", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }

  const statsResult = await db.query(
    `SELECT
       COUNT(pj.id)::int AS total_jobs,
       COALESCE(SUM(pj.pages) FILTER (WHERE pj.status = 'done'), 0)::int AS total_pages,
       COUNT(pj.id) FILTER (WHERE pj.status = 'failed' AND pj.created_at >= now() - INTERVAL '7 days')::int AS recent_errors
     FROM devices d
     JOIN print_jobs pj ON pj.device_id = d.id AND pj.deleted_at IS NULL
     WHERE d.location_id = $1 AND d.user_id = $2`,
    [locationId, ownerId],
  );

  // Order KPI counts — filtered by location_id on native orders.
  // Statuses considered "active" (not yet fulfilled or cancelled):
  //   pending_prep  = order received, not yet being prepared
  //   ready         = prepared, awaiting dispatch
  //   at_risk       = active order older than 4 hours past SLA
  const SLA_HOURS = 4;
  const ordersResult = await db.query<{
    orders_today: number;
    orders_yesterday: number;
    pending_prep: number;
    ready_for_dispatch: number;
    at_risk: number;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE ordered_at >= CURRENT_DATE
           AND status NOT IN ('cancelled','failed','refunded','trash')
       )::int AS orders_today,

       COUNT(*) FILTER (
         WHERE ordered_at >= CURRENT_DATE - INTERVAL '1 day'
           AND ordered_at <  CURRENT_DATE
           AND status NOT IN ('cancelled','failed','refunded','trash')
       )::int AS orders_yesterday,

       COUNT(*) FILTER (
         WHERE status IN ('pending','processing','on-hold')
           AND ordered_at >= CURRENT_DATE
       )::int AS pending_prep,

       COUNT(*) FILTER (
         WHERE status IN ('ready','ready-for-pickup','ready-for-dispatch',
                          'out-for-delivery','ready-to-ship')
           AND ordered_at >= CURRENT_DATE
       )::int AS ready_for_dispatch,

       COUNT(*) FILTER (
         WHERE status IN ('pending','processing','on-hold')
           AND ordered_at < now() - ($2 || ' hours')::interval
           AND ordered_at >= CURRENT_DATE - INTERVAL '1 day'
       )::int AS at_risk

     FROM orders
     WHERE location_id = $1`,
    [locationId, SLA_HOURS],
  );

  const orderRow = ordersResult.rows[0] ?? {
    orders_today: 0,
    orders_yesterday: 0,
    pending_prep: 0,
    ready_for_dispatch: 0,
    at_risk: 0,
  };

  const row = statsResult.rows[0] ?? { total_jobs: 0, total_pages: 0, recent_errors: 0 };
  res.json({
    stats: {
      total_jobs: row.total_jobs ?? 0,
      total_pages: row.total_pages ?? 0,
      recent_errors: row.recent_errors ?? 0,
      orders_today: orderRow.orders_today ?? 0,
      orders_yesterday: orderRow.orders_yesterday ?? 0,
      pending_prep: orderRow.pending_prep ?? 0,
      ready_for_dispatch: orderRow.ready_for_dispatch ?? 0,
      at_risk: orderRow.at_risk ?? 0,
    },
  });
});

// ── Location activity feed ────────────────────────────────────────────────────

router.get("/locations/:id/activity", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const assignedLocationIds = wreq.assignedLocationIds;

  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  if (assignedLocationIds !== null && assignedLocationIds.length > 0) {
    if (!assignedLocationIds.includes(locationId)) {
      res.status(403).json({ error: "You do not have access to this location" });
      return;
    }
  }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }

  const result = await db.query(
    `SELECT event_type, occurred_at, subject_name, subject_id, actor_name
     FROM (
       -- Device heartbeats: last ping from each device at this location
       SELECT
         'device_heartbeat'       AS event_type,
         d.last_seen_at           AS occurred_at,
         d.name                   AS subject_name,
         d.id::text               AS subject_id,
         NULL::text               AS actor_name
       FROM devices d
       WHERE d.location_id = $1
         AND d.user_id = $2
         AND d.last_seen_at >= now() - INTERVAL '7 days'

       UNION ALL

       -- Brand linked: brands assigned to this location
       SELECT
         'brand_linked'           AS event_type,
         lb.created_at            AS occurred_at,
         b.name                   AS subject_name,
         lb.brand_id::text        AS subject_id,
         lb.actor_email           AS actor_name
       FROM location_brands lb
       JOIN brands b ON b.id = lb.brand_id
       WHERE lb.location_id = $1
         AND lb.workspace_owner_id = $2
         AND lb.created_at >= now() - INTERVAL '30 days'

       UNION ALL

       -- Member added: members assigned to this location
       -- Schema sentinel: reads workspace_members.member_email (→ subject_name).
       -- Update here if member_email is renamed.
       SELECT
         'member_added'           AS event_type,
         ml.created_at            AS occurred_at,
         wm.member_email          AS subject_name,
         ml.member_id::text       AS subject_id,
         ml.actor_email           AS actor_name
       FROM member_locations ml
       JOIN workspace_members wm ON wm.id = ml.member_id
       WHERE ml.location_id = $1
         AND wm.workspace_owner_id = $2
         AND ml.created_at >= now() - INTERVAL '30 days'

       UNION ALL

       -- Jobs completed: print jobs finished at devices assigned to this location
       SELECT
         'job_completed'          AS event_type,
         pj.created_at            AS occurred_at,
         pj.file_name             AS subject_name,
         pj.id::text              AS subject_id,
         NULL::text               AS actor_name
       FROM print_jobs pj
       JOIN devices d ON d.id = pj.device_id
       WHERE d.location_id = $1
         AND d.user_id = $2
         AND pj.status = 'done'
         AND pj.deleted_at IS NULL
         AND pj.created_at >= now() - INTERVAL '24 hours'

       UNION ALL

       -- Brand removed / member removed: logged in location_activity_log
       SELECT
         lal.event_type           AS event_type,
         lal.occurred_at          AS occurred_at,
         lal.subject_name         AS subject_name,
         lal.subject_id           AS subject_id,
         lal.actor_email          AS actor_name
       FROM location_activity_log lal
       WHERE lal.location_id = $1
         AND lal.workspace_owner_id = $2
         AND lal.occurred_at >= now() - INTERVAL '30 days'
     ) AS activity
     ORDER BY occurred_at DESC
     LIMIT 50`,
    [locationId, ownerId],
  );

  res.json({ events: result.rows });
});

// ── Location brands ─────────────────────────────────────────────────────────

router.get("/locations/:id/brands", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }

  const result = await db.query(
    `SELECT b.id, b.name,
            (SELECT bl.id FROM brand_logos bl
              WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL
              ORDER BY bl.sort_order ASC LIMIT 1) AS primary_logo_id
       FROM location_brands lb
       JOIN brands b ON b.id = lb.brand_id
      WHERE lb.location_id = $1 AND lb.workspace_owner_id = $2
      ORDER BY b.name ASC`,
    [locationId, ownerId],
  );
  res.json({ brands: result.rows });
});

router.post("/locations/:id/brands", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const brandId = parseInt(req.body?.brand_id, 10);
  if (Number.isNaN(brandId)) { res.status(400).json({ error: "brand_id is required" }); return; }

  const locCheck = await db.query(
    `SELECT id, location_type FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Location not found" }); return; }
  if (locCheck.rows[0].location_type !== "Point of Sale") {
    res.status(400).json({ error: "Brands can only be added to Point of Sale locations" }); return;
  }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brandId, ownerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  await db.query(
    `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id, actor_email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (location_id, brand_id) DO NOTHING`,
    [ownerId, locationId, brandId, wreq.userEmail],
  );
  await maybeAutoActivateLocation(ownerId, locationId, req.log);
  res.json({ ok: true });
});

router.delete("/locations/:id/brands/:brandId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const locationId = parseInt(req.params.id, 10);
  const brandId = parseInt(req.params.brandId, 10);
  if (Number.isNaN(locationId) || Number.isNaN(brandId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  // Fetch brand name before deleting so we can log the removal event.
  const brandRow = await db.query<{ name: string }>(
    `SELECT b.name FROM brands b
       JOIN location_brands lb ON lb.brand_id = b.id
      WHERE lb.location_id = $1 AND lb.brand_id = $2 AND lb.workspace_owner_id = $3`,
    [locationId, brandId, ownerId],
  );
  const brandName = brandRow.rows[0]?.name ?? null;

  await db.query(
    `DELETE FROM location_brands WHERE location_id = $1 AND brand_id = $2 AND workspace_owner_id = $3`,
    [locationId, brandId, ownerId],
  );

  if (brandName !== null) {
    await db.query(
      `INSERT INTO location_activity_log
         (workspace_owner_id, location_id, event_type, subject_id, subject_name, actor_email)
       VALUES ($1, $2, 'brand_removed', $3, $4, $5)`,
      [ownerId, locationId, String(brandId), brandName, wreq.userEmail],
    );
  }

  res.json({ ok: true });
});

// ── Location members ─────────────────────────────────────────────────────────

router.get("/locations/:id/members", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }

  // Schema sentinel: reads workspace_members.member_email (→ email, ORDER BY) and custom_role_id.
  // Update here if member_email or custom_role_id is renamed.
  const result = await db.query<{ id: number; email: string; role_name: string | null; role: string }>(
    `SELECT wm.id, wm.member_email AS email, wm.role, wr.name AS role_name
       FROM member_locations ml
       JOIN workspace_members wm ON wm.id = ml.member_id
       LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
      WHERE ml.location_id = $1 AND wm.workspace_owner_id = $2
      ORDER BY wm.member_email ASC`,
    [locationId, ownerId],
  );
  res.json({ members: result.rows });
});

router.post("/locations/:id/members", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const locationId = parseInt(req.params.id, 10);
  if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const memberId = parseInt(req.body?.member_id, 10);
  if (Number.isNaN(memberId)) { res.status(400).json({ error: "member_id is required" }); return; }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Location not found" }); return; }

  const memberCheck = await db.query(
    `SELECT id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
    [memberId, ownerId],
  );
  if (memberCheck.rowCount === 0) { res.status(404).json({ error: "Member not found" }); return; }

  await db.query(
    `INSERT INTO member_locations (member_id, location_id, actor_email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [memberId, locationId, wreq.userEmail],
  );
  res.json({ ok: true });
});

router.delete("/locations/:id/members/:memberId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const locationId = parseInt(req.params.id, 10);
  const memberId = parseInt(req.params.memberId, 10);
  if (Number.isNaN(locationId) || Number.isNaN(memberId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  // Verify location belongs to workspace
  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, ownerId],
  );
  if (locCheck.rowCount === 0) { res.status(404).json({ error: "Location not found" }); return; }

  // Schema sentinel: reads workspace_members.member_email for activity log.
  // Update here if member_email is renamed.
  // Fetch member email before deleting so we can log the removal event.
  const memberRow = await db.query<{ member_email: string }>(
    `SELECT wm.member_email FROM workspace_members wm
       JOIN member_locations ml ON ml.member_id = wm.id
      WHERE ml.member_id = $1 AND ml.location_id = $2 AND wm.workspace_owner_id = $3`,
    [memberId, locationId, ownerId],
  );
  const memberEmail = memberRow.rows[0]?.member_email ?? null;

  await db.query(
    `DELETE FROM member_locations
      WHERE member_id = $1 AND location_id = $2`,
    [memberId, locationId],
  );

  if (memberEmail !== null) {
    await db.query(
      `INSERT INTO location_activity_log
         (workspace_owner_id, location_id, event_type, subject_id, subject_name, actor_email)
       VALUES ($1, $2, 'member_removed', $3, $4, $5)`,
      [ownerId, locationId, String(memberId), memberEmail, wreq.userEmail],
    );
  }

  res.json({ ok: true });
});

router.patch("/devices/:id/location", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const deviceId = parseInt(req.params.id, 10);
  if (Number.isNaN(deviceId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const rawLocationId = req.body?.location_id;
  const locationId = rawLocationId === null || rawLocationId === undefined
    ? null
    : parseInt(rawLocationId, 10);

  if (locationId !== null) {
    if (Number.isNaN(locationId)) { res.status(400).json({ error: "Invalid location_id" }); return; }
    const locCheck = await db.query(
      `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [locationId, ownerId],
    );
    if (locCheck.rowCount === 0) { res.status(404).json({ error: "Location not found" }); return; }
  }

  const result = await db.query(
    `UPDATE devices SET location_id = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, location_id`,
    [locationId, deviceId, ownerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Device not found" }); return; }
  if (locationId !== null) {
    await maybeAutoActivateLocation(ownerId, locationId, req.log);
  }
  res.json({ ok: true, device: result.rows[0] });
});

export default router;
