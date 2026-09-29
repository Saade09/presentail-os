/**
 * Events management dashboard API
 *
 * Authenticated (Clerk session + resolveWorkspace) CRUD for workspace events.
 *
 * Routes:
 *   GET    /api/events                      – paginated list
 *   POST   /api/events                      – create
 *   GET    /api/events/:id                  – get single
 *   PUT    /api/events/:id                  – update
 *   DELETE /api/events/:id                  – soft-archive
 *   POST   /api/events/:id/images           – upload additional image
 *   GET    /api/events/:id/publications     – list publications per channel
 *   POST   /api/events/:id/publications     – upsert publication for a channel
 *   DELETE /api/events/:id/publications/:channelId – delete publication
 */

import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { objectStorageClient, objectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

router.use(requireAuth, resolveWorkspace);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ownerOnly(
  wreq: ReturnType<typeof workspace>,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): boolean {
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Managing events requires owner access" });
    return false;
  }
  return true;
}

/** Upload an event image to private storage and return the private object path. */
async function uploadEventImage(
  buffer: Buffer,
  mime: string,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }
  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/events/${objectId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: mime, resumable: false });
  return `/objects/${workspaceOwnerId}/events/${objectId}`;
}

/** Mirror an event's images into the public bucket and update DB columns. */
async function syncEventPublicImages(
  eventId: number,
  mainImageUrl: string | null,
  additionalImageUrls: string[],
  ownerId: string,
): Promise<void> {
  try {
    let mainPublicKey: string | null = null;
    if (mainImageUrl) {
      mainPublicKey = await objectStorageService.copyPrivateObjectToPublic(
        mainImageUrl,
        `events/${eventId}/main`,
        ownerId,
      );
    }
    const additionalPublicKeys: string[] = [];
    for (let i = 0; i < additionalImageUrls.length; i++) {
      const url = additionalImageUrls[i];
      if (!url) continue;
      const key = await objectStorageService.copyPrivateObjectToPublic(
        url,
        `events/${eventId}/additional-${i}`,
        ownerId,
      );
      additionalPublicKeys.push(key);
    }
    await db.query(
      `UPDATE events
          SET image_public_path = $1, additional_image_public_paths = $2, updated_at = now()
        WHERE id = $3 AND workspace_owner_id = $4`,
      [mainPublicKey, additionalPublicKeys, eventId, ownerId],
    );
  } catch (err) {
    logger.error({ err, eventId }, "Failed to sync event public images");
  }
}

/** Parse an array of occasion IDs from a request body field. */
function parseOccasionIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value
    .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return Array.from(new Set(ids));
}

type OccasionLink = { id: number; name: string; slug: string };

/** Replace the set of occasion links for an event. */
async function replaceEventOccasions(
  eventId: number,
  ownerId: string,
  ids: number[],
): Promise<OccasionLink[]> {
  let valid: OccasionLink[] = [];
  if (ids.length > 0) {
    const r = await db.query<OccasionLink>(
      `SELECT id, name, slug FROM occasions
        WHERE id = ANY($1) AND workspace_owner_id = $2
        ORDER BY name`,
      [ids, ownerId],
    );
    valid = r.rows;
  }
  await db.query(`DELETE FROM event_occasions WHERE event_id = $1`, [eventId]);
  for (const link of valid) {
    await db.query(
      `INSERT INTO event_occasions (event_id, attribute_id) VALUES ($1, $2)
       ON CONFLICT (event_id, attribute_id) DO NOTHING`,
      [eventId, link.id],
    );
  }
  return valid;
}

/** Fetch occasions linked to an event. */
async function fetchEventOccasions(eventId: number): Promise<OccasionLink[]> {
  const r = await db.query<OccasionLink>(
    `SELECT o.id, o.name, o.slug
       FROM event_occasions eo
       JOIN occasions o ON o.id = eo.attribute_id
      WHERE eo.event_id = $1
      ORDER BY o.name ASC`,
    [eventId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------

router.get("/events", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = parseInt(typeof req.query.pageSize === "string" ? req.query.pageSize : "25", 10);
  const pageSize = ([10, 25, 50, 100] as number[]).includes(rawPageSize) ? rawPageSize : 25;

  const includeArchived = req.query.include_archived === "true";
  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  const statusFilter = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  const occasionIdRaw = typeof req.query.occasion_id === "string" ? parseInt(req.query.occasion_id, 10) : NaN;
  const occasionId = Number.isFinite(occasionIdRaw) && occasionIdRaw > 0 ? occasionIdRaw : null;

  const conditions: string[] = ["e.workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  if (!includeArchived) {
    conditions.push("e.is_archived = false");
  }
  if (q) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`e.name ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (statusFilter) {
    params.push(statusFilter);
    conditions.push(`e.status = $${params.length}`);
  }
  if (occasionId !== null) {
    params.push(occasionId);
    conditions.push(`EXISTS (SELECT 1 FROM event_occasions eo WHERE eo.event_id = e.id AND eo.attribute_id = $${params.length})`);
  }

  const where = conditions.join(" AND ");

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM events e WHERE ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  params.push(pageSize);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  type EventRow = {
    id: number;
    name: string;
    description: string | null;
    starting_price_usd: string;
    starting_price_aed: string;
    status: string;
    main_image_url: string | null;
    additional_image_urls: string[];
    image_public_path: string | null;
    additional_image_public_paths: string[];
    is_archived: boolean;
    created_at: string;
    updated_at: string;
    occasions: unknown;
  };

  const result = await db.query<EventRow>(
    `SELECT e.id, e.name, e.description, e.starting_price_usd, e.starting_price_aed,
            e.status, e.main_image_url, e.additional_image_urls,
            e.image_public_path, e.additional_image_public_paths,
            e.is_archived, e.created_at, e.updated_at,
            COALESCE((
              SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug) ORDER BY o.name)
                FROM event_occasions eo
                JOIN occasions o ON o.id = eo.attribute_id
               WHERE eo.event_id = e.id
            ), '[]'::json) AS occasions
       FROM events e
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  res.json({
    events: result.rows.map((r) => ({
      ...r,
      occasions: Array.isArray(r.occasions)
        ? r.occasions
        : r.occasions
          ? (JSON.parse(r.occasions as unknown as string) as object[])
          : [],
    })),
    total,
    page: safePage,
    pageSize,
    totalPages,
  });
});

// ---------------------------------------------------------------------------
// POST /api/events
// ---------------------------------------------------------------------------

router.post("/events", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const { name, description, starting_price_usd, starting_price_aed, status, main_image_url, additional_image_urls, occasion_ids } = req.body as Record<string, unknown>;

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const priceUsd = parseFloat(String(starting_price_usd ?? "0"));
  const priceAed = parseFloat(String(starting_price_aed ?? "0"));
  if (isNaN(priceUsd) || priceUsd < 0) {
    res.status(400).json({ error: "starting_price_usd must be a non-negative number" });
    return;
  }
  if (isNaN(priceAed) || priceAed < 0) {
    res.status(400).json({ error: "starting_price_aed must be a non-negative number" });
    return;
  }

  const validStatuses = ["available", "unavailable", "archived"] as const;
  const eventStatus = typeof status === "string" && validStatuses.includes(status as (typeof validStatuses)[number]) ? status : "available";

  const mainUrl = typeof main_image_url === "string" && main_image_url.trim() ? main_image_url.trim() : null;
  const additionalUrls = Array.isArray(additional_image_urls)
    ? (additional_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];

  try {
    const insertResult = await db.query<{ id: number }>(
      `INSERT INTO events
         (workspace_owner_id, name, description, starting_price_usd, starting_price_aed,
          status, main_image_url, additional_image_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        ownerId,
        name.trim(),
        typeof description === "string" ? description.trim() || null : null,
        priceUsd,
        priceAed,
        eventStatus,
        mainUrl,
        additionalUrls,
      ],
    );

    const eventId = insertResult.rows[0].id;

    const ids = parseOccasionIds(occasion_ids);
    const occasions = ids ? await replaceEventOccasions(eventId, ownerId, ids) : [];

    // Kick off public image sync in background (non-blocking)
    void syncEventPublicImages(eventId, mainUrl, additionalUrls, ownerId);

    const event = (
      await db.query(
        `SELECT id, workspace_owner_id, name, description, starting_price_usd, starting_price_aed,
                status, main_image_url, additional_image_urls, image_public_path,
                additional_image_public_paths, is_archived, created_at, updated_at
           FROM events WHERE id = $1`,
        [eventId],
      )
    ).rows[0];

    res.status(201).json({ event: { ...event, occasions } });
  } catch (err) {
    logger.error({ err }, "POST /events error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/events/:id
// ---------------------------------------------------------------------------

router.get("/events/:id", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(req.params.id, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const result = await db.query(
    `SELECT id, workspace_owner_id, name, description, starting_price_usd, starting_price_aed,
            status, main_image_url, additional_image_urls, image_public_path,
            additional_image_public_paths, is_archived, created_at, updated_at
       FROM events
      WHERE id = $1 AND workspace_owner_id = $2`,
    [eventId, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const occasions = await fetchEventOccasions(eventId);
  res.json({ event: { ...result.rows[0], occasions } });
});

// ---------------------------------------------------------------------------
// PUT /api/events/:id
// ---------------------------------------------------------------------------

router.put("/events/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(req.params.id, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const existing = await db.query(
    `SELECT id FROM events WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`,
    [eventId, ownerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { name, description, starting_price_usd, starting_price_aed, status, main_image_url, additional_image_urls, occasion_ids } = req.body as Record<string, unknown>;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    params.push(name.trim());
    updates.push(`name = $${params.length}`);
  }
  if (description !== undefined) {
    params.push(typeof description === "string" ? description.trim() || null : null);
    updates.push(`description = $${params.length}`);
  }
  if (starting_price_usd !== undefined) {
    const v = parseFloat(String(starting_price_usd));
    if (isNaN(v) || v < 0) {
      res.status(400).json({ error: "starting_price_usd must be a non-negative number" });
      return;
    }
    params.push(v);
    updates.push(`starting_price_usd = $${params.length}`);
  }
  if (starting_price_aed !== undefined) {
    const v = parseFloat(String(starting_price_aed));
    if (isNaN(v) || v < 0) {
      res.status(400).json({ error: "starting_price_aed must be a non-negative number" });
      return;
    }
    params.push(v);
    updates.push(`starting_price_aed = $${params.length}`);
  }
  if (status !== undefined) {
    const validStatuses = ["available", "unavailable", "archived"] as const;
    if (!validStatuses.includes(status as (typeof validStatuses)[number])) {
      res.status(400).json({ error: "status must be available, unavailable, or archived" });
      return;
    }
    params.push(status);
    updates.push(`status = $${params.length}`);
  }
  if (main_image_url !== undefined) {
    params.push(typeof main_image_url === "string" && main_image_url.trim() ? main_image_url.trim() : null);
    updates.push(`main_image_url = $${params.length}`);
  }
  if (additional_image_urls !== undefined) {
    const urls = Array.isArray(additional_image_urls)
      ? (additional_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0)
      : [];
    params.push(urls);
    updates.push(`additional_image_urls = $${params.length}`);
  }

  if (updates.length > 0) {
    updates.push(`updated_at = now()`);
    params.push(eventId, ownerId);
    await db.query(
      `UPDATE events SET ${updates.join(", ")} WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}`,
      params,
    );
  }

  // Handle occasion re-sync
  const ids = parseOccasionIds(occasion_ids);
  const occasions = ids ? await replaceEventOccasions(eventId, ownerId, ids) : await fetchEventOccasions(eventId);

  const updatedEvent = (
    await db.query(
      `SELECT id, workspace_owner_id, name, description, starting_price_usd, starting_price_aed,
              status, main_image_url, additional_image_urls, image_public_path,
              additional_image_public_paths, is_archived, created_at, updated_at
         FROM events WHERE id = $1`,
      [eventId],
    )
  ).rows[0];

  // Re-sync public images if image fields changed
  if (main_image_url !== undefined || additional_image_urls !== undefined) {
    void syncEventPublicImages(
      eventId,
      updatedEvent.main_image_url as string | null,
      (updatedEvent.additional_image_urls as string[]) ?? [],
      ownerId,
    );
  }

  res.json({ event: { ...updatedEvent, occasions } });
});

// ---------------------------------------------------------------------------
// DELETE /api/events/:id  — soft-archive
// ---------------------------------------------------------------------------

router.delete("/events/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(req.params.id, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const result = await db.query(
    `UPDATE events SET is_archived = true, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false
      RETURNING id`,
    [eventId, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/images  — upload additional image
// ---------------------------------------------------------------------------

router.post("/events/:id/images", upload.single("image"), async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const existing = await db.query(
    `SELECT id, additional_image_urls FROM events WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`,
    [eventId, ownerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "An image file is required" });
    return;
  }

  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as (typeof ALLOWED_MIME)[number])) {
    res.status(400).json({ error: "Image must be a JPEG, PNG, or WebP file" });
    return;
  }

  try {
    const objectPath = await uploadEventImage(file.buffer, mime, ownerId);

    const currentUrls: string[] = (existing.rows[0].additional_image_urls as string[]) ?? [];
    const MAX_ADDITIONAL = 10;
    if (currentUrls.length >= MAX_ADDITIONAL) {
      res.status(400).json({ error: `Maximum of ${MAX_ADDITIONAL} additional images allowed` });
      return;
    }

    const newUrls = [...currentUrls, objectPath];
    await db.query(
      `UPDATE events SET additional_image_urls = $1, updated_at = now()
        WHERE id = $2 AND workspace_owner_id = $3`,
      [newUrls, eventId, ownerId],
    );

    void syncEventPublicImages(eventId, existing.rows[0].main_image_url as string | null, newUrls, ownerId);

    res.json({ url: objectPath });
  } catch (err) {
    logger.error({ err }, "POST /events/:id/images error");
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/events/:id/publications
// ---------------------------------------------------------------------------

router.get("/events/:id/publications", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(req.params.id, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const event = await db.query(
    `SELECT id FROM events WHERE id = $1 AND workspace_owner_id = $2`,
    [eventId, ownerId],
  );
  if (event.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const result = await db.query(
    `SELECT ep.*, pc.name AS channel_name, pc.slug AS channel_slug
       FROM event_publications ep
       JOIN publishing_channels pc ON pc.id = ep.channel_id
      WHERE ep.event_id = $1 AND ep.workspace_owner_id = $2
      ORDER BY ep.created_at ASC`,
    [eventId, ownerId],
  );

  res.json({ publications: result.rows });
});

// ---------------------------------------------------------------------------
// POST /api/events/:id/publications  — upsert
// ---------------------------------------------------------------------------

router.post("/events/:id/publications", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(req.params.id, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const event = await db.query(
    `SELECT id FROM events WHERE id = $1 AND workspace_owner_id = $2`,
    [eventId, ownerId],
  );
  if (event.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const channelId = typeof body.channel_id === "number" ? body.channel_id : parseInt(String(body.channel_id ?? ""), 10);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    res.status(400).json({ error: "channel_id is required" });
    return;
  }

  const channel = await db.query(
    `SELECT id FROM publishing_channels WHERE id = $1 AND workspace_owner_id = $2`,
    [channelId, ownerId],
  );
  if (channel.rowCount === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const {
    publication_status, is_visible, featured, sort_order,
    public_slug, public_title, short_description, long_description,
    seo_title, seo_description, og_image_url,
    price_override, sale_price_override, currency_override,
    badges, extra_fields,
  } = body;

  try {
    const result = await db.query(
      `INSERT INTO event_publications
         (workspace_owner_id, event_id, channel_id, publication_status, is_visible, featured,
          sort_order, public_slug, public_title, short_description, long_description,
          seo_title, seo_description, og_image_url, price_override, sale_price_override,
          currency_override, badges, extra_fields, published_at)
       VALUES ($1, $2, $3,
         COALESCE($4, 'draft'), COALESCE($5, true), COALESCE($6, false),
         $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
         COALESCE($18::jsonb, '[]'::jsonb), COALESCE($19::jsonb, '{}'::jsonb),
         CASE WHEN COALESCE($4, 'draft') = 'published' THEN now() ELSE NULL END
       )
       ON CONFLICT (event_id, channel_id) DO UPDATE SET
         publication_status   = EXCLUDED.publication_status,
         is_visible           = EXCLUDED.is_visible,
         featured             = EXCLUDED.featured,
         sort_order           = EXCLUDED.sort_order,
         public_slug          = EXCLUDED.public_slug,
         public_title         = EXCLUDED.public_title,
         short_description    = EXCLUDED.short_description,
         long_description     = EXCLUDED.long_description,
         seo_title            = EXCLUDED.seo_title,
         seo_description      = EXCLUDED.seo_description,
         og_image_url         = EXCLUDED.og_image_url,
         price_override       = EXCLUDED.price_override,
         sale_price_override  = EXCLUDED.sale_price_override,
         currency_override    = EXCLUDED.currency_override,
         badges               = EXCLUDED.badges,
         extra_fields         = EXCLUDED.extra_fields,
         published_at         = CASE
           WHEN EXCLUDED.publication_status = 'published' AND event_publications.published_at IS NULL
           THEN now() ELSE event_publications.published_at END,
         unpublished_at       = CASE
           WHEN EXCLUDED.publication_status != 'published' THEN now() ELSE NULL END,
         updated_at           = now()
       RETURNING *`,
      [
        ownerId, eventId, channelId,
        publication_status ?? null, is_visible ?? null, featured ?? null,
        sort_order ?? null, public_slug ?? null, public_title ?? null,
        short_description ?? null, long_description ?? null,
        seo_title ?? null, seo_description ?? null, og_image_url ?? null,
        price_override ?? null, sale_price_override ?? null, currency_override ?? null,
        badges ? JSON.stringify(badges) : null,
        extra_fields ? JSON.stringify(extra_fields) : null,
      ],
    );
    res.json({ publication: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "POST /events/:id/publications error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/events/:id/publications/:channelId
// ---------------------------------------------------------------------------

router.delete("/events/:id/publications/:channelId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  const ownerId = wreq.workspaceOwnerId;

  const eventId = parseInt(req.params.id, 10);
  const channelId = parseInt(req.params.channelId, 10);
  if (!Number.isFinite(eventId) || eventId <= 0 || !Number.isFinite(channelId) || channelId <= 0) {
    res.status(400).json({ error: "Invalid event or channel id" });
    return;
  }

  const result = await db.query(
    `DELETE FROM event_publications
      WHERE event_id = $1 AND channel_id = $2 AND workspace_owner_id = $3
      RETURNING id`,
    [eventId, channelId, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Publication not found" });
    return;
  }

  res.json({ success: true });
});

export default router;
