// ---------------------------------------------------------------------------
// Omnichannel Phase 6 — Knowledge base CRUD API
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { requireOmnichannelRole } from "../omnichannelAuth";
import { workspace } from "../../../lib/workspace";

const router = Router();

const ownerAuth = requireOmnichannelRole("omnichannel:owner");
const agentAuth = requireOmnichannelRole("omnichannel:agent");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createKbSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  category: z.string().max(100).optional(),
  tags: z.array(z.string()).optional(),
  is_published: z.boolean().optional().default(false),
});

const updateKbSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  category: z.string().max(100).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  is_published: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET /omnichannel/knowledge-base
// ---------------------------------------------------------------------------

router.get(
  "/omnichannel/knowledge-base",
  agentAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const publishedOnly = req.query.published === "true";
      const q = typeof req.query.q === "string" ? req.query.q.trim() : null;

      let sql = `SELECT id, title, content, category, tags, is_published, created_by_agent_id, created_at, updated_at
                 FROM omni_knowledge_base
                 WHERE workspace_owner_id = $1`;
      const params: unknown[] = [wreq.workspaceOwnerId];

      if (publishedOnly) {
        sql += ` AND is_published = true`;
      }

      if (q) {
        params.push(`%${q}%`);
        sql += ` AND (title ILIKE $${params.length} OR content ILIKE $${params.length})`;
      }

      sql += ` ORDER BY updated_at DESC`;

      const result = await db.query(sql, params);
      res.json({ articles: result.rows });
    } catch (err) {
      logger.error({ err }, "omnichannel: failed to list knowledge base articles");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/knowledge-base
// ---------------------------------------------------------------------------

router.post(
  "/omnichannel/knowledge-base",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = createKbSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }

      const { title, content, category, tags, is_published } = parsed.data;

      const result = await db.query<{ id: number }>(
        `INSERT INTO omni_knowledge_base
           (workspace_owner_id, title, content, category, tags, is_published, created_by_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          wreq.workspaceOwnerId,
          title,
          content,
          category ?? null,
          tags ? JSON.stringify(tags) : null,
          is_published,
          wreq.userId,
        ],
      );

      const article = await db.query(
        `SELECT * FROM omni_knowledge_base WHERE id = $1`,
        [result.rows[0].id],
      );

      res.status(201).json({ article: article.rows[0] });
    } catch (err) {
      logger.error({ err }, "omnichannel: failed to create knowledge base article");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /omnichannel/knowledge-base/:id
// ---------------------------------------------------------------------------

router.patch(
  "/omnichannel/knowledge-base/:id",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }

      const parsed = updateKbSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }

      const existing = await db.query<{ id: number }>(
        `SELECT id FROM omni_knowledge_base WHERE id = $1 AND workspace_owner_id = $2`,
        [id, wreq.workspaceOwnerId],
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: "Article not found" });
        return;
      }

      const updates: string[] = [];
      const params: unknown[] = [];

      const d = parsed.data;
      if (d.title !== undefined) {
        params.push(d.title);
        updates.push(`title = $${params.length}`);
      }
      if (d.content !== undefined) {
        params.push(d.content);
        updates.push(`content = $${params.length}`);
      }
      if ("category" in d) {
        params.push(d.category ?? null);
        updates.push(`category = $${params.length}`);
      }
      if ("tags" in d) {
        params.push(d.tags ? JSON.stringify(d.tags) : null);
        updates.push(`tags = $${params.length}`);
      }
      if (d.is_published !== undefined) {
        params.push(d.is_published);
        updates.push(`is_published = $${params.length}`);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: "No fields to update" });
        return;
      }

      params.push(id, wreq.workspaceOwnerId);
      await db.query(
        `UPDATE omni_knowledge_base SET ${updates.join(", ")}, updated_at = NOW()
         WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}`,
        params,
      );

      const article = await db.query(
        `SELECT * FROM omni_knowledge_base WHERE id = $1`,
        [id],
      );

      res.json({ article: article.rows[0] });
    } catch (err) {
      logger.error({ err }, "omnichannel: failed to update knowledge base article");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /omnichannel/knowledge-base/:id
// ---------------------------------------------------------------------------

router.delete(
  "/omnichannel/knowledge-base/:id",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }

      const result = await db.query<{ id: number }>(
        `DELETE FROM omni_knowledge_base WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
        [id, wreq.workspaceOwnerId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Article not found" });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "omnichannel: failed to delete knowledge base article");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
