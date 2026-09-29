import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { drizzleDb } from "../lib/drizzle.js";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { validateAllowedPages } from "../lib/pageKeys";
import { sendValidated } from "../lib/responseValidation";
import { roleChannelAccess, channels } from "@workspace/db/schema";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const roleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  allowed_pages: z.array(z.string()),
  channel_ids: z.array(z.number().int()),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});

const rolesResponseSchema = z.object({
  roles: z.array(roleSchema),
});

/**
 * Parse and validate a channelIds body field.
 * Returns the array of valid IDs, or a string error message if invalid.
 */
function parseChannelIds(raw: unknown): number[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "channelIds must be an array";
  const ids: number[] = [];
  for (const id of raw) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) {
      return "channelIds must be an array of positive integers";
    }
    ids.push(n);
  }
  return ids;
}

/**
 * Validate that all given channel IDs belong to the specified workspace.
 * Returns null if valid, or an error message string if any ID is unknown/foreign.
 */
async function validateChannelOwnership(
  channelIds: number[],
  workspaceOwnerId: string,
): Promise<string | null> {
  if (channelIds.length === 0) return null;
  const rows = await drizzleDb
    .select({ id: channels.id })
    .from(channels)
    .where(and(inArray(channels.id, channelIds), eq(channels.workspaceOwnerId, workspaceOwnerId)));
  if (rows.length !== channelIds.length) {
    return "One or more channelIds are invalid or do not belong to this workspace";
  }
  return null;
}

/**
 * GET /roles
 * List all custom roles for this workspace, including their channel_ids.
 * Accessible by all members (owners and non-owners need this to show role names).
 */
router.get("/roles", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query(
    `SELECT id, name, description, allowed_pages, created_at, updated_at
       FROM workspace_roles
      WHERE workspace_owner_id = $1
      ORDER BY created_at ASC`,
    [wreq.workspaceOwnerId],
  );

  const roles = result.rows;

  if (roles.length === 0) {
    sendValidated(req, res, rolesResponseSchema, { roles: [] }, "GET /roles");
    return;
  }

  const roleIds = roles.map((r: { id: number }) => r.id);
  const channelRows = await drizzleDb
    .select({ role_id: roleChannelAccess.roleId, channel_id: roleChannelAccess.channelId })
    .from(roleChannelAccess)
    .where(inArray(roleChannelAccess.roleId, roleIds));

  const channelsByRole = new Map<number, number[]>();
  for (const row of channelRows) {
    const arr = channelsByRole.get(row.role_id) ?? [];
    arr.push(row.channel_id);
    channelsByRole.set(row.role_id, arr);
  }

  const rolesWithChannels = roles.map((r: { id: number }) => ({
    ...r,
    channel_ids: channelsByRole.get(r.id) ?? [],
  }));

  sendValidated(
    req,
    res,
    rolesResponseSchema,
    { roles: rolesWithChannels },
    "GET /roles",
  );
});

/**
 * POST /roles  { name, allowedPages, channelIds?, description? }
 * Create a new custom role. Owner-only.
 */
router.post("/roles", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage roles" });
    return;
  }

  const name = String(req.body?.name ?? "").trim();
  if (!name || name.length > 100) {
    res.status(400).json({ error: "A role name (up to 100 characters) is required" });
    return;
  }

  const description =
    req.body?.description != null && String(req.body.description).trim() !== ""
      ? String(req.body.description).trim().slice(0, 500)
      : null;

  const allowedPages = req.body?.allowedPages;
  if (!Array.isArray(allowedPages)) {
    res.status(400).json({ error: "allowedPages must be an array" });
    return;
  }
  const pageKeyError = validateAllowedPages(allowedPages);
  if (pageKeyError) {
    res.status(400).json({ error: pageKeyError });
    return;
  }

  const parsedChannelIds = parseChannelIds(req.body?.channelIds);
  if (typeof parsedChannelIds === "string") {
    res.status(400).json({ error: parsedChannelIds });
    return;
  }
  const channelIds = parsedChannelIds;

  const channelOwnershipError = await validateChannelOwnership(channelIds, wreq.workspaceOwnerId);
  if (channelOwnershipError) {
    res.status(400).json({ error: channelOwnershipError });
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let role: Record<string, unknown>;
    try {
      const result = await client.query(
        `INSERT INTO workspace_roles (workspace_owner_id, name, description, allowed_pages)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, allowed_pages, created_at, updated_at`,
        [wreq.workspaceOwnerId, name, description, JSON.stringify(allowedPages)],
      );
      role = result.rows[0];
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        res.status(409).json({ error: "A role with that name already exists" });
        return;
      }
      throw err;
    }

    if (channelIds.length > 0) {
      const values = channelIds.map((cid, i) => `($1, $${i + 2})`).join(", ");
      await client.query(
        `INSERT INTO role_channel_access (role_id, channel_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [role.id, ...channelIds],
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ role: { ...role, channel_ids: channelIds } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PATCH /roles/:id  { name?, description?, allowedPages?, channelIds? }
 * Update a custom role's name, description, allowed pages, or channel access. Owner-only.
 */
router.patch("/roles/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage roles" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 100) {
      res.status(400).json({ error: "A role name (up to 100 characters) is required" });
      return;
    }
    params.push(name);
    updates.push(`name = $${params.length}`);
  }

  if (req.body?.description !== undefined) {
    const desc = req.body.description;
    const value =
      desc === null || (typeof desc === "string" && desc.trim() === "")
        ? null
        : String(desc).trim().slice(0, 500);
    params.push(value);
    updates.push(`description = $${params.length}`);
  }

  if (req.body?.allowedPages !== undefined) {
    if (!Array.isArray(req.body.allowedPages)) {
      res.status(400).json({ error: "allowedPages must be an array" });
      return;
    }
    const patchPageKeyError = validateAllowedPages(req.body.allowedPages);
    if (patchPageKeyError) {
      res.status(400).json({ error: patchPageKeyError });
      return;
    }
    params.push(JSON.stringify(req.body.allowedPages));
    updates.push(`allowed_pages = $${params.length}`);
  }

  let newChannelIds: number[] | null = null;
  if (req.body?.channelIds !== undefined) {
    const parsedPatch = parseChannelIds(req.body.channelIds);
    if (typeof parsedPatch === "string") {
      res.status(400).json({ error: parsedPatch });
      return;
    }
    const patchOwnershipError = await validateChannelOwnership(parsedPatch, wreq.workspaceOwnerId);
    if (patchOwnershipError) {
      res.status(400).json({ error: patchOwnershipError });
      return;
    }
    newChannelIds = parsedPatch;
  }

  if (updates.length === 0 && newChannelIds === null) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  if (updates.length > 0) {
    updates.push("updated_at = now()");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let role: Record<string, unknown> | null = null;

    if (updates.length > 0) {
      params.push(id, wreq.workspaceOwnerId);
      try {
        const result = await client.query(
          `UPDATE workspace_roles
              SET ${updates.join(", ")}
            WHERE id = $${params.length - 1}
              AND workspace_owner_id = $${params.length}
            RETURNING id, name, description, allowed_pages, created_at, updated_at`,
          params,
        );
        if (result.rowCount === 0) {
          await client.query("ROLLBACK");
          res.status(404).json({ error: "Role not found" });
          return;
        }
        role = result.rows[0];
      } catch (err: unknown) {
        await client.query("ROLLBACK");
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "23505"
        ) {
          res.status(409).json({ error: "A role with that name already exists" });
          return;
        }
        throw err;
      }
    } else {
      const result = await client.query(
        `SELECT id, name, description, allowed_pages, created_at, updated_at FROM workspace_roles WHERE id = $1 AND workspace_owner_id = $2`,
        [id, wreq.workspaceOwnerId],
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Role not found" });
        return;
      }
      role = result.rows[0];
    }

    if (newChannelIds !== null) {
      await client.query(`DELETE FROM role_channel_access WHERE role_id = $1`, [id]);
      if (newChannelIds.length > 0) {
        const values = newChannelIds.map((cid, i) => `($1, $${i + 2})`).join(", ");
        await client.query(
          `INSERT INTO role_channel_access (role_id, channel_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [id, ...newChannelIds],
        );
      }
    }

    await client.query("COMMIT");

    const channelRows = await drizzleDb
      .select({ channel_id: roleChannelAccess.channelId })
      .from(roleChannelAccess)
      .where(eq(roleChannelAccess.roleId, id));
    const channel_ids = channelRows.map((r) => r.channel_id);

    res.json({ role: { ...role, channel_ids } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/**
 * POST /roles/:id/duplicate
 * Duplicate a role (copy name+" (copy)", description, allowed_pages, channel_ids). Owner-only.
 */
router.post("/roles/:id/duplicate", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage roles" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  // Load the source role
  const sourceResult = await db.query(
    `SELECT id, name, description, allowed_pages FROM workspace_roles WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (sourceResult.rowCount === 0) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  const source = sourceResult.rows[0];

  // Load the source channel IDs via Drizzle
  const channelRows = await drizzleDb
    .select({ channel_id: roleChannelAccess.channelId })
    .from(roleChannelAccess)
    .where(eq(roleChannelAccess.roleId, id));
  const channelIds = channelRows.map((r) => r.channel_id);

  // Build a unique copy name
  const baseName = `${source.name} (copy)`;
  let copyName = baseName;
  let attempt = 1;
  while (true) {
    const existing = await db.query(
      `SELECT id FROM workspace_roles WHERE workspace_owner_id = $1 AND name = $2`,
      [wreq.workspaceOwnerId, copyName],
    );
    if (existing.rowCount === 0) break;
    attempt += 1;
    copyName = `${baseName} ${attempt}`;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query(
      `INSERT INTO workspace_roles (workspace_owner_id, name, description, allowed_pages)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, allowed_pages, created_at, updated_at`,
      [wreq.workspaceOwnerId, copyName, source.description, JSON.stringify(source.allowed_pages)],
    );
    const newRole = insertResult.rows[0];

    if (channelIds.length > 0) {
      const values = channelIds.map((cid, i) => `($1, $${i + 2})`).join(", ");
      await client.query(
        `INSERT INTO role_channel_access (role_id, channel_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [newRole.id, ...channelIds],
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ role: { ...newRole, channel_ids: channelIds } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/**
 * DELETE /roles/:id
 * Delete a custom role. Owner-only. Blocked if any members are currently assigned.
 */
router.delete("/roles/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage roles" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  // Check the junction table for current role assignments.
  const memberCheck = await db.query(
    `SELECT COUNT(*) AS count
       FROM workspace_member_roles wmr
       JOIN workspace_members wm ON wm.id = wmr.member_id
      WHERE wmr.role_id = $1
        AND wm.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const count = parseInt(memberCheck.rows[0]?.count ?? "0", 10);
  if (count > 0) {
    res.status(409).json({
      error: `Cannot delete role: ${count} member${count === 1 ? " is" : "s are"} currently assigned to it`,
    });
    return;
  }

  const result = await db.query(
    `DELETE FROM workspace_roles
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
