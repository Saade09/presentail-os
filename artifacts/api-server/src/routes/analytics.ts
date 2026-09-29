import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

router.get("/analytics", async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;
  const period = (req.query.period as string) ?? "7d";

  let dateFilter: string;
  let prevDateFilter: string | null;

  switch (period) {
    case "today":
      dateFilter = "AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')";
      prevDateFilter =
        "AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day'" +
        " AND created_at < now() - interval '1 day'";
      break;
    case "30d":
      dateFilter = "AND created_at >= now() - interval '30 days'";
      prevDateFilter =
        "AND created_at >= now() - interval '60 days'" +
        " AND created_at < now() - interval '30 days'";
      break;
    case "all":
      dateFilter = "";
      prevDateFilter = null;
      break;
    case "7d":
    default:
      dateFilter = "AND created_at >= now() - interval '7 days'";
      prevDateFilter =
        "AND created_at >= now() - interval '14 days'" +
        " AND created_at < now() - interval '7 days'";
      break;
  }

  const summaryResult = await db.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status IN ('done', 'completed')) AS completed,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed,
       COALESCE(SUM(pages * copies), 0) AS pages_printed
     FROM print_jobs
     WHERE user_id = $1 ${dateFilter}`,
    [ownerId],
  );

  const summary = summaryResult.rows[0] as {
    total: string;
    completed: string;
    failed: string;
    pages_printed: string;
  };

  let previousSummary: { total: number; completed: number; failed: number; pages_printed: number } | null = null;

  if (prevDateFilter !== null) {
    const prevResult = await db.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status IN ('done', 'completed')) AS completed,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COALESCE(SUM(pages * copies), 0) AS pages_printed
       FROM print_jobs
       WHERE user_id = $1 ${prevDateFilter}`,
      [ownerId],
    );
    const prev = prevResult.rows[0] as {
      total: string;
      completed: string;
      failed: string;
      pages_printed: string;
    };
    previousSummary = {
      total: parseInt(prev.total, 10),
      completed: parseInt(prev.completed, 10),
      failed: parseInt(prev.failed, 10),
      pages_printed: parseInt(prev.pages_printed, 10),
    };
  }

  const dailyResult = await db.query(
    `SELECT
       date_trunc('day', created_at AT TIME ZONE 'UTC')::date::text AS date,
       COUNT(*) AS count
     FROM print_jobs
     WHERE user_id = $1 ${dateFilter}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [ownerId],
  );

  const settingsResult = await db.query(
    `SELECT offline_alert_threshold_minutes
     FROM workspace_settings
     WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const thresholdMinutes: number =
    settingsResult.rowCount && settingsResult.rowCount > 0
      ? (settingsResult.rows[0] as { offline_alert_threshold_minutes: number }).offline_alert_threshold_minutes
      : 5;

  const devicesResult = await db.query(
    `SELECT id, name, last_seen_at
     FROM devices
     WHERE user_id = $1
     ORDER BY last_seen_at DESC NULLS LAST`,
    [ownerId],
  );

  const thresholdMs = thresholdMinutes * 60 * 1000;
  const cutoff = new Date(Date.now() - thresholdMs);

  const devices = (devicesResult.rows as { id: number; name: string; last_seen_at: string | null }[]).map(
    (d) => ({
      id: d.id,
      name: d.name,
      last_seen_at: d.last_seen_at,
      online: d.last_seen_at != null && new Date(d.last_seen_at) >= cutoff,
    }),
  );

  res.json({
    summary: {
      total: parseInt(summary.total, 10),
      completed: parseInt(summary.completed, 10),
      failed: parseInt(summary.failed, 10),
      pages_printed: parseInt(summary.pages_printed, 10),
    },
    previous_summary: previousSummary,
    daily: (dailyResult.rows as { date: string; count: string }[]).map((r) => ({
      date: r.date,
      count: parseInt(r.count, 10),
    })),
    devices,
    offline_alert_threshold_minutes: thresholdMinutes,
  });
});

export default router;
