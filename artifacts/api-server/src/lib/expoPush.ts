import { db } from "./db";
import { logger } from "./logger";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearStalePushToken(token: string): Promise<void> {
  try {
    await db.query(
      `UPDATE fleet_drivers SET expo_push_token = NULL, updated_at = now() WHERE expo_push_token = $1`,
      [token],
    );
    logger.info({ token }, "Cleared stale DeviceNotRegistered push token from driver");
  } catch (err: unknown) {
    logger.warn({ err, token }, "Failed to clear stale push token from driver");
  }
}

export async function sendExpoPushNotification(
  token: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  onDeviceNotRegistered?: (token: string) => Promise<void>,
): Promise<{ success: boolean }> {
  const message = {
    to: token,
    sound: "default",
    title,
    body,
    ...(data ? { data } : {}),
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.pow(2, attempt - 1) * 1000;
      await sleep(backoffMs);
    }

    let response: Response;
    try {
      response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(message),
      });
    } catch (err: unknown) {
      lastError = err;
      logger.warn(
        { token, attempt: attempt + 1, err },
        "Expo push notification network error; will retry if attempts remain",
      );
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      lastError = new Error(`HTTP ${response.status}`);
      logger.warn(
        { token, status: response.status, body: text, attempt: attempt + 1 },
        "Expo push notification HTTP error; will retry if attempts remain",
      );
      continue;
    }

    const result = (await response.json()) as { data?: { status?: string; message?: string; details?: { error?: string } } };
    const ticket = result.data;

    if (ticket?.status === "error") {
      const errorType = ticket.details?.error ?? ticket.message;
      logger.warn({ token, message: ticket.message, errorType }, "Expo push notification returned error ticket");

      if (errorType === "DeviceNotRegistered") {
        if (onDeviceNotRegistered) {
          await onDeviceNotRegistered(token);
        } else {
          await clearStalePushToken(token);
        }
      }
      return { success: false };
    }

    return { success: true };
  }

  logger.warn(
    { token, attempts: MAX_RETRIES + 1, err: lastError },
    "Expo push notification failed after all retries; giving up",
  );
  return { success: false };
}
