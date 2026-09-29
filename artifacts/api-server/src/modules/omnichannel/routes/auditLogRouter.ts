import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../lib/db";
import { requireOmnichannelRole } from "../omnichannelAuth";
import type { WorkspaceRequest } from "../../../lib/workspace";

const router = Router();

const ownerAuth = requireOmnichannelRole("omnichannel:owner");

// ---------------------------------------------------------------------------
// GET /omnichannel/audit-log
// Owner-only: paginated audit trail with optional action-type filter
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/audit-log",
  ...ownerAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;

    const actionFilter = (req.query["action"] as string | undefined)?.trim() ?? null;
    const actorId = (req.query["actor_id"] as string | undefined)?.trim() ?? null;
    const resourceType = (req.query["resource_type"] as string | undefined)?.trim() ?? null;
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "50", 10), 200);
    const offset = Math.max(parseInt((req.query["offset"] as string) ?? "0", 10), 0);

    const conditions: string[] = ["workspace_owner_id = $1"];
    const params: unknown[] = [workspaceOwnerId];
    let paramIdx = 2;

    if (actionFilter) {
      conditions.push(`action = $${paramIdx++}`);
      params.push(actionFilter);
    }

    if (actorId) {
      conditions.push(`actor_id = $${paramIdx++}`);
      params.push(actorId);
    }

    if (resourceType) {
      conditions.push(`resource_type = $${paramIdx++}`);
      params.push(resourceType);
    }

    const where = conditions.join(" AND ");

    const [rowsResult, countResult, actionsResult] = await Promise.all([
      db.query<{
        id: string;
        actor_id: string | null;
        actor_type: string;
        action: string;
        resource_type: string;
        resource_id: string | null;
        metadata: Record<string, unknown> | null;
        occurred_at: Date;
      }>(
        `SELECT id, actor_id, actor_type, action, resource_type, resource_id, metadata, occurred_at
         FROM omni_audit_logs
         WHERE ${where}
         ORDER BY occurred_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
      db.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM omni_audit_logs WHERE ${where}`,
        params,
      ),
      // Return distinct action types for filter dropdown (workspace-scoped)
      db.query<{ action: string }>(
        `SELECT DISTINCT action FROM omni_audit_logs WHERE workspace_owner_id = $1 ORDER BY action`,
        [workspaceOwnerId],
      ),
    ]);

    res.json({
      success: true,
      events: rowsResult.rows,
      total: parseInt(countResult.rows[0]?.total ?? "0", 10),
      limit,
      offset,
      available_actions: actionsResult.rows.map((r) => r.action),
    });
  },
);

export default router;
