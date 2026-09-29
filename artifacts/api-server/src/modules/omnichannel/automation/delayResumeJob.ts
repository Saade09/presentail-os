// ---------------------------------------------------------------------------
// Omnichannel — delay resume scheduled job
//
// Runs every 30 seconds.  Finds automation executions that are waiting on a
// delay node whose timer has now expired (context->>'delayResumeAt' <= NOW())
// and resumes them by calling resumeExecution().
// ---------------------------------------------------------------------------

import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { resumeExecution } from "./flowExecutor";

const POLL_INTERVAL_MS = 30_000;

let pollerHandle: ReturnType<typeof setInterval> | null = null;

async function scanOnce(): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT id
     FROM omni_automation_executions
     WHERE status = 'waiting'
       AND context->>'delayResumeAt' IS NOT NULL
       AND (context->>'delayResumeAt')::timestamptz <= NOW()`,
  );

  if (result.rows.length === 0) return;

  for (const row of result.rows) {
    try {
      await resumeExecution(row.id, null);
      logger.info({ executionId: row.id }, "omnichannel: delay timer expired — execution resumed");
    } catch (err) {
      logger.error({ err, executionId: row.id }, "omnichannel: delayResumeJob failed to resume execution");
    }
  }
}

export function startDelayResumeJob(): void {
  if (pollerHandle !== null) return;

  pollerHandle = setInterval(() => {
    scanOnce().catch((err: unknown) => {
      logger.error({ err }, "omnichannel: delayResumeJob scan threw unexpected error");
    });
  }, POLL_INTERVAL_MS);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "omnichannel: delay resume job started");
}

export function stopDelayResumeJob(): void {
  if (pollerHandle !== null) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}
