import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth, authed } from "../lib/auth";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

/**
 * GET /notifications/seen
 * Returns the access_request IDs that the current user has already marked as seen.
 */
router.get("/notifications/seen", async (req, res) => {
  const { userId } = authed(req);

  const result = await db.query<{ access_request_id: number }>(
    `SELECT access_request_id FROM notification_seen_ids WHERE user_id = $1`,
    [userId],
  );

  res.json({ seenIds: result.rows.map((r) => r.access_request_id) });
});

const markSeenBody = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

/**
 * POST /notifications/seen
 * Marks the given access_request IDs as seen for the current user.
 * Body: { ids: number[] }
 */
router.post("/notifications/seen", async (req, res) => {
  const { userId } = authed(req);

  const parsed = markSeenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ids must be a non-empty array of positive integers" });
    return;
  }

  const { ids } = parsed.data;

  const values = ids.map((id, i) => `($1, $${i + 2})`).join(", ");
  await db.query(
    `INSERT INTO notification_seen_ids (user_id, access_request_id)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    [userId, ...ids],
  );

  res.json({ ok: true });
});

export default router;
