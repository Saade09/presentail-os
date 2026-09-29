import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../lib/db";
import {
  applyManifest,
  captureSemanticSnapshot,
  rollbackBatch,
  type SemanticSnapshot,
} from "./cleanup-weekly-delivery-slots";
import { exportWeeklySlotCandidates } from "./report-weekly-delivery-slots";

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__test_weekly_cleanup_rehearsal__";
const WORKSPACE_SLUG = "weekly-cleanup-rehearsal";
const CREATED_AT = "2024-01-02T03:04:05.000Z";
const UPDATED_AT = "2024-02-03T04:05:06.000Z";
const BATCH_ID = "weekly-cleanup-rehearsal";
const ABORT_BATCH_ID = "weekly-cleanup-rehearsal-abort";

const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const today = new Date().toISOString().slice(0, 10);
const tomorrow = addDays(today, 1);
const todayDay = new Date(`${today}T00:00:00.000Z`).getUTCDay();
const tomorrowDay = new Date(`${tomorrow}T00:00:00.000Z`).getUTCDay();

describe.skipIf(!DATABASE_URL)("weekly delivery-slot cleanup rehearsal (database)", () => {
  let pool: InstanceType<typeof pg.Pool>;
  let cityId: number;
  let identicalSurvivorId: number;
  let identicalRemovalId: number;
  let conflictingSurvivorId: number;
  let conflictingRemovalId: number;
  let abortSurvivorId: number;
  let abortRemovalId: number;
  let replacementOverrideId: number;
  let addOverrideId: number;
  let candidatePath: string;
  let abortCandidatePath: string;
  let beforeRows: unknown;
  let beforeSequence: { last_value: string; is_called: boolean };
  let beforeSnapshot: SemanticSnapshot;

  async function queryRows(): Promise<unknown> {
    const result = await pool.query(
      `SELECT to_jsonb(s) AS row
         FROM district_weekly_delivery_slots s
        WHERE s.city_id = $1
        ORDER BY s.id`,
      [cityId],
    );
    return result.rows.map((row) => row.row);
  }

  async function querySequence(): Promise<{ last_value: string; is_called: boolean }> {
    const result = await pool.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called
         FROM district_weekly_delivery_slots_id_seq`,
    );
    return result.rows[0]!;
  }

  async function insertWeeklySlot(input: {
    day: number;
    label: string;
    fee: number;
    cutoff: string | null;
    capacity: number;
    note: string;
    sort: number;
  }): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO district_weekly_delivery_slots
         (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
          is_enabled, fee_override, cutoff_time, capacity, internal_note,
          sort_order, delivery_type, same_day_available, next_day_available,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, '09:00', '11:00', true, $5, $6, $7, $8,
               $9, 'standard', true, true, $10, $10)
       RETURNING id`,
      [
        cityId,
        OWNER_ID,
        input.day,
        input.label,
        input.fee,
        input.cutoff,
        input.capacity,
        input.note,
        input.sort,
        CREATED_AT,
      ],
    );
    return result.rows[0]!.id;
  }

  async function insertAbortPair(): Promise<void> {
    abortSurvivorId = await insertWeeklySlot({
      day: todayDay,
      label: "Abort survivor",
      fee: 14,
      cutoff: "07:00",
      capacity: 3,
      note: "abort survivor",
      sort: 20,
    });
    abortRemovalId = await insertWeeklySlot({
      day: todayDay,
      label: "Abort duplicate",
      fee: 14,
      cutoff: "07:00",
      capacity: 3,
      note: "abort duplicate",
      sort: 21,
    });
  }

  async function createCandidate(
    outputPath: string,
    batchId: string,
    removals: Array<{ original_id: number; proposed_survivor_id: number }>,
  ): Promise<string> {
    const exported = await exportWeeklySlotCandidates(pool, outputPath);
    const content = await readFile(outputPath);
    const manifestPath = join(outputPath, "..", `${outputPath.split("/").pop()!}.manifest.json`);
    await writeFile(
      manifestPath,
      JSON.stringify({
        manifest_version: 1,
        batch_id: batchId,
        workspace_owner_id: OWNER_ID,
        export_file: outputPath,
        export_sha256: createHash("sha256").update(content).digest("hex"),
        exported_row_count: exported.rowCount,
        approved_by: "cleanup-rehearsal",
        approved_at: "2026-08-29T00:00:00.000Z",
        removals,
      }),
    );
    return manifestPath;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // The initDb containment index is intentionally removed only while this
    // fixture creates legacy duplicates. It is restored in afterAll.
    await pool.query(`DROP INDEX IF EXISTS uq_dwds_natural_key`);
    await pool.query(`DROP TRIGGER IF EXISTS trg_dwds_slot_identity ON district_weekly_delivery_slots`);
    await pool.query(
      `DELETE FROM weekly_slot_cleanup_quarantine q
        USING weekly_slot_cleanup_batches b
       WHERE q.batch_id = b.batch_id AND b.workspace_owner_id = $1`,
      [OWNER_ID],
    );
    await pool.query(`DELETE FROM weekly_slot_cleanup_batches WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM delivery_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);

    await pool.query(
      `INSERT INTO workspace_settings (workspace_owner_id, workspace_slug, available_countries)
       VALUES ($1, $2, ARRAY['Lebanon'])
       ON CONFLICT (workspace_owner_id) DO UPDATE
         SET workspace_slug = EXCLUDED.workspace_slug,
             available_countries = EXCLUDED.available_countries`,
      [OWNER_ID, WORKSPACE_SLUG],
    );
    await pool.query(
      `INSERT INTO delivery_country_settings
         (workspace_owner_id, country_code, delivery_active, delivery_sort_order)
       VALUES ($1, 'LB', true, 0)`,
      [OWNER_ID],
    );
    const cityResult = await pool.query<{ id: number }>(
      `INSERT INTO delivery_cities
         (workspace_owner_id, country_code, name, slug, sort_order, is_active,
          delivery_fee, free_delivery_enabled, express_delivery_enabled,
          express_delivery_fee, standard_delivery_available,
          express_delivery_available, delivery_timezone, updated_at)
       VALUES ($1, 'LB', 'Cleanup Rehearsal City', 'cleanup-rehearsal-city', 0, true,
               10, false, true, 15, true, true, 'UTC', $2)
       RETURNING id`,
      [OWNER_ID, UPDATED_AT],
    );
    cityId = cityResult.rows[0]!.id;
    await pool.query(
      `INSERT INTO delivery_settings
         (workspace_owner_id, standard_delivery_active, express_delivery_active)
       VALUES ($1, true, true)`,
      [OWNER_ID],
    );
    await pool.query(
      `INSERT INTO district_delivery_settings
         (city_id, workspace_owner_id, express_enabled, express_start_time,
          express_end_time, express_daily_capacity, weekly_slots_seeded)
       VALUES ($1, $2, true, '14:00', '18:00', 4, true)`,
      [cityId, OWNER_ID],
    );

    identicalSurvivorId = await insertWeeklySlot({
      day: todayDay,
      label: "Identical slot",
      fee: 12,
      cutoff: "07:00",
      capacity: 5,
      note: "same attributes",
      sort: 0,
    });
    identicalRemovalId = await insertWeeklySlot({
      day: todayDay,
      label: "Identical slot",
      fee: 12,
      cutoff: "07:00",
      capacity: 5,
      note: "same attributes",
      sort: 0,
    });
    conflictingSurvivorId = await insertWeeklySlot({
      day: tomorrowDay,
      label: "Business-approved survivor",
      fee: 13,
      cutoff: "08:00",
      capacity: 4,
      note: "approved editable values",
      sort: 2,
    });
    conflictingRemovalId = await insertWeeklySlot({
      day: tomorrowDay,
      label: "Legacy conflicting duplicate",
      fee: 99,
      cutoff: null,
      capacity: 1,
      note: "legacy editable values",
      sort: 3,
    });

    const replacement = await pool.query<{ id: number }>(
      `INSERT INTO district_special_date_overrides
         (workspace_owner_id, city_id, country_code, name, start_date, end_date,
          override_type, express_enabled, is_active, created_at, updated_at)
       VALUES ($1, $2, 'LB', 'Replacement override', $3, $3,
               'replace_regular_schedule', false, true, $4, $4)
       RETURNING id`,
      [OWNER_ID, cityId, today, CREATED_AT],
    );
    replacementOverrideId = replacement.rows[0]!.id;
    await pool.query(
      `INSERT INTO district_special_date_override_slots
         (override_id, label, start_time, end_time, is_enabled, fee_override,
          cutoff_time, capacity, internal_note, sort_order, delivery_type,
          same_day_available, next_day_available, created_at)
       VALUES ($1, 'Replacement slot', '12:00', '14:00', true, 20, '10:00',
               2, 'replacement', 0, 'standard', true, true, $2)`,
      [replacementOverrideId, CREATED_AT],
    );
    const addition = await pool.query<{ id: number }>(
      `INSERT INTO district_special_date_overrides
         (workspace_owner_id, city_id, country_code, name, start_date, end_date,
          override_type, express_enabled, is_active, created_at, updated_at)
       VALUES ($1, $2, 'LB', 'Addition override', $3, $3,
               'add_to_regular_schedule', false, true, $4, $4)
       RETURNING id`,
      [OWNER_ID, cityId, tomorrow, CREATED_AT],
    );
    addOverrideId = addition.rows[0]!.id;
    await pool.query(
      `INSERT INTO district_special_date_override_slots
         (override_id, label, start_time, end_time, is_enabled, fee_override,
          cutoff_time, capacity, internal_note, sort_order, delivery_type,
          same_day_available, next_day_available, created_at)
       VALUES ($1, 'Added override slot', '17:00', '19:00', true, 18, '15:00',
               2, 'addition', 9, 'standard', true, true, $2)`,
      [addOverrideId, CREATED_AT],
    );

    beforeRows = await queryRows();
    beforeSequence = await querySequence();
    beforeSnapshot = await captureSemanticSnapshot(db, OWNER_ID, [cityId]);

    const directory = await mkdtemp("/tmp/weekly-cleanup-rehearsal-");
    candidatePath = join(directory, "candidates.ndjson");
    const manifestPath = await createCandidate(candidatePath, BATCH_ID, [
      { original_id: identicalRemovalId, proposed_survivor_id: identicalSurvivorId },
      { original_id: conflictingRemovalId, proposed_survivor_id: conflictingSurvivorId },
    ]);
    await applyManifest(manifestPath);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TRIGGER IF EXISTS trg_test_cleanup_semantic_difference ON district_weekly_delivery_slots`);
    await pool.query(`DROP FUNCTION IF EXISTS test_cleanup_semantic_difference()`);
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(
      `DELETE FROM weekly_slot_cleanup_quarantine q
        USING weekly_slot_cleanup_batches b
       WHERE q.batch_id = b.batch_id AND b.workspace_owner_id = $1`,
      [OWNER_ID],
    );
    await pool.query(`DELETE FROM weekly_slot_cleanup_batches WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM delivery_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dwds_natural_key
        ON district_weekly_delivery_slots (
          city_id, day_of_week, (lower(btrim(delivery_type))),
          (lpad(start_time, 5, '0')), (lpad(end_time, 5, '0'))
        )
    `);
    await pool.query(`
      CREATE TRIGGER trg_dwds_slot_identity
        BEFORE INSERT OR UPDATE ON district_weekly_delivery_slots
        FOR EACH ROW EXECUTE FUNCTION enforce_district_weekly_delivery_slot_identity()
    `);
    await pool.end();
  });

  it("covers both override modes in every cleanup read model", async () => {
    expect((beforeSnapshot.admin as unknown[]).map((slot) => (slot as { label: string }).label))
      .toEqual(expect.arrayContaining(["Identical slot", "Business-approved survivor", "Legacy conflicting duplicate"]));
    expect((beforeSnapshot.schedule_summary as Array<Record<string, unknown>>)[0]).toMatchObject({
      raw_enabled_weekly_slots: 4,
      enabled_weekly_slots: 2,
      active_overrides: 2,
    });

    const after = await captureSemanticSnapshot(db, OWNER_ID, [cityId]);
    expect((after.admin as unknown[]).map((slot) => (slot as { label: string }).label))
      .toEqual(expect.arrayContaining(["Identical slot", "Business-approved survivor"]));
    expect(JSON.stringify(after.admin)).not.toContain("Legacy conflicting duplicate");

    const availability = after.availability as Array<Record<string, unknown>>;
    const replacementAvailability = availability.find((entry) => entry.date === today)!;
    const additionAvailability = availability.find((entry) => entry.date === tomorrow)!;
    expect(replacementAvailability).toMatchObject({
      override_applied: { override_type: "replace_regular_schedule" },
    });
    expect(JSON.stringify(replacementAvailability)).toContain("Replacement slot");
    expect(JSON.stringify(additionAvailability)).toContain("Added override slot");
    expect(JSON.stringify(additionAvailability)).toContain("Business-approved survivor");
    expect(JSON.stringify(additionAvailability)).not.toContain("Legacy conflicting duplicate");

    const reschedule = after.order_reschedule as Array<Record<string, unknown>>;
    expect(JSON.stringify(reschedule.filter((entry) => entry.date === today))).toContain("Replacement slot");
    const additionReschedule = JSON.stringify(reschedule.filter((entry) => entry.date === tomorrow));
    expect(additionReschedule).toContain("Added override slot");
    expect(additionReschedule).toContain("Business-approved survivor");

    expect(JSON.stringify(after.public_locations)).toContain("Business-approved survivor");
    expect(JSON.stringify(after.public_locations)).not.toContain("Legacy conflicting duplicate");
    expect(JSON.stringify(after.workspace_webhook)).toContain("Business-approved survivor");
    expect(JSON.stringify(after.workspace_webhook)).not.toContain("Legacy conflicting duplicate");
    expect(JSON.stringify(after.os_webhook)).toContain("Business-approved survivor");
    expect(JSON.stringify(after.os_webhook)).not.toContain("Legacy conflicting duplicate");
    expect((after.schedule_summary as Array<Record<string, unknown>>)[0]).toMatchObject({
      raw_enabled_weekly_slots: 2,
      enabled_weekly_slots: 2,
      active_overrides: 2,
    });
  });

  it("restores every original row, ID, timestamp, and sequence value", async () => {
    await rollbackBatch(BATCH_ID);
    expect(await queryRows()).toEqual(beforeRows);
    expect(await querySequence()).toEqual(beforeSequence);
    expect(await captureSemanticSnapshot(db, OWNER_ID, [cityId])).toEqual(beforeSnapshot);

    const quarantine = await pool.query(
      `SELECT original_id, proposed_survivor_id, original_row
         FROM weekly_slot_cleanup_quarantine
        WHERE batch_id = $1
        ORDER BY original_id`,
      [BATCH_ID],
    );
    expect(quarantine.rows).toHaveLength(2);
    expect(quarantine.rows.map((row) => row.original_id)).toEqual(
      [identicalRemovalId, conflictingRemovalId].sort((a, b) => a - b),
    );
    expect(quarantine.rows.every((row) => new Date(row.original_row.created_at).toISOString() === CREATED_AT)).toBe(true);
    expect(quarantine.rows.every((row) => new Date(row.original_row.updated_at).toISOString() === CREATED_AT)).toBe(true);
  });

  it("aborts the whole transaction when deletion causes an unexpected semantic difference", async () => {
    await insertAbortPair();
    const directory = await mkdtemp("/tmp/weekly-cleanup-abort-");
    abortCandidatePath = join(directory, "candidates.ndjson");
    const manifestPath = await createCandidate(abortCandidatePath, ABORT_BATCH_ID, [
      { original_id: abortRemovalId, proposed_survivor_id: abortSurvivorId },
    ]);

    await pool.query(`
      CREATE FUNCTION test_cleanup_semantic_difference()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE district_weekly_delivery_slots
           SET label = 'unexpected semantic difference'
         WHERE id = ${abortSurvivorId};
        RETURN OLD;
      END;
      $$;
    `);
    await pool.query(`
      CREATE TRIGGER trg_test_cleanup_semantic_difference
      AFTER DELETE ON district_weekly_delivery_slots
      FOR EACH ROW EXECUTE FUNCTION test_cleanup_semantic_difference()
    `);

    await expect(applyManifest(manifestPath)).rejects.toThrow(
      "Semantic snapshot changed unexpectedly",
    );
    await pool.query(`DROP TRIGGER trg_test_cleanup_semantic_difference ON district_weekly_delivery_slots`);
    await pool.query(`DROP FUNCTION test_cleanup_semantic_difference()`);

    const rows = await pool.query(
      `SELECT id, label
         FROM district_weekly_delivery_slots
        WHERE id = ANY($1::integer[])
        ORDER BY id`,
      [[abortSurvivorId, abortRemovalId]],
    );
    expect(rows.rows).toEqual([
      { id: abortSurvivorId, label: "Abort survivor" },
      { id: abortRemovalId, label: "Abort duplicate" },
    ]);
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM weekly_slot_cleanup_batches
        WHERE batch_id = $1`,
      [ABORT_BATCH_ID],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM weekly_slot_cleanup_quarantine
        WHERE batch_id = $1`,
      [ABORT_BATCH_ID],
    )).rows[0].count).toBe(0);
  });
});