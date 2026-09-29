import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { db } from "../lib/db";
import { DEFAULT_WORKING_DAYS } from "../lib/timeOffBalances";
import type { WorkingDaysConfig } from "../lib/timeOffBalances";

const router = Router();

const workingDaysSchema = z.object({
  monday: z.boolean(),
  tuesday: z.boolean(),
  wednesday: z.boolean(),
  thursday: z.boolean(),
  friday: z.boolean(),
  saturday: z.boolean(),
  sunday: z.boolean(),
});

type ProfileRow = {
  member_id: number;
  phone: string | null;
  job_title: string | null;
  birthday: string | null;
  gender: string | null;
  notify_email_on_time_off_request: boolean;
  notify_email_on_time_off_decision: boolean;
  notify_email_on_new_sign_in: boolean;
  notify_email_on_new_order: boolean;
  notify_email_weekly_digest: boolean;
  working_days: WorkingDaysConfig | null;
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
  ec_name: string | null;
  ec_relationship: string | null;
  ec_phone_country_code: string | null;
  ec_phone: string | null;
  pref_add_person_last_type: string | null;
};

/**
 * Schema sentinel — this function reads the following workspace_members columns.
 * If any column is renamed in a schema migration you MUST update this query:
 *   - workspace_members.member_user_id  (used in WHERE clause)
 *   - workspace_members.member_email    (selected directly → member_email)
 *   - workspace_members.manager_member_id (JOIN key → manager_member_id)
 *   - workspace_members mgr.member_email (aliased → manager_name)
 */
async function buildProfileResponse(wreq: ReturnType<typeof workspace>) {
  const result = await db.query<ProfileRow>(
    `SELECT wm.id AS member_id, wm.phone, wm.job_title, wm.birthday, wm.gender,
            wm.notify_email_on_time_off_request,
            wm.notify_email_on_time_off_decision,
            wm.notify_email_on_new_sign_in,
            wm.notify_email_on_new_order,
            wm.notify_email_weekly_digest,
            wm.working_days, wm.department, wm.location,
            wm.employment_type, wm.employment_status, wm.start_date,
            wm.manager_member_id, wm.role, wm.custom_role_id,
            wm.member_email,
            wm.ec_name, wm.ec_relationship, wm.ec_phone_country_code, wm.ec_phone,
            wm.pref_add_person_last_type,
            mgr.member_email AS manager_name,
            wr.name AS custom_role_name
       FROM workspace_members wm
       LEFT JOIN workspace_members mgr ON mgr.id = wm.manager_member_id
       LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
      WHERE wm.member_user_id = $1
        AND wm.workspace_owner_id = $2
        AND wm.joined_at IS NOT NULL
      LIMIT 1`,
    [wreq.userId, wreq.workspaceOwnerId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const locResult = await db.query<{ id: number; name: string }>(
    `SELECT l.id, l.name
       FROM member_locations ml
       JOIN locations l ON l.id = ml.location_id
      WHERE ml.member_id = $1
      ORDER BY l.name`,
    [row.member_id],
  );

  const bday = row.birthday;
  const sdate = row.start_date;
  return {
    phone: row.phone ?? null,
    job_title: row.job_title ?? null,
    birthday: bday ? String(bday).slice(0, 10) : null,
    gender: row.gender ?? null,
    notify_email_on_time_off_request: row.notify_email_on_time_off_request ?? true,
    notify_email_on_time_off_decision: row.notify_email_on_time_off_decision ?? true,
    notify_email_on_new_sign_in: row.notify_email_on_new_sign_in ?? true,
    notify_email_on_new_order: row.notify_email_on_new_order ?? true,
    notify_email_weekly_digest: row.notify_email_weekly_digest ?? true,
    working_days: row.working_days ?? DEFAULT_WORKING_DAYS,
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
    member_email: row.member_email,
    assigned_locations: locResult.rows,
    ec_name: row.ec_name ?? null,
    ec_relationship: row.ec_relationship ?? null,
    ec_phone_country_code: row.ec_phone_country_code ?? null,
    ec_phone: row.ec_phone ?? null,
    pref_add_person_last_type: row.pref_add_person_last_type ?? null,
  };
}

router.get("/profile", requireAuth, resolveWorkspace, async (req, res) => {
  const wreq = workspace(req);
  const profile = await buildProfileResponse(wreq);
  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  res.json(profile);
});

router.patch("/profile", requireAuth, resolveWorkspace, async (req, res) => {
  const wreq = workspace(req);
  const {
    phone,
    job_title,
    birthday,
    gender,
    notify_email_on_time_off_request,
    notify_email_on_time_off_decision,
    notify_email_on_new_sign_in,
    notify_email_on_new_order,
    notify_email_weekly_digest,
    ec_name,
    ec_relationship,
    ec_phone_country_code,
    ec_phone,
    pref_add_person_last_type,
  } = req.body as {
    phone?: string | null;
    job_title?: string | null;
    birthday?: string | null;
    gender?: string | null;
    notify_email_on_time_off_request?: boolean;
    notify_email_on_time_off_decision?: boolean;
    notify_email_on_new_sign_in?: boolean;
    notify_email_on_new_order?: boolean;
    notify_email_weekly_digest?: boolean;
    ec_name?: string | null;
    ec_relationship?: string | null;
    ec_phone_country_code?: string | null;
    ec_phone?: string | null;
    pref_add_person_last_type?: string | null;
  };

  // Validate emergency contact: if any EC field is provided with a non-null value,
  // ec_name must be present. If ec_phone is provided, ec_relationship must also be present.
  // Null values mean the user cleared the field, not that they provided EC data.
  const anyEcField =
    ec_name != null ||
    ec_relationship != null ||
    ec_phone_country_code != null ||
    ec_phone != null;

  if (anyEcField) {
    if (!ec_name) {
      res.status(400).json({ error: "Emergency contact name is required when providing emergency contact details." });
      return;
    }
    if (ec_phone && !ec_relationship) {
      res.status(400).json({ error: "Emergency contact relationship is required when providing a phone number." });
      return;
    }
  }

  const normalizedBirthday = (() => {
    if (!birthday) return birthday;
    if (/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return birthday;
    const d = new Date(birthday);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  })();

  // Schema sentinel: reads workspace_members via member_user_id (WHERE) and
  // joined_at (WHERE IS NOT NULL). Update here if either column is renamed.
  const existing = await db.query<{
    phone: string | null;
    job_title: string | null;
    birthday: string | null;
    gender: string | null;
    notify_email_on_time_off_request: boolean;
    notify_email_on_time_off_decision: boolean;
    notify_email_on_new_sign_in: boolean;
    notify_email_on_new_order: boolean;
    notify_email_weekly_digest: boolean;
    ec_name: string | null;
    ec_relationship: string | null;
    ec_phone_country_code: string | null;
    ec_phone: string | null;
    pref_add_person_last_type: string | null;
  }>(
    `SELECT phone, job_title, birthday, gender,
            notify_email_on_time_off_request,
            notify_email_on_time_off_decision,
            notify_email_on_new_sign_in,
            notify_email_on_new_order,
            notify_email_weekly_digest,
            ec_name, ec_relationship, ec_phone_country_code, ec_phone,
            pref_add_person_last_type
       FROM workspace_members
      WHERE member_user_id = $1
        AND workspace_owner_id = $2
        AND joined_at IS NOT NULL
      LIMIT 1`,
    [wreq.userId, wreq.workspaceOwnerId],
  );
  const cur = existing.rows[0];
  if (!cur) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const PERSON_TYPES = ["internal", "workspace_user", "external"] as const;
  const validatedPersonLastType =
    pref_add_person_last_type !== undefined
      ? (PERSON_TYPES.includes(pref_add_person_last_type as (typeof PERSON_TYPES)[number])
          ? pref_add_person_last_type
          : null)
      : cur.pref_add_person_last_type;

  // Schema sentinel: writes workspace_members via member_user_id (WHERE $13) and
  // joined_at (WHERE IS NOT NULL). Update here if either column is renamed.
  await db.query(
    `UPDATE workspace_members
        SET phone = $1,
            job_title = $2,
            birthday = $3,
            gender = $4,
            notify_email_on_time_off_request = $5,
            notify_email_on_time_off_decision = $6,
            notify_email_on_new_sign_in = $7,
            notify_email_on_new_order = $8,
            notify_email_weekly_digest = $9,
            ec_name = $10,
            ec_relationship = $11,
            ec_phone_country_code = $12,
            ec_phone = $13,
            pref_add_person_last_type = $14
      WHERE member_user_id = $15
        AND workspace_owner_id = $16
        AND joined_at IS NOT NULL`,
    [
      phone !== undefined ? (phone || null) : cur.phone,
      job_title !== undefined ? (job_title || null) : cur.job_title,
      birthday !== undefined ? (normalizedBirthday || null) : cur.birthday,
      gender !== undefined ? (gender || null) : cur.gender,
      notify_email_on_time_off_request !== undefined
        ? !!notify_email_on_time_off_request
        : cur.notify_email_on_time_off_request,
      notify_email_on_time_off_decision !== undefined
        ? !!notify_email_on_time_off_decision
        : cur.notify_email_on_time_off_decision,
      notify_email_on_new_sign_in !== undefined
        ? !!notify_email_on_new_sign_in
        : cur.notify_email_on_new_sign_in,
      notify_email_on_new_order !== undefined
        ? !!notify_email_on_new_order
        : cur.notify_email_on_new_order,
      notify_email_weekly_digest !== undefined
        ? !!notify_email_weekly_digest
        : cur.notify_email_weekly_digest,
      ec_name !== undefined ? (ec_name || null) : cur.ec_name,
      ec_relationship !== undefined ? (ec_relationship || null) : cur.ec_relationship,
      ec_phone_country_code !== undefined ? (ec_phone_country_code || null) : cur.ec_phone_country_code,
      ec_phone !== undefined ? (ec_phone || null) : cur.ec_phone,
      validatedPersonLastType,
      wreq.userId,
      wreq.workspaceOwnerId,
    ],
  );

  const profile = await buildProfileResponse(wreq);
  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  res.json(profile);
});

router.patch("/profile/work-info", requireAuth, resolveWorkspace, async (req, res) => {
  const wreq = workspace(req);

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners can update work information" });
    return;
  }

  const { department, location, employment_type, start_date, manager_member_id } = req.body as {
    department?: string | null;
    location?: string | null;
    employment_type?: string | null;
    start_date?: string | null;
    manager_member_id?: number | null;
  };

  const normalizedStartDate = (() => {
    if (!start_date) return start_date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return start_date;
    const d = new Date(start_date);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  })();

  if (manager_member_id != null) {
    const managerCheck = await db.query(
      `SELECT id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2 AND joined_at IS NOT NULL LIMIT 1`,
      [manager_member_id, wreq.workspaceOwnerId],
    );
    if (managerCheck.rowCount === 0) {
      res.status(400).json({ error: "Invalid manager" });
      return;
    }
  }

  // Schema sentinel: reads workspace_members via member_user_id (WHERE).
  // Update here if that column or manager_member_id is renamed.
  const existing = await db.query<{
    department: string | null;
    location: string | null;
    employment_type: string | null;
    start_date: string | null;
    manager_member_id: number | null;
  }>(
    `SELECT department, location, employment_type, start_date, manager_member_id
       FROM workspace_members
      WHERE member_user_id = $1
        AND workspace_owner_id = $2
        AND joined_at IS NOT NULL
      LIMIT 1`,
    [wreq.userId, wreq.workspaceOwnerId],
  );
  const cur = existing.rows[0];
  if (!cur) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  // Schema sentinel: writes workspace_members via member_user_id (WHERE $6),
  // manager_member_id (SET), and joined_at (WHERE IS NOT NULL).
  // Update here if any of those columns is renamed.
  await db.query(
    `UPDATE workspace_members
        SET department = $1,
            location = $2,
            employment_type = $3,
            start_date = $4,
            manager_member_id = $5
      WHERE member_user_id = $6
        AND workspace_owner_id = $7
        AND joined_at IS NOT NULL`,
    [
      department !== undefined ? (department || null) : cur.department,
      location !== undefined ? (location || null) : cur.location,
      employment_type !== undefined ? (employment_type || null) : cur.employment_type,
      start_date !== undefined ? (normalizedStartDate || null) : cur.start_date,
      manager_member_id !== undefined ? (manager_member_id ?? null) : cur.manager_member_id,
      wreq.userId,
      wreq.workspaceOwnerId,
    ],
  );

  const profile = await buildProfileResponse(wreq);
  if (!profile) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  res.json(profile);
});

router.patch("/profile/work-schedule", requireAuth, resolveWorkspace, async (req, res) => {
  const wreq = workspace(req);

  const parsed = workingDaysSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const config = parsed.data;
  const hasAtLeastOneDay = Object.values(config).some(Boolean);
  if (!hasAtLeastOneDay) {
    res.status(400).json({ error: "At least one working day must be selected" });
    return;
  }

  // Schema sentinel: writes workspace_members via member_user_id (WHERE $2) and
  // joined_at (WHERE IS NOT NULL). Update here if either column is renamed.
  const result = await db.query<{ working_days: WorkingDaysConfig }>(
    `UPDATE workspace_members
        SET working_days = $1
      WHERE member_user_id = $2
        AND workspace_owner_id = $3
        AND joined_at IS NOT NULL
      RETURNING working_days`,
    [JSON.stringify(config), wreq.userId, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  res.json({ working_days: result.rows[0].working_days });
});

export default router;
