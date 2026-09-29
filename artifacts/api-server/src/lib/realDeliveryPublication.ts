import { randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import { objectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { db } from "./db";

type QueryClient = Pool | PoolClient;

/**
 * Register the current revision without publishing it. Publication is an
 * explicit operations decision now; this helper only makes a revision
 * available for that decision and for the worker after it is enabled.
 */
export async function enqueueRealDeliveryPublication(
  client: QueryClient,
  assignmentId: number,
  workspaceOwnerId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO florist_photo_publications
       (workspace_owner_id, assignment_id, photo_set_rev, source_photo_path, publication_status,
         enabled, next_attempt_at, automatic)
       SELECT a.workspace_owner_id, a.id, a.photo_set_rev, a.photo_items_path, 'pending',
              false, NULL, false
       FROM order_florist_assignments a
       JOIN orders o ON o.id=a.order_id AND o.workspace_owner_id=a.workspace_owner_id
      WHERE a.id=$1 AND a.workspace_owner_id=$2
        AND a.verification_status='approved' AND a.photo_items_path IS NOT NULL
        AND o.status='completed'
      ON CONFLICT (assignment_id, photo_set_rev) DO NOTHING`,
    [assignmentId, workspaceOwnerId],
  );
}

/** Idempotently discover eligible revisions without silently featuring them. */
export async function backfillRealDeliveryPublications(client: QueryClient): Promise<void> {
  await client.query(
    `INSERT INTO florist_photo_publications
       (workspace_owner_id, assignment_id, photo_set_rev, source_photo_path, publication_status,
         enabled, next_attempt_at, automatic)
       SELECT a.workspace_owner_id, a.id, a.photo_set_rev, a.photo_items_path, 'pending',
              false, NULL, false
       FROM order_florist_assignments a
       JOIN orders o ON o.id=a.order_id AND o.workspace_owner_id=a.workspace_owner_id
      WHERE a.verification_status='approved' AND a.photo_items_path IS NOT NULL
        AND o.status='completed'
      ON CONFLICT (assignment_id, photo_set_rev) DO NOTHING`,
  );
}

type ClaimedPublication = {
  id: number; workspace_owner_id: string; assignment_id: number; source_photo_path: string;
  lease_token: string;
};

/**
 * Bounded worker: its short transaction claims one row, while the potentially
 * slow object copy happens after that transaction has committed.
 */
export async function processRealDeliveryPublications(pool: Pool, limit = 10): Promise<number> {
  // Discovery on every tick closes ordering/write-skew gaps between independent
  // order and verification transactions and also picks up post-start inserts.
  await backfillRealDeliveryPublications(pool);
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const claimed = await pool.query<ClaimedPublication>(
      `WITH candidate AS (
         SELECT f.id
           FROM florist_photo_publications f
           JOIN order_florist_assignments a ON a.id=f.assignment_id
           JOIN orders o ON o.id=a.order_id AND o.workspace_owner_id=a.workspace_owner_id
           WHERE f.enabled=true AND (
              (f.publication_status IN ('pending','failed')
                AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now()))
              OR (f.publication_status='processing'
                AND (f.lease_until IS NULL OR f.lease_until < now()))
            )
            AND a.photo_set_rev=f.photo_set_rev AND a.photo_items_path=f.source_photo_path
            AND a.verification_status='approved' AND o.status='completed'
          -- Fair scheduling: failed attempts move next_attempt_at forward, so
          -- they cannot monopolize every batch ahead of untouched/new work.
          ORDER BY f.next_attempt_at NULLS FIRST, f.created_at
          FOR UPDATE OF f SKIP LOCKED LIMIT 1
       )
       UPDATE florist_photo_publications f
          SET publication_status='processing', lease_token=$1,
              lease_until=now()+interval '2 minutes', attempts=f.attempts+1, updated_at=now()
         FROM candidate
        WHERE f.id=candidate.id
       RETURNING f.id, f.workspace_owner_id, f.assignment_id, f.source_photo_path,
                  f.lease_token`,
      [token],
    );
    const row = claimed.rows[0];
    if (!row) break;
    processed++;
    // Every attempt gets a distinct extensionless destination. A lost lease
    // can therefore clean up only its own bytes, never a winner's ready asset.
    const baseKey = `real-deliveries/${randomUUID()}`;
    await pool.query(
      `UPDATE florist_photo_publications SET public_asset_base_key=$1
        WHERE id=$2 AND lease_token=$3`,
      [baseKey, row.id, token],
    );
    let publicKey: string | null = null;
    try {
      publicKey = await objectStorageService.copyPrivateImageToPublicSanitized(
        row.source_photo_path, baseKey, row.workspace_owner_id,
      );
      const saved = await pool.query(
        `UPDATE florist_photo_publications f SET publication_status='ready', public_asset_key=$1,
             lease_token=NULL, lease_until=NULL, next_attempt_at=NULL, last_error=NULL, updated_at=now()
          FROM order_florist_assignments a, orders o
         WHERE f.id=$2 AND f.lease_token=$3 AND a.id=f.assignment_id
           AND o.id=a.order_id AND o.workspace_owner_id=a.workspace_owner_id
           AND a.photo_set_rev=f.photo_set_rev AND a.photo_items_path=f.source_photo_path
           AND a.verification_status='approved' AND o.status='completed'`,
        [publicKey, row.id, token],
      );
      if (!saved.rowCount) {
        await objectStorageService.deletePublicObject(publicKey).catch(() => {});
      }
    } catch (error) {
      if (publicKey) {
        await objectStorageService.deletePublicObject(publicKey).catch(() => {});
      }
      await pool.query(
        `UPDATE florist_photo_publications SET publication_status='failed', lease_token=NULL,
             lease_until=NULL, next_attempt_at=now()+interval '1 minute',
             last_error=$1, updated_at=now() WHERE id=$2 AND lease_token=$3`,
        [error instanceof Error ? error.message.slice(0, 1000) : "public copy failed", row.id, token],
      );
      logger.warn({ err: error, publicationId: row.id }, "real delivery publication copy failed");
    }
  }
  // Invalidated records are permanently fail-closed, including old manual rows.
  await pool.query(
       `UPDATE florist_photo_publications f SET publication_status='stale', enabled=false,
        lease_token=NULL, lease_until=NULL, updated_at=now()
       FROM order_florist_assignments a
       JOIN orders o ON o.id=a.order_id AND o.workspace_owner_id=a.workspace_owner_id
      WHERE f.assignment_id=a.id AND f.publication_status <> 'stale'
        AND (a.photo_set_rev <> f.photo_set_rev OR a.photo_items_path IS DISTINCT FROM f.source_photo_path
             OR a.verification_status <> 'approved' OR o.status <> 'completed')`,
  );
  return processed;
}

let publicationTimer: ReturnType<typeof setInterval> | null = null;
let publicationTickRunning = false;

/** Starts one unref'd bounded poller; exported stop hook keeps unit tests clean. */
export function startRealDeliveryPublicationWorker(): void {
  if (publicationTimer) return;
  const tick = () => {
    if (publicationTickRunning) return;
    publicationTickRunning = true;
    void processRealDeliveryPublications(db, 10)
      .catch((error) => logger.error({ err: error }, "real delivery publication worker tick failed"))
      .finally(() => { publicationTickRunning = false; });
  };
  tick();
  publicationTimer = setInterval(tick, 30_000);
  publicationTimer.unref();
  logger.info({ intervalMs: 30_000 }, "real delivery publication worker started");
}

export function stopRealDeliveryPublicationWorker(): void {
  if (publicationTimer) clearInterval(publicationTimer);
  publicationTimer = null;
  publicationTickRunning = false;
}