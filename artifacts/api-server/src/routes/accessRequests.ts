import { Router } from "express";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { drizzleDb } from "../lib/drizzle.js";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { sendInviteEmail, sendAccessRejectionEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { subscribe, broadcast } from "../lib/accessRequestSse";
import { sendValidated } from "../lib/responseValidation";
import { accessRequests, workspaceRoles } from "@workspace/db/schema";

const accessRequestSchema = z.object({
  id: z.number().int(),
  requester_clerk_id: z.string(),
  requester_email: z.string(),
  requester_name: z.string(),
  status: z.string(),
  requested_at: z.union([z.string(), z.date()]),
  resolved_at: z.union([z.string(), z.date()]).nullable(),
});

const accessRequestsResponseSchema = z.object({
  requests: z.array(accessRequestSchema),
});

const RETRYABLE_PG_CODES = new Set(["40001", "40P01"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_TX_RETRIES = 5;

export function createAccessRequestsRouter(heartbeatMs = 30_000): Router {
  const router = Router();

  router.use(requireAuth, resolveWorkspace);

  /**
   * GET /access-requests
   * Returns all pending access requests. Owner-only.
   */
  router.get("/access-requests", async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceRole !== "owner") {
      res.status(403).json({ error: "Only the workspace owner can view access requests" });
      return;
    }

    const rows = await drizzleDb
      .select({
        id: accessRequests.id,
        requester_clerk_id: accessRequests.requesterClerkId,
        requester_email: accessRequests.requesterEmail,
        requester_name: accessRequests.requesterName,
        status: accessRequests.status,
        requested_at: accessRequests.requestedAt,
        resolved_at: accessRequests.resolvedAt,
      })
      .from(accessRequests)
      .where(and(
        eq(accessRequests.workspaceOwnerId, wreq.workspaceOwnerId),
        eq(accessRequests.status, "pending"),
      ))
      .orderBy(asc(accessRequests.requestedAt));

    sendValidated(
      req,
      res,
      accessRequestsResponseSchema,
      { requests: rows },
      "GET /access-requests",
    );
  });

  /**
   * GET /access-requests/events
   * Server-Sent Events stream that emits a "changed" event whenever a pending
   * access request is approved or rejected in this workspace. Owner-only.
   */
  router.get("/access-requests/events", (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceRole !== "owner") {
      res.status(403).json({ error: "Only the workspace owner can subscribe to access-request events" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    subscribe(wreq.workspaceOwnerId, res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, heartbeatMs);

    req.on("close", () => {
      clearInterval(heartbeat);
    });
  });

  /**
   * POST /access-requests/:id/approve  { roleId }
   * Approve a pending access request. Creates a workspace_member row and marks
   * the request as approved. Owner-only.
   */
  router.post("/access-requests/:id/approve", async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceRole !== "owner") {
      res.status(403).json({ error: "Only the workspace owner can approve access requests" });
      return;
    }

    const requestId = parseInt(req.params.id, 10);
    if (Number.isNaN(requestId)) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }

    const rawRoleId = req.body?.roleId;
    if (rawRoleId == null) {
      res.status(400).json({ error: "A role is required to approve a request" });
      return;
    }
    const roleId = parseInt(String(rawRoleId), 10);
    if (Number.isNaN(roleId)) {
      res.status(400).json({ error: "Invalid roleId" });
      return;
    }

    // Verify the role belongs to this workspace.
    const roleRows = await drizzleDb
      .select({ id: workspaceRoles.id, name: workspaceRoles.name })
      .from(workspaceRoles)
      .where(and(eq(workspaceRoles.id, roleId), eq(workspaceRoles.workspaceOwnerId, wreq.workspaceOwnerId)));

    if (roleRows.length === 0) {
      res.status(400).json({ error: "Role not found in this workspace" });
      return;
    }
    const customRoleName = roleRows[0].name;

    // Fetch the access request.
    const arRows = await drizzleDb
      .select({
        id: accessRequests.id,
        requester_email: accessRequests.requesterEmail,
        requester_name: accessRequests.requesterName,
        status: accessRequests.status,
      })
      .from(accessRequests)
      .where(and(
        eq(accessRequests.id, requestId),
        eq(accessRequests.workspaceOwnerId, wreq.workspaceOwnerId),
      ));

    if (arRows.length === 0) {
      res.status(404).json({ error: "Access request not found" });
      return;
    }
    const ar = arRows[0];
    if (ar.status !== "pending") {
      res.status(409).json({ error: "Access request is no longer pending" });
      return;
    }

    // Create the workspace member and mark the request approved atomically.
    // Both writes are wrapped in a single drizzle transaction so that a
    // mid-operation crash cannot leave the member inserted but the request
    // still "pending".  Serialization failures (40001/40P01) are retried
    // automatically (matches withTransaction behavior).
    let member!: Record<string, unknown>;
    try {
      let attempt = 0;
      while (true) {
        try {
          member = await drizzleDb.transaction(async (tx) => {
            // workspace_members is not yet in the Drizzle schema — raw SQL via tx.execute.
            // Schema sentinel: access-approval INSERT workspace_members RETURNING the following columns.
            // Update here if any are renamed:
            //   - member_email (SET + → email), invited_by_email (SET + RETURNING),
            //     member_user_id (IS NOT NULL → joined), joined_at, manager_member_id (RETURNING)
            const insertResult = await tx.execute<{
              id: number;
              email: string;
              role: string;
              custom_role_id: number | null;
              joined: boolean;
              joined_at: string | null;
              invited_at: string;
              invited_by_email: string | null;
              manager_member_id: number | null;
              manager_email: string | null;
            }>(sql`
              INSERT INTO workspace_members
                (workspace_owner_id, member_email, role, custom_role_id, invited_by_user_id, invited_by_email)
              VALUES (
                ${wreq.workspaceOwnerId},
                ${ar.requester_email},
                'member',
                ${roleId},
                ${wreq.userId},
                ${wreq.userEmail}
              )
              RETURNING
                id,
                member_email AS email,
                role,
                custom_role_id,
                member_user_id IS NOT NULL AS joined,
                joined_at,
                created_at AS invited_at,
                invited_by_email,
                manager_member_id,
                NULL::text AS manager_email
            `);

            // Insert into junction table for multi-role support
            await tx.execute(sql`
              INSERT INTO workspace_member_roles (member_id, role_id)
              VALUES (${insertResult.rows[0].id}, ${roleId})
              ON CONFLICT DO NOTHING
            `);

            // Mark the access request as approved (Drizzle — access_requests is in schema).
            await tx
              .update(accessRequests)
              .set({ status: "approved", resolvedAt: new Date() })
              .where(and(
                eq(accessRequests.id, requestId),
                eq(accessRequests.workspaceOwnerId, wreq.workspaceOwnerId),
              ));

            // notification_seen_ids is not in the Drizzle schema — raw SQL via tx.execute.
            await tx.execute(
              sql`DELETE FROM notification_seen_ids WHERE access_request_id = ${requestId}`,
            );

            return insertResult.rows[0] as Record<string, unknown>;
          });
          break; // transaction committed successfully
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (RETRYABLE_PG_CODES.has(code ?? "") && attempt < MAX_TX_RETRIES) {
            attempt++;
            const backoffMs = Math.pow(2, attempt) * 50;
            req.log.warn(
              { pgCode: code, attempt, backoffMs },
              "access-requests approve: retrying after DB conflict",
            );
            await sleep(backoffMs);
            continue;
          }
          throw err;
        }
      }
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        // Already a member — still mark the request resolved so it disappears
        // (runs outside the rolled-back transaction, in autocommit mode).
        await drizzleDb
          .update(accessRequests)
          .set({ status: "approved", resolvedAt: new Date() })
          .where(and(
            eq(accessRequests.id, requestId),
            eq(accessRequests.workspaceOwnerId, wreq.workspaceOwnerId),
          ));
        // notification_seen_ids is not in the Drizzle schema — keep as raw SQL.
        await db.query(
          `DELETE FROM notification_seen_ids WHERE access_request_id = $1`,
          [requestId],
        );
        broadcast(wreq.workspaceOwnerId);
        res.status(409).json({ error: "That email is already in this workspace" });
        return;
      }
      throw err;
    }

    broadcast(wreq.workspaceOwnerId);

    sendInviteEmail({
      toEmail: ar.requester_email,
      invitedByEmail: wreq.userEmail,
      role: customRoleName,
      isAccessApproval: true,
    }).catch((err) => {
      logger.warn({ err, email: ar.requester_email }, "Failed to send access approval email");
    });

    res.json({ member });
  });

  /**
   * POST /access-requests/:id/reject
   * Reject a pending access request. Owner-only.
   */
  router.post("/access-requests/:id/reject", async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceRole !== "owner") {
      res.status(403).json({ error: "Only the workspace owner can reject access requests" });
      return;
    }

    const requestId = parseInt(req.params.id, 10);
    if (Number.isNaN(requestId)) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }

    // Atomically update only if the request is still pending (mirrors the original
    // WHERE id = $1 AND status = 'pending' guard).
    const updated = await drizzleDb
      .update(accessRequests)
      .set({ status: "rejected", resolvedAt: new Date() })
      .where(and(
        eq(accessRequests.id, requestId),
        eq(accessRequests.workspaceOwnerId, wreq.workspaceOwnerId),
        eq(accessRequests.status, "pending"),
      ))
      .returning({
        id: accessRequests.id,
        requester_email: accessRequests.requesterEmail,
      });

    if (updated.length === 0) {
      res.status(404).json({ error: "Pending access request not found" });
      return;
    }

    const { requester_email } = updated[0];

    // notification_seen_ids is not in the Drizzle schema — keep as raw SQL.
    await db.query(
      `DELETE FROM notification_seen_ids WHERE access_request_id = $1`,
      [requestId],
    );

    broadcast(wreq.workspaceOwnerId);

    sendAccessRejectionEmail({ toEmail: requester_email }).catch((err) => {
      logger.warn({ err, email: requester_email }, "Failed to send access rejection email");
    });

    res.json({ ok: true });
  });

  return router;
}

export default createAccessRequestsRouter();
