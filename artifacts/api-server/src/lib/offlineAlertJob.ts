import { db } from "./db";
import { logger } from "./logger";
import { sendOfflineAlertEmail } from "./email";
import { clerkClient } from "@clerk/express";

const JOB_INTERVAL_MS = 60_000;

type WorkspaceRow = {
  workspace_owner_id: string;
  offline_alert_threshold_minutes: number;
};

type DeviceRow = {
  id: number;
  name: string;
  user_id: string;
  last_seen_at: string | null;
  offline_alert_sent_at: string | null;
};

async function getOwnerEmail(userId: string): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(userId);
    return user.primaryEmailAddress?.emailAddress ?? null;
  } catch {
    return null;
  }
}

async function runCheck(): Promise<void> {
  const settingsResult = await db.query<WorkspaceRow>(
    `SELECT workspace_owner_id, offline_alert_threshold_minutes
     FROM workspace_settings
     WHERE offline_alert_email_enabled = true`,
  );

  if (!settingsResult.rowCount || settingsResult.rowCount === 0) return;

  for (const ws of settingsResult.rows) {
    const { workspace_owner_id: ownerId, offline_alert_threshold_minutes: thresholdMinutes } = ws;

    const devicesResult = await db.query<DeviceRow>(
      `SELECT id, name, user_id, last_seen_at, offline_alert_sent_at
       FROM devices
       WHERE user_id = $1
         AND last_seen_at IS NOT NULL
         AND last_seen_at < now() - ($2 || ' minutes')::interval
         AND (offline_alert_sent_at IS NULL OR offline_alert_sent_at < last_seen_at)`,
      [ownerId, thresholdMinutes],
    );

    if (!devicesResult.rowCount || devicesResult.rowCount === 0) continue;

    const alertDevices = devicesResult.rows;
    const deviceNames = alertDevices.map((d) => d.name);
    const deviceIds = alertDevices.map((d) => d.id);

    const email = await getOwnerEmail(ownerId);
    if (!email) {
      logger.warn({ ownerId }, "Could not fetch owner email for offline alert");
      continue;
    }

    try {
      await sendOfflineAlertEmail({ toEmail: email, deviceNames, thresholdMinutes });

      await db.query(
        `UPDATE devices SET offline_alert_sent_at = now() WHERE id = ANY($1::int[])`,
        [deviceIds],
      );

      logger.info({ ownerId, deviceCount: deviceIds.length }, "Offline alert processed");
    } catch (err) {
      logger.warn({ err, ownerId }, "Failed to send offline alert email");
    }
  }
}

export function startOfflineAlertJob(): void {
  const tick = async () => {
    try {
      await runCheck();
    } catch (err) {
      logger.warn({ err }, "Offline alert job error");
    }
  };

  setInterval(tick, JOB_INTERVAL_MS);
  logger.info("Offline alert background job started");
}
