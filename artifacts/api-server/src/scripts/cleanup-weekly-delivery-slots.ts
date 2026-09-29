/**
 * Separately reviewed, reversible cleanup for historical duplicate weekly
 * delivery slots.
 *
 * Commands:
 *   export --output <path>
 *   apply --manifest <path>
 *   rollback --batch-id <id>
 *   build-index --confirm
 *   remove-trigger --confirm
 *
 * apply requires an immutable candidate export plus a business-approved
 * manifest. It quarantines full rows, compares all schedule projections in one
 * serializable transaction, and rolls back on any unexpected difference.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { db } from "../lib/db.js";
import {
  buildDeliveryLocationsPayloadForQuery,
  buildOsDeliveryConfigCountries,
} from "../lib/deliveryWebhook.js";
import {
  exportWeeklySlotCandidates,
  WEEKLY_SLOT_NATURAL_KEY,
} from "./report-weekly-delivery-slots.js";

type Queryable = Pick<PoolClient, "query">;

type WeeklySlotRow = {
  id: number;
  city_id: number;
  workspace_owner_id: string;
  day_of_week: number;
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
  created_at: string | Date;
  updated_at: string | Date;
};

type Removal = {
  original_id: number;
  proposed_survivor_id: number;
};

type CleanupManifest = {
  manifest_version: 1;
  batch_id: string;
  workspace_owner_id: string;
  export_file: string;
  export_sha256: string;
  exported_row_count: number;
  approved_by: string;
  approved_at: string;
  removals: Removal[];
};

export type SemanticSnapshot = {
  admin: unknown;
  availability: unknown;
  order_reschedule: unknown;
  public_locations: unknown;
  schedule_summary: unknown;
  workspace_webhook: unknown;
  os_webhook: unknown;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function normalizedTime(value: string): string {
  return value.padStart(5, "0");
}

function dateKeyInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function naturalKey(row: WeeklySlotRow): string {
  return [
    row.city_id,
    row.day_of_week,
    row.delivery_type.trim().toLowerCase(),
    normalizedTime(row.start_time),
    normalizedTime(row.end_time),
  ].join("|");
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function uniquePreservingOrder(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = stableJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWebhookPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return uniquePreservingOrder(value.map(normalizeWebhookPayload));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "id")
      .map(([key, child]) => [key, normalizeWebhookPayload(child)]);
    return Object.fromEntries(entries);
  }
  return value;
}

async function captureJsonResponse(
  invoke: (req: Request, res: Response) => Promise<void>,
  query: Record<string, string>,
): Promise<unknown> {
  let statusCode = 200;
  let body: unknown;
  const req = { query, headers: {} } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  await invoke(req, res);
  if (statusCode >= 400) {
    throw new Error(`Snapshot route returned ${statusCode}: ${stableJson(body)}`);
  }
  return body;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function parseManifest(raw: unknown): CleanupManifest {
  if (raw === null || typeof raw !== "object") throw new Error("Manifest must be an object");
  const value = raw as Partial<CleanupManifest>;
  if (value.manifest_version !== 1) throw new Error("manifest_version must be 1");
  for (const key of [
    "batch_id",
    "workspace_owner_id",
    "export_file",
    "export_sha256",
    "approved_by",
    "approved_at",
  ] as const) {
    if (typeof value[key] !== "string" || value[key]!.trim() === "") {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(value.exported_row_count) || value.exported_row_count! <= 0) {
    throw new Error("exported_row_count must be a positive integer");
  }
  if (!Array.isArray(value.removals) || value.removals.length === 0) {
    throw new Error("removals must contain at least one approved mapping");
  }
  const seen = new Set<number>();
  for (const removal of value.removals) {
    if (
      !Number.isSafeInteger(removal.original_id) ||
      !Number.isSafeInteger(removal.proposed_survivor_id) ||
      removal.original_id <= 0 ||
      removal.proposed_survivor_id <= 0 ||
      removal.original_id === removal.proposed_survivor_id
    ) {
      throw new Error("Every removal needs distinct positive original_id and proposed_survivor_id values");
    }
    if (seen.has(removal.original_id)) throw new Error(`Duplicate removal id ${removal.original_id}`);
    seen.add(removal.original_id);
  }
  if (Number.isNaN(Date.parse(value.approved_at!))) throw new Error("approved_at must be an ISO date");
  return value as CleanupManifest;
}

async function exportedRowsForIds(
  path: string,
  ids: Set<number>,
): Promise<{ rows: Map<number, WeeklySlotRow>; rowCount: number }> {
  const rows = new Map<number, WeeklySlotRow>();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let firstLine = true;
  let rowCount = 0;
  let summaryCount: number | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as WeeklySlotRow | {
      export_version?: number;
      export_summary?: boolean;
      row_count?: number;
      completed?: boolean;
    };
    if (firstLine) {
      firstLine = false;
      if (!("export_version" in parsed) || parsed.export_version !== 1) {
        throw new Error("Candidate export metadata is missing or unsupported");
      }
      continue;
    }
    if ("export_summary" in parsed) {
      if (parsed.export_summary !== true || parsed.completed !== true || !Number.isSafeInteger(parsed.row_count)) {
        throw new Error("Candidate export completion record is invalid");
      }
      summaryCount = parsed.row_count!;
      continue;
    }
    const row = parsed as WeeklySlotRow;
    rowCount++;
    if (ids.has(row.id)) rows.set(row.id, row);
  }
  if (summaryCount === null || summaryCount !== rowCount) {
    throw new Error("Candidate export is incomplete or has an invalid row count");
  }
  for (const id of ids) {
    if (!rows.has(id)) throw new Error(`Row ${id} is not present in the reviewed candidate export`);
  }
  return { rows, rowCount };
}

async function fetchSlots(
  queryable: Queryable,
  ownerId: string,
  cityIds: number[],
  excludedIds: number[],
): Promise<WeeklySlotRow[]> {
  const result = await queryable.query<WeeklySlotRow>(
    `SELECT *
       FROM district_weekly_delivery_slots
      WHERE workspace_owner_id = $1
        AND city_id = ANY($2::integer[])
        AND id <> ALL($3::integer[])
      ORDER BY city_id, day_of_week, sort_order, id`,
    [ownerId, cityIds, excludedIds],
  );
  return result.rows;
}

function slotProjection(row: WeeklySlotRow): Record<string, unknown> {
  return {
    city_id: row.city_id,
    day_of_week: row.day_of_week,
    delivery_type: row.delivery_type.trim().toLowerCase(),
    start_time: normalizedTime(row.start_time),
    end_time: normalizedTime(row.end_time),
    label: row.label,
    is_enabled: row.is_enabled,
    fee_override: row.fee_override,
    cutoff_time: row.cutoff_time,
    capacity: row.capacity,
    internal_note: row.internal_note,
    sort_order: row.sort_order,
    same_day_available: row.same_day_available,
    next_day_available: row.next_day_available,
  };
}

export async function captureSemanticSnapshot(
  queryable: Queryable,
  ownerId: string,
  cityIds: number[],
  excludedIds: number[] = [],
): Promise<SemanticSnapshot> {
  const slots = await fetchSlots(queryable, ownerId, cityIds, excludedIds);
  const projected = slots.map(slotProjection);
  const admin = uniquePreservingOrder(projected);
  const enabled = slots.filter((row) => row.is_enabled);

  const nowResult = await queryable.query<{ now: Date }>(
    `SELECT clock_timestamp() AS now`,
  );
  const snapshotNow = new Date(nowResult.rows[0]?.now ?? new Date());
  const [{ handleDeliveryAvailability }, { handleDeliveryLocationsExt }, { resolveRescheduleContext }] =
    await Promise.all([
      import("../routes/deliveryScheduling.js"),
      import("../routes/deliveryLocations.js"),
      import("../routes/orders.js"),
    ]);
  const utcToday = snapshotNow.toISOString().slice(0, 10);
  const availability: unknown[] = [];
  for (const cityId of cityIds) {
    for (let offset = 0; offset < 8; offset++) {
      const date = addDays(utcToday, offset);
      const payload = await captureJsonResponse(
        (req, res) => handleDeliveryAvailability(queryable, req, res, excludedIds),
        { districtId: String(cityId), date, workspace: ownerId },
      );
      availability.push(normalizeWebhookPayload(payload));
    }
  }
  const orderReschedule: unknown[] = [];
  for (const cityId of cityIds) {
    const baseOrder = {
      id: `cleanup-snapshot-${cityId}`,
      status: "pending",
      external_order_id: null,
      delivery_type: "standard",
      delivery_address: { cityId },
      window_start: null,
      window_end: null,
      tookan_job_id: null,
    };
    const timezoneProbe = await resolveRescheduleContext(
      queryable,
      ownerId,
      baseOrder,
      snapshotNow.toISOString().slice(0, 10),
      { excludedWeeklySlotIds: excludedIds, now: snapshotNow },
    );
    const localToday = dateKeyInTimeZone(snapshotNow, timezoneProbe.timezone);
    for (let offset = 0; offset < 8; offset++) {
      const date = addDays(localToday, offset);
      for (const deliveryType of ["standard", "express"]) {
        const resolved = await resolveRescheduleContext(
          queryable,
          ownerId,
          { ...baseOrder, delivery_type: deliveryType },
          date,
          { excludedWeeklySlotIds: excludedIds, now: snapshotNow },
        );
        orderReschedule.push({
          city_id: cityId,
          date,
          relation: offset === 0 ? "same_day" : offset === 1 ? "next_day" : "following_week",
          delivery_type: deliveryType,
          timezone: resolved.timezone,
          slots: resolved.slots.map(({ id: _id, ...slot }) => slot),
        });
      }
    }
  }

  const publicLocations = normalizeWebhookPayload(
    await captureJsonResponse(
      (req, res) => handleDeliveryLocationsExt(queryable, req, res, excludedIds, ownerId),
      {},
    ),
  );

  const activeOverrideCounts = await queryable.query<{ city_id: number; count: string }>(
    `SELECT city_id, COUNT(*)::text AS count
       FROM district_special_date_overrides
      WHERE workspace_owner_id = $1
        AND city_id = ANY($2::integer[])
        AND is_active = true
      GROUP BY city_id`,
    [ownerId, cityIds],
  );
  const overrideCount = new Map(activeOverrideCounts.rows.map((row) => [row.city_id, Number(row.count)]));
  const scheduleSummary = cityIds.map((cityId) => {
    const citySlots = enabled.filter((row) => row.city_id === cityId);
    return {
      city_id: cityId,
      raw_enabled_weekly_slots: citySlots.length,
      enabled_weekly_slots: new Set(citySlots.map(naturalKey)).size,
      raw_sunday_enabled_slots: citySlots.filter((row) => row.day_of_week === 0).length,
      sunday_enabled_slots: new Set(citySlots.filter((row) => row.day_of_week === 0).map(naturalKey)).size,
      active_overrides: overrideCount.get(cityId) ?? 0,
    };
  });

  const webhook = await buildDeliveryLocationsPayloadForQuery(queryable, ownerId, excludedIds);
  const workspaceWebhook = normalizeWebhookPayload(webhook.countries);
  const osWebhook = normalizeWebhookPayload(buildOsDeliveryConfigCountries(webhook.countries));

  return {
    admin,
    availability,
    order_reschedule: orderReschedule,
    public_locations: publicLocations,
    schedule_summary: scheduleSummary,
    workspace_webhook: workspaceWebhook,
    os_webhook: osWebhook,
  };
}

async function lockCitiesAndSlots(client: PoolClient, cityIds: number[]): Promise<void> {
  for (const cityId of [...cityIds].sort((a, b) => a - b)) {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(format('district-weekly-slots:%s', $1::integer), 0)
       )`,
      [cityId],
    );
  }
  const cities = await client.query(
    `SELECT id FROM delivery_cities WHERE id = ANY($1::integer[]) ORDER BY id FOR UPDATE`,
    [cityIds],
  );
  if (cities.rowCount !== cityIds.length) throw new Error("One or more affected cities no longer exist");
  await client.query(
    `SELECT id
       FROM district_weekly_delivery_slots
      WHERE city_id = ANY($1::integer[])
      ORDER BY id
      FOR UPDATE`,
    [cityIds],
  );
}

export async function applyManifest(manifestPath: string): Promise<void> {
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const actualHash = await sha256File(manifest.export_file);
  if (actualHash !== manifest.export_sha256) throw new Error("Candidate export SHA-256 does not match the manifest");

  const relevantIds = new Set(
    manifest.removals.flatMap((row) => [row.original_id, row.proposed_survivor_id]),
  );
  const exportedResult = await exportedRowsForIds(manifest.export_file, relevantIds);
  if (exportedResult.rowCount !== manifest.exported_row_count) {
    throw new Error("Candidate export row count does not match the manifest");
  }
  const exported = exportedResult.rows;
  const removalIds = manifest.removals.map((row) => row.original_id);
  const survivorIds = new Set(manifest.removals.map((row) => row.proposed_survivor_id));
  for (const id of removalIds) {
    if (survivorIds.has(id)) throw new Error(`Row ${id} cannot be both a removal and a survivor`);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const current = await client.query<WeeklySlotRow>(
      `SELECT * FROM district_weekly_delivery_slots WHERE id = ANY($1::integer[]) ORDER BY id`,
      [[...relevantIds]],
    );
    if (current.rowCount !== relevantIds.size) throw new Error("An approved row or survivor no longer exists");
    const currentById = new Map(current.rows.map((row) => [row.id, row]));
    for (const [id, exportedRow] of exported) {
      const currentRow = currentById.get(id);
      if (!currentRow || stableJson(currentRow) !== stableJson(exportedRow)) {
        throw new Error(`Row ${id} changed after export; create and review a new export`);
      }
      if (currentRow.workspace_owner_id !== manifest.workspace_owner_id) {
        throw new Error(`Row ${id} belongs to a different workspace`);
      }
    }
    for (const removal of manifest.removals) {
      if (naturalKey(currentById.get(removal.original_id)!) !== naturalKey(currentById.get(removal.proposed_survivor_id)!)) {
        throw new Error(`Row ${removal.original_id} and survivor ${removal.proposed_survivor_id} do not share a natural key`);
      }
    }

    const cityIds = [...new Set(current.rows.map((row) => row.city_id))].sort((a, b) => a - b);
    await lockCitiesAndSlots(client, cityIds);
    const before = await captureSemanticSnapshot(client, manifest.workspace_owner_id, cityIds);
    const expectedAfter = await captureSemanticSnapshot(client, manifest.workspace_owner_id, cityIds, removalIds);

    await client.query(
      `INSERT INTO weekly_slot_cleanup_batches
         (batch_id, workspace_owner_id, export_sha256, exported_row_count,
          affected_city_ids, status, before_snapshot)
       VALUES ($1, $2, $3, $4, $5, 'running', $6::jsonb)`,
      [
        manifest.batch_id,
        manifest.workspace_owner_id,
        manifest.export_sha256,
        manifest.exported_row_count,
        cityIds,
        JSON.stringify(before),
      ],
    );

    for (const removal of manifest.removals) {
      const inserted = await client.query(
        `INSERT INTO weekly_slot_cleanup_quarantine
           (batch_id, original_id, proposed_survivor_id, city_id, workspace_owner_id,
            day_of_week, label, start_time, end_time, is_enabled, fee_override,
            cutoff_time, capacity, internal_note, sort_order, delivery_type,
            same_day_available, next_day_available, created_at, updated_at, original_row)
         SELECT $1, s.id, $2, s.city_id, s.workspace_owner_id, s.day_of_week,
                s.label, s.start_time, s.end_time, s.is_enabled, s.fee_override,
                s.cutoff_time, s.capacity, s.internal_note, s.sort_order,
                s.delivery_type, s.same_day_available, s.next_day_available,
                s.created_at, s.updated_at, to_jsonb(s)
           FROM district_weekly_delivery_slots s
          WHERE s.id = $3`,
        [manifest.batch_id, removal.proposed_survivor_id, removal.original_id],
      );
      if (inserted.rowCount !== 1) throw new Error(`Could not quarantine row ${removal.original_id}`);
    }

    const deleted = await client.query(
      `DELETE FROM district_weekly_delivery_slots WHERE id = ANY($1::integer[])`,
      [removalIds],
    );
    if (deleted.rowCount !== removalIds.length) throw new Error("Not every approved row was deleted");

    const after = await captureSemanticSnapshot(client, manifest.workspace_owner_id, cityIds);
    if (stableJson(expectedAfter) !== stableJson(after)) {
      throw new Error("Semantic snapshot changed unexpectedly; the cleanup batch was rolled back");
    }
    await client.query(
      `UPDATE weekly_slot_cleanup_batches
          SET status = 'completed', after_snapshot = $2::jsonb, completed_at = now()
        WHERE batch_id = $1`,
      [manifest.batch_id, JSON.stringify(after)],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ batch_id: manifest.batch_id, removed: removalIds.length, status: "completed" }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function rollbackBatch(batchId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const index = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_dwds_natural_key'`,
    );
    if (index.rowCount) throw new Error("Rollback must happen before the natural-key unique index is built");
    const batchResult = await client.query<{
      workspace_owner_id: string;
      affected_city_ids: number[];
      before_snapshot: SemanticSnapshot;
      after_snapshot: SemanticSnapshot;
      status: string;
    }>(
      `SELECT workspace_owner_id, affected_city_ids, before_snapshot, after_snapshot, status
         FROM weekly_slot_cleanup_batches
        WHERE batch_id = $1
        FOR UPDATE`,
      [batchId],
    );
    const batch = batchResult.rows[0];
    if (!batch || batch.status !== "completed") throw new Error("Only a completed cleanup batch can be rolled back");
    await lockCitiesAndSlots(client, batch.affected_city_ids);
    const current = await captureSemanticSnapshot(client, batch.workspace_owner_id, batch.affected_city_ids);
    if (stableJson(current) !== stableJson(batch.after_snapshot)) {
      throw new Error("Schedule data changed after cleanup; rollback was aborted for review");
    }
    await client.query(`SET LOCAL app.weekly_slot_cleanup_restore = 'on'`);
    const restored = await client.query(
      `INSERT INTO district_weekly_delivery_slots
       SELECT (jsonb_populate_record(
                NULL::district_weekly_delivery_slots,
                original_row
              )).*
         FROM weekly_slot_cleanup_quarantine
        WHERE batch_id = $1
        ORDER BY original_id`,
      [batchId],
    );
    const quarantineCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM weekly_slot_cleanup_quarantine WHERE batch_id = $1`,
      [batchId],
    );
    if (restored.rowCount !== Number(quarantineCount.rows[0]?.count ?? 0)) {
      throw new Error("Not every quarantined row was restored");
    }
    const fullRowCheck = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM weekly_slot_cleanup_quarantine q
         JOIN district_weekly_delivery_slots s ON s.id = q.original_id
        WHERE q.batch_id = $1
          AND to_jsonb(s) = q.original_row`,
      [batchId],
    );
    if (Number(fullRowCheck.rows[0]?.count ?? 0) !== restored.rowCount) {
      throw new Error("One or more restored rows differ from their immutable quarantine copy");
    }
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence('district_weekly_delivery_slots', 'id'),
         GREATEST((SELECT COALESCE(MAX(id), 1) FROM district_weekly_delivery_slots), 1),
         true
       )`,
    );
    const afterRestore = await captureSemanticSnapshot(client, batch.workspace_owner_id, batch.affected_city_ids);
    if (stableJson(afterRestore) !== stableJson(batch.before_snapshot)) {
      throw new Error("Restored snapshot differs from the pre-cleanup snapshot; rollback was aborted");
    }
    await client.query(
      `UPDATE weekly_slot_cleanup_batches
          SET status = 'rolled_back', rolled_back_at = now()
        WHERE batch_id = $1`,
      [batchId],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ batch_id: batchId, restored: restored.rowCount, status: "rolled_back" }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function duplicateGroupCount(queryable: Queryable): Promise<number> {
  const result = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM (
         SELECT 1
           FROM district_weekly_delivery_slots
          GROUP BY city_id, day_of_week, lower(btrim(delivery_type)),
                   lpad(start_time, 5, '0'), lpad(end_time, 5, '0')
         HAVING COUNT(*) > 1
       ) conflicts`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function naturalKeyIndexState(queryable: Queryable): Promise<{
  exists: boolean;
  exact: boolean;
  valid: boolean;
}> {
  const result = await queryable.query<{
    indisvalid: boolean;
    indisready: boolean;
    indisunique: boolean;
    key_1: string;
    key_2: string;
    key_3: string;
    key_4: string;
    key_5: string;
    table_name: string;
  }>(
    `SELECT i.indisvalid, i.indisready, i.indisunique,
            table_class.relname AS table_name,
            pg_get_indexdef(index_class.oid, 1, true) AS key_1,
            pg_get_indexdef(index_class.oid, 2, true) AS key_2,
            pg_get_indexdef(index_class.oid, 3, true) AS key_3,
            pg_get_indexdef(index_class.oid, 4, true) AS key_4,
            pg_get_indexdef(index_class.oid, 5, true) AS key_5
       FROM pg_class index_class
       JOIN pg_index i ON i.indexrelid = index_class.oid
       JOIN pg_class table_class ON table_class.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = index_class.relnamespace
      WHERE n.nspname = 'public' AND index_class.relname = 'uq_dwds_natural_key'`,
  );
  const row = result.rows[0];
  if (!row) return { exists: false, exact: false, valid: false };
  const compact = (value: string): string => value.replace(/\s+/g, "").replace(/::text/g, "");
  const exact =
    row.table_name === "district_weekly_delivery_slots" &&
    row.key_1 === "city_id" &&
    row.key_2 === "day_of_week" &&
    compact(row.key_3) === "lower(btrim(delivery_type))" &&
    compact(row.key_4) === "lpad(start_time,5,'0')" &&
    compact(row.key_5) === "lpad(end_time,5,'0')";
  return {
    exists: true,
    exact,
    valid: exact && row.indisvalid && row.indisready && row.indisunique,
  };
}

async function buildUniqueIndex(): Promise<void> {
  if (!process.argv.includes("--confirm")) throw new Error("build-index requires --confirm");
  const conflicts = await duplicateGroupCount(db);
  if (conflicts !== 0) throw new Error(`Cannot build the unique index while ${conflicts} duplicate groups remain`);
  const existing = await naturalKeyIndexState(db);
  if (existing.exists) {
    if (!existing.valid) {
      throw new Error("uq_dwds_natural_key exists but does not exactly match the valid natural-key index; review it manually");
    }
  } else {
    await db.query(`
      CREATE UNIQUE INDEX CONCURRENTLY uq_dwds_natural_key
        ON district_weekly_delivery_slots (
          city_id,
          day_of_week,
          (lower(btrim(delivery_type))),
          (lpad(start_time, 5, '0')),
          (lpad(end_time, 5, '0'))
        )
    `);
  }
  const validated = await naturalKeyIndexState(db);
  if (!validated.valid) {
    throw new Error("Natural-key index did not validate");
  }
  console.log(JSON.stringify({ index: "uq_dwds_natural_key", valid: true, trigger_retained: true }));
}

async function removeContainmentTrigger(): Promise<void> {
  if (!process.argv.includes("--confirm")) throw new Error("remove-trigger requires --confirm");
  if (await duplicateGroupCount(db)) throw new Error("Duplicate groups reappeared; trigger removal aborted");
  const index = await naturalKeyIndexState(db);
  if (!index.valid) throw new Error("The exact validated natural-key unique index is required");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("DROP TRIGGER IF EXISTS trg_dwds_slot_identity ON district_weekly_delivery_slots");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ trigger: "trg_dwds_slot_identity", removed: true }));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "export") {
    const output = requiredArgument("--output");
    const client = await db.connect();
    let result: Awaited<ReturnType<typeof exportWeeklySlotCandidates>>;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      result = await exportWeeklySlotCandidates(client, output);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const sha256 = await sha256File(output);
    console.log(JSON.stringify({ ...result, sha256, natural_key: WEEKLY_SLOT_NATURAL_KEY }));
    return;
  }
  if (command === "apply") {
    await applyManifest(requiredArgument("--manifest"));
    return;
  }
  if (command === "rollback") {
    await rollbackBatch(requiredArgument("--batch-id"));
    return;
  }
  if (command === "build-index") {
    await buildUniqueIndex();
    return;
  }
  if (command === "remove-trigger") {
    await removeContainmentTrigger();
    return;
  }
  throw new Error("Expected export, apply, rollback, build-index, or remove-trigger");
}

if (process.argv[1]?.endsWith("cleanup-weekly-delivery-slots.ts")) {
  await main().finally(() => db.end());
}