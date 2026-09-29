import { Router } from "express";
import type { Request, Response } from "express";
import { requireOmnichannelRole } from "../omnichannelAuth";
import { workspace } from "../../../lib/workspace";
import { sseBus } from "../sseBus";
import { logger } from "../../../lib/logger";

export function createSseRouter(heartbeatMs = 30_000): Router {
  const router = Router();

  router.get(
    "/omnichannel/events",
    requireOmnichannelRole("omnichannel:viewer"),
    (req: Request, res: Response): void => {
      const wreq = workspace(req);
      const workspaceOwnerId = wreq.workspaceOwnerId;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      res.write(": connected\n\n");

      sseBus.subscribe(workspaceOwnerId, res);

      logger.debug(
        { workspaceOwnerId, connections: sseBus.connectionCount(workspaceOwnerId) },
        "omnichannel SSE client connected",
      );

      const heartbeat = setInterval(() => {
        try {
          res.write(": heartbeat\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);

      req.on("close", () => {
        clearInterval(heartbeat);
        sseBus.unsubscribe(workspaceOwnerId, res);
        logger.debug({ workspaceOwnerId }, "omnichannel SSE client disconnected");
      });
    },
  );

  return router;
}

export default createSseRouter();
