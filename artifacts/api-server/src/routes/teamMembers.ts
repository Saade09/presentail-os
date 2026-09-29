import { Router, type NextFunction, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function requirePeopleDirectoryAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (hasPageAccess(workspace(req), "people.directory")) {
    next();
    return;
  }
  res.status(403).json({ error: "You do not have access to the people directory" });
}

/**
 * GET /departments
 * List departments for the workspace.
 */
router.get("/departments", async (req, res) => {
  const wreq = workspace(req);
  try {
    const result = await db.query(
      `SELECT * FROM departments
       WHERE workspace_owner_id = $1
       ORDER BY name ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, departments: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list departments");
    res.status(500).json({ error: "Failed to list departments" });
  }
});

/**
 * POST /departments
 * Create a new department.
 */
router.post("/departments", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage departments" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : null;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const description = typeof body.description === "string" ? body.description.trim() || null : null;
  try {
    const result = await db.query(
      `INSERT INTO departments (workspace_owner_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [wreq.workspaceOwnerId, name, description],
    );
    res.status(201).json({ success: true, department: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create department");
    res.status(500).json({ error: "Failed to create department" });
  }
});

/**
 * PATCH /departments/:id
 * Update a department.
 */
router.patch("/departments/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage departments" });
    return;
  }
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (typeof body.name === "string") { fields.push(`name = $${i++}`); params.push(body.name.trim()); }
  if (body.description !== undefined) { fields.push(`description = $${i++}`); params.push(body.description || null); }
  if (typeof body.status === "string") { fields.push(`status = $${i++}`); params.push(body.status); }
  if (fields.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  fields.push(`updated_at = NOW()`);
  params.push(id, wreq.workspaceOwnerId);
  try {
    const result = await db.query(
      `UPDATE departments SET ${fields.join(", ")}
       WHERE id = $${i} AND workspace_owner_id = $${i + 1}
       RETURNING *`,
      params,
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    res.json({ success: true, department: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to update department");
    res.status(500).json({ error: "Failed to update department" });
  }
});

/**
 * DELETE /departments/:id
 * Delete a department.
 */
router.delete("/departments/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage departments" });
    return;
  }
  const id = Number(req.params.id);
  try {
    const result = await db.query(
      `DELETE FROM departments WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete department");
    res.status(500).json({ error: "Failed to delete department" });
  }
});

/**
 * GET /team-members
 * List team members for the workspace.
 */
router.get("/team-members", requirePeopleDirectoryAccess, async (req, res) => {
  const wreq = workspace(req);
  const params: unknown[] = [wreq.workspaceOwnerId];
  let whereClause = "WHERE tm.workspace_owner_id = $1 AND tm.archived_at IS NULL";
  let i = 2;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
  if (q) {
    whereClause += ` AND (tm.first_name ILIKE $${i} OR tm.last_name ILIKE $${i} OR tm.email ILIKE $${i} OR tmp.job_title ILIKE $${i})`;
    params.push(`%${q}%`);
    i++;
  }
  const departmentId = req.query.department_id;
  if (departmentId) {
    whereClause += ` AND tm.department_id = $${i}`;
    params.push(Number(departmentId));
    i++;
  }
  if (req.query.include_archived === "true") {
    whereClause = whereClause.replace(" AND tm.archived_at IS NULL", "");
  }
  try {
    const result = await db.query<{ id: number; email: string | null; [key: string]: unknown }>(
      `SELECT tm.*,
              d.name AS department_name,
              tmp.job_title
         FROM team_members tm
         LEFT JOIN departments d ON d.id = tm.department_id
         LEFT JOIN team_member_profiles tmp ON tmp.team_member_id = tm.id
       ${whereClause}
       ORDER BY tm.first_name ASC, tm.last_name ASC`,
      params,
    );

    const rows: Array<{ id: number; email: string | null; image_url: string | null; [key: string]: unknown }> =
      result.rows.map((r) => ({ ...r, image_url: null }));

    // Enrich with Clerk profile photos via workspace_members email match.
    const emails = rows.map((r) => r.email).filter((e): e is string => !!e);
    if (emails.length > 0) {
      try {
        const wmResult = await db.query<{ member_email: string; member_user_id: string }>(
          `SELECT member_email, member_user_id
             FROM workspace_members
            WHERE workspace_owner_id = $1
              AND member_user_id IS NOT NULL
              AND member_email = ANY($2)`,
          [wreq.workspaceOwnerId, emails],
        );
        const emailToUserId = new Map(wmResult.rows.map((r) => [r.member_email, r.member_user_id]));
        const userIds = [...new Set(emailToUserId.values())];
        if (userIds.length > 0) {
          const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 200 });
          const userIdToImageUrl = new Map(
            clerkUsers.data
              .filter((u) => u.hasImage && u.imageUrl)
              .map((u) => [u.id, u.imageUrl]),
          );
          for (const row of rows) {
            if (!row.email) continue;
            const uid = emailToUserId.get(row.email);
            if (uid) row.image_url = userIdToImageUrl.get(uid) ?? null;
          }
        }
      } catch (clerkErr) {
        logger.warn({ err: clerkErr }, "team-members: failed to fetch Clerk profile photos");
      }
    }

    res.json({ success: true, team_members: rows });
  } catch (err) {
    logger.error({ err }, "Failed to list team members");
    res.status(500).json({ error: "Failed to list team members" });
  }
});

/**
 * GET /team-members/:id
 * Get a single team member, enriched with Clerk profile photo.
 */
router.get("/team-members/:id", requirePeopleDirectoryAccess, async (req, res) => {
  const wreq = workspace(req);
  const id = Number(req.params.id);
  try {
    const result = await db.query<{ id: number; email: string | null; [key: string]: unknown }>(
      `SELECT tm.*,
              d.name AS department_name,
              tmp.job_title
         FROM team_members tm
         LEFT JOIN departments d ON d.id = tm.department_id
         LEFT JOIN team_member_profiles tmp ON tmp.team_member_id = tm.id
        WHERE tm.id = $1 AND tm.workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }

    const row: { id: number; email: string | null; image_url: string | null; [key: string]: unknown } = {
      ...result.rows[0],
      image_url: null,
    };

    // Enrich with Clerk profile photo via workspace_members email match.
    if (row.email) {
      try {
        const wmResult = await db.query<{ member_email: string; member_user_id: string }>(
          `SELECT member_email, member_user_id
             FROM workspace_members
            WHERE workspace_owner_id = $1
              AND member_user_id IS NOT NULL
              AND member_email = $2
            LIMIT 1`,
          [wreq.workspaceOwnerId, row.email],
        );
        if (wmResult.rows.length > 0) {
          const userId = wmResult.rows[0].member_user_id;
          const clerkUsers = await clerkClient.users.getUserList({ userId: [userId], limit: 1 });
          const clerkUser = clerkUsers.data[0];
          if (clerkUser?.hasImage && clerkUser.imageUrl) {
            row.image_url = clerkUser.imageUrl;
          }
        }
      } catch (clerkErr) {
        logger.warn({ err: clerkErr }, "team-members/:id: failed to fetch Clerk profile photo");
      }
    }

    res.json({ success: true, team_member: row });
  } catch (err) {
    logger.error({ err }, "Failed to get team member");
    res.status(500).json({ error: "Failed to get team member" });
  }
});

/**
 * POST /team-members
 * Create a new team member.
 */
router.post("/team-members", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage team members" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const firstName = typeof body.first_name === "string" ? body.first_name.trim() : null;
  if (!firstName) {
    res.status(400).json({ error: "first_name is required" });
    return;
  }
  try {
    const result = await db.query(
      `INSERT INTO team_members
         (workspace_owner_id, first_name, last_name, email, phone,
          department_id, location_id, manager_id, employment_status, start_date,
          birthday, emergency_contact_name, emergency_contact_phone,
          emergency_contact_relationship, notes, work_schedule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        firstName,
        body.last_name || null,
        body.email || null,
        body.phone || null,
        body.department_id ? Number(body.department_id) : null,
        body.location_id ? Number(body.location_id) : null,
        body.manager_id ? Number(body.manager_id) : null,
        body.employment_status || "full_time",
        body.start_date || null,
        body.birthday || null,
        body.emergency_contact_name || null,
        body.emergency_contact_phone || null,
        body.emergency_contact_relationship || null,
        body.notes || null,
        body.work_schedule_id ? Number(body.work_schedule_id) : null,
      ],
    );
    const jobTitle = body.job_title ? String(body.job_title).trim() || null : null;
    const tm = result.rows[0] as {
      id: number;
      workspace_owner_id: string;
      first_name: string;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      department_id: number | null;
      employment_status: string;
      start_date: string | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
    };

    // ── People-directory linkage ──────────────────────────────────────────────
    // Mirror the startup-migration logic so the people/team_member_profiles rows
    // are created immediately, not just on the next server restart.
    try {
      // Find or create the people row, keyed by email+workspace.
      let personId: number | null = null;
      if (tm.email) {
        const existing = await db.query<{ id: number }>(
          `SELECT id FROM people
            WHERE workspace_owner_id = $1 AND LOWER(email) = LOWER($2)
            LIMIT 1`,
          [tm.workspace_owner_id, tm.email],
        );
        if (existing.rows.length > 0) {
          personId = existing.rows[0].id;
        }
      }
      if (personId === null) {
        const inserted = await db.query<{ id: number }>(
          `INSERT INTO people (workspace_owner_id, first_name, last_name, email, phone, status)
           VALUES ($1, $2, $3, $4, $5, 'active')
           RETURNING id`,
          [tm.workspace_owner_id, tm.first_name, tm.last_name, tm.email, tm.phone],
        );
        personId = inserted.rows[0].id;
      }
      // Create the team_member_profiles row linking people ↔ team_member.
      await db.query(
        `INSERT INTO team_member_profiles
           (person_id, workspace_owner_id, team_member_id, job_title, department_id,
            employment_type, start_date, emergency_contact_name, emergency_contact_phone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
        [
          personId,
          tm.workspace_owner_id,
          tm.id,
          jobTitle,
          tm.department_id,
          tm.employment_status,
          tm.start_date,
          tm.emergency_contact_name,
          tm.emergency_contact_phone,
        ],
      );
    } catch (linkErr) {
      logger.error({ linkErr, teamMemberId: tm.id }, "Failed to sync people-directory linkage on create");
    }

    res.status(201).json({ success: true, team_member: tm });
  } catch (err) {
    logger.error({ err }, "Failed to create team member");
    res.status(500).json({ error: "Failed to create team member" });
  }
});

/**
 * PATCH /team-members/:id
 * Update a team member.
 */
router.patch("/team-members/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage team members" });
    return;
  }
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  const allowed = [
    "first_name","last_name","email","phone","department_id",
    "location_id","manager_id","employment_status","start_date","birthday",
    "emergency_contact_name","emergency_contact_phone","emergency_contact_relationship",
    "notes","work_schedule_id",
  ];
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = $${i++}`);
      const v = body[key];
      params.push(v === "" ? null : v);
    }
  }
  let archiving: boolean | null = null;
  if ("archived" in body) {
    if (body.archived) {
      archiving = true;
      fields.push(`archived_at = $${i++}`); params.push(new Date().toISOString());
    } else {
      archiving = false;
      fields.push(`archived_at = NULL`);
    }
  }
  if (fields.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  fields.push("updated_at = NOW()");
  params.push(id, wreq.workspaceOwnerId);
  try {
    const result = await db.query(
      `UPDATE team_members SET ${fields.join(", ")}
       WHERE id = $${i} AND workspace_owner_id = $${i + 1}
       RETURNING *`,
      params,
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    const tm = result.rows[0] as {
      id: number;
      workspace_owner_id: string;
      first_name: string;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      department_id: number | null;
      employment_status: string;
      start_date: string | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
      archived_at: string | null;
    };

    // ── People-directory sync ─────────────────────────────────────────────────
    // Propagate changed fields to the linked people + team_member_profiles rows.
    try {
      // Resolve the linked profile (may not exist for legacy records not yet migrated).
      const profileRes = await db.query<{ id: number; person_id: number }>(
        `SELECT id, person_id FROM team_member_profiles WHERE team_member_id = $1 LIMIT 1`,
        [tm.id],
      );

      if (profileRes.rows.length > 0) {
        const { id: profileId, person_id: personId } = profileRes.rows[0];

        // Sync people row — identity fields.
        const peopleFields: string[] = [];
        const peopleParams: unknown[] = [];
        let pi = 1;
        const identityKeys = ["first_name", "last_name", "email", "phone"] as const;
        for (const key of identityKeys) {
          if (key in body) {
            peopleFields.push(`${key} = $${pi++}`);
            const v = body[key];
            peopleParams.push(v === "" ? null : v);
          }
        }
        if (archiving === true) {
          peopleFields.push(`status = $${pi++}`, `archived_at = $${pi++}`);
          peopleParams.push("archived", new Date().toISOString());
        } else if (archiving === false) {
          peopleFields.push(`status = $${pi++}`, `archived_at = NULL`);
          peopleParams.push("active");
        }
        if (peopleFields.length > 0) {
          peopleFields.push(`updated_at = NOW()`);
          peopleParams.push(personId);
          await db.query(
            `UPDATE people SET ${peopleFields.join(", ")} WHERE id = $${pi}`,
            peopleParams,
          );
        }

        // Sync team_member_profiles row — HR fields.
        const profileFields: string[] = [];
        const profileParams: unknown[] = [];
        let fi = 1;
        const profileKeyMap: Record<string, string> = {
          job_title: "job_title",
          department_id: "department_id",
          employment_status: "employment_type",
          start_date: "start_date",
          emergency_contact_name: "emergency_contact_name",
          emergency_contact_phone: "emergency_contact_phone",
        };
        for (const [bodyKey, colName] of Object.entries(profileKeyMap)) {
          if (bodyKey in body) {
            profileFields.push(`${colName} = $${fi++}`);
            const v = body[bodyKey];
            profileParams.push(v === "" ? null : v);
          }
        }
        if (archiving === true) {
          profileFields.push(`status = $${fi++}`);
          profileParams.push("archived");
        } else if (archiving === false) {
          profileFields.push(`status = $${fi++}`);
          profileParams.push("active");
        }
        if (profileFields.length > 0) {
          profileFields.push(`updated_at = NOW()`);
          profileParams.push(profileId);
          await db.query(
            `UPDATE team_member_profiles SET ${profileFields.join(", ")} WHERE id = $${fi}`,
            profileParams,
          );
        }
      } else {
        logger.warn({ teamMemberId: tm.id }, "No team_member_profiles row found during PATCH sync — skipping people-directory update");
      }
    } catch (linkErr) {
      logger.error({ linkErr, teamMemberId: tm.id }, "Failed to sync people-directory linkage on update");
    }

    res.json({ success: true, team_member: tm });
  } catch (err) {
    logger.error({ err }, "Failed to update team member");
    res.status(500).json({ error: "Failed to update team member" });
  }
});

/**
 * DELETE /team-members/:id
 * Delete (archive) a team member.
 */
router.delete("/team-members/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage team members" });
    return;
  }
  const id = Number(req.params.id);
  try {
    const result = await db.query(
      `UPDATE team_members SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL
       RETURNING id`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }

    // ── People-directory sync ─────────────────────────────────────────────────
    // Mark the linked profile and people row as archived.
    try {
      const profileRes = await db.query<{ id: number; person_id: number }>(
        `SELECT id, person_id FROM team_member_profiles WHERE team_member_id = $1 LIMIT 1`,
        [id],
      );
      if (profileRes.rows.length > 0) {
        const { id: profileId, person_id: personId } = profileRes.rows[0];
        await db.query(
          `UPDATE team_member_profiles SET status = 'archived', updated_at = NOW() WHERE id = $1`,
          [profileId],
        );
        await db.query(
          `UPDATE people SET status = 'archived', archived_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [personId],
        );
      } else {
        logger.warn({ teamMemberId: id }, "No team_member_profiles row found during DELETE sync — skipping people-directory update");
      }
    } catch (linkErr) {
      logger.error({ linkErr, teamMemberId: id }, "Failed to sync people-directory linkage on archive");
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete team member");
    res.status(500).json({ error: "Failed to delete team member" });
  }
});

export default router;
