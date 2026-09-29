import type { Request, Response, NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { db } from "./db";
import type { AuthedRequest } from "./auth";
import { logger } from "./logger";

export type WorkspaceRequest = AuthedRequest & {
  /** Clerk user_id of the workspace this request operates within. */
  workspaceOwnerId: string;
  /** Simplified role: "owner" | "member". */
  workspaceRole: "owner" | "member";
  /** Full DB role string: "owner" | "member". */
  workspaceActualRole: string;
  /** Email of the current user (filled in lazily). */
  userEmail: string | null;
  /** Pages the current user is allowed to access (null = owner, unrestricted). */
  allowedPages: string[] | null;
  /** The primary custom role ID assigned to this member (null for owners). */
  customRoleId: number | null;
  /** All custom role IDs assigned to this member via the junction table. */
  customRoleIds: number[];
  /** The workspace_members.id for the current user (null if unresolved). */
  memberDbId: number | null;
  /**
   * Location IDs this member is restricted to.
   * null  = owner (no restriction, sees everything).
   * []    = member with no location assignments (no restriction, sees everything).
   * [..n] = member restricted to those location IDs.
   */
  assignedLocationIds: number[] | null;
};

/** Narrow a Request to WorkspaceRequest after `resolveWorkspace` has run. */
export function workspace(req: Request): WorkspaceRequest {
  return req as unknown as WorkspaceRequest;
}

/**
 * True when the request's user may access the given page. Workspace owners
 * (role "owner", allowedPages === null) always pass; members pass only when
 * the page key is present in their allowedPages list.
 */
export function hasPageAccess(
  wreq: WorkspaceRequest,
  pageKey: string,
): boolean {
  if (wreq.workspaceRole === "owner") return true;
  return !!wreq.allowedPages?.includes(pageKey);
}

/**
 * Log a permission rejection with enough resolved workspace context to
 * distinguish a real denial from a broken membership/role assignment. Tokens,
 * cookies, email addresses, and other credentials are intentionally excluded.
 */
export function logPageAccessDenial(
  req: Request,
  wreq: WorkspaceRequest,
  requiredPages: string[],
): void {
  req.log?.warn?.(
    {
      authUserId: wreq.userId,
      workspaceOwnerId: wreq.workspaceOwnerId,
      workspaceRole: wreq.workspaceRole,
      workspaceActualRole: wreq.workspaceActualRole,
      memberDbId: wreq.memberDbId,
      customRoleId: wreq.customRoleId,
      customRoleIds: wreq.customRoleIds,
      allowedPages: wreq.allowedPages,
      requiredPages,
      requestPath: req.path,
      httpStatus: 403,
      authorizationResult: "denied_before_query",
      databaseError: null,
    },
    "workspace page permission denied",
  );
}

type UserEmailLookup = {
  email: string | null;
  userNotFound: boolean;
};

function clearRejectedClerkCookies(req: Request, res: Response): void {
  const cookieNames = ["__session", "__client_uat"];
  for (const name of cookieNames) {
    // Clear a host-only cookie if Clerk or an older app build placed one on
    // os.presentail.com.
    res.clearCookie(name, { path: "/" });
  }

  const hostname = req.hostname.toLowerCase();
  if (hostname === "presentail.com" || hostname.endsWith(".presentail.com")) {
    for (const name of cookieNames) {
      // Clerk's custom-domain cookies may be scoped to the shared parent
      // domain. Expire those too so the next page load cannot rehydrate the
      // deleted user.
      res.clearCookie(name, { domain: ".presentail.com", path: "/" });
    }
  }
}

async function fetchUserEmail(userId: string): Promise<UserEmailLookup> {
  try {
    const user = await clerkClient.users.getUser(userId);
    return {
      email: user.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null,
      userNotFound: false,
    };
  } catch (err) {
    logger.warn({ err, userId }, "Failed to fetch user email from Clerk");
    const clerkError = err as {
      status?: number;
      errors?: Array<{ code?: string }>;
    };
    return {
      email: null,
      userNotFound:
        clerkError.status === 404 ||
        clerkError.errors?.some((error) => error.code === "resource_not_found") === true,
    };
  }
}

type MembershipRow = {
  id: number;
  workspace_owner_id: string;
  role: string;
  member_email: string;
  custom_role_id: number | null;
  custom_role_ids: number[] | null;
  allowed_pages: string[] | null;
  revoked_at: string | Date | null;
  access_expires_at: string | Date | null;
};

/**
 * Look up an existing joined membership for this user. The unique partial
 * index on (member_user_id) WHERE NOT NULL guarantees at most one row.
 *
 * Schema sentinel — reads the following workspace_members columns.
 * If any column is renamed in a schema migration you MUST update this query:
 *   - workspace_members.member_user_id  (used in WHERE clause)
 *   - workspace_members.member_email    (selected directly)
 */
async function findMembership(userId: string): Promise<MembershipRow | null> {
  const r = await db.query<MembershipRow>(
    `SELECT wm.id, wm.workspace_owner_id, wm.role, wm.member_email,
            wm.revoked_at, wm.access_expires_at,
            wm.custom_role_id,
            (SELECT array_agg(wmr.role_id ORDER BY wmr.role_id)
               FROM workspace_member_roles wmr
              WHERE wmr.member_id = wm.id) AS custom_role_ids,
            (SELECT array_agg(DISTINCT page)
               FROM workspace_member_roles wmr
               JOIN workspace_roles wr ON wr.id = wmr.role_id,
               LATERAL jsonb_array_elements_text(wr.allowed_pages) AS page
              WHERE wmr.member_id = wm.id) AS allowed_pages
       FROM workspace_members wm
      WHERE wm.member_user_id = $1
        AND wm.joined_at IS NOT NULL
        AND wm.revoked_at IS NULL
        AND (wm.access_expires_at IS NULL OR wm.access_expires_at > NOW())
      LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

async function fetchAssignedLocationIds(memberDbId: number): Promise<number[]> {
  const r = await db.query<{ location_id: number }>(
    `SELECT location_id FROM member_locations WHERE member_id = $1`,
    [memberDbId],
  );
  return r.rows.map((row) => row.location_id);
}

/**
 * Atomically claim the user's workspace:
 *  1. If a pending invite exists for their email → accept it (any domain).
 *  2. Else if an existing JOINED membership with a different Clerk user ID
 *     exists for the same email (Clerk tenant migration) → re-link it.
 *  3. Else → return null (access denied; caller returns 403).
 *
 * Note: @presentail.com addresses used to be auto-provisioned as owner of a
 * brand-new workspace. That behavior was removed (July 2026) — it created
 * confusing duplicate empty workspaces for users who signed in before being
 * invited. Everyone without an invite or an existing membership is now denied.
 *
 * The unique partial index on member_user_id makes this idempotent — concurrent
 * requests will see one winner and the loser falls through to a re-read.
 *
 * Schema sentinel — this function writes and reads the following workspace_members
 * columns. If any column is renamed in a schema migration you MUST update the SQL
 * blocks inside this function:
 *   - workspace_members.member_user_id  (SET on claim/re-link, WHERE on lookup)
 *   - workspace_members.member_email    (WHERE for invite/re-link matching, RETURNING)
 *   - workspace_members.joined_at       (SET to now() on claim, WHERE IS NOT NULL)
 */
// Exported for unit-testing only; not part of the public API.
export async function claimMembership(
  userId: string,
  email: string | null,
): Promise<MembershipRow | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Re-check inside the transaction in case a parallel request just won.
    const already = await client.query<MembershipRow>(
      `SELECT wm.id, wm.workspace_owner_id, wm.role, wm.member_email,
              wm.revoked_at, wm.access_expires_at,
              wm.custom_role_id,
              (SELECT array_agg(wmr.role_id ORDER BY wmr.role_id)
                 FROM workspace_member_roles wmr
                WHERE wmr.member_id = wm.id) AS custom_role_ids,
              (SELECT array_agg(DISTINCT page)
                 FROM workspace_member_roles wmr
                 JOIN workspace_roles wr ON wr.id = wmr.role_id,
                 LATERAL jsonb_array_elements_text(wr.allowed_pages) AS page
                WHERE wmr.member_id = wm.id) AS allowed_pages
         FROM workspace_members wm
        WHERE wm.member_user_id = $1
          AND wm.joined_at IS NOT NULL
          AND wm.revoked_at IS NULL
          AND (wm.access_expires_at IS NULL OR wm.access_expires_at > NOW())
        LIMIT 1
        FOR UPDATE OF wm`,
      [userId],
    );
    if (already.rows[0]) {
      await client.query("COMMIT");
      return already.rows[0];
    }

    if (email) {
      // Accept ONE pending invite, oldest first. Lock it to prevent two
      // concurrent acceptances from claiming different rows.
      // Note: invite_token is intentionally kept so that subsequent visits
      // to the /join link return 410 ("already used") rather than 404.
      const accepted = await client.query<MembershipRow>(
        `UPDATE workspace_members
            SET member_user_id = $1, joined_at = now()
          WHERE id = (
            SELECT id FROM workspace_members
             WHERE lower(member_email) = lower($2) AND member_user_id IS NULL
               AND revoked_at IS NULL
               AND (access_expires_at IS NULL OR access_expires_at > NOW())
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, workspace_owner_id, role, member_email, custom_role_id,
                    revoked_at, access_expires_at, NULL::jsonb AS allowed_pages`,
        [userId, email],
      );
      if (accepted.rows[0]) {
        // Fetch allowed_pages and custom_role_ids from junction table
        const roleRow = await client.query<{ allowed_pages: string[] | null; custom_role_ids: number[] | null }>(
          `SELECT
             (SELECT array_agg(DISTINCT page)
                FROM workspace_member_roles wmr
                JOIN workspace_roles wr2 ON wr2.id = wmr.role_id,
                LATERAL jsonb_array_elements_text(wr2.allowed_pages) AS page
               WHERE wmr.member_id = $1) AS allowed_pages,
             (SELECT array_agg(wmr.role_id ORDER BY wmr.role_id)
                FROM workspace_member_roles wmr
               WHERE wmr.member_id = $1) AS custom_role_ids`,
          [accepted.rows[0].id],
        );
        accepted.rows[0].allowed_pages = roleRow.rows[0]?.allowed_pages ?? null;
        accepted.rows[0].custom_role_ids = roleRow.rows[0]?.custom_role_ids ?? null;
        await client.query("COMMIT");
        return accepted.rows[0];
      }

      // Re-link: if an existing JOINED membership exists for this email under a
      // different Clerk user ID (e.g. after a Clerk tenant migration), update it
      // to the new Clerk ID instead of creating a new empty workspace.
      const relinked = await client.query<MembershipRow>(
        `UPDATE workspace_members
            SET member_user_id = $1
          WHERE id = (
            SELECT id FROM workspace_members
             WHERE lower(member_email) = lower($2)
               AND member_user_id IS NOT NULL
               AND member_user_id != $1
               AND joined_at IS NOT NULL
                AND revoked_at IS NULL
                AND (access_expires_at IS NULL OR access_expires_at > NOW())
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, workspace_owner_id, role, member_email, custom_role_id,
                    revoked_at, access_expires_at, NULL::jsonb AS allowed_pages`,
        [userId, email],
      );
      if (relinked.rows[0]) {
        // Fetch allowed_pages and custom_role_ids from junction table
        const roleRow2 = await client.query<{ allowed_pages: string[] | null; custom_role_ids: number[] | null }>(
          `SELECT
             (SELECT array_agg(DISTINCT page)
                FROM workspace_member_roles wmr
                JOIN workspace_roles wr2 ON wr2.id = wmr.role_id,
                LATERAL jsonb_array_elements_text(wr2.allowed_pages) AS page
               WHERE wmr.member_id = $1) AS allowed_pages,
             (SELECT array_agg(wmr.role_id ORDER BY wmr.role_id)
                FROM workspace_member_roles wmr
               WHERE wmr.member_id = $1) AS custom_role_ids`,
          [relinked.rows[0].id],
        );
        relinked.rows[0].allowed_pages = roleRow2.rows[0]?.allowed_pages ?? null;
        relinked.rows[0].custom_role_ids = roleRow2.rows[0]?.custom_role_ids ?? null;
        await client.query("COMMIT");
        logger.info(
          { email, newUserId: userId },
          "claimMembership: re-linked existing membership to new Clerk user ID",
        );
        return relinked.rows[0];
      }
    }

    // No pending invite found and no existing membership to re-link.
    // Everyone — including @presentail.com addresses — is denied access.
    // (Auto-provisioning a new owner workspace for @presentail.com emails was
    // removed in July 2026; see the function doc comment.)
    await client.query("COMMIT");
    return null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve the workspace context for the authenticated user. Idempotent and
 * safe under concurrent first-time sign-in requests.
 *
 * MUST be called after `requireAuth`.
 */
export async function resolveWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = (req as AuthedRequest).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    let row = await findMembership(userId);
    let email: string | null = row?.member_email ?? null;

    if (
      row &&
      (row.revoked_at !== null ||
        (row.access_expires_at !== null &&
          new Date(row.access_expires_at).getTime() <= Date.now()))
    ) {
      res.status(403).json({ error: "no_access" });
      return;
    }

    if (!row) {
      const userLookup = await fetchUserEmail(userId);
      if (userLookup.userNotFound) {
        // Clerk middleware can hydrate a stale cookie from a previous Clerk
        // instance. If the currently configured Backend API explicitly says
        // that user does not exist, this is an invalid session, not a workspace
        // permission failure.
        clearRejectedClerkCookies(req, res);
        res.status(401).json({
          error: "Unauthorized",
          code: "stale_clerk_session",
        });
        return;
      }
      email = userLookup.email;
      try {
        row = await claimMembership(userId, email);
      } catch (err) {
        // Concurrent claim raced and won; re-read.
        const code = (err as { code?: string })?.code;
        if (code === "23505") {
          row = await findMembership(userId);
        } else {
          throw err;
        }
      }
    }

    if (!row) {
      // No pending invite and no existing membership → deny access.
      res.status(403).json({ error: "no_access" });
      return;
    }

    const wreq = req as WorkspaceRequest;
    wreq.workspaceOwnerId = row.workspace_owner_id;
    wreq.workspaceRole = row.role === "owner" ? "owner" : "member";
    wreq.workspaceActualRole = row.role;
    wreq.userEmail = email ?? row.member_email;
    wreq.allowedPages = row.role === "owner" ? null : (row.allowed_pages ?? []);
    wreq.customRoleId = row.custom_role_id ?? null;
    wreq.customRoleIds = row.custom_role_ids ?? [];
    wreq.memberDbId = row.id ?? null;
    if (row.role === "owner") {
      wreq.assignedLocationIds = null;
    } else {
      wreq.assignedLocationIds = row.id ? await fetchAssignedLocationIds(row.id) : [];
    }
    req.log?.debug?.(
      {
        authUserId: userId,
        workspaceOwnerId: wreq.workspaceOwnerId,
        workspaceRole: wreq.workspaceRole,
        workspaceActualRole: wreq.workspaceActualRole,
        memberDbId: wreq.memberDbId,
        customRoleId: wreq.customRoleId,
        customRoleIds: wreq.customRoleIds,
        allowedPages: wreq.allowedPages,
      },
      "workspace context resolved",
    );
    next();
  } catch (err) {
    logger.error({ err, userId }, "Failed to resolve workspace");
    res.status(500).json({ error: "Failed to resolve workspace" });
  }
}
