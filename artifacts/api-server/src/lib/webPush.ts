import webpush from "web-push";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Web Push (VAPID) helper for browser notifications.
 *
 * VAPID keys come from Replit Secrets:
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, optional VAPID_SUBJECT (mailto: or https:).
 * When keys are absent, web push is disabled — endpoints report unavailable
 * and sends are silently skipped (logged once).
 */

let configured = false;
let configAttempted = false;

export function getVapidPublicKey(): string | null {
  return process.env["VAPID_PUBLIC_KEY"] || null;
}

function ensureConfigured(): boolean {
  if (configAttempted) return configured;
  configAttempted = true;
  const publicKey = process.env["VAPID_PUBLIC_KEY"];
  const privateKey = process.env["VAPID_PRIVATE_KEY"];
  if (!publicKey || !privateKey) {
    logger.info("Web push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set");
    return false;
  }
  const subject = process.env["VAPID_SUBJECT"] || "mailto:support@presentail.com";
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  } catch (err: unknown) {
    logger.warn({ err }, "Web push disabled: invalid VAPID configuration");
    configured = false;
  }
  return configured;
}

export function isWebPushEnabled(): boolean {
  return ensureConfigured();
}

export type WebPushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

/**
 * Send a web push notification to every subscription in a workspace.
 * Best-effort: failures are logged, dead subscriptions (404/410) are pruned.
 */
export async function sendWebPushToWorkspace(
  workspaceOwnerId: string,
  payload: WebPushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 };

  const result = await db.query<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `SELECT id, endpoint, p256dh, auth
       FROM web_push_subscriptions
      WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );

  let sent = 0;
  let pruned = 0;
  const body = JSON.stringify(payload);

  for (const sub of result.rows) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
        { TTL: 300, urgency: "high" },
      );
      sent++;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        try {
          await db.query(`DELETE FROM web_push_subscriptions WHERE id = $1`, [sub.id]);
          pruned++;
        } catch (delErr: unknown) {
          logger.warn({ err: delErr, id: sub.id }, "Failed to prune dead web push subscription");
        }
      } else {
        logger.warn(
          { err, id: sub.id, statusCode },
          "Web push send failed for subscription",
        );
      }
    }
  }

  return { sent, pruned };
}
