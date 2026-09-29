import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { requireAuth } from "../lib/auth";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import type { AuthedRequest } from "../lib/auth";

const router = Router();

/**
 * GET /invite/:token
 * Public endpoint — no auth required.
 * Returns the invited email, inviter email, and workspace name if the token is valid and unclaimed.
 * Returns 404 if the token does not exist.
 * Returns 410 if the token has already been claimed.
 */
router.get("/invite/:token", async (req, res) => {
  const { token } = req.params;
  if (!token || token.length > 128) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  try {
    // Schema sentinel: reads workspace_members.member_email, invited_by_email,
    // workspace_owner_id, member_user_id, invite_token, invite_expires_at.
    // Update here and in invite.test.ts mocks if any of these columns are renamed.
    const result = await db.query<{
      member_email: string;
      invited_by_email: string | null;
      workspace_owner_id: string;
      member_user_id: string | null;
      invite_expires_at: Date | null;
    }>(
      `SELECT member_email, invited_by_email, workspace_owner_id, member_user_id, invite_expires_at
         FROM workspace_members
        WHERE invite_token = $1
        LIMIT 1`,
      [token],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }

    const row = result.rows[0];
    if (row.member_user_id !== null) {
      res.status(410).json({ error: "Invite already used" });
      return;
    }

    if (row.invite_expires_at !== null && new Date() > new Date(row.invite_expires_at)) {
      res.status(410).json({ error: "Invite expired" });
      return;
    }

    // Attempt to fetch the workspace owner's display name from Clerk for context.
    let workspaceName: string | null = null;
    try {
      const owner = await clerkClient.users.getUser(row.workspace_owner_id);
      const parts = [owner.firstName, owner.lastName].filter(Boolean);
      if (parts.length > 0) {
        workspaceName = parts.join(" ") + "'s workspace";
      } else {
        workspaceName = owner.primaryEmailAddress?.emailAddress ?? null;
      }
    } catch {
      // Non-fatal — workspace name is display-only
    }

    res.json({
      email: row.member_email,
      invitedBy: row.invited_by_email,
      workspaceName,
    });
  } catch (err) {
    logger.error({ err }, "Failed to look up invite token");
    res.status(500).json({ error: "Internal error" });
  }
});

/**
 * POST /invite/claim
 * Requires Clerk auth but NOT resolveWorkspace (user has no membership yet).
 * Claims the invite identified by `token`, linking it to the authenticated user.
 * Verifies that the authenticated user's email matches the invited email (case-insensitive).
 * Idempotent: if the user already has a membership row, returns success.
 */
router.post("/invite/claim", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const token = String(req.body?.token ?? "").trim();

  if (!token || token.length > 128) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  // Fetch the authenticated user's email from Clerk to enforce ownership.
  // Falls back to the first email address if no primary is set (handles test environments).
  let userEmail: string | null = null;
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    userEmail =
      (clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress)
        ?.toLowerCase() ?? null;
  } catch (err) {
    logger.warn({ err, userId }, "Failed to fetch user email from Clerk for invite claim");
  }

  if (!userEmail) {
    res.status(400).json({ error: "Could not determine your email address" });
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Schema sentinel — the three workspace_members queries in this transaction
    // read and write the following columns. Update here if any are renamed:
    //   - invite_token         (WHERE filter for SELECT and UPDATE)
    //   - member_user_id       (WHERE IS NULL filter; SET on claim; WHERE for existing-member check)
    //   - member_email         (RETURNING / ownership verification)
    //   - invite_expires_at    (expiry check)
    //   - joined_at            (WHERE IS NOT NULL for existing-member; SET to now() on claim)
    // Look up the invite row first so we can scope the existing-member check
    // to the same workspace. Must be done before the membership check to
    // prevent a membership in a *different* workspace from short-circuiting
    // this claim and leaving the invite row unclaimed.
    const inviteRow = await client.query<{
      member_email: string;
      invite_expires_at: Date | null;
      workspace_owner_id: string;
    }>(
      `SELECT member_email, invite_expires_at, workspace_owner_id
         FROM workspace_members
        WHERE invite_token = $1 AND member_user_id IS NULL
        LIMIT 1
        FOR UPDATE`,
      [token],
    );

    if (inviteRow.rowCount === 0) {
      await client.query("COMMIT");
      res.status(410).json({ error: "Invite token is invalid or has already been used" });
      return;
    }

    const expiresAt = inviteRow.rows[0].invite_expires_at;
    if (expiresAt !== null && new Date() > new Date(expiresAt)) {
      await client.query("COMMIT");
      res.status(410).json({ error: "Invite expired" });
      return;
    }

    const invitedEmail = inviteRow.rows[0].member_email.toLowerCase();
    if (invitedEmail !== userEmail) {
      await client.query("COMMIT");
      res.status(403).json({
        error: `This invite was sent to ${inviteRow.rows[0].member_email}. Please sign in with that email address to accept it.`,
      });
      return;
    }

    // Check if this user already has an active membership in THIS workspace.
    // Scoping to workspace_owner_id prevents a membership in a different
    // workspace from blocking the claim here.
    const workspaceOwnerId = inviteRow.rows[0].workspace_owner_id;
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM workspace_members
        WHERE member_user_id = $1 AND joined_at IS NOT NULL
          AND workspace_owner_id = $2
        LIMIT 1`,
      [userId, workspaceOwnerId],
    );
    const alreadyMember = existing.rowCount !== null && existing.rowCount > 0;

    // Always run the UPDATE to claim the invite row. This is a no-op when the
    // row was already claimed, but ensures the token is marked as used even
    // when the user already had a membership (e.g. from a prior migration).
    // The token is intentionally kept so that subsequent visits to the /join
    // link return 410 ("already used") instead of 404.
    await client.query(
      `UPDATE workspace_members
          SET member_user_id = $1, joined_at = now()
        WHERE invite_token = $2
          AND member_user_id IS NULL`,
      [userId, token],
    );

    await client.query("COMMIT");
    res.json({ ok: true, ...(alreadyMember ? { alreadyMember: true } : {}) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err, userId }, "Failed to claim invite token");
    res.status(500).json({ error: "Internal error" });
  } finally {
    client.release();
  }
});

export default router;
