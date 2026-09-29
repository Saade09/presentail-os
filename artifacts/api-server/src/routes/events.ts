import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../lib/auth";
import { requireApiKey } from "../lib/apiKeyAuth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { subscribeEvents } from "../lib/eventsSse";
import { logger } from "../lib/logger";

const router = Router();

function requireAuthOrApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = (req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer pk_live_")) {
    requireApiKey(req, res, next);
    return;
  }
  requireAuth(req, res, next);
}

/**
 * GET /api/events
 *
 * Broad Server-Sent Events stream. Broadcasts real-time events to authorized
 * listeners (Clerk session owner or API key). Emits:
 *   customer.created, customer.updated, customer.deleted
 *   order.created, order.updated, order.status_updated
 *   product.created, product.updated, product.deleted
 *   city.updated
 *   delivery_slot.updated
 *   delivery_settings.updated
 *   express_delivery.updated
 *   cmc_sale.created
 */
router.get(
  "/events",
  requireAuthOrApiKey,
  resolveWorkspace,
  (req: Request, res: Response): void => {
    const wreq = workspace(req);
    const workspaceOwnerId = wreq.workspaceOwnerId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    subscribeEvents(workspaceOwnerId, res);

    logger.debug({ workspaceOwnerId }, "events SSE client connected");

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      logger.debug({ workspaceOwnerId }, "events SSE client disconnected");
    });
  },
);

export default router;
