import crypto from "crypto";
import { randomUUID } from "crypto";
import { db } from "./db";
import { logger } from "./logger";
import { isPrivateUrl } from "./urlValidator";

export type ProductWebhookEvent =
  | "product.created"
  | "product.updated"
  | "product.price_updated"
  | "product.hidden"
  | "product.unhidden"
  | "product.published"
  | "product.unpublished"
  | "product.availability_updated"
  | "product.images_updated";

const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_MAX = 2000;

export type ProductWebhookPayload = {
  id: string;
  event: ProductWebhookEvent;
  created_at: string;
  brand_id: number | null;
  channel_id: number;
  product_id: number;
  product_slug: string | null;
  changed_fields: string[] | null;
  api_url: string;
  data?: Record<string, unknown>;
};

function signPayload(secret: string, deliveryId: string, timestamp: string, body: string): string {
  const message = `${deliveryId}.${timestamp}.${body}`;
  return "sha256=" + crypto.createHmac("sha256", secret).update(message).digest("hex");
}

async function attemptDelivery(
  endpointUrl: string,
  signingSecret: string,
  event: string,
  payloadBody: string,
): Promise<{ success: boolean; responseStatus: number | null; responseBody: string; durationMs: number }> {
  const deliveryUuid = randomUUID();
  const timestamp = new Date().toISOString();
  const signature = signPayload(signingSecret, deliveryUuid, timestamp, payloadBody);

  if (isPrivateUrl(endpointUrl)) {
    logger.warn({ endpointUrl }, "productWebhook: blocked delivery to private/non-HTTPS URL");
    return {
      success: false,
      responseStatus: null,
      responseBody: "blocked: endpoint_url is not a public HTTPS address",
      durationMs: 0,
    };
  }

  const startMs = Date.now();
  try {
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Presentail-Event": event,
        "X-Presentail-Delivery": deliveryUuid,
        "X-Presentail-Timestamp": timestamp,
        "X-Presentail-Signature": signature,
      },
      body: payloadBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    let responseBody = "";
    try { responseBody = await res.text(); } catch { responseBody = ""; }

    return {
      success: res.ok,
      responseStatus: res.status,
      responseBody: responseBody.slice(0, RESPONSE_BODY_MAX),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    logger.warn({ err, endpointUrl }, "productWebhook: fetch error");
    return {
      success: false,
      responseStatus: null,
      responseBody: String(err).slice(0, RESPONSE_BODY_MAX),
      durationMs: Date.now() - startMs,
    };
  }
}

export async function retryDelivery(
  deliveryId: string,
  endpointId: number,
  endpointUrl: string,
  signingSecret: string,
  event: string,
  payload: unknown,
): Promise<void> {
  return performDelivery(deliveryId, endpointId, endpointUrl, signingSecret, event, payload, 0);
}

async function performDelivery(
  deliveryId: string,
  endpointId: number,
  endpointUrl: string,
  signingSecret: string,
  event: string,
  payload: unknown,
  attemptCount: number,
): Promise<void> {
  const payloadBody = JSON.stringify(payload);
  const { success, responseStatus, responseBody, durationMs } = await attemptDelivery(
    endpointUrl, signingSecret, event, payloadBody,
  );
  const newAttemptCount = attemptCount + 1;

  if (success) {
    await db.query(
      `UPDATE product_webhook_deliveries SET status = 'delivered', response_status = $1, response_body = $2, attempt_count = $3, next_retry_at = NULL, duration_ms = $4 WHERE id = $5`,
      [responseStatus, responseBody, newAttemptCount, durationMs, deliveryId],
    );
    await db.query(
      `UPDATE channel_webhook_endpoints SET last_delivery_status = 'delivered', last_delivery_at = now() WHERE id = $1`,
      [endpointId],
    );
    return;
  }

  if (newAttemptCount >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE product_webhook_deliveries SET status = 'failed', response_status = $1, response_body = $2, attempt_count = $3, next_retry_at = NULL, duration_ms = $4 WHERE id = $5`,
      [responseStatus, responseBody, newAttemptCount, durationMs, deliveryId],
    );
    await db.query(
      `UPDATE channel_webhook_endpoints SET last_delivery_status = 'failed', last_delivery_at = now() WHERE id = $1`,
      [endpointId],
    );
    logger.warn({ deliveryId, endpointId, attempts: newAttemptCount }, "productWebhook: max retries exhausted");
    return;
  }

  const delayMs = BACKOFF_DELAYS_MS[newAttemptCount - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await db.query(
    `UPDATE product_webhook_deliveries SET status = 'pending_retry', response_status = $1, response_body = $2, attempt_count = $3, next_retry_at = $4, duration_ms = $5 WHERE id = $6`,
    [responseStatus, responseBody, newAttemptCount, nextRetryAt, durationMs, deliveryId],
  );
  await db.query(
    `UPDATE channel_webhook_endpoints SET last_delivery_status = 'pending_retry', last_delivery_at = now() WHERE id = $1`,
    [endpointId],
  );

  setTimeout(() => {
    performDelivery(deliveryId, endpointId, endpointUrl, signingSecret, event, payload, newAttemptCount).catch((err) => {
      logger.error({ err, deliveryId }, "productWebhook: unexpected error during retry");
    });
  }, delayMs);
}

export async function fireProductWebhook(
  channelId: number,
  workspaceOwnerId: string,
  event: ProductWebhookEvent,
  payload: ProductWebhookPayload,
): Promise<void> {
  const endpointsResult = await db.query<{
    id: number;
    endpoint_url: string;
    signing_secret: string;
    subscribed_events: string[];
  }>(
    `SELECT id, endpoint_url, signing_secret, subscribed_events
       FROM channel_webhook_endpoints
      WHERE channel_id = $1
        AND workspace_owner_id = $2
        AND is_active = true
        AND (subscribed_events @> $3::jsonb OR subscribed_events @> '["product.*"]'::jsonb)`,
    [channelId, workspaceOwnerId, JSON.stringify([event])],
  );

  if (endpointsResult.rowCount === 0) return;

  for (const endpoint of endpointsResult.rows) {
    const deliveryId = randomUUID();
    try {
      await db.query(
        `INSERT INTO product_webhook_deliveries (id, channel_webhook_endpoint_id, event, payload, status, attempt_count)
         VALUES ($1, $2, $3, $4, 'pending', 0)`,
        [deliveryId, endpoint.id, event, JSON.stringify(payload)],
      );
      performDelivery(deliveryId, endpoint.id, endpoint.endpoint_url, endpoint.signing_secret, event, payload, 0).catch((err) => {
        logger.error({ err, deliveryId, endpointId: endpoint.id }, "productWebhook: unexpected error during initial delivery");
      });
    } catch (err) {
      logger.error({ err, endpointId: endpoint.id }, "productWebhook: failed to insert delivery record");
    }
  }
}
