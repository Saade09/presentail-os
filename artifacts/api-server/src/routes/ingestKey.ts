import crypto from "crypto";
import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * GET /api/settings/ingest-key
 * Returns key metadata for the workspace's ingest key (never the plaintext),
 * plus per-endpoint usage counts for the last 7 days.
 * Owner-only.
 */
router.get("/settings/ingest-key", async (req, res) => {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  const result = await db.query<{
    id: number;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
  }>(
    `SELECT id, key_prefix, created_at, last_used_at
       FROM workspace_ingest_keys
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );

  if (!result.rowCount || result.rowCount === 0) {
    res.json({ exists: false, prefix: null, created_at: null, last_used_at: null, usage_7d: [], total_calls_7d: 0 });
    return;
  }

  const row = result.rows[0];

  // Fetch per-endpoint usage for the last 7 days
  const usageResult = await db.query<{ endpoint: string; count: string }>(
    `SELECT endpoint, SUM(call_count)::text AS count
       FROM ingest_key_usage
      WHERE ingest_key_id = $1
        AND usage_date >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY endpoint
      ORDER BY SUM(call_count) DESC`,
    [row.id],
  );

  const usage7d = usageResult.rows.map((u) => ({
    endpoint: u.endpoint,
    count: Number(u.count),
  }));
  const totalCalls7d = usage7d.reduce((sum, u) => sum + u.count, 0);

  res.json({
    exists: true,
    prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    usage_7d: usage7d,
    total_calls_7d: totalCalls7d,
  });
});

/**
 * POST /api/settings/ingest-key/rotate
 * Generates a new pik_live_<random> token, hashes it, upserts the row.
 * Returns { prefix, plaintext } — plaintext is never stored.
 * Owner-only.
 */
router.post("/settings/ingest-key/rotate", async (req, res) => {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const ownerId = workspace(req).workspaceOwnerId;

  const random = crypto.randomBytes(24).toString("base64url");
  const plaintext = `pik_live_${random}`;
  const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");
  const keyPrefix = plaintext.slice(0, 16);

  await db.query(
    `INSERT INTO workspace_ingest_keys (workspace_owner_id, key_hash, key_prefix, created_at, last_used_at)
     VALUES ($1, $2, $3, now(), NULL)
     ON CONFLICT (workspace_owner_id) DO UPDATE
       SET key_hash = EXCLUDED.key_hash,
           key_prefix = EXCLUDED.key_prefix,
           created_at = now(),
           last_used_at = NULL`,
    [ownerId, keyHash, keyPrefix],
  );

  res.json({ prefix: keyPrefix, plaintext });
});

export default router;
