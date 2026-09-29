import crypto from "crypto";
import { randomUUID } from "crypto";
import { db } from "./db";
import { logger } from "./logger";
import { publicWebhookFetch } from "./publicWebhookFetch";

export type CatalogAttributeType = "occasions" | "catalog_categories" | "catalog_brands" | "recipients";

export type CatalogWebhookEvent =
  | "catalog_attribute.occasion.created"
  | "catalog_attribute.occasion.updated"
  | "catalog_attribute.occasion.deleted"
  | "catalog_attribute.occasion.city_availability_updated"
  | "catalog_attribute.catalog_category.created"
  | "catalog_attribute.catalog_category.updated"
  | "catalog_attribute.catalog_category.deleted"
  | "catalog_attribute.catalog_category.city_availability_updated"
  | "catalog_attribute.catalog_brand.created"
  | "catalog_attribute.catalog_brand.updated"
  | "catalog_attribute.catalog_brand.deleted"
  | "catalog_attribute.catalog_brand.city_availability_updated"
  | "catalog_attribute.recipient.created"
  | "catalog_attribute.recipient.updated"
  | "catalog_attribute.recipient.deleted"
  | "catalog_attribute.recipient.city_availability_updated"
  | "catalog_attributes.changed"
  | "currency_rates.updated"
  | "catalog.products.changed"
  | "catalog.brands.changed"
  | "catalog.banners.changed"
  | "delivery.city.updated"
  | "delivery.timeslots.updated"
  | "exchange_rate.updated"
  | "fx.rates.updated"
  | "delivery_config.updated"
  | "product.created"
  | "product.updated"
  | "product.deleted"
  | "order.created"
  | "order.updated"
  | "order.status_updated"
  | "customer.created"
  | "customer.updated"
  | "banner.updated";

const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_MAX = 2000;

function signPayload(secret: string, deliveryId: string, timestamp: string, body: string): string {
  const message = `${deliveryId}.${timestamp}.${body}`;
  return "sha256=" + crypto.createHmac("sha256", secret).update(message).digest("hex");
}

type WebhookEndpointRow = {
  id: number;
  endpoint_url: string;
  signing_secret: string;
  subscribed_events: string[];
};

async function attemptDelivery(
  deliveryId: number,
  endpointUrl: string,
  signingSecret: string,
  event: string,
  payload: unknown,
): Promise<{ success: boolean; responseStatus: number | null; responseBody: string }> {
  const deliveryUuid = randomUUID();
  const timestamp = new Date().toISOString();
  // Re-stamp the body's `timestamp` field with the fresh per-attempt value so it
  // matches the x-presentail-timestamp header and the HMAC signature. This keeps
  // retries inside a receiver's replay window instead of reusing the (now stale)
  // creation-time timestamp baked into the persisted payload.
  const stampedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), timestamp }
      : payload;
  const payloadBody = JSON.stringify(stampedPayload);
  const signature = signPayload(signingSecret, deliveryUuid, timestamp, payloadBody);

  try {
    const res = await publicWebhookFetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-presentail-event": event,
        "x-presentail-delivery-id": deliveryUuid,
        "x-presentail-timestamp": timestamp,
        "x-presentail-signature": signature,
      },
      body: payloadBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    let responseBody = "";
    try {
      responseBody = await res.text();
    } catch {
      responseBody = "";
    }

    return {
      success: res.ok,
      responseStatus: res.status,
      responseBody: responseBody.slice(0, RESPONSE_BODY_MAX),
    };
  } catch (err) {
    logger.warn({ err, deliveryId, endpointUrl }, "catalogWebhook: fetch error");
    return { success: false, responseStatus: null, responseBody: String(err).slice(0, RESPONSE_BODY_MAX) };
  }
}

async function performDelivery(
  deliveryId: number,
  endpointId: number,
  endpointUrl: string,
  signingSecret: string,
  event: string,
  payload: unknown,
  attemptCount: number,
): Promise<void> {
  const { success, responseStatus, responseBody } = await attemptDelivery(deliveryId, endpointUrl, signingSecret, event, payload);
  const newAttemptCount = attemptCount + 1;

  if (success) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'delivered', response_status = $1, response_body = $2, attempt_count = $3, next_retry_at = NULL WHERE id = $4`,
      [responseStatus, responseBody, newAttemptCount, deliveryId],
    );
    await db.query(
      `UPDATE webhook_endpoints SET last_delivery_status = 'delivered', last_delivery_at = now() WHERE id = $1`,
      [endpointId],
    );
    return;
  }

  if (newAttemptCount >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', response_status = $1, response_body = $2, attempt_count = $3, next_retry_at = NULL WHERE id = $4`,
      [responseStatus, responseBody, newAttemptCount, deliveryId],
    );
    await db.query(
      `UPDATE webhook_endpoints SET last_delivery_status = 'failed', last_delivery_at = now() WHERE id = $1`,
      [endpointId],
    );
    logger.warn({ deliveryId, endpointId, endpointUrl, attempts: newAttemptCount }, "catalogWebhook: max retries exhausted");
    return;
  }

  const delayMs = BACKOFF_DELAYS_MS[newAttemptCount - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await db.query(
    `UPDATE webhook_deliveries SET status = 'pending_retry', response_status = $1, response_body = $2, attempt_count = $3, next_retry_at = $4 WHERE id = $5`,
    [responseStatus, responseBody, newAttemptCount, nextRetryAt, deliveryId],
  );
  await db.query(
    `UPDATE webhook_endpoints SET last_delivery_status = 'pending_retry', last_delivery_at = now() WHERE id = $1`,
    [endpointId],
  );

  setTimeout(() => {
    performDelivery(deliveryId, endpointId, endpointUrl, signingSecret, event, payload, newAttemptCount).catch((err) => {
      logger.error({ err, deliveryId }, "catalogWebhook: unexpected error during retry");
    });
  }, delayMs);
}

/**
 * Internal generic dispatcher. Queries all active endpoints for this workspace
 * subscribed to `event`, inserts delivery rows, and fires them.
 */
async function dispatchToWorkspace(
  event: CatalogWebhookEvent,
  workspaceOwnerId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const endpointsResult = await db.query<WebhookEndpointRow>(
    `SELECT id, endpoint_url, signing_secret, subscribed_events
       FROM webhook_endpoints
      WHERE workspace_owner_id = $1
        AND is_active = true
        AND subscribed_events @> $2::jsonb`,
    [workspaceOwnerId, JSON.stringify([event])],
  );

  if (endpointsResult.rowCount === 0) return;

  const payload = {
    event,
    workspace: workspaceOwnerId,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const endpoint of endpointsResult.rows) {
    const insertResult = await db.query<{ id: number }>(
      `INSERT INTO webhook_deliveries (webhook_endpoint_id, event, payload, status, attempt_count)
       VALUES ($1, $2, $3, 'pending', 0)
       RETURNING id`,
      [endpoint.id, event, JSON.stringify(payload)],
    );
    const deliveryId = insertResult.rows[0]?.id;
    if (!deliveryId) continue;

    performDelivery(
      deliveryId,
      endpoint.id,
      endpoint.endpoint_url,
      endpoint.signing_secret,
      event,
      payload,
      0,
    ).catch((err) => {
      logger.error({ err, deliveryId, endpointId: endpoint.id }, `catalogWebhook: unexpected error during ${event} delivery`);
    });
  }
}

/**
 * Generic fire-and-forget webhook dispatcher for any CatalogWebhookEvent.
 * Safe to call without await — errors are caught and logged internally.
 */
export async function fireWebhookEvent(
  event: CatalogWebhookEvent,
  workspaceOwnerId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await dispatchToWorkspace(event, workspaceOwnerId, data);
}

export async function fireCatalogAttributeWebhook(
  event: CatalogWebhookEvent,
  attributeType: CatalogAttributeType,
  attribute: Record<string, unknown>,
  workspaceOwnerId: string,
  affectedCityIds?: number[],
): Promise<void> {
  const endpointsResult = await db.query<WebhookEndpointRow>(
    `SELECT id, endpoint_url, signing_secret, subscribed_events
       FROM webhook_endpoints
      WHERE workspace_owner_id = $1
        AND is_active = true
        AND (subscribed_events @> $2::jsonb OR subscribed_events @> $3::jsonb)`,
    [workspaceOwnerId, JSON.stringify([event]), JSON.stringify(["catalog_attributes.changed"])],
  );

  if (endpointsResult.rowCount === 0) return;

  const payload = {
    event,
    workspace: workspaceOwnerId,
    timestamp: new Date().toISOString(),
    data: {
      attribute_type: attributeType,
      attribute,
      ...(affectedCityIds !== undefined ? { affected_city_ids: affectedCityIds } : {}),
    },
  };

  for (const endpoint of endpointsResult.rows) {
    const insertResult = await db.query<{ id: number }>(
      `INSERT INTO webhook_deliveries (webhook_endpoint_id, event, payload, status, attempt_count)
       VALUES ($1, $2, $3, 'pending', 0)
       RETURNING id`,
      [endpoint.id, event, JSON.stringify(payload)],
    );
    const deliveryId = insertResult.rows[0]?.id;
    if (!deliveryId) continue;

    performDelivery(deliveryId, endpoint.id, endpoint.endpoint_url, endpoint.signing_secret, event, payload, 0).catch((err) => {
      logger.error({ err, deliveryId, endpointId: endpoint.id }, "catalogWebhook: unexpected error during initial delivery");
    });
  }

  if (event !== "catalog_attributes.changed") {
    fireCatalogAttributeWebhook("catalog_attributes.changed", attributeType, attribute, workspaceOwnerId, affectedCityIds).catch((err) => {
      logger.error({ err }, "catalogWebhook: error firing catalog_attributes.changed event");
    });
  }
}

export type CurrencyRatesWebhookPayload = {
  base_currency: string;
  last_updated_at: string;
  updated_fields: string[];
};

/**
 * Fire `currency_rates.updated` to all active workspace endpoints subscribed to
 * that event. Safe to call fire-and-forget; errors are caught and logged.
 */
export async function fireCurrencyRatesWebhook(
  workspaceOwnerId: string,
  data: CurrencyRatesWebhookPayload,
): Promise<void> {
  await dispatchToWorkspace("currency_rates.updated", workspaceOwnerId, data as unknown as Record<string, unknown>);
}

/**
 * Fire `currency_rates.updated` to all workspaces that have active endpoints
 * subscribed to the event. Used by the auto-refresh background job which updates
 * global rates shared across all workspaces.
 */
export async function fireCurrencyRatesWebhookAllWorkspaces(
  data: CurrencyRatesWebhookPayload,
): Promise<void> {
  const event: CatalogWebhookEvent = "currency_rates.updated";

  const ownersResult = await db.query<{ workspace_owner_id: string }>(
    `SELECT DISTINCT workspace_owner_id
       FROM webhook_endpoints
      WHERE is_active = true
        AND subscribed_events @> $1::jsonb`,
    [JSON.stringify([event])],
  );

  for (const row of ownersResult.rows) {
    fireCurrencyRatesWebhook(row.workspace_owner_id, data).catch((err) => {
      logger.error(
        { err, workspaceOwnerId: row.workspace_owner_id },
        "catalogWebhook: error firing currency_rates.updated for workspace",
      );
    });
  }
}

/**
 * Fire one of the public-catalog change events or product-level events
 * to all active endpoints subscribed to the given event. Intended to be called
 * fire-and-forget after any write operation on the corresponding resource.
 *
 * Safe to call without await — errors are caught and logged internally.
 */
export async function fireCatalogDataWebhook(
  event: "catalog.products.changed" | "catalog.brands.changed" | "catalog.banners.changed" | "product.created" | "product.updated" | "product.deleted",
  workspaceOwnerId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await dispatchToWorkspace(event, workspaceOwnerId, data);
}

/**
 * Fire a delivery configuration event (`delivery.city.updated`,
 * `delivery.timeslots.updated`, or `exchange_rate.updated`) to all active
 * workspace endpoints subscribed to that event.
 * Safe to call fire-and-forget; errors are caught and logged.
 */
export async function fireDeliveryConfigWebhook(
  event: "delivery.city.updated" | "delivery.timeslots.updated" | "exchange_rate.updated" | "fx.rates.updated",
  workspaceOwnerId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await dispatchToWorkspace(event, workspaceOwnerId, data);
}

/**
 * Fire `exchange_rate.updated` to all workspaces that have active endpoints
 * subscribed to the event. Used by the auto-refresh background job which updates
 * global rates shared across all workspaces.
 */
export async function fireDeliveryConfigWebhookAllWorkspaces(
  event: "exchange_rate.updated" | "fx.rates.updated",
  data: Record<string, unknown>,
): Promise<void> {
  const ownersResult = await db.query<{ workspace_owner_id: string }>(
    `SELECT DISTINCT workspace_owner_id
       FROM webhook_endpoints
      WHERE is_active = true
        AND subscribed_events @> $1::jsonb`,
    [JSON.stringify([event])],
  );

  for (const row of ownersResult.rows) {
    fireDeliveryConfigWebhook(event, row.workspace_owner_id, data).catch((err) => {
      logger.error(
        { err, workspaceOwnerId: row.workspace_owner_id },
        `catalogWebhook: error firing ${event} for workspace`,
      );
    });
  }
}

export async function retryDelivery(deliveryId: number, workspaceOwnerId: string): Promise<boolean> {
  const claimed = await db.query<{
    id: number;
    webhook_endpoint_id: number;
    event: string;
    payload: unknown;
    attempt_count: number;
    endpoint_url: string;
    signing_secret: string;
    is_active: boolean;
    owner_id: string;
  }>(
    `UPDATE webhook_deliveries AS d
        SET status = 'pending',
            next_retry_at = NULL
       FROM webhook_endpoints AS e
      WHERE d.id = $1
        AND e.id = d.webhook_endpoint_id
        AND e.workspace_owner_id = $2
        AND d.status IN ('delivered', 'failed', 'pending_retry')
      RETURNING d.id, d.webhook_endpoint_id, d.event, d.payload, d.attempt_count,
                e.endpoint_url, e.signing_secret, e.is_active,
                e.workspace_owner_id AS owner_id`,
    [deliveryId, workspaceOwnerId],
  );

  if (!claimed.rows[0]) return false;
  const d = claimed.rows[0];

  performDelivery(deliveryId, d.webhook_endpoint_id, d.endpoint_url, d.signing_secret, d.event, d.payload, d.attempt_count).catch((err) => {
    logger.error({ err, deliveryId }, "catalogWebhook: error during manual retry");
  });

  return true;
}
