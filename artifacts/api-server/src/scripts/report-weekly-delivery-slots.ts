/**
 * Read-only evidence report and candidate export for weekly delivery-slot
 * cleanup. This module intentionally contains no UPDATE, DELETE, INSERT, or
 * DDL. The separate cleanup tool consumes its output only after review.
 */
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { db } from "../lib/db.js";

export const WEEKLY_SLOT_NATURAL_KEY = [
  "city_id",
  "day_of_week",
  "lower(trim(delivery_type))",
  "normalized_start_time",
  "normalized_end_time",
];

export const WEEKLY_SLOT_NATURAL_KEY_SQL = `
  city_id,
  day_of_week,
  lower(btrim(delivery_type)),
  lpad(start_time, 5, '0'),
  lpad(end_time, 5, '0')
`;

type Queryable = Pick<typeof db, "query">;

export type WeeklySlotReportOptions = {
  limit?: number;
  offset?: number;
};

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum?: number): number {
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.floor(value as number);
  return Math.max(minimum, maximum === undefined ? integer : Math.min(integer, maximum));
}

export function parseReportOptions(env: NodeJS.ProcessEnv = process.env): Required<WeeklySlotReportOptions> {
  return {
    limit: boundedInteger(Number.parseInt(env.REPORT_LIMIT ?? "100", 10), 100, 1, 500),
    offset: boundedInteger(Number.parseInt(env.REPORT_OFFSET ?? "0", 10), 0, 0),
  };
}

export async function buildWeeklySlotReport(
  queryable: Queryable,
  { limit, offset }: Required<WeeklySlotReportOptions>,
): Promise<Record<string, unknown>> {
  const duplicateSummary = await queryable.query(`
    SELECT COUNT(*)::integer AS duplicate_group_count,
           COALESCE(SUM(row_count - 1), 0)::bigint AS repeated_row_count
      FROM (
        SELECT COUNT(*) AS row_count
          FROM district_weekly_delivery_slots
         GROUP BY ${WEEKLY_SLOT_NATURAL_KEY_SQL}
        HAVING COUNT(*) > 1
      ) duplicates
  `);

  const duplicateGroups = await queryable.query(`
    SELECT city_id,
           day_of_week,
           lower(btrim(delivery_type)) AS delivery_type,
           lpad(start_time, 5, '0') AS start_time,
           lpad(end_time, 5, '0') AS end_time,
           COUNT(*)::integer AS row_count,
           (ARRAY_AGG(
             id ORDER BY is_enabled DESC, updated_at DESC NULLS LAST, sort_order, id
           ))[1:20] AS candidate_survivor_first_row_ids
      FROM district_weekly_delivery_slots
     GROUP BY ${WEEKLY_SLOT_NATURAL_KEY_SQL}
    HAVING COUNT(*) > 1
     ORDER BY row_count DESC, city_id, day_of_week, delivery_type, start_time
     LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const cityDayCounts = await queryable.query(`
    SELECT city_id,
           day_of_week,
           COUNT(*)::integer AS row_count,
           COUNT(DISTINCT (
             lower(btrim(delivery_type)),
             lpad(start_time, 5, '0'),
             lpad(end_time, 5, '0')
           ))::integer AS distinct_identity_count
      FROM district_weekly_delivery_slots
     GROUP BY city_id, day_of_week
     ORDER BY row_count DESC, city_id, day_of_week
     LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const sizes = await queryable.query(`
    SELECT pg_size_pretty(pg_table_size('district_weekly_delivery_slots')) AS table_size,
           pg_size_pretty(pg_indexes_size('district_weekly_delivery_slots')) AS index_size,
           pg_size_pretty(pg_total_relation_size('district_weekly_delivery_slots')) AS total_size
  `);

  return {
    generated_at: new Date().toISOString(),
    natural_key: WEEKLY_SLOT_NATURAL_KEY,
    relation_size: sizes.rows[0] ?? null,
    duplicate_summary: duplicateSummary.rows[0] ?? null,
    page: { limit, offset },
    duplicate_groups: duplicateGroups.rows,
    city_day_counts: cityDayCounts.rows,
  };
}

/**
 * Export every current candidate row as NDJSON. The first line is metadata;
 * each subsequent line is one complete database row. Streaming keeps the
 * export safe for the multi-million-row production case.
 */
export async function exportWeeklySlotCandidates(
  queryable: Queryable,
  outputPath: string,
  pageSize = 5_000,
): Promise<{ outputPath: string; rowCount: number }> {
  const output = createWriteStream(outputPath, { encoding: "utf8", flags: "wx" });
  await once(output, "open");
  const write = async (chunk: string): Promise<void> => {
    if (!output.write(chunk)) await once(output, "drain");
  };

  let rowCount = 0;
  let lastId = 0;
  try {
    await write(`${JSON.stringify({
      export_version: 1,
      generated_at: new Date().toISOString(),
      natural_key: WEEKLY_SLOT_NATURAL_KEY,
      format: "ndjson",
    })}\n`);
    for (;;) {
      const result = await queryable.query(
        `SELECT s.*
           FROM district_weekly_delivery_slots s
          WHERE s.id > $1
            AND EXISTS (
              SELECT 1
                FROM district_weekly_delivery_slots duplicate
               WHERE duplicate.id <> s.id
                 AND duplicate.city_id = s.city_id
                 AND duplicate.day_of_week = s.day_of_week
                 AND lower(btrim(duplicate.delivery_type)) = lower(btrim(s.delivery_type))
                 AND lpad(duplicate.start_time, 5, '0') = lpad(s.start_time, 5, '0')
                 AND lpad(duplicate.end_time, 5, '0') = lpad(s.end_time, 5, '0')
            )
          ORDER BY s.id
          LIMIT $2`,
        [lastId, pageSize],
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        await write(`${JSON.stringify(row)}\n`);
        lastId = Number((row as { id: number }).id);
        rowCount++;
      }
    }
    await write(`${JSON.stringify({
      export_summary: true,
      row_count: rowCount,
      last_id: lastId,
      completed: true,
    })}\n`);
    output.end();
    await once(output, "close");
    return { outputPath, rowCount };
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseReportOptions();
  const report = await buildWeeklySlotReport(db, options);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.endsWith("report-weekly-delivery-slots.ts")) {
  await main().finally(() => db.end());
}