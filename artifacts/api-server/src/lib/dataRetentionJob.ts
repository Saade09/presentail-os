import type { PoolClient } from "pg";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Retention is intentionally different for the two append-only ledgers:
 *
 * - Completed webhook deliveries remain available for six months for
 *   debugging, partner support, and audit review. Active work is never
 *   age-pruned, so a delivery can remain pending while an endpoint is down.
 * - Website events remain available for four years so the analytics dashboard
 *   can support multi-year and year-over-year comparisons.
 *
 * These are business policy values, rather than a shared database default.
 * Change them only with the corresponding reporting and audit decision.
 */
export const RETENTION_POLICY = {
  webhookDeliveryDays: 180,
  webEventDays: 1_460,
} as const;

export const RETENTION_DELETE_BATCH_SIZE = 5_000;
export const RETENTION_JOB_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const RETENTION_INITIAL_DELAY_MS = 60_000;

/**
 * A stable lock makes cleanup safe when the API is running on multiple
 * instances. The lock is session-scoped, so every operation uses one client.
 */
const RETENTION_ADVISORY_LOCK_ID = 946_281_517;

type TableMetrics = {
  liveRowEstimate: number;
  deadRowEstimate: number;
  totalBytes: number;
};

export type RetentionRunResult = {
  webhookDeliveries: {
    before: TableMetrics;
    after: TableMetrics;
    deleted: number;
  };
  webEvents: {
    before: TableMetrics;
    after: TableMetrics;
    deleted: number;
  };
};

async function getTableMetrics(
  client: PoolClient,
  table: "webhook_deliveries" | "web_events",
): Promise<TableMetrics> {
  const result = await client.query<{
    live_row_count: string;
    dead_row_count: string;
    total_bytes: string;
  }>(
    `SELECT COALESCE(stats.n_live_tup, 0)::text AS live_row_count,
            COALESCE(stats.n_dead_tup, 0)::text AS dead_row_count,
            pg_total_relation_size(rel.oid)::text AS total_bytes
       FROM pg_class AS rel
       JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
       LEFT JOIN pg_stat_user_tables AS stats ON stats.relid = rel.oid
      WHERE ns.nspname = 'public'
        AND rel.relname = $1`,
    [table],
  );

  return {
    liveRowEstimate: Number(result.rows[0]?.live_row_count ?? 0),
    deadRowEstimate: Number(result.rows[0]?.dead_row_count ?? 0),
    totalBytes: Number(result.rows[0]?.total_bytes ?? 0),
  };
}

async function deleteOldWebhookDeliveries(client: PoolClient): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT id
         FROM webhook_deliveries
        WHERE created_at < now() - ($1 || ' days')::interval
          AND status IN ('delivered', 'failed')
        ORDER BY created_at ASC
        LIMIT $2
     )
     DELETE FROM webhook_deliveries AS deliveries
      USING candidates
      WHERE deliveries.id = candidates.id
        AND deliveries.created_at < now() - ($1 || ' days')::interval
        AND deliveries.status IN ('delivered', 'failed')`,
    [
      RETENTION_POLICY.webhookDeliveryDays,
      RETENTION_DELETE_BATCH_SIZE,
    ],
  );

  return result.rowCount ?? 0;
}

async function deleteOldWebEvents(client: PoolClient): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT id
         FROM web_events
        WHERE received_at < now() - ($1 || ' days')::interval
        ORDER BY received_at ASC
        LIMIT $2
     )
     DELETE FROM web_events AS events
      USING candidates
      WHERE events.id = candidates.id`,
    [RETENTION_POLICY.webEventDays, RETENTION_DELETE_BATCH_SIZE],
  );

  return result.rowCount ?? 0;
}

/**
 * Execute one bounded retention pass. The metrics are captured in the same
 * transaction as deletion so the log describes one consistent snapshot.
 */
export async function runRetentionCleanupOnClient(
  client: PoolClient,
): Promise<RetentionRunResult> {
  await client.query("BEGIN");

  try {
    const webhookBefore = await getTableMetrics(
      client,
      "webhook_deliveries",
    );
    const webEventsBefore = await getTableMetrics(client, "web_events");

    const webhookDeleted = await deleteOldWebhookDeliveries(client);
    const webEventsDeleted = await deleteOldWebEvents(client);

    const webhookAfter = await getTableMetrics(
      client,
      "webhook_deliveries",
    );
    const webEventsAfter = await getTableMetrics(client, "web_events");

    await client.query("COMMIT");

    const result: RetentionRunResult = {
      webhookDeliveries: {
        before: webhookBefore,
        after: webhookAfter,
        deleted: webhookDeleted,
      },
      webEvents: {
        before: webEventsBefore,
        after: webEventsAfter,
        deleted: webEventsDeleted,
      },
    };

    logger.info(
      {
        policy: RETENTION_POLICY,
        batchSize: RETENTION_DELETE_BATCH_SIZE,
        webhookDeliveries: result.webhookDeliveries,
        webEvents: result.webEvents,
      },
      "data-retention cleanup completed",
    );

    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw err;
  }
}

export async function runRetentionCleanup(): Promise<RetentionRunResult | null> {
  const client = await db.connect();

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [RETENTION_ADVISORY_LOCK_ID],
    );

    if (!lockResult.rows[0]?.acquired) {
      logger.info(
        "data-retention cleanup skipped — another instance holds the advisory lock",
      );
      return null;
    }

    try {
      return await runRetentionCleanupOnClient(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [
        RETENTION_ADVISORY_LOCK_ID,
      ]);
    }
  } finally {
    client.release();
  }
}

export function startDataRetentionJob(): void {
  const tick = async () => {
    try {
      await runRetentionCleanup();
    } catch (err) {
      logger.error(
        {
          err,
          policy: RETENTION_POLICY,
          batchSize: RETENTION_DELETE_BATCH_SIZE,
        },
        "data-retention cleanup failed",
      );
    }
  };

  setTimeout(tick, RETENTION_INITIAL_DELAY_MS);
  setInterval(tick, RETENTION_JOB_INTERVAL_MS);

  logger.info(
    {
      intervalMs: RETENTION_JOB_INTERVAL_MS,
      initialDelayMs: RETENTION_INITIAL_DELAY_MS,
      policy: RETENTION_POLICY,
      batchSize: RETENTION_DELETE_BATCH_SIZE,
    },
    "data-retention background job started",
  );
}