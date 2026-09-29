/**
 * Scheduled re-evaluation for ACTIVE dynamic audiences.
 *
 * Schedule (documented contract):
 *  - The poller ticks every 15 minutes.
 *  - Each tick re-evaluates active dynamic audiences whose last evaluation is
 *    missing or older than 60 minutes (staleness window), oldest first, up to
 *    a small batch cap so one giant workspace cannot starve the rest.
 *  - POST /api/audiences/:id/refresh forces an immediate re-evaluation (used
 *    by the dashboard after relevant data changes).
 *
 * State machine per audience (recoverable): evaluation_status
 * idle → running → ok | error. Failures persist evaluation_error and keep the
 * previous cached_counts; the next tick retries. Logs carry durations and
 * result counts only — never contact PII.
 */
import { db } from "./db";
import { logger } from "./logger";
import { evaluateMetrics } from "./audienceEvaluate";
import type { RuleTree } from "./audienceRules";

const TICK_INTERVAL_MS = 15 * 60 * 1_000;
const STALE_AFTER_MINUTES = 60;
const BATCH_LIMIT = 20;

/**
 * Re-evaluate a single audience and persist counts/status. Returns true on
 * success. Static audiences just refresh their cached member counts.
 */
export async function refreshAudience(
  workspaceOwnerId: string,
  audienceId: string,
): Promise<boolean> {
  const started = Date.now();
  const r = await db.query<{ id: string; kind: string; rules: RuleTree | null }>(
    `UPDATE audiences SET evaluation_status = 'running', updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING id, kind, rules`,
    [audienceId, workspaceOwnerId],
  );
  const row = r.rows[0];
  if (!row) return false;
  try {
    const metrics = await evaluateMetrics(
      workspaceOwnerId,
      row.kind === "static"
        ? { kind: "static", audienceId: row.id }
        : { kind: "rules", tree: row.rules as RuleTree },
    );
    await db.query(
      `UPDATE audiences
          SET cached_counts = $2, last_evaluated_at = now(),
              evaluation_status = 'ok', evaluation_error = NULL, updated_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify(metrics)],
    );
    logger.info(
      {
        audienceId: row.id,
        durationMs: Date.now() - started,
        matched: metrics.matched,
        excluded: metrics.excluded,
      },
      "audiences: evaluation complete",
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .query(
        `UPDATE audiences
            SET evaluation_status = 'error', evaluation_error = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, message.slice(0, 1000)],
      )
      .catch(() => {});
    logger.warn(
      { err, audienceId: row.id, durationMs: Date.now() - started },
      "audiences: evaluation failed",
    );
    return false;
  }
}

/** One poller tick — refresh stale active dynamic audiences, oldest first. */
export async function refreshStaleAudiences(): Promise<number> {
  const r = await db.query<{ id: string; workspace_owner_id: string }>(
    `SELECT id, workspace_owner_id
       FROM audiences
      WHERE status = 'active' AND kind = 'dynamic' AND rules IS NOT NULL
        AND (last_evaluated_at IS NULL OR last_evaluated_at < now() - interval '${STALE_AFTER_MINUTES} minutes')
        -- 'running' rows older than the stale window are retried too (crash recovery)
        AND (evaluation_status <> 'running' OR updated_at < now() - interval '${STALE_AFTER_MINUTES} minutes')
      ORDER BY last_evaluated_at ASC NULLS FIRST
      LIMIT ${BATCH_LIMIT}`,
  );
  let ok = 0;
  for (const row of r.rows) {
    if (await refreshAudience(row.workspace_owner_id, row.id)) ok += 1;
  }
  return ok;
}

export function startAudienceRefreshJob(): void {
  const tick = async () => {
    try {
      await refreshStaleAudiences();
    } catch (err) {
      logger.warn({ err }, "Audience refresh poller error");
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref?.();
  logger.info(
    { intervalMinutes: TICK_INTERVAL_MS / 60_000, staleAfterMinutes: STALE_AFTER_MINUTES },
    "Audience refresh poller started",
  );
}
