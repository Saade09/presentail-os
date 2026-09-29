import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { sendAccessRequestEmail } from "../lib/email";
import { clerkClient } from "@clerk/express";
import { logger } from "../lib/logger";
import { db } from "../lib/db";
import { broadcast } from "../lib/accessRequestSse";
import type { AuthedRequest } from "../lib/auth";

const router = Router();

async function resolveRequestedWorkspace(rawWorkspace: unknown): Promise<string | null> {
  if (typeof rawWorkspace !== "string" || !rawWorkspace.trim()) return null;
  const workspace = rawWorkspace.trim();
  if (workspace.startsWith("user_")) return workspace;

  const result = await db.query<{ workspace_owner_id: string }>(
    `SELECT workspace_owner_id
       FROM workspace_settings
      WHERE workspace_slug = $1
      LIMIT 1`,
    [workspace],
  );
  return result.rows[0]?.workspace_owner_id ?? null;
}

/**
 * GET /request-access/status
 * Returns { requested: boolean } indicating whether this user has already
 * submitted an access request. Sits outside workspace middleware.
 */
router.get("/request-access/status", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  try {
    const workspaceOwnerId = await resolveRequestedWorkspace(req.query.workspace);
    if (!workspaceOwnerId) {
      res.status(400).json({ error: "workspace is required" });
      return;
    }
    const result = await db.query(
      `SELECT 1
         FROM access_requests
        WHERE workspace_owner_id = $1
          AND requester_clerk_id = $2
        LIMIT 1`,
      [workspaceOwnerId, userId],
    );
    res.json({ requested: result.rowCount! > 0 });
  } catch (err) {
    logger.warn({ err, userId }, "Failed to check access request status");
    res.status(500).json({ error: "Failed to check request status" });
  }
});

/**
 * POST /request-access
 * Saves an access request to the database and sends a notification email to
 * all workspace owners on behalf of the authenticated Clerk user.
 * This route intentionally sits OUTSIDE the resolveWorkspace middleware so
 * that users with no workspace access can call it.
 * Returns HTTP 409 with { error: "already_requested" } if the user has already
 * submitted a request.
 */
router.post("/request-access", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  let workspaceOwnerId: string | null;
  try {
    const explicitOwnerId =
      typeof req.body?.workspaceOwnerId === "string"
        ? req.body.workspaceOwnerId.trim()
        : "";
    workspaceOwnerId =
      explicitOwnerId || (await resolveRequestedWorkspace(req.body?.workspace));
  } catch (err) {
    logger.warn({ err }, "Failed to resolve access request workspace");
    res.status(500).json({ error: "Failed to resolve workspace" });
    return;
  }
  if (!workspaceOwnerId) {
    res.status(400).json({ error: "workspace is required" });
    return;
  }

  let requesterEmail: string | null = null;
  let requesterName = "Unknown";

  try {
    const user = await clerkClient.users.getUser(userId);
    requesterEmail = user.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
    const firstName = user.firstName ?? "";
    const lastName = user.lastName ?? "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    requesterName = fullName || requesterEmail || "Unknown";
  } catch (err) {
    logger.warn({ err, userId }, "Failed to fetch user from Clerk for access request");
  }

  if (!requesterEmail) {
    res.status(400).json({ error: "Could not determine your email address" });
    return;
  }

  let ownerEmails: string[];
  try {
    const ownerResult = await db.query<{ member_email: string }>(
      `SELECT member_email
         FROM workspace_members
        WHERE workspace_owner_id = $1
          AND role = 'owner'
          AND joined_at IS NOT NULL
          AND revoked_at IS NULL
          AND (access_expires_at IS NULL OR access_expires_at > NOW())
          AND member_email IS NOT NULL`,
      [workspaceOwnerId],
    );
    ownerEmails = ownerResult.rows.map((r) => r.member_email);
    if (ownerEmails.length === 0) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
  } catch (err) {
    logger.warn({ err, workspaceOwnerId }, "Failed to resolve access request workspace");
    res.status(500).json({ error: "Failed to resolve workspace" });
    return;
  }

  // Atomic insert: RETURNING id is only populated when a new row is actually
  // inserted. If the unique constraint fires (concurrent or repeat request),
  // ON CONFLICT DO NOTHING produces zero rows, and we return 409 without
  // sending any email. This eliminates the TOCTOU race between a pre-check
  // SELECT and the subsequent INSERT.
  let inserted = false;
  try {
    const result = await db.query<{ id: number }>(
      `INSERT INTO access_requests
         (workspace_owner_id, requester_clerk_id, requester_email, requester_name, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (workspace_owner_id, requester_clerk_id) DO NOTHING
       RETURNING id`,
      [workspaceOwnerId, userId, requesterEmail, requesterName],
    );
    inserted = result.rowCount! > 0;
  } catch (err) {
    logger.warn({ err, userId }, "Failed to insert into access_requests table");
    res.status(500).json({ error: "Failed to record access request" });
    return;
  }

  if (!inserted) {
    res.status(409).json({ error: "already_requested" });
    return;
  }

  // Broadcast a "changed" SSE event to this workspace's owner tabs so the pending-request
  // badge updates instantly without waiting for the next polling cycle.
  try {
    broadcast(workspaceOwnerId);
  } catch (err) {
    logger.warn({ err }, "Failed to broadcast SSE event for new access request");
  }

  // Send the notification email (non-fatal if it fails — the request is already
  // persisted in the DB so the owner will still see it in the UI).
  try {
    await sendAccessRequestEmail({ requesterEmail, requesterName, ownerEmails });
  } catch (err) {
    logger.error({ err, requesterEmail }, "Access request email failed — persisting to failed_access_requests");
    try {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await db.query(
        `INSERT INTO failed_access_requests
           (workspace_owner_id, requester_email, requester_name, error_message)
         VALUES ($1, $2, $3, $4)`,
        [workspaceOwnerId, requesterEmail, requesterName, errorMessage],
      );
    } catch (dbErr) {
      logger.error({ dbErr, requesterEmail }, "Could not persist failed access request to DB");
    }
  }

  res.json({ ok: true });
});

export default router;
