import { Router } from "express";
import { z } from "zod/v4";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";

const router = Router();

const CheckResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  reason: z.string().optional(),
});

const PostBodySchema = z.object({
  base_url: z.string(),
  passed: z.boolean(),
  total: z.number().int(),
  passed_count: z.number().int(),
  failed_count: z.number().int(),
  checks: z.array(CheckResultSchema),
  duration_ms: z.number().int().optional(),
});

type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * Reads SMOKE_TEST_CONSECUTIVE_FAILURE_THRESHOLD from env.
 * Must be an integer >= 2. Falls back to 3.
 */
function consecutiveFailureThreshold(): number {
  const raw = parseInt(process.env["SMOKE_TEST_CONSECUTIVE_FAILURE_THRESHOLD"] ?? "3", 10);
  return Number.isFinite(raw) && raw >= 2 ? raw : 3;
}

/**
 * Sends a Slack-compatible high-priority alert when specific checks have
 * failed in N consecutive runs. Never throws — failures are logged only.
 */
async function sendConsecutiveFailureAlert(
  baseUrl: string,
  failedChecks: { name: string; reason?: string }[],
  threshold: number,
): Promise<void> {
  const webhookUrl = process.env["SMOKE_TEST_ALERT_WEBHOOK_URL"];
  if (!webhookUrl) return;

  const failLines = failedChecks
    .map((c) => `• *${c.name}*: ${c.reason ?? "unknown reason"}`)
    .join("\n");

  const payload = {
    text: `:sos: *Smoke test repeatedly failing for ${baseUrl}* (${threshold} consecutive failures)`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:sos: *Repeated smoke-test failures — <${baseUrl}|${baseUrl}>*\nThe following check(s) have failed in the last *${threshold} consecutive runs*:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: failLines,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Consecutive failure threshold: ${threshold} | Alert sent at ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Consecutive-failure alert webhook returned non-OK status");
    } else {
      logger.info({ threshold, checks: failedChecks.map((c) => c.name) }, "Consecutive-failure alert sent");
    }
  } catch (err) {
    logger.warn({ err }, "Could not send consecutive-failure alert webhook");
  }
}

/**
 * After a new run is persisted, inspect the last `threshold` runs *for the
 * same base_url* to detect any check that has failed in every one of them.
 * Returns the check names (and reasons from the latest run) that have reached
 * the threshold.
 */
async function detectConsecutiveFailures(
  threshold: number,
  currentFailedChecks: CheckResult[],
  baseUrl: string,
): Promise<{ name: string; reason?: string }[]> {
  if (currentFailedChecks.length === 0) return [];

  // Query the last `threshold` runs for this specific base_url, newest-first.
  // Use (ran_at DESC, id DESC) for deterministic ordering when timestamps tie.
  const result = await db.query<{ checks: CheckResult[] }>(
    `SELECT checks FROM smoke_test_runs
      WHERE base_url = $1
      ORDER BY ran_at DESC, id DESC
      LIMIT $2`,
    [baseUrl, threshold],
  );

  // Not enough history yet to conclude consecutive failures.
  if (result.rows.length < threshold) return [];

  const consecutivelyFailed: { name: string; reason?: string }[] = [];

  for (const check of currentFailedChecks) {
    // Walk through each historical run (newest→oldest) and confirm the check
    // failed in every one of them.
    let consecutiveCount = 0;
    for (const row of result.rows) {
      const match = (row.checks ?? []).find((c) => c.name === check.name);
      if (match && !match.passed) {
        consecutiveCount++;
      } else {
        // Check passed (or was absent) in this run — streak is broken.
        break;
      }
    }
    if (consecutiveCount >= threshold) {
      consecutivelyFailed.push({ name: check.name, reason: check.reason });
    }
  }

  return consecutivelyFailed;
}

/**
 * POST /api/smoke-test-runs
 *
 * Called by the smoke-test script after each run. Authenticated with the
 * SMOKE_TEST_SECRET shared secret supplied in the X-Smoke-Test-Secret header.
 * No Clerk session required — the script runs outside the browser.
 *
 * After persisting the run, the handler checks whether any check has failed in
 * the last SMOKE_TEST_CONSECUTIVE_FAILURE_THRESHOLD consecutive runs (default 3)
 * and, if so, fires a high-priority alert to SMOKE_TEST_ALERT_WEBHOOK_URL.
 */
router.post("/smoke-test-runs", async (req, res) => {
  const secret = process.env["SMOKE_TEST_SECRET"];
  if (!secret) {
    res.status(503).json({ error: "SMOKE_TEST_SECRET is not configured on the server" });
    return;
  }

  const provided = req.headers["x-smoke-test-secret"];
  if (provided !== secret) {
    res.status(401).json({ error: "Invalid smoke-test secret" });
    return;
  }

  const parse = PostBodySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body", details: parse.error.issues });
    return;
  }

  const { base_url, passed, total, passed_count, failed_count, checks, duration_ms } = parse.data;

  try {
    const result = await db.query<{ id: number; ran_at: string }>(
      `INSERT INTO smoke_test_runs
         (base_url, passed, total, passed_count, failed_count, checks, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, ran_at`,
      [base_url, passed, total, passed_count, failed_count, JSON.stringify(checks), duration_ms ?? null],
    );
    const row = result.rows[0];

    // --- Consecutive failure detection (fire-and-forget, never blocks the response) ---
    const threshold = consecutiveFailureThreshold();
    const failedChecks = checks.filter((c) => !c.passed);

    void detectConsecutiveFailures(threshold, failedChecks, base_url)
      .then((consecutivelyFailed) => {
        if (consecutivelyFailed.length > 0) {
          return sendConsecutiveFailureAlert(base_url, consecutivelyFailed, threshold);
        }
        return Promise.resolve();
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "Consecutive failure detection error (non-fatal)");
      });

    res.status(201).json({ success: true, id: row?.id, ran_at: row?.ran_at });
  } catch (err) {
    logger.error({ err }, "Failed to insert smoke_test_run");
    res.status(500).json({ error: "Failed to save smoke-test run" });
  }
});

/**
 * GET /api/smoke-test-runs
 *
 * Owner-only. Returns the most recent 100 smoke-test run records, newest first.
 * Supports optional ?limit=N (max 500) query param.
 */
router.get(
  "/smoke-test-runs",
  requireAuth,
  resolveWorkspace,
  async (req, res) => {
    const ws = workspace(req);
    if (ws.workspaceRole !== "owner") {
      res.status(403).json({ error: "Owner access required" });
      return;
    }

    const rawLimit = parseInt(String(req.query["limit"] ?? "100"), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

    try {
      const result = await db.query<{
        id: number;
        ran_at: string;
        base_url: string;
        passed: boolean;
        total: number;
        passed_count: number;
        failed_count: number;
        checks: unknown;
        duration_ms: number | null;
      }>(
        `SELECT id, ran_at, base_url, passed, total, passed_count, failed_count, checks, duration_ms
           FROM smoke_test_runs
          ORDER BY ran_at DESC
          LIMIT $1`,
        [limit],
      );
      res.json({ success: true, runs: result.rows });
    } catch (err) {
      logger.error({ err }, "Failed to query smoke_test_runs");
      res.status(500).json({ error: "Failed to fetch smoke-test runs" });
    }
  },
);

export default router;
