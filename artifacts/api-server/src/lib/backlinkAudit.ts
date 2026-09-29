import { db } from "./db";
import { logger } from "./logger";
import type { WorkspaceRequest } from "./workspace";

/**
 * Write an immutable audit event for any Backlink Engine action.
 * Fire-and-forget safe: never throws; logs on failure.
 */
export async function recordBacklinkAudit(
  wreq: WorkspaceRequest,
  entityType: string,
  entityId: string | number,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO backlink_audit_events
         (workspace_owner_id, entity_type, entity_id, action, user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        wreq.workspaceOwnerId,
        entityType,
        String(entityId),
        action,
        wreq.userId ?? null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err, entityType, entityId, action }, "backlink: audit write failed");
  }
}
