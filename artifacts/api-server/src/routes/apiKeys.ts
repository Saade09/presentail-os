import { Router } from "express";
import crypto from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

router.get("/api-keys", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can view API keys" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const result = await db.query(
    `SELECT id, name, key_prefix, created_at, last_used_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  res.json({ keys: result.rows });
});

router.post("/api-keys", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can create API keys" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const name = (req.body?.name as string) || "Untitled key";

  const rawKey = "pk_live_" + crypto.randomBytes(24).toString("hex");
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  const result = await db.query(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, key_prefix, created_at, last_used_at`,
    [ownerId, name, keyHash, keyPrefix],
  );

  res.json({ key: result.rows[0], plaintext: rawKey });
});

router.delete("/api-keys/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can delete API keys" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.query(`DELETE FROM api_keys WHERE id = $1 AND user_id = $2`, [
    id,
    ownerId,
  ]);
  res.json({ ok: true });
});

export default router;
