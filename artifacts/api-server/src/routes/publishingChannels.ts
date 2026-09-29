/**
 * Admin routes for publishing channels, catalog API keys, channel webhook endpoints,
 * and product publication management.
 *
 * All routes require Clerk auth + workspace resolution.
 * Most mutating routes require owner or "publishing.manage" permission.
 */

import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { assertPublicStoreUrl } from "../lib/urlValidator";
import { logger } from "../lib/logger";
import {
  publishProduct,
  unpublishProduct,
  hideProduct,
  unhideProduct,
  updatePublicationFields,
} from "../lib/productPublishing";
import { retryDelivery } from "../lib/productWebhook";

const router = Router();
router.use(requireAuth, resolveWorkspace);

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function hasPublishingPermission(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.includes("publishing.manage") ?? false)
  );
}

function ownerOrPublishing(wreq: ReturnType<typeof workspace>, res: Parameters<typeof router.get>[1] extends (req: unknown, res: infer R, ...args: unknown[]) => unknown ? R : never): boolean {
  if (!hasPublishingPermission(wreq)) {
    (res as { status: (n: number) => { json: (d: unknown) => void } }).status(403).json({ error: "Owner access or Manage Publishing permission required" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CHANNEL_TYPES = ["website", "mobile_app", "pos", "marketplace", "api_consumer", "other"] as const;

const createChannelSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes"),
  type: z.enum(CHANNEL_TYPES).default("website"),
  brand_id: z.number().int().nullable().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  default_currency: z.string().max(10).default("USD"),
  auto_publish_new_products: z.boolean().default(false),
  allowed_origins: z.string().max(2000).nullable().optional(),
});

const updateChannelSchema = createChannelSchema.partial().omit({ slug: true });

const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  channel_id: z.number().int().nullable().optional(),
});

const createWebhookSchema = z.object({
  name: z.string().min(1).max(200),
  endpoint_url: z.string().url().max(2000),
  subscribed_events: z.array(z.string()).default([]),
  is_active: z.boolean().default(true),
});

const updateWebhookSchema = createWebhookSchema.partial();

const PUBLICATION_STATUSES = ["draft", "published", "hidden", "unpublished", "archived"] as const;

const publicationActionSchema = z.object({
  action: z.enum(["publish", "unpublish", "hide", "unhide"]).optional(),
  publication_status: z.enum(PUBLICATION_STATUSES).optional(),
  is_visible: z.boolean().optional(),
  public_slug: z.string().max(200).nullable().optional(),
  public_title: z.string().max(500).nullable().optional(),
  short_description: z.string().max(2000).nullable().optional(),
  long_description: z.string().max(10000).nullable().optional(),
  seo_title: z.string().max(500).nullable().optional(),
  seo_description: z.string().max(1000).nullable().optional(),
  og_image_url: z.string().max(2000).nullable().optional(),
  featured: z.boolean().optional(),
  sort_order: z.number().int().nullable().optional(),
  badges: z.unknown().optional(),
  extra_fields: z.unknown().optional(),
  price_override: z.string().nullable().optional(),
  sale_price_override: z.string().nullable().optional(),
  currency_override: z.string().max(10).nullable().optional(),
});

const createPublicationSchema = z.object({
  channel_id: z.number().int(),
  publication_status: z.enum(PUBLICATION_STATUSES).default("published"),
  is_visible: z.boolean().default(true),
  public_slug: z.string().max(200).nullable().optional(),
  public_title: z.string().max(500).nullable().optional(),
  short_description: z.string().max(2000).nullable().optional(),
  long_description: z.string().max(10000).nullable().optional(),
  seo_title: z.string().max(500).nullable().optional(),
  seo_description: z.string().max(1000).nullable().optional(),
  og_image_url: z.string().max(2000).nullable().optional(),
  featured: z.boolean().optional(),
  sort_order: z.number().int().nullable().optional(),
  badges: z.unknown().optional(),
  extra_fields: z.unknown().optional(),
  price_override: z.string().nullable().optional(),
  sale_price_override: z.string().nullable().optional(),
  currency_override: z.string().max(10).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Publishing Channels CRUD
// ---------------------------------------------------------------------------

const CHANNEL_COLS = "id, workspace_owner_id, name, slug, type, brand_id, status, default_currency, auto_publish_new_products, allowed_origins, created_at, updated_at";

router.get("/publishing-channels", async (req, res) => {
  const wreq = workspace(req);
  try {
    const result = await db.query(
      `SELECT ${CHANNEL_COLS},
              (SELECT COUNT(*) FROM product_publications pp WHERE pp.channel_id = pc.id AND pp.publication_status = 'published')::int AS published_product_count,
              (SELECT COUNT(*) FROM channel_webhook_endpoints cwe WHERE cwe.channel_id = pc.id AND cwe.is_active = true)::int AS active_webhook_count,
              (SELECT COUNT(*) FROM catalog_api_keys cak WHERE cak.channel_id = pc.id AND cak.status = 'active')::int AS active_api_key_count
         FROM publishing_channels pc
        WHERE workspace_owner_id = $1
        ORDER BY created_at ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, channels: result.rows });
  } catch (err) {
    logger.error({ err }, "GET /publishing-channels error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/publishing-channels", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;

  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  const slugConflict = await db.query(
    `SELECT id FROM publishing_channels WHERE workspace_owner_id = $1 AND slug = $2`,
    [wreq.workspaceOwnerId, d.slug],
  );
  if (slugConflict.rowCount && slugConflict.rowCount > 0) {
    res.status(409).json({ error: "A channel with this slug already exists" });
    return;
  }

  const result = await db.query<{ id: number }>(
    `INSERT INTO publishing_channels (workspace_owner_id, name, slug, type, brand_id, status, default_currency, auto_publish_new_products, allowed_origins)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [wreq.workspaceOwnerId, d.name, d.slug, d.type, d.brand_id ?? null, d.status, d.default_currency, d.auto_publish_new_products, d.allowed_origins ?? null],
  );
  const id = result.rows[0]?.id;
  if (!id) { res.status(500).json({ error: "Insert failed" }); return; }

  const channel = await db.query(`SELECT ${CHANNEL_COLS} FROM publishing_channels WHERE id = $1`, [id]);
  res.status(201).json({ success: true, channel: channel.rows[0] });
});

router.get("/publishing-channels/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await db.query(
    `SELECT ${CHANNEL_COLS} FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ success: true, channel: result.rows[0] });
});

router.patch("/publishing-channels/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const parsed = updateChannelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id, wreq.workspaceOwnerId];
  const fieldMap: Record<string, string> = {
    name: "name", type: "type", brand_id: "brand_id", status: "status",
    default_currency: "default_currency", auto_publish_new_products: "auto_publish_new_products",
    allowed_origins: "allowed_origins",
  };
  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (d as Record<string, unknown>)[key];
    if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
  }

  await db.query(
    `UPDATE publishing_channels SET ${sets.join(", ")} WHERE id = $1 AND workspace_owner_id = $2`,
    params,
  );
  const updated = await db.query(`SELECT ${CHANNEL_COLS} FROM publishing_channels WHERE id = $1`, [id]);
  res.json({ success: true, channel: updated.rows[0] });
});

router.delete("/publishing-channels/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  await db.query(`UPDATE publishing_channels SET status = 'inactive', updated_at = now() WHERE id = $1`, [id]);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Catalog API Keys
// ---------------------------------------------------------------------------

router.get("/publishing-channels/:id/api-keys", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const result = await db.query(
    `SELECT id, name, key_prefix, channel_id, status, created_at, last_used_at, revoked_at
       FROM catalog_api_keys
      WHERE channel_id = $1 AND workspace_owner_id = $2
      ORDER BY created_at DESC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ success: true, api_keys: result.rows });
});

router.post("/publishing-channels/:id/api-keys", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const channelId = parseInt(req.params.id, 10);
  if (isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [channelId, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Channel not found" }); return; }

  const parsed = createApiKeySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const { name } = parsed.data;

  const rawKey = "cat_live_" + crypto.randomBytes(32).toString("hex");
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 16);

  const result = await db.query<{ id: number }>(
    `INSERT INTO catalog_api_keys (workspace_owner_id, name, key_hash, key_prefix, channel_id, status)
     VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
    [wreq.workspaceOwnerId, name, keyHash, keyPrefix, channelId],
  );
  const keyId = result.rows[0]?.id;
  if (!keyId) { res.status(500).json({ error: "Insert failed" }); return; }

  res.status(201).json({
    success: true,
    api_key: { id: keyId, name, key_prefix: keyPrefix, channel_id: channelId },
    plaintext_key: rawKey,
    warning: "This key is shown only once. Store it securely — it cannot be retrieved again.",
  });
});

router.delete("/publishing-channels/:id/api-keys/:kid", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const channelId = parseInt(req.params.id, 10);
  const kid = parseInt(req.params.kid, 10);
  if (isNaN(channelId) || isNaN(kid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM catalog_api_keys WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [kid, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  await db.query(`UPDATE catalog_api_keys SET status = 'revoked', revoked_at = now() WHERE id = $1`, [kid]);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Channel Webhook Endpoints
// ---------------------------------------------------------------------------

const PRODUCT_WEBHOOK_EVENTS = [
  "product.created",
  "product.updated",
  "product.price_updated",
  "product.hidden",
  "product.unhidden",
  "product.published",
  "product.unpublished",
  "product.availability_updated",
  "product.images_updated",
] as const;

function generateWebhookSecret(): string {
  return "whsec_" + crypto.randomBytes(32).toString("hex");
}

const WEBHOOK_COLS = "id, channel_id, workspace_owner_id, name, endpoint_url, subscribed_events, is_active, last_delivery_status, last_delivery_at, created_at, updated_at";

router.get("/publishing-channels/:id/webhook-endpoints", async (req, res) => {
  const wreq = workspace(req);
  const channelId = parseInt(req.params.id, 10);
  if (isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [channelId, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Channel not found" }); return; }

  const result = await db.query(
    `SELECT ${WEBHOOK_COLS} FROM channel_webhook_endpoints WHERE channel_id = $1 AND workspace_owner_id = $2 ORDER BY created_at DESC`,
    [channelId, wreq.workspaceOwnerId],
  );
  res.json({ success: true, endpoints: result.rows });
});

router.post("/publishing-channels/:id/webhook-endpoints", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const channelId = parseInt(req.params.id, 10);
  if (isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [channelId, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Channel not found" }); return; }

  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  try { assertPublicStoreUrl(d.endpoint_url); } catch (err) {
    res.status(400).json({ error: (err as Error).message }); return;
  }

  const invalidEvents = d.subscribed_events.filter(
    (e) => !(PRODUCT_WEBHOOK_EVENTS as readonly string[]).includes(e),
  );
  if (invalidEvents.length > 0) {
    res.status(400).json({ error: `Invalid events: ${invalidEvents.join(", ")}` }); return;
  }

  const signingSecret = generateWebhookSecret();
  const result = await db.query<{ id: number }>(
    `INSERT INTO channel_webhook_endpoints (channel_id, workspace_owner_id, name, endpoint_url, signing_secret, subscribed_events, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [channelId, wreq.workspaceOwnerId, d.name, d.endpoint_url, signingSecret, JSON.stringify(d.subscribed_events), d.is_active],
  );
  const wid = result.rows[0]?.id;
  if (!wid) { res.status(500).json({ error: "Insert failed" }); return; }

  const row = await db.query(`SELECT ${WEBHOOK_COLS} FROM channel_webhook_endpoints WHERE id = $1`, [wid]);
  res.status(201).json({
    success: true,
    endpoint: row.rows[0],
    signing_secret: signingSecret,
    warning: "The signing secret is shown only once. Store it securely.",
  });
});

router.patch("/publishing-channels/:id/webhook-endpoints/:wid", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const channelId = parseInt(req.params.id, 10);
  const wid = parseInt(req.params.wid, 10);
  if (isNaN(channelId) || isNaN(wid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM channel_webhook_endpoints WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [wid, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const parsed = updateWebhookSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  if (d.endpoint_url) {
    try { assertPublicStoreUrl(d.endpoint_url); } catch (err) {
      res.status(400).json({ error: (err as Error).message }); return;
    }
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [wid];
  const fieldMap: Record<string, string> = { name: "name", endpoint_url: "endpoint_url", is_active: "is_active" };
  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (d as Record<string, unknown>)[key];
    if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
  }
  if (d.subscribed_events !== undefined) {
    params.push(JSON.stringify(d.subscribed_events));
    sets.push(`subscribed_events = $${params.length}`);
  }

  await db.query(`UPDATE channel_webhook_endpoints SET ${sets.join(", ")} WHERE id = $1`, params);
  const row = await db.query(`SELECT ${WEBHOOK_COLS} FROM channel_webhook_endpoints WHERE id = $1`, [wid]);
  res.json({ success: true, endpoint: row.rows[0] });
});

router.delete("/publishing-channels/:id/webhook-endpoints/:wid", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const channelId = parseInt(req.params.id, 10);
  const wid = parseInt(req.params.wid, 10);
  if (isNaN(channelId) || isNaN(wid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM channel_webhook_endpoints WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [wid, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  await db.query(`DELETE FROM channel_webhook_endpoints WHERE id = $1`, [wid]);
  res.json({ success: true });
});

router.get("/publishing-channels/:id/webhook-endpoints/:wid/deliveries", async (req, res) => {
  const wreq = workspace(req);
  const channelId = parseInt(req.params.id, 10);
  const wid = parseInt(req.params.wid, 10);
  if (isNaN(channelId) || isNaN(wid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM channel_webhook_endpoints WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [wid, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const result = await db.query(
    `SELECT id, event, payload, status, response_status, response_body, attempt_count, next_retry_at, duration_ms, created_at
       FROM product_webhook_deliveries
      WHERE channel_webhook_endpoint_id = $1
      ORDER BY created_at DESC
      LIMIT 20`,
    [wid],
  );
  res.json({ success: true, deliveries: result.rows });
});

router.post("/publishing-channels/:id/webhook-endpoints/:wid/deliveries/:deliveryId/retry", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const channelId = parseInt(req.params.id, 10);
  const wid = parseInt(req.params.wid, 10);
  const { deliveryId } = req.params;
  if (isNaN(channelId) || isNaN(wid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM channel_webhook_endpoints WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [wid, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const deliveryResult = await db.query<{ id: string; event: string; payload: unknown; status: string }>(
    `SELECT id, event, payload, status FROM product_webhook_deliveries WHERE id = $1 AND channel_webhook_endpoint_id = $2`,
    [deliveryId, wid],
  );
  if (!deliveryResult.rows[0]) { res.status(404).json({ error: "Delivery not found" }); return; }

  const d = deliveryResult.rows[0];
  if (d.status !== "failed") {
    res.status(400).json({ error: "Only failed deliveries can be retried" }); return;
  }

  const epResult = await db.query<{ endpoint_url: string; signing_secret: string }>(
    `SELECT endpoint_url, signing_secret FROM channel_webhook_endpoints WHERE id = $1`,
    [wid],
  );
  const ep = epResult.rows[0];
  if (!ep) { res.status(404).json({ error: "Endpoint not found" }); return; }

  await db.query(
    `UPDATE product_webhook_deliveries SET status = 'pending', attempt_count = 0, next_retry_at = NULL WHERE id = $1`,
    [deliveryId],
  );

  retryDelivery(deliveryId, wid, ep.endpoint_url, ep.signing_secret, d.event, d.payload).catch((err: unknown) => {
    logger.error({ err, deliveryId }, "publishingChannels: unexpected error during manual retry");
  });

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Product Publications — sub-routes under /api/products/:id/publications
// ---------------------------------------------------------------------------

router.get("/products/:id/publications", async (req, res) => {
  const wreq = workspace(req);
  const productId = parseInt(req.params.id, 10);
  if (isNaN(productId)) { res.status(400).json({ error: "Invalid product id" }); return; }

  const check = await db.query(`SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`, [productId, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Product not found" }); return; }

  const result = await db.query(
    `SELECT pp.*, pc.name AS channel_name, pc.slug AS channel_slug, pc.type AS channel_type, pc.status AS channel_status
       FROM product_publications pp
       JOIN publishing_channels pc ON pc.id = pp.channel_id
      WHERE pp.product_id = $1 AND pp.workspace_owner_id = $2
      ORDER BY pp.created_at ASC`,
    [productId, wreq.workspaceOwnerId],
  );

  const logs = await db.query(
    `SELECT * FROM product_sync_logs WHERE product_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [productId],
  );

  res.json({ success: true, publications: result.rows, sync_logs: logs.rows });
});

router.post("/products/:id/publications", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const productId = parseInt(req.params.id, 10);
  if (isNaN(productId)) { res.status(400).json({ error: "Invalid product id" }); return; }

  const productCheck = await db.query(`SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`, [productId, wreq.workspaceOwnerId]);
  if (!productCheck.rows[0]) { res.status(404).json({ error: "Product not found" }); return; }

  const parsed = createPublicationSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  const channelCheck = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [d.channel_id, wreq.workspaceOwnerId]);
  if (!channelCheck.rows[0]) { res.status(404).json({ error: "Channel not found" }); return; }

  if (d.publication_status === "published") {
    await publishProduct(productId, d.channel_id, d as Parameters<typeof publishProduct>[2], wreq.userId);
  } else {
    await db.query(
      `INSERT INTO product_publications (product_id, channel_id, workspace_owner_id, publication_status, is_visible)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (product_id, channel_id) DO UPDATE SET
         publication_status = EXCLUDED.publication_status,
         is_visible = EXCLUDED.is_visible,
         updated_at = now()`,
      [productId, d.channel_id, wreq.workspaceOwnerId, d.publication_status, d.is_visible],
    );
  }

  const pub = await db.query(
    `SELECT pp.*, pc.name AS channel_name, pc.slug AS channel_slug
       FROM product_publications pp
       JOIN publishing_channels pc ON pc.id = pp.channel_id
      WHERE pp.product_id = $1 AND pp.channel_id = $2`,
    [productId, d.channel_id],
  );
  res.status(201).json({ success: true, publication: pub.rows[0] });
});

router.patch("/products/:id/publications/:channelId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const productId = parseInt(req.params.id, 10);
  const channelId = parseInt(req.params.channelId, 10);
  if (isNaN(productId) || isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM product_publications WHERE product_id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [productId, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Publication not found" }); return; }

  const parsed = publicationActionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  const userId = wreq.userId;
  if (d.action === "publish") await publishProduct(productId, channelId, d, userId);
  else if (d.action === "unpublish") await unpublishProduct(productId, channelId, userId);
  else if (d.action === "hide") await hideProduct(productId, channelId, userId);
  else if (d.action === "unhide") await unhideProduct(productId, channelId, userId);
  else await updatePublicationFields(productId, channelId, d, userId);

  const pub = await db.query(
    `SELECT pp.*, pc.name AS channel_name, pc.slug AS channel_slug
       FROM product_publications pp
       JOIN publishing_channels pc ON pc.id = pp.channel_id
      WHERE pp.product_id = $1 AND pp.channel_id = $2`,
    [productId, channelId],
  );
  res.json({ success: true, publication: pub.rows[0] });
});

router.delete("/products/:id/publications/:channelId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const productId = parseInt(req.params.id, 10);
  const channelId = parseInt(req.params.channelId, 10);
  if (isNaN(productId) || isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM product_publications WHERE product_id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [productId, channelId, wreq.workspaceOwnerId],
  );
  if (!check.rows[0]) { res.status(404).json({ error: "Publication not found" }); return; }

  await unpublishProduct(productId, channelId, wreq.userId);
  res.json({ success: true });
});

router.post("/products/:id/publications/:channelId/retry-sync", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOrPublishing(wreq, res as never)) return;
  const productId = parseInt(req.params.id, 10);
  const channelId = parseInt(req.params.channelId, 10);
  if (isNaN(productId) || isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.query(
    `UPDATE product_publications SET sync_status = 'synced', sync_error = NULL, last_synced_at = now(), updated_at = now()
     WHERE product_id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [productId, channelId, wreq.workspaceOwnerId],
  );
  await db.query(
    `INSERT INTO product_sync_logs (product_id, channel_id, event_type, status, message)
     VALUES ($1, $2, 'retry_sync', 'ok', 'Manual retry sync')`,
    [productId, channelId],
  );
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Publishing Channels — products list
// ---------------------------------------------------------------------------

router.get("/publishing-channels/:id/products", async (req, res) => {
  const wreq = workspace(req);
  const channelId = parseInt(req.params.id, 10);
  if (isNaN(channelId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(`SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`, [channelId, wreq.workspaceOwnerId]);
  if (!check.rows[0]) { res.status(404).json({ error: "Channel not found" }); return; }

  const statusFilter = typeof req.query.status === "string" ? req.query.status : null;
  const params: unknown[] = [channelId, wreq.workspaceOwnerId];
  const conditions = ["pp.channel_id = $1", "pp.workspace_owner_id = $2"];

  if (statusFilter) {
    params.push(statusFilter);
    conditions.push(`pp.publication_status = $${params.length}`);
  }

  const result = await db.query(
    `SELECT pp.*, p.name, p.brand, p.status AS product_status, p.main_image_url, p.price_usd, p.price_aed
       FROM product_publications pp
       JOIN products p ON p.id = pp.product_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY COALESCE(pp.sort_order, 9999) ASC, p.name ASC
      LIMIT 200`,
    params,
  );
  res.json({ success: true, products: result.rows });
});

// ---------------------------------------------------------------------------
// All catalog API keys for a workspace
// ---------------------------------------------------------------------------

router.get("/catalog-api-keys", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") { res.status(403).json({ error: "Owner access required" }); return; }

  const result = await db.query(
    `SELECT cak.id, cak.name, cak.key_prefix, cak.channel_id, cak.status, cak.created_at, cak.last_used_at, cak.revoked_at,
            pc.name AS channel_name, pc.slug AS channel_slug
       FROM catalog_api_keys cak
       LEFT JOIN publishing_channels pc ON pc.id = cak.channel_id
      WHERE cak.workspace_owner_id = $1
      ORDER BY cak.created_at DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ success: true, api_keys: result.rows });
});

export default router;
