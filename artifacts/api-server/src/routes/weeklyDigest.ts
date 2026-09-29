// ---------------------------------------------------------------------------
// Weekly Sales Digest — owner-only settings + send-now routes (task #2830)
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { getLastCompletedWeek } from "../lib/weeklyDigest/aggregate";
import {
  buildAndSendWeeklyDigest,
  normalizeExtraRecipients,
} from "../lib/weeklyDigest/send";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage the weekly digest" });
    return;
  }
  next();
}

interface SettingsRow {
  enabled: boolean;
  extra_recipients: unknown;
}

function settingsResponse(row: SettingsRow | null) {
  return {
    enabled: row?.enabled ?? false,
    extra_recipients: normalizeExtraRecipients(row?.extra_recipients),
  };
}

router.get("/digest/settings", requireOwner, async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;
  const result = await db.query(
    `SELECT enabled, extra_recipients FROM weekly_digest_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const row = result.rowCount === 0 ? null : (result.rows[0] as SettingsRow);
  res.json(settingsResponse(row));
});

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    extra_recipients: z
      .array(z.string().trim().toLowerCase().email())
      .max(20)
      .optional(),
  })
  .strict();

router.put("/digest/settings", requireOwner, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const { enabled, extra_recipients } = parsed.data;

  const result = await db.query(
    `INSERT INTO weekly_digest_settings (workspace_owner_id, enabled, extra_recipients, updated_at)
     VALUES ($1, COALESCE($2, false), COALESCE($3::jsonb, '[]'::jsonb), now())
     ON CONFLICT (workspace_owner_id) DO UPDATE SET
       enabled = COALESCE($2, weekly_digest_settings.enabled),
       extra_recipients = COALESCE($3::jsonb, weekly_digest_settings.extra_recipients),
       updated_at = now()
     RETURNING enabled, extra_recipients`,
    [
      ownerId,
      enabled ?? null,
      extra_recipients != null
        ? JSON.stringify(normalizeExtraRecipients(extra_recipients))
        : null,
    ],
  );
  res.json(settingsResponse(result.rows[0] as SettingsRow));
});

router.post("/digest/send-now", requireOwner, async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;
  const settingsResult = await db.query(
    `SELECT extra_recipients FROM weekly_digest_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const extraRecipients = normalizeExtraRecipients(
    (settingsResult.rows[0] as SettingsRow | undefined)?.extra_recipients,
  );

  const window = getLastCompletedWeek();

  try {
    const result = await buildAndSendWeeklyDigest({
      ownerId,
      window,
      extraRecipients,
      recordSend: false,
    });
    if (!result.sent) {
      res.status(409).json({
        error:
          result.reason === "no_recipients"
            ? "No recipients found — the owner has no email on file"
            : "Digest already sent for this week",
      });
      return;
    }
    res.json({
      sent: true,
      week_start: result.weekStart,
      recipients: result.recipients,
    });
  } catch (err) {
    req.log.error({ err }, "Weekly digest send-now failed");
    res.status(502).json({ error: "Failed to send the weekly digest email" });
  }
});

export default router;
