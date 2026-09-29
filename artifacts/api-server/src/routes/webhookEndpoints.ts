import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { retryDelivery } from "../lib/catalogWebhook";
import { assertPublicStoreUrl } from "../lib/urlValidator";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function isOwner(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner";
}

function generateSigningSecret(): string {
  return "whsec_" + crypto.randomBytes(32).toString("hex");
}

const VALID_EVENTS = [
  "catalog_attribute.occasion.created",
  "catalog_attribute.occasion.updated",
  "catalog_attribute.occasion.deleted",
  "catalog_attribute.occasion.city_availability_updated",
  "catalog_attribute.catalog_category.created",
  "catalog_attribute.catalog_category.updated",
  "catalog_attribute.catalog_category.deleted",
  "catalog_attribute.catalog_category.city_availability_updated",
  "catalog_attribute.catalog_brand.created",
  "catalog_attribute.catalog_brand.updated",
  "catalog_attribute.catalog_brand.deleted",
  "catalog_attribute.catalog_brand.city_availability_updated",
  "catalog_attribute.recipient.created",
  "catalog_attribute.recipient.updated",
  "catalog_attribute.recipient.deleted",
  "catalog_attribute.recipient.city_availability_updated",
  "catalog_attributes.changed",
  // Delivery configuration events
  "delivery_config.updated",
  "delivery.city.updated",
  "delivery.timeslots.updated",
  // Exchange rate / currency events
  "exchange_rate.updated",
  "fx.rates.updated",
  "currency_rates.updated",
  // Product catalog events
  "product.created",
  "product.updated",
  "product.deleted",
  "catalog.products.changed",
  "catalog.brands.changed",
  // Banner events
  "banner.updated",
  "catalog.banners.changed",
  // Order events
  "order.created",
  "order.updated",
  "order.status_updated",
  // Customer events
  "customer.created",
  "customer.updated",
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  endpoint_url: z.string().url().max(2000),
  subscribed_events: z.array(z.string()).default([]),
  is_active: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  endpoint_url: z.string().url().max(2000).optional(),
  subscribed_events: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

const ENDPOINT_COLS = "id, workspace_owner_id, name, endpoint_url, subscribed_events, is_active, last_delivery_status, last_delivery_at, created_at, updated_at";

router.get("/webhook-endpoints", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const result = await db.query(
    `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE workspace_owner_id = $1 ORDER BY created_at DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ endpoints: result.rows });
});

router.post("/webhook-endpoints", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { name, endpoint_url, subscribed_events, is_active } = parsed.data;

  try {
    await assertPublicStoreUrl(endpoint_url);
  } catch (err) {
    res.status(400).json({ error: "endpoint_url must be a public HTTPS address" });
    return;
  }

  const validatedEvents = subscribed_events.filter((e) => VALID_EVENTS.includes(e as typeof VALID_EVENTS[number]));
  const signingSecret = generateSigningSecret();

  const result = await db.query(
    `INSERT INTO webhook_endpoints (workspace_owner_id, name, endpoint_url, subscribed_events, signing_secret, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ENDPOINT_COLS}`,
    [wreq.workspaceOwnerId, name, endpoint_url, JSON.stringify(validatedEvents), signingSecret, is_active],
  );

  res.status(201).json({ endpoint: result.rows[0], signing_secret: signingSecret });
});

router.get("/webhook-endpoints/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await db.query(
    `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!result.rowCount) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ endpoint: result.rows[0] });
});

router.patch("/webhook-endpoints/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (!check.rowCount) { res.status(404).json({ error: "Not found" }); return; }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }

  const data = parsed.data;

  if (data.endpoint_url !== undefined) {
    try {
      await assertPublicStoreUrl(data.endpoint_url);
    } catch (err) {
      res.status(400).json({ error: "endpoint_url must be a public HTTPS address" });
      return;
    }
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];

  if (data.name !== undefined) { params.push(data.name); sets.push(`name = $${params.length}`); }
  if (data.endpoint_url !== undefined) { params.push(data.endpoint_url); sets.push(`endpoint_url = $${params.length}`); }
  if (data.subscribed_events !== undefined) {
    const validatedEvents = data.subscribed_events.filter((e) => VALID_EVENTS.includes(e as typeof VALID_EVENTS[number]));
    params.push(JSON.stringify(validatedEvents)); sets.push(`subscribed_events = $${params.length}`);
  }
  if (data.is_active !== undefined) { params.push(data.is_active); sets.push(`is_active = $${params.length}`); }

  if (sets.length === 1) { res.json({ endpoint: check.rows[0] }); return; }

  params.push(id, wreq.workspaceOwnerId);
  const result = await db.query(
    `UPDATE webhook_endpoints SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length} RETURNING ${ENDPOINT_COLS}`,
    params,
  );
  res.json({ endpoint: result.rows[0] });
});

router.delete("/webhook-endpoints/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (!check.rowCount) { res.status(404).json({ error: "Not found" }); return; }

  await db.query(`DELETE FROM webhook_endpoints WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  res.json({ success: true });
});

router.get("/webhook-endpoints/:id/deliveries", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (!check.rowCount) { res.status(404).json({ error: "Not found" }); return; }

  const rawLimit = parseInt(typeof req.query.limit === "string" ? req.query.limit : "50", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 200 ? rawLimit : 50;

  const result = await db.query(
    `SELECT id, webhook_endpoint_id, event, status, response_status, response_body, attempt_count, next_retry_at, created_at
       FROM webhook_deliveries
      WHERE webhook_endpoint_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [id, limit],
  );
  res.json({ deliveries: result.rows });
});

router.post("/webhook-endpoints/:id/deliveries/:deliveryId/retry", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) { res.status(403).json({ error: "Owner access required" }); return; }

  const endpointId = parseInt(req.params.id, 10);
  const deliveryId = parseInt(req.params.deliveryId, 10);
  if (isNaN(endpointId) || isNaN(deliveryId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND workspace_owner_id = $2`, [endpointId, wreq.workspaceOwnerId]);
  if (!check.rowCount) { res.status(404).json({ error: "Webhook endpoint not found" }); return; }

  const ok = await retryDelivery(deliveryId, wreq.workspaceOwnerId);
  if (!ok) { res.status(404).json({ error: "Delivery not found" }); return; }

  res.json({ success: true });
});

export default router;
