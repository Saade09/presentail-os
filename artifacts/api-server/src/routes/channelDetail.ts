import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { normalizePhone } from "../lib/customerUpsert";

const router = Router();
router.use(requireAuth, resolveWorkspace);

function canManage(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes("channels.manage") ?? false);
}

function canManageImageConfigs(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("channels.manage") ?? false) ||
    (wreq.allowedPages?.includes("channels.manage-image-configs") ?? false)
  );
}

function parsePositiveInt(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return NaN;
  return n;
}

const IMAGE_TYPES = ["product", "banner", "logo"] as const;
const OUTPUT_FORMATS = ["jpeg", "png", "webp"] as const;

type ImageConfigRow = {
  id: number;
  channel_id: number;
  image_type: string;
  width_px: number;
  height_px: number;
  output_format: string;
  created_at: string;
};

type ContactRow = {
  id: number;
  channel_id: number;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type ChannelDetailRow = {
  id: number;
  name: string;
  has_cover_photo: boolean;
  cover_photo_width: number | null;
  cover_photo_height: number | null;
  has_logo: boolean;
  created_at: string;
};

/**
 * GET /api/channel-image-configs
 * List all channel image configs for the workspace, optionally filtered by image_type.
 * Joins with channels to include channel_name.
 */
router.get("/channel-image-configs", async (req, res) => {
  const wreq = workspace(req);
  const imageTypeFilter = req.query.image_type as string | undefined;

  const params: unknown[] = [wreq.workspaceOwnerId];
  const filters: string[] = ["cic.workspace_owner_id = $1"];

  if (imageTypeFilter && (IMAGE_TYPES as readonly string[]).includes(imageTypeFilter)) {
    params.push(imageTypeFilter);
    filters.push(`cic.image_type = $${params.length}`);
  }

  const result = await db.query<ImageConfigRow & { channel_name: string }>(
    `SELECT cic.id, cic.channel_id, c.name AS channel_name,
            cic.image_type, cic.width_px, cic.height_px,
            COALESCE(cic.output_format, 'jpeg') AS output_format,
            cic.created_at
       FROM channel_image_configs cic
       JOIN channels c ON c.id = cic.channel_id
      WHERE ${filters.join(" AND ")}
      ORDER BY c.name ASC, cic.image_type ASC`,
    params,
  );

  res.json({ image_configs: result.rows });
});

/**
 * GET /api/channels/:id
 * Return one channel with its image_configs and active contacts.
 */
router.get("/channels/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const channelResult = await db.query<ChannelDetailRow>(
    `SELECT id, name, has_cover_photo, cover_photo_width, cover_photo_height,
            (logo_data IS NOT NULL) AS has_logo, created_at
       FROM channels
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if ((channelResult.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const channel = channelResult.rows[0];

  const configsResult = await db.query<ImageConfigRow>(
    `SELECT id, channel_id, image_type, width_px, height_px, output_format, created_at
       FROM channel_image_configs
      WHERE channel_id = $1 AND workspace_owner_id = $2
      ORDER BY image_type ASC`,
    [id, wreq.workspaceOwnerId],
  );

  const contactsResult = await db.query<ContactRow>(
    `SELECT id, channel_id, first_name, last_name, email, phone, title, is_active, created_at, updated_at
       FROM channel_contacts
      WHERE channel_id = $1 AND workspace_owner_id = $2 AND is_active = true
      ORDER BY created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );

  res.json({
    channel: {
      ...channel,
      image_configs: configsResult.rows,
      contacts: contactsResult.rows,
    },
  });
});

const createImageConfigSchema = z.object({
  image_type: z.enum(IMAGE_TYPES),
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  output_format: z.enum(OUTPUT_FORMATS).default("jpeg"),
});

const updateImageConfigSchema = z.object({
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  output_format: z.enum(OUTPUT_FORMATS).optional(),
});

/**
 * POST /api/channels/:channelId/image-configs
 */
router.post("/channels/:channelId/image-configs", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageImageConfigs(wreq)) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage channel image configs" });
    return;
  }

  const channelId = parseInt(String(req.params.channelId), 10);
  if (Number.isNaN(channelId)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const parsed = createImageConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    const field = parsed.error.issues[0];
    res.status(400).json({ error: field?.message ?? "Validation error", issues: parsed.error.issues });
    return;
  }
  const { image_type, width_px, height_px, output_format } = parsed.data;

  const channelCheck = await db.query(
    `SELECT id FROM channels WHERE id = $1 AND workspace_owner_id = $2`,
    [channelId, wreq.workspaceOwnerId],
  );
  if ((channelCheck.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  try {
    const result = await db.query<ImageConfigRow>(
      `INSERT INTO channel_image_configs
         (workspace_owner_id, channel_id, image_type, width_px, height_px, output_format)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, channel_id, image_type, width_px, height_px, output_format, created_at`,
      [wreq.workspaceOwnerId, channelId, image_type, width_px, height_px, output_format],
    );
    res.status(201).json({ image_config: result.rows[0] });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      res.status(409).json({ error: `A ${image_type} image config already exists for this channel.` });
      return;
    }
    throw err;
  }
});

/**
 * PUT /api/channels/:channelId/image-configs/:configId
 */
router.put("/channels/:channelId/image-configs/:configId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageImageConfigs(wreq)) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage channel image configs" });
    return;
  }

  const channelId = parseInt(String(req.params.channelId), 10);
  const configId = parseInt(String(req.params.configId), 10);
  if (Number.isNaN(channelId) || Number.isNaN(configId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = updateImageConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    const field = parsed.error.issues[0];
    res.status(400).json({ error: field?.message ?? "Validation error", issues: parsed.error.issues });
    return;
  }
  const { width_px, height_px, output_format } = parsed.data;

  const existing = await db.query(
    `SELECT id FROM channel_image_configs WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [configId, channelId, wreq.workspaceOwnerId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Image config not found" });
    return;
  }

  const sets: string[] = ["width_px = $1", "height_px = $2"];
  const params: unknown[] = [width_px, height_px];
  if (output_format !== undefined) {
    sets.push(`output_format = $${params.length + 1}`);
    params.push(output_format);
  }
  params.push(configId, wreq.workspaceOwnerId);

  const result = await db.query<ImageConfigRow>(
    `UPDATE channel_image_configs
        SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING id, channel_id, image_type, width_px, height_px, output_format, created_at`,
    params,
  );

  res.json({ image_config: result.rows[0] });
});

/**
 * DELETE /api/channels/:channelId/image-configs/:configId
 */
router.delete("/channels/:channelId/image-configs/:configId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageImageConfigs(wreq)) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage channel image configs" });
    return;
  }

  const channelId = parseInt(String(req.params.channelId), 10);
  const configId = parseInt(String(req.params.configId), 10);
  if (Number.isNaN(channelId) || Number.isNaN(configId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db.query(
    `DELETE FROM channel_image_configs WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [configId, channelId, wreq.workspaceOwnerId],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Image config not found" });
    return;
  }
  res.json({ ok: true });
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhoneNumberBasic(phone: string): boolean {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

const createContactSchema = z.object({
  first_name: z.string().min(1, "first_name is required").max(100),
  last_name: z.string().max(100).nullable().optional(),
  email: z.string().max(255).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  title: z.string().max(100).nullable().optional(),
});

const updateContactSchema = z.object({
  first_name: z.string().min(1, "first_name is required").max(100).optional(),
  last_name: z.string().max(100).nullable().optional(),
  email: z.string().max(255).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  title: z.string().max(100).nullable().optional(),
});

/**
 * POST /api/channels/:channelId/contacts
 */
router.post("/channels/:channelId/contacts", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage contacts" });
    return;
  }

  const channelId = parseInt(String(req.params.channelId), 10);
  if (Number.isNaN(channelId)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const parsed = createContactSchema.safeParse(req.body);
  if (!parsed.success) {
    const field = parsed.error.issues[0];
    res.status(400).json({ error: field?.message ?? "Validation error", issues: parsed.error.issues });
    return;
  }

  const { first_name, last_name, email, phone, title } = parsed.data;

  if (email && !isValidEmail(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  const normalizedPhone = phone ? normalizePhone(phone) : null;
  if (phone && !isValidPhoneNumberBasic(phone)) {
    res.status(400).json({ error: "Invalid phone number" });
    return;
  }

  const channelCheck = await db.query(
    `SELECT id FROM channels WHERE id = $1 AND workspace_owner_id = $2`,
    [channelId, wreq.workspaceOwnerId],
  );
  if ((channelCheck.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const result = await db.query<ContactRow>(
    `INSERT INTO channel_contacts
       (workspace_owner_id, channel_id, first_name, last_name, email, phone, title)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, channel_id, first_name, last_name, email, phone, title, is_active, created_at, updated_at`,
    [wreq.workspaceOwnerId, channelId, first_name.trim(), last_name?.trim() ?? null, email?.trim() ?? null, normalizedPhone, title?.trim() ?? null],
  );
  res.status(201).json({ contact: result.rows[0] });
});

/**
 * PUT /api/channels/:channelId/contacts/:contactId
 */
router.put("/channels/:channelId/contacts/:contactId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage contacts" });
    return;
  }

  const channelId = parseInt(String(req.params.channelId), 10);
  const contactId = parseInt(String(req.params.contactId), 10);
  if (Number.isNaN(channelId) || Number.isNaN(contactId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = updateContactSchema.safeParse(req.body);
  if (!parsed.success) {
    const field = parsed.error.issues[0];
    res.status(400).json({ error: field?.message ?? "Validation error", issues: parsed.error.issues });
    return;
  }

  const { first_name, last_name, email, phone, title } = parsed.data;

  if (email && !isValidEmail(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  if (phone && !isValidPhoneNumberBasic(phone)) {
    res.status(400).json({ error: "Invalid phone number" });
    return;
  }

  const existing = await db.query(
    `SELECT id FROM channel_contacts WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3`,
    [contactId, channelId, wreq.workspaceOwnerId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];

  if (first_name !== undefined) { sets.push(`first_name = $${params.length + 1}`); params.push(first_name.trim()); }
  if (last_name !== undefined) { sets.push(`last_name = $${params.length + 1}`); params.push(last_name?.trim() ?? null); }
  if (email !== undefined) { sets.push(`email = $${params.length + 1}`); params.push(email?.trim() ?? null); }
  if (phone !== undefined) {
    const norm = phone ? normalizePhone(phone) : null;
    sets.push(`phone = $${params.length + 1}`); params.push(norm);
  }
  if (title !== undefined) { sets.push(`title = $${params.length + 1}`); params.push(title?.trim() ?? null); }

  params.push(contactId, wreq.workspaceOwnerId);

  const result = await db.query<ContactRow>(
    `UPDATE channel_contacts
        SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING id, channel_id, first_name, last_name, email, phone, title, is_active, created_at, updated_at`,
    params,
  );

  res.json({ contact: result.rows[0] });
});

/**
 * DELETE /api/channels/:channelId/contacts/:contactId
 * Soft-delete: sets is_active = false.
 */
router.delete("/channels/:channelId/contacts/:contactId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage contacts" });
    return;
  }

  const channelId = parseInt(String(req.params.channelId), 10);
  const contactId = parseInt(String(req.params.contactId), 10);
  if (Number.isNaN(channelId) || Number.isNaN(contactId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db.query(
    `UPDATE channel_contacts
        SET is_active = false, updated_at = now()
      WHERE id = $1 AND channel_id = $2 AND workspace_owner_id = $3 AND is_active = true`,
    [contactId, channelId, wreq.workspaceOwnerId],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
