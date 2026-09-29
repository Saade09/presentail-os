import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { getVapidPublicKey, isWebPushEnabled } from "../lib/webPush";

const router = Router();

// GET /api/web-push/public-key — VAPID public key for the browser to subscribe.
router.get(
  "/web-push/public-key",
  requireAuth,
  resolveWorkspace,
  (_req: Request, res: Response): void => {
    if (!isWebPushEnabled()) {
      res.status(503).json({ error: "Web push is not configured" });
      return;
    }
    res.json({ publicKey: getVapidPublicKey() });
  },
);

// POST /api/web-push/subscribe — store/refresh a browser push subscription.
router.post(
  "/web-push/subscribe",
  requireAuth,
  resolveWorkspace,
  async (req: Request, res: Response): Promise<void> => {
    if (!isWebPushEnabled()) {
      res.status(503).json({ error: "Web push is not configured" });
      return;
    }
    const wreq = workspace(req);
    const body = req.body as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = body.endpoint;
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;
    if (
      typeof endpoint !== "string" ||
      !/^https:\/\//.test(endpoint) ||
      endpoint.length > 2048 ||
      typeof p256dh !== "string" ||
      p256dh.length === 0 ||
      p256dh.length > 512 ||
      typeof auth !== "string" ||
      auth.length === 0 ||
      auth.length > 512
    ) {
      res.status(400).json({ error: "Invalid push subscription" });
      return;
    }
    try {
      await db.query(
        `INSERT INTO web_push_subscriptions
           (workspace_owner_id, user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint)
         DO UPDATE SET workspace_owner_id = EXCLUDED.workspace_owner_id,
                       user_id = EXCLUDED.user_id,
                       p256dh = EXCLUDED.p256dh,
                       auth = EXCLUDED.auth,
                       updated_at = now()`,
        [wreq.workspaceOwnerId, wreq.userId, endpoint, p256dh, auth],
      );
      res.json({ success: true });
    } catch (err: unknown) {
      logger.error({ err }, "web-push subscribe failed");
      res.status(500).json({ error: "Failed to save subscription" });
    }
  },
);

// POST /api/web-push/unsubscribe — remove a browser push subscription.
router.post(
  "/web-push/unsubscribe",
  requireAuth,
  resolveWorkspace,
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const body = req.body as { endpoint?: unknown };
    const endpoint = body.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      res.status(400).json({ error: "Invalid endpoint" });
      return;
    }
    try {
      await db.query(
        `DELETE FROM web_push_subscriptions
          WHERE endpoint = $1 AND user_id = $2`,
        [endpoint, wreq.userId],
      );
      res.json({ success: true });
    } catch (err: unknown) {
      logger.error({ err }, "web-push unsubscribe failed");
      res.status(500).json({ error: "Failed to remove subscription" });
    }
  },
);

export default router;
