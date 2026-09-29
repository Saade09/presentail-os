import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { clerkClient } from "@clerk/express";
import { z } from "zod";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { sendInviteEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router = Router();

const memberRowSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    role: z.string(),
    joined: z.boolean(),
    image_url: z.string().nullable(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    assigned_locations: z.array(
      z.object({ id: z.number().int(), name: z.string() }).passthrough(),
    ),
  })
  .passthrough();

const usersListResponseSchema = z.object({
  members: z.array(memberRowSchema),
  me: z
    .object({
      role: z.string(),
      email: z.string(),
    })
    .passthrough(),
});

function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error(
      { err: parsed.error.issues, route },
      "Response validation failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}

router.use(requireAuth, resolveWorkspace);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYMENT_TYPES = ["full_time", "part_time", "contractor", "intern"] as const;
const EMPLOYMENT_STATUSES = ["active", "inactive", "on_leave"] as const;
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * GET /users
 * List everyone in the current workspace, including pending invites.
 */
router.get("/users", async (req, res) => {
  const wreq = workspace(req);
  const isOwner = wreq.workspaceRole === "owner";
  // Schema sentinel: reads workspace_members.member_user_id, member_email,
  // manager_member_id, invited_by_email, and mgr.member_email (via self-JOIN).
  // Update here and in the users list test mocks if any of these columns are renamed.
  const result = await db.query<{ member_user_id: string | null; id: number; [key: string]: unknown }>(
    `SELECT wm.id, wm.member_email AS email, wm.role, wm.custom_role_id,
            wm.member_user_id,
            wm.member_user_id IS NOT NULL AS joined,
            wm.joined_at, wm.created_at AS invited_at, wm.invited_by_email,
            wr.name AS role_name,
            wm.manager_member_id,
            mgr.member_email AS manager_email,
            wm.job_title,
            to_char(wm.start_date, 'YYYY-MM-DD') AS start_date,
            wm.department,
            wm.location,
            wm.employment_type,
            wm.employment_status,
            wm.working_days,
            wm.florist_location_id,
            CASE WHEN $2 AND wm.member_user_id IS NULL THEN wm.invite_token ELSE NULL END AS invite_token,
            wm.access_expires_at,
            wm.revoked_at
       FROM workspace_members wm
       LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
       LEFT JOIN workspace_members mgr ON mgr.id = wm.manager_member_id
      WHERE wm.workspace_owner_id = $1
      ORDER BY (wm.role = 'owner') DESC, wm.created_at ASC`,
    [wreq.workspaceOwnerId, isOwner],
  );

  // Batch-fetch location assignments for all members
  const memberIds = result.rows.map((r) => r.id);
  const locAssignMap = new Map<number, { id: number; name: string }[]>();
  if (memberIds.length > 0) {
    const locResult = await db.query<{ member_id: number; location_id: number; location_name: string }>(
      `SELECT ml.member_id, l.id AS location_id, l.name AS location_name
         FROM member_locations ml
         JOIN locations l ON l.id = ml.location_id
        WHERE ml.member_id = ANY($1::int[])`,
      [memberIds],
    );
    for (const row of locResult.rows) {
      const arr = locAssignMap.get(row.member_id) ?? [];
      arr.push({ id: row.location_id, name: row.location_name });
      locAssignMap.set(row.member_id, arr);
    }
  }

  // Batch-fetch role assignments from junction table
  const roleDataMap = new Map<number, { role_names: string[]; custom_role_ids: number[] }>();
  if (memberIds.length > 0) {
    const roleResult = await db.query<{ member_id: number; role_id: number; role_name: string }>(
      `SELECT wmr.member_id, wr.id AS role_id, wr.name AS role_name
         FROM workspace_member_roles wmr
         JOIN workspace_roles wr ON wr.id = wmr.role_id
        WHERE wmr.member_id = ANY($1::int[])
        ORDER BY wmr.member_id, wr.name`,
      [memberIds],
    );
    for (const row of roleResult.rows) {
      const entry = roleDataMap.get(row.member_id) ?? { role_names: [], custom_role_ids: [] };
      entry.role_names.push(row.role_name);
      entry.custom_role_ids.push(row.role_id);
      roleDataMap.set(row.member_id, entry);
    }
  }

  // Batch-fetch Clerk profile images for all joined members
  const clerkUserIds = result.rows
    .map((r) => r.member_user_id)
    .filter((id): id is string => !!id);
  const imageMap = new Map<string, string>();
  const nameMap = new Map<string, { first_name: string | null; last_name: string | null }>();
  if (clerkUserIds.length > 0) {
    try {
      const clerkUsers = await clerkClient.users.getUserList({ userId: clerkUserIds, limit: 100 });
      for (const u of clerkUsers.data) {
        if (u.hasImage && u.imageUrl) imageMap.set(u.id, u.imageUrl);
        nameMap.set(u.id, {
          first_name: u.firstName ?? null,
          last_name: u.lastName ?? null,
        });
      }
    } catch {
      // Non-fatal — fall back to initials avatars
    }
  }

  const members = result.rows.map(({ member_user_id, ...rest }) => ({
    ...rest,
    image_url: member_user_id ? (imageMap.get(member_user_id) ?? null) : null,
    first_name: member_user_id ? (nameMap.get(member_user_id)?.first_name ?? null) : null,
    last_name: member_user_id ? (nameMap.get(member_user_id)?.last_name ?? null) : null,
    assigned_locations: locAssignMap.get(rest.id as number) ?? [],
    role_names: roleDataMap.get(rest.id as number)?.role_names ?? [],
    custom_role_ids: roleDataMap.get(rest.id as number)?.custom_role_ids ?? [],
  }));

  sendValidated(
    req,
    res,
    usersListResponseSchema,
    {
      members,
      me: {
        role: wreq.workspaceActualRole,
        email: wreq.userEmail,
        allowedPages: wreq.allowedPages,
        customRoleId: wreq.customRoleId,
        customRoleIds: wreq.customRoleIds,
        // The caller's own florist location (null for owners / non-florists) —
        // used by the dashboard to filter florist-assignment SSE alerts.
        floristLocationId:
          (result.rows.find((r) => r.member_user_id === wreq.userId)
            ?.florist_location_id as number | null | undefined) ?? null,
      },
    },
    "GET /users",
  );
});

/**
 * POST /users  { email, roleId? }
 * Invite someone by email. Owner or users.invite permission required.
 */
router.post("/users", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    if (!wreq.allowedPages?.includes("users.invite")) {
      res.status(403).json({ error: "You do not have permission to invite members" });
      return;
    }
  }

  const email = String(req.body?.email ?? "")
    .trim()
    .toLowerCase();
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Valid email required" });
    return;
  }

  const rawRoleId = req.body?.roleId;
  if (rawRoleId == null) {
    res.status(400).json({ error: "A role is required when inviting a user" });
    return;
  }

  const roleId = parseInt(String(rawRoleId), 10);
  if (Number.isNaN(roleId)) {
    res.status(400).json({ error: "Invalid roleId" });
    return;
  }
  const roleCheck = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM workspace_roles WHERE id = $1 AND workspace_owner_id = $2`,
    [roleId, wreq.workspaceOwnerId],
  );
  if (roleCheck.rowCount === 0) {
    res.status(400).json({ error: "Role not found in this workspace" });
    return;
  }
  const customRoleId = roleId;
  const customRoleName = roleCheck.rows[0].name;

  const fromAccessRequest = req.body?.fromAccessRequest === true;

  // Optional mobile app password — if provided, we pre-create the Clerk account
  // immediately so the user can sign in to the mobile app right away.
  const rawMobilePassword = req.body?.mobilePassword;
  const mobilePassword =
    typeof rawMobilePassword === "string" && rawMobilePassword.trim().length >= 8
      ? rawMobilePassword.trim()
      : null;
  if (
    typeof rawMobilePassword === "string" &&
    rawMobilePassword.trim().length > 0 &&
    rawMobilePassword.trim().length < 8
  ) {
    res.status(400).json({ error: "Mobile app password must be at least 8 characters" });
    return;
  }

  // When a password is set, we pre-create the Clerk user so no invite flow is needed.
  // When no password, use the standard invite token flow.
  let preCreatedClerkUserId: string | null = null;
  if (mobilePassword) {
    try {
      const clerkUser = await clerkClient.users.createUser({
        emailAddress: [email],
        password: mobilePassword,
        skipPasswordChecks: false,
      });
      preCreatedClerkUserId = clerkUser.id;
    } catch (clerkErr: unknown) {
      req.log.error({ err: clerkErr, email }, "Failed to pre-create Clerk user with mobile password");
      const clerkMsg =
        clerkErr != null &&
        typeof clerkErr === "object" &&
        "errors" in clerkErr &&
        Array.isArray((clerkErr as { errors: { message: string }[] }).errors)
          ? (clerkErr as { errors: { message: string }[] }).errors
              .map((e) => e.message)
              .join("; ")
          : null;
      res.status(400).json({
        error: clerkMsg ?? "Failed to create user account — the email may already exist in another workspace",
      });
      return;
    }
  }

  const inviteToken = fromAccessRequest || mobilePassword ? null : randomUUID();

  // Optional employment-info fields on invite. Defaults applied below.
  const inviteJobTitle =
    typeof req.body?.jobTitle === "string" && req.body.jobTitle.trim() !== ""
      ? req.body.jobTitle.trim().slice(0, 200)
      : null;
  const inviteStartDate =
    typeof req.body?.startDate === "string" && req.body.startDate.trim() !== ""
      ? req.body.startDate.trim()
      : null;
  if (inviteStartDate && !isValidIsoDate(inviteStartDate)) {
    res.status(400).json({ error: "startDate must be YYYY-MM-DD" });
    return;
  }
  const inviteDepartment =
    typeof req.body?.department === "string" && req.body.department.trim() !== ""
      ? req.body.department.trim().slice(0, 120)
      : null;
  const inviteLocation =
    typeof req.body?.location === "string" && req.body.location.trim() !== ""
      ? req.body.location.trim().slice(0, 200)
      : null;
  const rawEmpType = req.body?.employmentType;
  const inviteEmploymentType =
    rawEmpType == null || rawEmpType === ""
      ? "full_time"
      : EMPLOYMENT_TYPES.includes(String(rawEmpType) as (typeof EMPLOYMENT_TYPES)[number])
        ? String(rawEmpType)
        : null;
  if (inviteEmploymentType === null) {
    res
      .status(400)
      .json({ error: `employmentType must be one of ${EMPLOYMENT_TYPES.join(", ")}` });
    return;
  }
  const rawEmpStatus = req.body?.employmentStatus;
  const inviteEmploymentStatus =
    rawEmpStatus == null || rawEmpStatus === ""
      ? "active"
      : EMPLOYMENT_STATUSES.includes(
            String(rawEmpStatus) as (typeof EMPLOYMENT_STATUSES)[number],
          )
        ? String(rawEmpStatus)
        : null;
  if (inviteEmploymentStatus === null) {
    res
      .status(400)
      .json({ error: `employmentStatus must be one of ${EMPLOYMENT_STATUSES.join(", ")}` });
    return;
  }
  let inviteManagerMemberId: number | null = null;
  if (req.body?.managerMemberId != null && req.body.managerMemberId !== "") {
    const mid = parseInt(String(req.body.managerMemberId), 10);
    if (Number.isNaN(mid)) {
      res.status(400).json({ error: "Invalid managerMemberId" });
      return;
    }
    const mgr = await db.query<{ id: number }>(
      `SELECT id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
      [mid, wreq.workspaceOwnerId],
    );
    if (mgr.rowCount === 0) {
      res.status(400).json({ error: "Manager not found in this workspace" });
      return;
    }
    inviteManagerMemberId = mid;
  }

  // Schema sentinel: POST /users INSERT workspace_members and RETURNING the following columns.
  // Update here if any are renamed:
  //   - member_email (SET + → email), invited_by_email (SET + RETURNING),
  //     invite_token (SET), invite_expires_at (SET), manager_member_id (SET + RETURNING),
  //     member_user_id (IS NOT NULL → joined), joined_at
  // Wrap the INSERT and the access-request dismiss UPDATE in a single
  // transaction so that a crash between the two cannot leave a member
  // row without the corresponding request being dismissed.
  // withTransaction retries automatically on serialization failures (40001/40P01).
  const client = await db.connect();
  let memberRow: Record<string, unknown>;
  try {
    memberRow = await withTransaction(client, async () => {
      // When pre-creating a Clerk user with a password, insert with member_user_id
      // already set and joined_at = now() so the member is immediately active.
      const insertResult = preCreatedClerkUserId
        ? await client.query(
            `INSERT INTO workspace_members
               (workspace_owner_id, member_email, role, custom_role_id, invited_by_user_id, invited_by_email,
                member_user_id, joined_at,
                job_title, start_date, manager_member_id, department, location, employment_type, employment_status)
             VALUES ($1, $2, 'member', $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13)
             RETURNING id, member_email AS email, role, custom_role_id,
                       member_user_id IS NOT NULL AS joined,
                       joined_at, created_at AS invited_at, invited_by_email,
                       manager_member_id, NULL::text AS manager_email,
                       job_title,
                       to_char(start_date, 'YYYY-MM-DD') AS start_date,
                       department, location, employment_type, employment_status`,
            [
              wreq.workspaceOwnerId,
              email,
              customRoleId,
              wreq.userId,
              wreq.userEmail,
              preCreatedClerkUserId,
              inviteJobTitle,
              inviteStartDate,
              inviteManagerMemberId,
              inviteDepartment,
              inviteLocation,
              inviteEmploymentType,
              inviteEmploymentStatus,
            ],
          )
        : await client.query(
            `INSERT INTO workspace_members
               (workspace_owner_id, member_email, role, custom_role_id, invited_by_user_id, invited_by_email, invite_token, invite_expires_at,
                job_title, start_date, manager_member_id, department, location, employment_type, employment_status)
             VALUES ($1, $2, 'member', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING id, member_email AS email, role, custom_role_id,
                       member_user_id IS NOT NULL AS joined,
                       joined_at, created_at AS invited_at, invited_by_email,
                       manager_member_id, NULL::text AS manager_email,
                       job_title,
                       to_char(start_date, 'YYYY-MM-DD') AS start_date,
                       department, location, employment_type, employment_status`,
            [
              wreq.workspaceOwnerId,
              email,
              customRoleId,
              wreq.userId,
              wreq.userEmail,
              inviteToken,
              inviteToken ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
              inviteJobTitle,
              inviteStartDate,
              inviteManagerMemberId,
              inviteDepartment,
              inviteLocation,
              inviteEmploymentType,
              inviteEmploymentStatus,
            ],
          );

      // Insert into junction table for multi-role support
      await client.query(
        `INSERT INTO workspace_member_roles (member_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [(insertResult.rows[0] as { id: number }).id, customRoleId],
      );

      // Automatically dismiss any pending access request for this email
      // inside the same transaction.
      await client.query(
        `UPDATE access_requests
            SET status = 'dismissed', resolved_at = now()
          WHERE workspace_owner_id = $1
            AND requester_email = $2
            AND status = 'pending'`,
        [wreq.workspaceOwnerId, email],
      );

      return insertResult.rows[0] as Record<string, unknown>;
    });
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      // Schema sentinel: conflict-check reads workspace_members.member_email.
      // Update here if member_email is renamed.
      const existing = await db.query<{ id: number }>(
        `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND member_email = $2 LIMIT 1`,
        [wreq.workspaceOwnerId, email],
      );
      const existingPersonId = existing.rows[0] ? `wm_${existing.rows[0].id}` : null;
      res.status(409).json({
        error: "That email is already in this workspace",
        ...(existingPersonId ? { existing_person_id: existingPersonId } : {}),
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }

  // When a mobile password was set, the account is pre-created so no invite token
  // is needed. Skip the invite email in that case.
  if (!mobilePassword) {
    sendInviteEmail({
      toEmail: memberRow.email as string,
      invitedByEmail: wreq.userEmail,
      role: customRoleName,
      isAccessApproval: fromAccessRequest,
      inviteToken: inviteToken ?? undefined,
    }).catch((err: unknown) => {
      logger.warn({ err, toEmail: memberRow.email }, "invite email delivery failed — member was saved but may not receive notification");
    });
  }
  res.json({ member: memberRow });
});

/**
 * PATCH /users/:id
 * Body fields (all optional; provide at least one):
 *   roleId, managerMemberId, jobTitle, startDate, department, location,
 *   employmentType, employmentStatus
 * Requires users.edit (or owner). Changing roleId additionally requires users.assign-role.
 * Cannot change the owner row's role/manager (employment info is allowed).
 */
router.patch("/users/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    if (!wreq.allowedPages?.includes("users.edit")) {
      res.status(403).json({ error: "You do not have permission to edit member details" });
      return;
    }
    // Changing custom_role_id requires the extra assign-role permission
    if (("roleId" in (req.body ?? {}) || "roleIds" in (req.body ?? {})) && !wreq.allowedPages?.includes("users.assign-role")) {
      res.status(403).json({ error: "You do not have permission to assign member roles" });
      return;
    }
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = req.body ?? {};
  const hasRoleId = "roleId" in body;
  const hasRoleIds = "roleIds" in body;
  const hasManagerMemberId = "managerMemberId" in body;
  const hasJobTitle = "jobTitle" in body;
  const hasStartDate = "startDate" in body;
  const hasDepartment = "department" in body;
  const hasLocation = "location" in body;
  const hasEmploymentType = "employmentType" in body;
  const hasEmploymentStatus = "employmentStatus" in body;
  const hasWorkingDays = "workingDays" in body;
  const hasFloristLocationId = "floristLocationId" in body;

  const hasAny =
    hasRoleId ||
    hasRoleIds ||
    hasManagerMemberId ||
    hasJobTitle ||
    hasStartDate ||
    hasDepartment ||
    hasLocation ||
    hasEmploymentType ||
    hasEmploymentStatus ||
    hasWorkingDays ||
    hasFloristLocationId;

  if (!hasAny) {
    res.status(400).json({ error: "At least one updatable field is required" });
    return;
  }

  // Build the SET clauses dynamically
  const setClauses: string[] = [];
  const params: unknown[] = [];

  // resolvedRoleIds: null = not changing roles; [] = clear all; [..] = set to these
  let resolvedRoleIds: number[] | null = null;

  if (hasRoleIds) {
    // Multi-role path (preferred): roleIds: number[]
    const rawRoleIds = body.roleIds;
    if (!Array.isArray(rawRoleIds)) {
      res.status(400).json({ error: "roleIds must be an array of integers" });
      return;
    }
    const ids: number[] = [];
    for (const item of rawRoleIds) {
      const n = typeof item === "number" ? item : parseInt(String(item), 10);
      if (Number.isNaN(n)) {
        res.status(400).json({ error: "roleIds must contain only integers" });
        return;
      }
      ids.push(n);
    }
    if (ids.length > 0) {
      const roleCheck = await db.query<{ id: number }>(
        `SELECT id FROM workspace_roles WHERE id = ANY($1::int[]) AND workspace_owner_id = $2`,
        [ids, wreq.workspaceOwnerId],
      );
      if ((roleCheck.rowCount ?? 0) !== ids.length) {
        res.status(400).json({ error: "One or more role IDs are not valid for this workspace" });
        return;
      }
    }
    resolvedRoleIds = ids;
    params.push(ids[0] ?? null);
    setClauses.push(`custom_role_id = $${params.length}`);
  } else if (hasRoleId) {
    // Single-role backward-compat path: roleId: number | null
    const rawRoleId = body.roleId;
    if (rawRoleId === null) {
      resolvedRoleIds = [];
      params.push(null);
    } else {
      const roleId = parseInt(String(rawRoleId), 10);
      if (Number.isNaN(roleId)) {
        res.status(400).json({ error: "Invalid roleId" });
        return;
      }
      const roleCheck = await db.query(
        `SELECT id FROM workspace_roles WHERE id = $1 AND workspace_owner_id = $2`,
        [roleId, wreq.workspaceOwnerId],
      );
      if (roleCheck.rowCount === 0) {
        res.status(400).json({ error: "Role not found in this workspace" });
        return;
      }
      resolvedRoleIds = [roleId];
      params.push(roleId);
    }
    setClauses.push(`custom_role_id = $${params.length}`);
  }

  if (hasManagerMemberId) {
    const rawManagerId = body.managerMemberId;
    let resolvedManagerId: number | null = null;

    if (rawManagerId !== null) {
      const managerId = parseInt(String(rawManagerId), 10);
      if (Number.isNaN(managerId)) {
        res.status(400).json({ error: "Invalid managerMemberId" });
        return;
      }

      // Manager must be in the same workspace and must not be the member themselves
      if (managerId === id) {
        res.status(400).json({ error: "A member cannot be their own manager" });
        return;
      }

      const managerCheck = await db.query(
        `SELECT id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
        [managerId, wreq.workspaceOwnerId],
      );
      if (managerCheck.rowCount === 0) {
        res.status(400).json({ error: "Manager not found in this workspace" });
        return;
      }
      resolvedManagerId = managerId;
    }

    params.push(resolvedManagerId);
    setClauses.push(`manager_member_id = $${params.length}`);
  }

  if (hasJobTitle) {
    const raw = body.jobTitle;
    if (raw !== null && typeof raw !== "string") {
      res.status(400).json({ error: "jobTitle must be a string or null" });
      return;
    }
    const value = raw === null ? null : (raw as string).trim() || null;
    params.push(value);
    setClauses.push(`job_title = $${params.length}`);
  }

  if (hasStartDate) {
    const raw = body.startDate;
    if (raw !== null && typeof raw !== "string") {
      res.status(400).json({ error: "startDate must be an ISO date string (YYYY-MM-DD) or null" });
      return;
    }
    let value: string | null = null;
    if (raw !== null) {
      const trimmed = (raw as string).trim();
      if (trimmed === "") {
        value = null;
      } else if (!isValidIsoDate(trimmed)) {
        res.status(400).json({ error: "startDate must be a valid ISO date (YYYY-MM-DD)" });
        return;
      } else {
        value = trimmed;
      }
    }
    params.push(value);
    setClauses.push(`start_date = $${params.length}`);
  }

  if (hasDepartment) {
    const raw = body.department;
    if (raw !== null && typeof raw !== "string") {
      res.status(400).json({ error: "department must be a string or null" });
      return;
    }
    const value = raw === null ? null : (raw as string).trim() || null;
    params.push(value);
    setClauses.push(`department = $${params.length}`);
  }

  if (hasLocation) {
    const raw = body.location;
    if (raw !== null && typeof raw !== "string") {
      res.status(400).json({ error: "location must be a string or null" });
      return;
    }
    const value = raw === null ? null : (raw as string).trim() || null;
    params.push(value);
    setClauses.push(`location = $${params.length}`);
  }

  if (hasEmploymentType) {
    const raw = body.employmentType;
    let value: EmploymentType | null = null;
    if (raw !== null) {
      if (typeof raw !== "string" || !(EMPLOYMENT_TYPES as readonly string[]).includes(raw)) {
        res
          .status(400)
          .json({ error: `employmentType must be one of: ${EMPLOYMENT_TYPES.join(", ")}` });
        return;
      }
      value = raw as EmploymentType;
    }
    params.push(value);
    setClauses.push(`employment_type = $${params.length}`);
  }

  if (hasEmploymentStatus) {
    const raw = body.employmentStatus;
    if (raw === null) {
      res.status(400).json({ error: "employmentStatus cannot be null" });
      return;
    }
    if (typeof raw !== "string" || !(EMPLOYMENT_STATUSES as readonly string[]).includes(raw)) {
      res
        .status(400)
        .json({ error: `employmentStatus must be one of: ${EMPLOYMENT_STATUSES.join(", ")}` });
      return;
    }
    const value = raw as EmploymentStatus;
    params.push(value);
    setClauses.push(`employment_status = $${params.length}`);
  }

  if (hasWorkingDays) {
    const raw = body.workingDays;
    if (raw === null) {
      params.push(null);
      setClauses.push(`working_days = $${params.length}`);
    } else {
      const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
      if (typeof raw !== "object" || Array.isArray(raw) || !DAYS.every((d) => typeof (raw as Record<string, unknown>)[d] === "boolean")) {
        res.status(400).json({ error: "workingDays must be an object with boolean values for each day of the week" });
        return;
      }
      const wd = raw as Record<string, boolean>;
      const hasAtLeastOneDay = DAYS.some((d) => wd[d]);
      if (!hasAtLeastOneDay) {
        res.status(400).json({ error: "At least one working day must be selected" });
        return;
      }
      params.push(JSON.stringify(wd));
      setClauses.push(`working_days = $${params.length}`);
    }
  }

  if (hasFloristLocationId) {
    const raw = body.floristLocationId;
    let resolvedLocationId: number | null = null;

    if (raw !== null) {
      const locationId = parseInt(String(raw), 10);
      if (Number.isNaN(locationId)) {
        res.status(400).json({ error: "Invalid floristLocationId" });
        return;
      }
      const locationCheck = await db.query(
        `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
        [locationId, wreq.workspaceOwnerId],
      );
      if (locationCheck.rowCount === 0) {
        res.status(400).json({ error: "Location not found in this workspace" });
        return;
      }
      resolvedLocationId = locationId;
    }

    params.push(resolvedLocationId);
    setClauses.push(`florist_location_id = $${params.length}`);
  }

  // Capture existing role/custom_role_id for audit log (only when role is changing)
  let oldCustomRoleId: number | null = null;
  if (resolvedRoleIds !== null) {
    const existing = await db.query<{ custom_role_id: number | null }>(
      `SELECT custom_role_id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2 AND role <> 'owner'`,
      [id, wreq.workspaceOwnerId],
    );
    if (existing.rowCount === 0) {
      res.status(404).json({ error: "Member not found or cannot change owner role" });
      return;
    }
    oldCustomRoleId = (existing.rows[0] as { custom_role_id: number | null }).custom_role_id;
  }

  // Role/manager mutations exclude the owner row, but employment-info-only
  // edits are allowed for any member (including the owner).
  const onlyEmploymentInfo = !hasRoleId && !hasManagerMemberId;

  // Add WHERE clause params
  params.push(id);
  const idParam = `$${params.length}`;
  params.push(wreq.workspaceOwnerId);
  const ownerParam = `$${params.length}`;

  // Schema sentinel: PATCH /users/:id UPDATE returns the following workspace_members
  // columns. Update here if any are renamed:
  //   - member_email (→ email), member_user_id (IS NOT NULL → joined),
  //     joined_at (→ invited_at alias overlap), invited_by_email, manager_member_id
  const result = await db.query(
    `UPDATE workspace_members
        SET ${setClauses.join(", ")}
      WHERE id = ${idParam}
        AND workspace_owner_id = ${ownerParam}
        ${onlyEmploymentInfo ? "" : "AND role <> 'owner'"}
      RETURNING id, member_email AS email, role, custom_role_id,
                member_user_id IS NOT NULL AS joined,
                joined_at, created_at AS invited_at, invited_by_email,
                manager_member_id, job_title,
                to_char(start_date, 'YYYY-MM-DD') AS start_date,
                department, location, employment_type, employment_status,
                florist_location_id`,
    params,
  );
  if (result.rowCount === 0) {
    res.status(404).json({
      error: onlyEmploymentInfo
        ? "Member not found"
        : "Member not found or cannot change owner role",
    });
    return;
  }

  const updatedMember = result.rows[0] as {
    custom_role_id: number | null;
    manager_member_id: number | null;
    manager_email?: string | null;
  };

  // Update junction table when roles are changing
  if (resolvedRoleIds !== null) {
    await db.query(`DELETE FROM workspace_member_roles WHERE member_id = $1`, [id]);
    if (resolvedRoleIds.length > 0) {
      const valuePlaceholders = resolvedRoleIds.map((_, i) => `($1, $${i + 2})`).join(", ");
      await db.query(
        `INSERT INTO workspace_member_roles (member_id, role_id) VALUES ${valuePlaceholders} ON CONFLICT DO NOTHING`,
        [id, ...resolvedRoleIds],
      );
    }
  }

  // Record audit log entry when custom role changed
  if (resolvedRoleIds !== null && oldCustomRoleId !== updatedMember.custom_role_id) {
    try {
      await db.query(
        `INSERT INTO role_change_audit_log
           (workspace_owner_id, changed_by_user_id, target_member_id,
            old_role, new_role, old_custom_role_id, new_custom_role_id)
         VALUES ($1, $2, $3, 'member', 'member', $4, $5)`,
        [wreq.workspaceOwnerId, wreq.userId, id, oldCustomRoleId, updatedMember.custom_role_id],
      );
    } catch (auditErr) {
      req.log.error({ err: auditErr, memberId: id }, "role_change_audit_log INSERT failed; member update itself succeeded");
    }
  }

  // Schema sentinel: reads workspace_members.member_email for the manager lookup.
  // Update here if member_email is renamed.
  if (updatedMember.manager_member_id) {
    const mgrRow = await db.query<{ member_email: string }>(
      `SELECT member_email FROM workspace_members WHERE id = $1`,
      [updatedMember.manager_member_id],
    );
    updatedMember.manager_email = mgrRow.rows[0]?.member_email ?? null;
  } else {
    updatedMember.manager_email = null;
  }

  res.json({ member: updatedMember });
});

/**
 * POST /users/:id/set-mobile-password
 * Set or change the mobile app password for an already-joined member.
 * Owner-only — this is an administrative action to enable mobile app login.
 * Body: { password: string (min 8 chars) }
 */
router.post("/users/:id/set-mobile-password", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can set mobile app passwords" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const rawPassword = req.body?.password;
  if (typeof rawPassword !== "string" || rawPassword.trim().length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  const password = rawPassword.trim();

  const memberRow = await db.query<{ member_user_id: string | null }>(
    `SELECT member_user_id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (memberRow.rowCount === 0) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  const clerkUserId = memberRow.rows[0].member_user_id;
  if (!clerkUserId) {
    res.status(400).json({
      error: "Member has not joined yet — they must accept the invite before you can set a mobile password",
    });
    return;
  }

  try {
    await clerkClient.users.updateUser(clerkUserId, { password });
    res.json({ ok: true });
  } catch (err: unknown) {
    req.log.error({ err, memberId: id }, "Failed to set mobile password via Clerk");
    const clerkMsg =
      err != null &&
      typeof err === "object" &&
      "errors" in err &&
      Array.isArray((err as { errors: { message: string }[] }).errors)
        ? (err as { errors: { message: string }[] }).errors.map((e) => e.message).join("; ")
        : null;
    res.status(500).json({ error: clerkMsg ?? "Failed to set password — please try again" });
  }
});

/**
 * POST /users/:id/resend-invite
 * Generate a fresh invite token, reset invite_expires_at, and resend the invite email.
 * Requires users.resend-invite permission (or owner).
 */
router.post("/users/:id/resend-invite", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    if (!wreq.allowedPages?.includes("users.resend-invite")) {
      res.status(403).json({ error: "You do not have permission to resend invitations" });
      return;
    }
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const newToken = randomUUID();
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Schema sentinel: resend-invite UPDATE touches the following workspace_members columns.
  // Update here if any are renamed:
  //   - invite_token, invite_expires_at (SET), member_user_id (WHERE IS NULL check),
  //     member_email (→ email), member_user_id (IS NOT NULL → joined),
  //     invited_by_email, manager_member_id (RETURNING)
  const result = await db.query(
    `UPDATE workspace_members
        SET invite_token = $1, invite_expires_at = $2
      WHERE id = $3
        AND workspace_owner_id = $4
        AND member_user_id IS NULL
        AND role <> 'owner'
      RETURNING id, member_email AS email, role, custom_role_id,
                member_user_id IS NOT NULL AS joined,
                joined_at, created_at AS invited_at, invited_by_email,
                manager_member_id`,
    [newToken, newExpiry, id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Pending member not found" });
    return;
  }

  const member = result.rows[0] as {
    email: string;
    invited_by_email: string | null;
    custom_role_id: number | null;
  };

  // Look up the role names from junction table (comma-joined for the email)
  let roleName = "Member";
  {
    const roleRow = await db.query<{ name: string }>(
      `SELECT wr.name
         FROM workspace_member_roles wmr
         JOIN workspace_roles wr ON wr.id = wmr.role_id
        WHERE wmr.member_id = $1
        ORDER BY wr.name`,
      [(result.rows[0] as { id: number }).id],
    );
    if (roleRow.rows.length > 0) roleName = roleRow.rows.map((r) => r.name).join(", ");
  }

  sendInviteEmail({
    toEmail: member.email,
    invitedByEmail: member.invited_by_email ?? wreq.userEmail,
    role: roleName,
    isAccessApproval: false,
    inviteToken: newToken,
  }).catch(() => {});

  res.json({ member: result.rows[0] });
});

/**
 * DELETE /users/:id
 * Remove a member or pending invite. Requires users.remove (active) or users.revoke-invite
 * (pending) sub-permission, or owner. Cannot remove the owner.
 */
router.delete("/users/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  if (wreq.workspaceRole !== "owner") {
    // Schema sentinel: reads workspace_members.member_user_id (IS NOT NULL → joined).
    // Update here if member_user_id is renamed.
    const peek = await db.query<{ joined: boolean }>(
      `SELECT (member_user_id IS NOT NULL) AS joined
         FROM workspace_members
        WHERE id = $1 AND workspace_owner_id = $2 AND role <> 'owner'`,
      [id, wreq.workspaceOwnerId],
    );
    if (peek.rowCount === 0) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    const isPending = !peek.rows[0].joined;
    const requiredKey = isPending ? "users.revoke-invite" : "users.remove";
    if (!wreq.allowedPages?.includes(requiredKey)) {
      const msg = isPending
        ? "You do not have permission to revoke invitations"
        : "You do not have permission to remove members";
      res.status(403).json({ error: msg });
      return;
    }
  }

  // Schema sentinel: DELETE RETURNING workspace_members.member_user_id.
  // Update here if member_user_id is renamed.
  const result = await db.query<{ member_user_id: string | null }>(
    `DELETE FROM workspace_members
      WHERE id = $1
        AND workspace_owner_id = $2
        AND role <> 'owner'
      RETURNING member_user_id`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const memberUserId = result.rows[0]?.member_user_id ?? null;
  if (memberUserId) {
    try {
      const sessions = await clerkClient.sessions.getSessionList({ userId: memberUserId });
      await Promise.all(
        sessions.data.map((s) => clerkClient.sessions.revokeSession(s.id)),
      );
    } catch (err: unknown) {
      req.log.error({ err, memberUserId }, "Failed to revoke Clerk sessions before member deletion");
    }

    try {
      await clerkClient.users.deleteUser(memberUserId);
    } catch (err: unknown) {
      const status =
        err != null &&
        typeof err === "object" &&
        "status" in err &&
        typeof (err as { status: unknown }).status === "number"
          ? (err as { status: number }).status
          : null;
      if (status !== 404) {
        req.log.error({ err, memberUserId }, "Failed to delete Clerk user after member removal");
      }
    }
  }

  res.json({ ok: true });
});

/**
 * GET /users/:id/locations
 * List location assignments for a member. Owner-only.
 */
router.get("/users/:id/locations", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can view location assignments" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const memberCheck = await db.query(
    `SELECT id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (memberCheck.rowCount === 0) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const result = await db.query<{ id: number; name: string; country: string; location_type: string }>(
    `SELECT l.id, l.name, l.country, l.location_type
       FROM member_locations ml
       JOIN locations l ON l.id = ml.location_id
      WHERE ml.member_id = $1
      ORDER BY l.name ASC`,
    [id],
  );
  res.json({ locations: result.rows });
});

/**
 * PUT /users/:id/locations
 * Replace a member's location assignments. Owner-only.
 * Body: { locationIds: number[] }
 */
router.put("/users/:id/locations", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can change location assignments" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const memberCheck = await db.query<{ id: number; role: string }>(
    `SELECT id, role FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (memberCheck.rowCount === 0) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  if (memberCheck.rows[0].role === "owner") {
    res.status(400).json({ error: "Location assignments cannot be set for owners — owners always see all data" });
    return;
  }

  const rawIds = req.body?.locationIds;
  if (!Array.isArray(rawIds)) {
    res.status(400).json({ error: "locationIds must be an array" });
    return;
  }

  const rawLocationIds: number[] = [];
  for (const raw of rawIds) {
    const lid = parseInt(String(raw), 10);
    if (Number.isNaN(lid)) {
      res.status(400).json({ error: "Each locationId must be a number" });
      return;
    }
    rawLocationIds.push(lid);
  }
  // De-duplicate to prevent validation false-positives from repeated IDs
  const locationIds = [...new Set(rawLocationIds)];

  // Validate all provided location IDs belong to this workspace
  if (locationIds.length > 0) {
    const locCheck = await db.query<{ id: number }>(
      `SELECT id FROM locations WHERE id = ANY($1::int[]) AND workspace_owner_id = $2`,
      [locationIds, wreq.workspaceOwnerId],
    );
    if ((locCheck.rowCount ?? 0) !== locationIds.length) {
      res.status(400).json({ error: "One or more location IDs not found in this workspace" });
      return;
    }
  }

  // Replace all assignments atomically.
  // withTransaction retries automatically on serialization failures (40001/40P01).
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      await client.query(`DELETE FROM member_locations WHERE member_id = $1`, [id]);
      if (locationIds.length > 0) {
        const values = locationIds.map((_, i) => `($1, $${i + 2})`).join(", ");
        await client.query(
          `INSERT INTO member_locations (member_id, location_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [id, ...locationIds],
        );
      }
    });
  } finally {
    client.release();
  }

  res.json({ ok: true, locationIds });
});

/**
 * GET /users/failed-access-requests
 * Returns undismissed failed access request entries. Owner-only.
 */
router.get("/users/failed-access-requests", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can view failed access requests" });
    return;
  }
  const result = await db.query(
    `SELECT id, requester_email, requester_name, error_message, created_at
       FROM failed_access_requests
      WHERE workspace_owner_id = $1
        AND dismissed_at IS NULL
      ORDER BY created_at DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ failedRequests: result.rows });
});

/**
 * DELETE /users/failed-access-requests/:id
 * Dismiss (soft-delete) a failed access request entry. Owner-only.
 */
router.delete("/users/failed-access-requests/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can dismiss failed access requests" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db.query(
    `UPDATE failed_access_requests
        SET dismissed_at = now()
      WHERE id = $1
        AND workspace_owner_id = $2
        AND dismissed_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

/**
 * POST /users/:id/promote-to-owner
 * Make another member an additional workspace owner.
 * The current owner keeps their owner role — multiple owners are allowed.
 * (workspace_owner_id, the workspace identity/billing key, is unchanged.)
 * Requires owner role OR the users.make-owner sub-permission.
 * The target member must have already joined (not a pending invite).
 */
router.post("/users/:id/promote-to-owner", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    if (!wreq.allowedPages?.includes("users.make-owner")) {
      res.status(403).json({ error: "You do not have permission to transfer ownership" });
      return;
    }
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  // Schema sentinel: promote-to-owner reads workspace_members.member_user_id to verify
  // the target has joined. Update here if member_user_id is renamed.
  // Verify target member exists, has joined, and is not already the owner
  const targetCheck = await db.query<{
    id: number;
    member_user_id: string | null;
    role: string;
  }>(
    `SELECT id, member_user_id, role
       FROM workspace_members
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (targetCheck.rowCount === 0) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const target = targetCheck.rows[0];

  if (target.role === "owner") {
    res.status(400).json({ error: "Member is already the owner" });
    return;
  }

  if (!target.member_user_id) {
    res.status(400).json({ error: "Cannot promote a pending (not-yet-joined) member to owner" });
    return;
  }

  // Record audit log for the promotion
  await db.query(
    `INSERT INTO role_change_audit_log
       (workspace_owner_id, changed_by_user_id, target_member_id,
        old_role, new_role, old_custom_role_id, new_custom_role_id)
     VALUES ($1, $2, $3, 'member', 'owner', NULL, NULL)`,
    [wreq.workspaceOwnerId, wreq.userId, id],
  );

  // Promote the target member to owner role
  await db.query(
    `UPDATE workspace_members
        SET role = 'owner', custom_role_id = NULL
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  res.json({ ok: true, promoted_member_id: id });
});

/**
 * GET /users/role-audit-log
 * List role change audit log entries for this workspace. Owner-only.
 */
router.get("/users/role-audit-log", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can view the audit log" });
    return;
  }

  const raw = parseInt((req.query.limit as string) ?? "50", 10);
  const limit = Math.max(1, Math.min(Number.isFinite(raw) && raw > 0 ? raw : 50, 200));

  // Schema sentinel: role-audit-log query JOINs workspace_members and reads
  // wm.member_email (→ target_email). Update here if member_email is renamed.
  const result = await db.query(
    `SELECT rcal.id, rcal.changed_by_user_id, rcal.target_member_id,
            rcal.old_role, rcal.new_role, rcal.old_custom_role_id, rcal.new_custom_role_id,
            rcal.changed_at,
            wm.member_email AS target_email,
            old_wr.name AS old_role_name,
            new_wr.name AS new_role_name
       FROM role_change_audit_log rcal
       LEFT JOIN workspace_members wm
         ON wm.id = rcal.target_member_id
       LEFT JOIN workspace_roles old_wr
         ON old_wr.id = rcal.old_custom_role_id
       LEFT JOIN workspace_roles new_wr
         ON new_wr.id = rcal.new_custom_role_id
      WHERE rcal.workspace_owner_id = $1
      ORDER BY rcal.changed_at DESC
      LIMIT $2`,
    [wreq.workspaceOwnerId, limit],
  );

  res.json({ entries: result.rows });
});

/**
 * GET /users/:memberId/profile
 * Return the full profile data for any workspace member.
 * Requires owner role or the "users" page permission.
 */
router.get("/users/:memberId/profile", async (req, res) => {
  const wreq = workspace(req);
  const isOwner = wreq.workspaceRole === "owner";
  if (!isOwner && !wreq.allowedPages?.includes("users")) {
    res.status(403).json({ error: "You do not have permission to view member profiles" });
    return;
  }

  const memberId = parseInt(req.params.memberId, 10);
  if (!Number.isFinite(memberId)) {
    res.status(400).json({ error: "Invalid member id" });
    return;
  }

  // Schema sentinel: GET /users/:memberId/profile JOINs workspace_members twice.
  // Reads the following drift-prone columns. Update here if any are renamed:
  //   - wm.member_user_id, wm.member_email, wm.manager_member_id (→ JOIN key),
  //     mgr.member_email (→ manager_name), wm.joined_at (WHERE IS NOT NULL)
  const result = await db.query<{
    member_id: number;
    member_user_id: string | null;
    phone: string | null;
    job_title: string | null;
    birthday: string | null;
    gender: string | null;
    notify_email_on_time_off_request: boolean;
    notify_email_on_time_off_decision: boolean;
    working_days: unknown;
    department: string | null;
    location: string | null;
    employment_type: string | null;
    employment_status: string | null;
    start_date: string | null;
    manager_member_id: number | null;
    manager_name: string | null;
    role: string;
    custom_role_id: number | null;
    custom_role_name: string | null;
    member_email: string;
    allowed_pages: string[] | null;
  }>(
    `SELECT wm.id AS member_id, wm.member_user_id, wm.phone, wm.job_title, wm.birthday, wm.gender,
            wm.notify_email_on_time_off_request,
            wm.notify_email_on_time_off_decision,
            wm.working_days, wm.department, wm.location,
            wm.employment_type, wm.employment_status, wm.start_date,
            wm.manager_member_id, wm.role, wm.custom_role_id,
            wm.member_email,
            mgr.member_email AS manager_name,
            wr.name AS custom_role_name,
            (SELECT array_agg(DISTINCT page)
               FROM workspace_member_roles wmr_ap
               JOIN workspace_roles wr_ap ON wr_ap.id = wmr_ap.role_id,
               LATERAL jsonb_array_elements_text(wr_ap.allowed_pages) AS page
              WHERE wmr_ap.member_id = wm.id) AS allowed_pages
       FROM workspace_members wm
       LEFT JOIN workspace_members mgr ON mgr.id = wm.manager_member_id
       LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
      WHERE wm.id = $1
        AND wm.workspace_owner_id = $2
        AND wm.joined_at IS NOT NULL
      LIMIT 1`,
    [memberId, wreq.workspaceOwnerId],
  );

  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const locResult = await db.query<{ id: number; name: string }>(
    `SELECT l.id, l.name
       FROM member_locations ml
       JOIN locations l ON l.id = ml.location_id
      WHERE ml.member_id = $1
      ORDER BY l.name`,
    [row.member_id],
  );

  let first_name: string | null = null;
  let last_name: string | null = null;
  let image_url: string | null = null;

  if (row.member_user_id) {
    try {
      const clerkUsers = await clerkClient.users.getUserList({
        userId: [row.member_user_id],
        limit: 1,
      });
      const clerkUser = clerkUsers.data[0];
      if (clerkUser) {
        first_name = clerkUser.firstName ?? null;
        last_name = clerkUser.lastName ?? null;
        if (clerkUser.hasImage && clerkUser.imageUrl) {
          image_url = clerkUser.imageUrl;
        }
      }
    } catch {
      // Non-fatal — fall back to initials
    }
  }

  const bday = row.birthday;
  const sdate = row.start_date;

  // Fetch multi-role data from junction table
  const roleJunctionResult = await db.query<{ role_id: number; role_name: string }>(
    `SELECT wmr.role_id, wr.name AS role_name
       FROM workspace_member_roles wmr
       JOIN workspace_roles wr ON wr.id = wmr.role_id
      WHERE wmr.member_id = $1
      ORDER BY wr.name`,
    [row.member_id],
  );
  const custom_role_ids = roleJunctionResult.rows.map((r) => r.role_id);
  const custom_role_names = roleJunctionResult.rows.map((r) => r.role_name);

  res.json({
    phone: row.phone ?? null,
    job_title: row.job_title ?? null,
    birthday: bday ? String(bday).slice(0, 10) : null,
    gender: row.gender ?? null,
    notify_email_on_time_off_request: row.notify_email_on_time_off_request ?? true,
    notify_email_on_time_off_decision: row.notify_email_on_time_off_decision ?? true,
    working_days: row.working_days ?? { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    department: row.department ?? null,
    location: row.location ?? null,
    employment_type: row.employment_type ?? null,
    employment_status: row.employment_status ?? "active",
    start_date: sdate ? String(sdate).slice(0, 10) : null,
    manager_member_id: row.manager_member_id ?? null,
    manager_name: row.manager_name ?? null,
    role: row.role,
    custom_role_id: row.custom_role_id ?? null,
    custom_role_name: row.custom_role_name ?? null,
    custom_role_ids,
    custom_role_names,
    member_email: row.member_email,
    assigned_locations: locResult.rows,
    first_name,
    last_name,
    image_url,
    allowed_pages: row.role === "owner" ? null : (row.allowed_pages ?? []),
    pref_add_person_last_type: null,
  });
});

/**
 * GET /users/me/preferences
 * Returns the current user's UI preferences blob.
 * Any authenticated workspace member can call this.
 */
router.get("/users/me/preferences", async (req, res) => {
  const wreq = workspace(req);
  const memberDbId = wreq.memberDbId;
  if (!memberDbId) {
    res.status(404).json({ error: "Member record not found" });
    return;
  }
  const result = await db.query<{ ui_preferences: Record<string, unknown> }>(
    `SELECT COALESCE(ui_preferences, '{}') AS ui_preferences
       FROM workspace_members
      WHERE id = $1`,
    [memberDbId],
  );
  const prefs = result.rows[0]?.ui_preferences ?? {};
  res.json({ ui_preferences: prefs });
});

/**
 * PATCH /users/me/preferences
 * Merges the provided key/value pairs into the current user's UI preferences.
 * Body: partial UI preferences object (e.g. { show_spend_column: true })
 * Any authenticated workspace member can call this for their own record.
 */
router.patch("/users/me/preferences", async (req, res) => {
  const wreq = workspace(req);
  const memberDbId = wreq.memberDbId;
  if (!memberDbId) {
    res.status(404).json({ error: "Member record not found" });
    return;
  }

  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.status(400).json({ error: "Body must be a JSON object" });
    return;
  }

  const BOOLEAN_KEYS = ["show_spend_column"] as const;
  const STRING_KEYS: Record<string, readonly string[]> = {
    products_gallery_density: ["compact", "comfortable"],
    products_view_mode: ["list", "gallery"],
    brands_view_mode: ["list", "gallery"],
  };
  const patch: Record<string, unknown> = {};
  for (const key of BOOLEAN_KEYS) {
    if (key in body) {
      const val = (body as Record<string, unknown>)[key];
      if (typeof val !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean` });
        return;
      }
      patch[key] = val;
    }
  }
  for (const [key, allowed] of Object.entries(STRING_KEYS)) {
    if (key in body) {
      const val = (body as Record<string, unknown>)[key];
      if (typeof val !== "string" || !allowed.includes(val)) {
        res.status(400).json({ error: `${key} must be one of: ${allowed.join(", ")}` });
        return;
      }
      patch[key] = val;
    }
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No recognised preference keys provided" });
    return;
  }

  const result = await db.query<{ ui_preferences: Record<string, unknown> }>(
    `UPDATE workspace_members
        SET ui_preferences = COALESCE(ui_preferences, '{}') || $1::jsonb
      WHERE id = $2
      RETURNING COALESCE(ui_preferences, '{}') AS ui_preferences`,
    [JSON.stringify(patch), memberDbId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Member record not found" });
    return;
  }

  res.json({ ui_preferences: result.rows[0].ui_preferences });
});

export default router;
