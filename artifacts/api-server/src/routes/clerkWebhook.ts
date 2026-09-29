import { Router, type Request, type Response } from "express";
import { Webhook } from "svix";
import { clerkClient } from "@clerk/express";
import { db } from "../lib/db";
import { sendNewSignInAlertEmail, sendUnexpectedCountryAlertEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router = Router();

type RawRequest = Request & { rawBody?: Buffer };

/**
 * Builds a device fingerprint from Clerk session activity data.
 * Combines browser name + device type to identify a device category.
 * Falls back to "unknown" when data is missing.
 */
function buildDeviceFingerprint(latestActivity: {
  browserName?: string | null;
  deviceType?: string | null;
  osName?: string | null;
} | null | undefined): string {
  const parts = [
    latestActivity?.browserName ?? "unknown_browser",
    latestActivity?.deviceType ?? "unknown_device",
    latestActivity?.osName ?? "unknown_os",
  ];
  return parts.join("|").toLowerCase();
}

/**
 * Builds a human-readable device label for email notifications.
 */
function buildDeviceLabel(latestActivity: {
  browserName?: string | null;
  deviceType?: string | null;
  osName?: string | null;
} | null | undefined): string {
  const browser = latestActivity?.browserName;
  const device = latestActivity?.deviceType;
  const os = latestActivity?.osName;
  if (browser && os) return `${browser} on ${os}`;
  if (browser && device) return `${browser} on ${device}`;
  if (browser) return browser;
  if (device) return device;
  return "Unknown device";
}

/**
 * POST /api/webhooks/clerk
 * Handles Clerk webhook events — specifically session.created.
 * Verifies the svix signature using CLERK_WEBHOOK_SECRET.
 * On a new sign-in from an unfamiliar device, sends an alert email
 * to the user (unless they have opted out via notify_email_on_new_sign_in).
 */
router.post("/webhooks/clerk", async (req: RawRequest, res: Response) => {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn("CLERK_WEBHOOK_SECRET not set — Clerk webhook handler is disabled");
    res.status(503).json({ error: "Clerk webhook not configured" });
    return;
  }

  const svixId = req.headers["svix-id"] as string | undefined;
  const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
  const svixSignature = req.headers["svix-signature"] as string | undefined;

  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: "Missing svix headers" });
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    res.status(400).json({ error: "Missing request body" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const wh = new Webhook(webhookSecret);
    payload = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "Clerk webhook signature verification failed");
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const eventType = payload["type"] as string | undefined;
  if (eventType !== "session.created") {
    res.json({ received: true });
    return;
  }

  try {
    const data = payload["data"] as Record<string, unknown> | undefined;
    if (!data) {
      res.json({ received: true });
      return;
    }

    const userId = data["user_id"] as string | undefined;
    const sessionId = data["id"] as string | undefined;
    if (!userId || !sessionId) {
      res.json({ received: true });
      return;
    }

    const latestActivity = data["latest_activity"] as {
      browser_name?: string | null;
      device_type?: string | null;
      os_name?: string | null;
      city?: string | null;
      country?: string | null;
      ip_address?: string | null;
    } | null | undefined;

    const activityNormalized = {
      browserName: latestActivity?.browser_name ?? null,
      deviceType: latestActivity?.device_type ?? null,
      osName: latestActivity?.os_name ?? null,
    };

    const deviceFingerprint = buildDeviceFingerprint(activityNormalized);
    const deviceLabel = buildDeviceLabel(activityNormalized);

    const existingCount = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM known_user_devices WHERE user_id = $1`,
      [userId],
    );
    const priorDeviceCount = parseInt(existingCount.rows[0]?.count ?? "0", 10);

    const insertResult = await db.query(
      `INSERT INTO known_user_devices (user_id, device_fingerprint)
       VALUES ($1, $2)
       ON CONFLICT (user_id, device_fingerprint) DO NOTHING`,
      [userId, deviceFingerprint],
    );
    const isNewDevice = (insertResult.rowCount ?? 0) > 0;

    const country = latestActivity?.country ?? null;
    const createdAt = data["created_at"] as number | null | undefined;
    const signedInAt = createdAt
      ? new Date(createdAt).toUTCString()
      : new Date().toUTCString();

    // --- Unexpected-country detection ---
    // Track and alert when a session comes from a previously-unseen country.
    // A 1-hour per-user cooldown prevents email flooding.
    let isUnexpectedCountry = false;
    if (country) {
      const priorCountryCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM known_user_countries WHERE user_id = $1`,
        [userId],
      );
      const hadKnownCountries = parseInt(priorCountryCount.rows[0]?.count ?? "0", 10) > 0;

      const countryInsert = await db.query(
        `INSERT INTO known_user_countries (user_id, country)
         VALUES ($1, $2)
         ON CONFLICT (user_id, country) DO NOTHING`,
        [userId, country],
      );
      isUnexpectedCountry = hadKnownCountries && (countryInsert.rowCount ?? 0) > 0;
    }

    // Schema sentinel: sign-in webhook reads and writes workspace_members:
    //   - member_email (SELECT), member_user_id (WHERE filter + UPDATE WHERE),
    //     joined_at (WHERE IS NOT NULL), notify_email_on_new_sign_in (SELECT)
    // Update here if any of those columns is renamed.
    // --- Resolve user email and preferences ---
    const memberResult = await db.query<{
      member_email: string;
      notify_email_on_new_sign_in: boolean;
      last_country_alert_at: Date | null;
    }>(
      `SELECT member_email, notify_email_on_new_sign_in, last_country_alert_at
         FROM workspace_members
        WHERE member_user_id = $1
          AND joined_at IS NOT NULL
        LIMIT 1`,
      [userId],
    );
    const member = memberResult.rows[0];

    // Handle unexpected-country alerts for workspace members.
    if (isUnexpectedCountry && country && member) {
      const lastAlertAt = member.last_country_alert_at;
      const cooldownMs = 60 * 60 * 1000;
      const outsideCooldown =
        !lastAlertAt || Date.now() - new Date(lastAlertAt).getTime() > cooldownMs;

      if (outsideCooldown) {
        await db.query(
          `UPDATE workspace_members SET last_country_alert_at = now() WHERE member_user_id = $1`,
          [userId],
        );
        await sendUnexpectedCountryAlertEmail({
          toEmail: member.member_email,
          deviceLabel,
          country,
          signedInAt,
        });
        await db.query(
          `INSERT INTO security_alert_events (user_id, kind, device_label, country) VALUES ($1, $2, $3, $4)`,
          [userId, "unexpected_country", deviceLabel, country],
        );
      }
    }

    // Handle unexpected-country alerts for non-workspace users (no cooldown table).
    if (isUnexpectedCountry && country && !member) {
      let userEmail: string | null = null;
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        const primary = clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId,
        );
        userEmail = primary?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? null;
      } catch (e) {
        logger.warn({ userId }, "Could not fetch Clerk user for unexpected-country alert");
      }
      if (userEmail) {
        await sendUnexpectedCountryAlertEmail({
          toEmail: userEmail,
          deviceLabel,
          country,
          signedInAt,
        });
        await db.query(
          `INSERT INTO security_alert_events (user_id, kind, device_label, country) VALUES ($1, $2, $3, $4)`,
          [userId, "unexpected_country", deviceLabel, country],
        );
      }
    }

    // --- New-device alerts (existing behaviour) ---
    if (!isNewDevice || priorDeviceCount === 0) {
      res.json({ received: true });
      return;
    }

    if (!member) {
      let userEmail: string | null = null;
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        const primary = clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId,
        );
        userEmail = primary?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? null;
      } catch (e) {
        logger.warn({ userId }, "Could not fetch Clerk user for new sign-in alert");
      }

      if (userEmail) {
        await sendNewSignInAlertEmail({
          toEmail: userEmail,
          deviceLabel,
          city: latestActivity?.city ?? null,
          country: latestActivity?.country ?? null,
          signedInAt,
        });
        await db.query(
          `INSERT INTO security_alert_events (user_id, kind, device_label, country) VALUES ($1, $2, $3, $4)`,
          [userId, "new_device", deviceLabel, country],
        );
      }

      res.json({ received: true });
      return;
    }

    if (!member.notify_email_on_new_sign_in) {
      res.json({ received: true });
      return;
    }

    await sendNewSignInAlertEmail({
      toEmail: member.member_email,
      deviceLabel,
      city: latestActivity?.city ?? null,
      country: latestActivity?.country ?? null,
      signedInAt,
    });
    await db.query(
      `INSERT INTO security_alert_events (user_id, kind, device_label, country) VALUES ($1, $2, $3, $4)`,
      [userId, "new_device", deviceLabel, country],
    );
  } catch (err) {
    logger.error({ err }, "Error processing Clerk session.created webhook");
  }

  res.json({ received: true });
});

export default router;
