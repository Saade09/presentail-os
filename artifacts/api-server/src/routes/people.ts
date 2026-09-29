import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { clerkClient } from "@clerk/express";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * Module-level cache: null = unchecked, true = exists, false = absent.
 * Once true it is never reset (tables are not dropped at runtime).
 * Once false it stays false until the server restarts; after running the
 * team_members migration simply restart the server to re-enable the merged view.
 */
let _teamMembersTableExists: boolean | null = null;
let _teamMemberProfilesTableExists: boolean | null = null;
let _externalProfilesTableExists: boolean | null = null;
let _departmentsTableExists: boolean | null = null;

/** Exported for test isolation only — do not call in production code. */
export function _resetTeamMembersTableExistsForTesting(): void {
  _teamMembersTableExists = null;
  _teamMemberProfilesTableExists = null;
  _externalProfilesTableExists = null;
  _departmentsTableExists = null;
}

type PersonRow = {
  id: string;
  source: "member" | "team_member" | "both" | "external";
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_name: string | null;
  image_url: string | null;
  access_type: "owner" | "user" | "pending_invite" | "team_member_only" | "no_access";
  role: string | null;
  role_name: string | null;
  role_names: string[];
  custom_role_id: number | null;
  joined: boolean;
  joined_at: string | null;
  invited_at: string | null;
  member_id: number | null;
  team_member_id: number | null;
  employment_status: string | null;
  archived_at: string | null;
  person_id: number | null;
  profile_id: number | null;
  employee_code: string | null;
  start_date: string | null;
  has_external_profile: boolean;
  external_type: string | null;
  external_company_name: string | null;
  access_expires_at: string | null;
  revoked_at: string | null;
};

/**
 * Shared helper — build the full unified people list for a workspace.
 *
 * Schema sentinel: reads the following workspace_members columns:
 *   - member_email (→ email), member_user_id (+ IS NOT NULL → joined),
 *     custom_role_id, joined_at (→ joined_at), job_title, employment_type,
 *     employment_status, access_expires_at, revoked_at
 * Update here if any column is renamed in a migration.
 */
async function buildPeopleList(workspaceOwnerId: string): Promise<PersonRow[]> {
  const membersResult = await db.query<{
    id: number;
    email: string;
    role: string;
    custom_role_id: number | null;
    role_name: string | null;
    member_user_id: string | null;
    joined: boolean;
    joined_at: string | null;
    invited_at: string;
    job_title: string | null;
    employment_type: string | null;
    employment_status: string;
    access_expires_at: string | null;
    revoked_at: string | null;
  }>(
    `SELECT wm.id, wm.member_email AS email, wm.role, wm.custom_role_id,
            wr.name AS role_name,
            wm.member_user_id,
            wm.member_user_id IS NOT NULL AS joined,
            wm.joined_at,
            wm.created_at AS invited_at,
            wm.job_title,
            wm.employment_type,
            wm.employment_status,
            wm.access_expires_at,
            wm.revoked_at
       FROM workspace_members wm
       LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
      WHERE wm.workspace_owner_id = $1`,
    [workspaceOwnerId],
  );

  // Batch-fetch role assignments from junction table
  const memberDbIds = membersResult.rows.map((r) => r.id);
  const memberRoleDataMap = new Map<number, { role_names: string[] }>();
  if (memberDbIds.length > 0) {
    const roleResult = await db.query<{ member_id: number; role_name: string }>(
      `SELECT wmr.member_id, wr.name AS role_name
         FROM workspace_member_roles wmr
         JOIN workspace_roles wr ON wr.id = wmr.role_id
        WHERE wmr.member_id = ANY($1::int[])
        ORDER BY wmr.member_id, wr.name`,
      [memberDbIds],
    );
    for (const row of roleResult.rows) {
      const entry = memberRoleDataMap.get(row.member_id) ?? { role_names: [] };
      entry.role_names.push(row.role_name);
      memberRoleDataMap.set(row.member_id, entry);
    }
  }

  type TeamMemberRow = {
    id: number;
    first_name: string;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    department_name: string | null;
    employment_status: string;
    archived_at: string | null;
  };
  type ProfileRow = {
    team_member_id: number;
    person_id: number;
    profile_id: number;
    employee_code: string | null;
    start_date: string | null;
    job_title: string | null;
  };

  let teamMembersResult: { rows: TeamMemberRow[] } = { rows: [] };
  let profilesResult: { rows: ProfileRow[] } = { rows: [] };

  if (_teamMembersTableExists !== false) {
    const useDeptJoin = _departmentsTableExists !== false;
    const teamMembersQuery = useDeptJoin
      ? `SELECT tm.id, tm.first_name, tm.last_name, tm.email, tm.phone,
                d.name AS department_name, tm.employment_status,
                tm.archived_at
           FROM team_members tm
           LEFT JOIN departments d ON d.id = tm.department_id
          WHERE tm.workspace_owner_id = $1`
      : `SELECT tm.id, tm.first_name, tm.last_name, tm.email, tm.phone,
                NULL AS department_name, tm.employment_status,
                tm.archived_at
           FROM team_members tm
          WHERE tm.workspace_owner_id = $1`;
    try {
      teamMembersResult = await db.query<TeamMemberRow>(teamMembersQuery, [workspaceOwnerId]);
      _teamMembersTableExists = true;
      if (useDeptJoin) _departmentsTableExists = true;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "42P01") {
        const msg = (err as { message?: string }).message ?? "";
        if (useDeptJoin && msg.includes("departments")) {
          // departments is absent but team_members exists — retry without the JOIN
          _departmentsTableExists = false;
          logger.info("People Directory: departments table not yet present — returning team members without department names");
          try {
            teamMembersResult = await db.query<TeamMemberRow>(
              `SELECT tm.id, tm.first_name, tm.last_name, tm.email, tm.phone,
                      NULL AS department_name, tm.employment_status,
                      tm.archived_at
                 FROM team_members tm
                WHERE tm.workspace_owner_id = $1`,
              [workspaceOwnerId],
            );
            _teamMembersTableExists = true;
          } catch (retryErr: unknown) {
            if ((retryErr as { code?: string }).code === "42P01") {
              _teamMembersTableExists = false;
              logger.info("People Directory: team_members table not yet present — returning members-only list");
            } else {
              throw retryErr;
            }
          }
        } else {
          _teamMembersTableExists = false;
          logger.info("People Directory: team_members table not yet present — returning members-only list");
        }
      } else {
        throw err;
      }
    }
  }

  if (_teamMembersTableExists !== false && _teamMemberProfilesTableExists !== false) {
    try {
      // Fetch linked people + team_member_profiles keyed by team_member_id
      profilesResult = await db.query<ProfileRow>(
        `SELECT tmp.team_member_id, tmp.person_id, tmp.id AS profile_id,
                tmp.employee_code, tmp.start_date, tmp.job_title
           FROM team_member_profiles tmp
          WHERE tmp.workspace_owner_id = $1
            AND tmp.team_member_id IS NOT NULL`,
        [workspaceOwnerId],
      );
      _teamMemberProfilesTableExists = true;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "42P01") {
        _teamMemberProfilesTableExists = false;
        logger.info("People Directory: team_member_profiles table not yet present — skipping profile enrichment");
      } else {
        throw err;
      }
    }
  }

  const profilesByTeamMemberId = new Map(
    profilesResult.rows.map((p) => [p.team_member_id, p]),
  );

  const memberMap = new Map(
    membersResult.rows.map((m) => [m.email.toLowerCase(), m]),
  );
  const teamMemberMap = new Map(
    teamMembersResult.rows
      .filter((tm) => tm.email)
      .map((tm) => [tm.email!.toLowerCase(), tm]),
  );

  const allEmails = new Set([
    ...Array.from(memberMap.keys()),
    ...Array.from(teamMemberMap.keys()),
  ]);

  const teamMembersWithoutEmail = teamMembersResult.rows.filter((tm) => !tm.email);

  const rows: PersonRow[] = [];

  for (const email of allEmails) {
    const member = memberMap.get(email);
    const tm = teamMemberMap.get(email);

    let accessType: PersonRow["access_type"] = "no_access";
    if (member) {
      if (member.role === "owner") {
        accessType = "owner";
      } else if (member.joined) {
        accessType = "user";
      } else {
        accessType = "pending_invite";
      }
    } else {
      accessType = "team_member_only";
    }

    const profile = tm ? profilesByTeamMemberId.get(tm.id) : undefined;

    rows.push({
      id: member ? `wm_${member.id}` : `tm_${tm!.id}`,
      source: member && tm ? "both" : member ? "member" : "team_member",
      first_name: tm?.first_name ?? null,
      last_name: tm?.last_name ?? null,
      email,
      phone: tm?.phone ?? null,
      job_title: profile?.job_title ?? member?.job_title ?? null,
      department_name: tm?.department_name ?? null,
      image_url: null,
      access_type: accessType,
      role: member?.role ?? null,
      role_name: member?.role_name ?? null,
      role_names: member ? (memberRoleDataMap.get(member.id)?.role_names ?? (member.role_name ? [member.role_name] : [])) : [],
      custom_role_id: member?.custom_role_id ?? null,
      joined: member?.joined ?? false,
      joined_at: member?.joined_at ?? null,
      invited_at: member?.invited_at ?? null,
      member_id: member?.id ?? null,
      team_member_id: tm?.id ?? null,
      employment_status: tm?.employment_status ?? member?.employment_status ?? null,
      archived_at: tm?.archived_at ?? null,
      person_id: profile?.person_id ?? null,
      profile_id: profile?.profile_id ?? null,
      employee_code: profile?.employee_code ?? null,
      start_date: profile?.start_date ?? null,
      has_external_profile: false,
      external_type: null,
      external_company_name: null,
      access_expires_at: member?.access_expires_at ?? null,
      revoked_at: member?.revoked_at ?? null,
    });
  }

  for (const tm of teamMembersWithoutEmail) {
    const profile = profilesByTeamMemberId.get(tm.id);
    rows.push({
      id: `tm_${tm.id}`,
      source: "team_member",
      first_name: tm.first_name,
      last_name: tm.last_name,
      email: null,
      phone: tm.phone,
      job_title: profile?.job_title ?? null,
      department_name: tm.department_name,
      image_url: null,
      access_type: "team_member_only",
      role: null,
      role_name: null,
      role_names: [],
      custom_role_id: null,
      joined: false,
      joined_at: null,
      invited_at: null,
      member_id: null,
      team_member_id: tm.id,
      employment_status: tm.employment_status,
      archived_at: tm.archived_at,
      person_id: profile?.person_id ?? null,
      profile_id: profile?.profile_id ?? null,
      employee_code: profile?.employee_code ?? null,
      start_date: profile?.start_date ?? null,
      has_external_profile: false,
      external_type: null,
      external_company_name: null,
      access_expires_at: null,
      revoked_at: null,
    });
  }

  // ── External profiles — annotate + add standalone external users ──────────
  type ExternalProfileRow = {
    id: number;
    person_id: number;
    external_type: string;
    company_name: string | null;
    person_first_name: string | null;
    person_last_name: string | null;
    person_email: string | null;
    person_phone: string | null;
  };
  let externalProfilesResult: { rows: ExternalProfileRow[] } = { rows: [] };
  if (_externalProfilesTableExists !== false) {
    try {
      externalProfilesResult = await db.query<ExternalProfileRow>(
        `SELECT ep.id, ep.person_id, ep.external_type, ep.company_name,
                p.first_name AS person_first_name, p.last_name AS person_last_name,
                p.email AS person_email, p.phone AS person_phone
           FROM external_profiles ep
           JOIN people p ON p.id = ep.person_id
          WHERE ep.workspace_owner_id = $1 AND ep.status = 'active'`,
        [workspaceOwnerId],
      );
      _externalProfilesTableExists = true;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "42P01") {
        _externalProfilesTableExists = false;
        logger.info("People Directory: external_profiles table not yet present — skipping external profiles");
      } else {
        logger.warn({ err }, "People Directory: failed to fetch external_profiles — degrading to empty list");
      }
    }
  }

  const externalByPersonId = new Map(
    externalProfilesResult.rows.map((ep) => [ep.person_id, ep]),
  );
  const externalByEmail = new Map(
    externalProfilesResult.rows
      .filter((ep) => ep.person_email)
      .map((ep) => [ep.person_email!.toLowerCase(), ep]),
  );

  // Annotate rows that already exist in the list
  for (const row of rows) {
    let extData = row.person_id != null ? externalByPersonId.get(row.person_id) : undefined;
    if (!extData && row.email) extData = externalByEmail.get(row.email.toLowerCase());
    if (extData) {
      row.has_external_profile = true;
      row.external_type = extData.external_type;
      row.external_company_name = extData.company_name;
    }
  }

  // Add new rows for external persons not already represented
  const seenEmails = new Set(
    rows.map((r) => r.email?.toLowerCase()).filter((e): e is string => e != null),
  );
  const seenPersonIds = new Set(
    rows.map((r) => r.person_id).filter((id): id is number => id != null),
  );

  for (const ep of externalProfilesResult.rows) {
    const emailKey = ep.person_email?.toLowerCase();
    if (emailKey && seenEmails.has(emailKey)) continue;
    if (seenPersonIds.has(ep.person_id)) continue;

    rows.push({
      id: `ep_${ep.person_id}`,
      source: "external",
      first_name: ep.person_first_name,
      last_name: ep.person_last_name,
      email: ep.person_email,
      phone: ep.person_phone,
      job_title: null,
      department_name: null,
      image_url: null,
      access_type: "no_access",
      role: null,
      role_name: null,
      role_names: [],
      custom_role_id: null,
      joined: false,
      joined_at: null,
      invited_at: null,
      member_id: null,
      team_member_id: null,
      employment_status: null,
      archived_at: null,
      person_id: ep.person_id,
      profile_id: null,
      employee_code: null,
      start_date: null,
      has_external_profile: true,
      external_type: ep.external_type,
      external_company_name: ep.company_name,
      access_expires_at: null,
      revoked_at: null,
    });
  }

  // Populate image_url for rows that have a Clerk member_user_id.
  // Build a map from row.id → member_user_id using the memberMap we already have.
  const rowIdToMemberUserId = new Map<string, string>();
  for (const row of rows) {
    if (row.member_id == null) continue;
    const memberRow = membersResult.rows.find((m) => m.id === row.member_id);
    if (memberRow?.member_user_id) {
      rowIdToMemberUserId.set(row.id, memberRow.member_user_id);
    }
  }

  if (rowIdToMemberUserId.size > 0) {
    const uniqueUserIds = [...new Set(rowIdToMemberUserId.values())];
    const clerkMap = await fetchClerkNames(uniqueUserIds);
    for (const row of rows) {
      const uid = rowIdToMemberUserId.get(row.id);
      if (uid) {
        const entry = clerkMap.get(uid);
        if (entry?.imageUrl) row.image_url = entry.imageUrl;
        // workspace_members stores the Clerk user id, not their profile
        // name. Use the login profile as the source of truth when this
        // person has no HR record supplying a name.
        if (!row.first_name && entry?.firstName) row.first_name = entry.firstName;
        if (!row.last_name && entry?.lastName) row.last_name = entry.lastName;
      }
    }
  }

  // Enrich team_member rows that still have no image_url via email-based
  // workspace_members lookup — mirrors the approach in /api/team-members.
  // A team member whose email matches a signed-in workspace member gets the
  // Clerk profile photo even when the merge produced a team_member-only row.
  const teamMemberRowsWithoutPhoto = rows.filter(
    (r) =>
      (r.source === "team_member" || r.source === "both") &&
      r.image_url === null &&
      r.email != null,
  );
  if (teamMemberRowsWithoutPhoto.length > 0) {
    const emails = teamMemberRowsWithoutPhoto.map((r) => r.email as string);
    try {
      const wmByEmail = await db.query<{ member_email: string; member_user_id: string }>(
        `SELECT member_email, member_user_id
           FROM workspace_members
          WHERE workspace_owner_id = $1
            AND member_user_id IS NOT NULL
            AND member_email = ANY($2)`,
        [workspaceOwnerId, emails],
      );
      if (wmByEmail.rows.length > 0) {
        const emailToUserId = new Map(wmByEmail.rows.map((r) => [r.member_email.toLowerCase(), r.member_user_id]));
        const userIds = [...new Set(emailToUserId.values())];
        const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 200 });
        const userIdToImageUrl = new Map(
          clerkUsers.data
            .filter((u) => u.hasImage && u.imageUrl)
            .map((u) => [u.id, u.imageUrl]),
        );
        for (const row of teamMemberRowsWithoutPhoto) {
          const uid = emailToUserId.get(row.email!.toLowerCase());
          if (uid) row.image_url = userIdToImageUrl.get(uid) ?? null;
        }
      }
    } catch (clerkErr) {
      logger.warn({ err: clerkErr }, "People Directory: failed to fetch Clerk profile photos for team_member rows");
    }
  }

  return rows;
}

/**
 * GET /people
 * Unified people directory — joins workspace_members (login users + pending invites)
 * and team_members (HR records) by email, returning a deduplicated list.
 *
 * Query params:
 *   ?tab=all|team-members|users|pending|no-access|archived
 *   ?q=   (search by name / email)
 */
router.get("/people", async (req, res): Promise<void> => {
  const wreq = workspace(req);

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const tab = typeof req.query.tab === "string" ? req.query.tab : "all";

  try {
    const rows = await buildPeopleList(wreq.workspaceOwnerId);

    let filtered = rows;

    if (tab === "team-members") {
      filtered = rows.filter(
        (r) => (r.source === "member" || r.source === "team_member" || r.source === "both") && !r.archived_at,
      );
    } else if (tab === "users") {
      filtered = rows.filter(
        (r) => r.access_type === "user" || r.access_type === "owner",
      );
    } else if (tab === "pending") {
      filtered = rows.filter((r) => r.access_type === "pending_invite");
    } else if (tab === "no-access") {
      filtered = rows.filter((r) => r.access_type === "team_member_only");
    } else if (tab === "archived") {
      filtered = rows.filter((r) => r.archived_at != null);
    } else if (tab === "external") {
      filtered = rows.filter((r) => r.has_external_profile);
    } else {
      filtered = rows.filter((r) => !r.archived_at);
    }

    if (q) {
      const lq = q.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.email?.toLowerCase().includes(lq) ||
          r.first_name?.toLowerCase().includes(lq) ||
          r.last_name?.toLowerCase().includes(lq),
      );
    }

    const totalPeople = rows.filter((r) => !r.archived_at).length;
    const totalTeamMembers = rows.filter(
      (r) => (r.source === "member" || r.source === "team_member" || r.source === "both") && !r.archived_at,
    ).length;
    const totalUsersWithAccess = rows.filter(
      (r) =>
        (r.access_type === "user" || r.access_type === "owner") && !r.archived_at,
    ).length;
    const totalPendingInvites = rows.filter(
      (r) => r.access_type === "pending_invite",
    ).length;
    const totalAdmins = rows.filter(
      (r) => r.access_type === "owner" && !r.archived_at,
    ).length;
    const totalNoLoginAccess = rows.filter(
      (r) => r.access_type === "team_member_only" && !r.archived_at,
    ).length;
    const totalExternal = rows.filter((r) => r.has_external_profile && !r.archived_at).length;

    res.json({
      people: filtered,
      stats: {
        totalPeople,
        totalTeamMembers,
        totalUsersWithAccess,
        totalPendingInvites,
        totalAdmins,
        totalNoLoginAccess,
        totalExternal,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to list people");
    res.status(500).json({ error: "Failed to list people" });
  }
});

/**
 * GET /people/orphan-count
 * Returns the count of team_member rows that have no linked team_member_profiles record.
 * Owner-only. Used by the People directory to surface a repair banner.
 */
router.get("/people/orphan-count", async (req, res): Promise<void> => {
  const wreq = workspace(req);

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can view orphan counts" });
    return;
  }

  try {
    const result = await db.query<{ orphan_count: string }>(`
      SELECT COUNT(*) AS orphan_count
        FROM team_members tm
       WHERE tm.workspace_owner_id = $1
         AND NOT EXISTS (
           SELECT 1
             FROM team_member_profiles tmp
            WHERE tmp.team_member_id = tm.id
         )
    `, [wreq.workspaceOwnerId]);

    const orphanCount = parseInt(result.rows[0]?.orphan_count ?? "0", 10);
    res.json({ orphan_count: orphanCount });
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") {
      res.json({ orphan_count: 0 });
      return;
    }
    logger.error({ err }, "Failed to get orphan count");
    res.status(500).json({ error: "Failed to get orphan count" });
  }
});

/**
 * POST /people/repair-orphans
 * Re-runs the people-directory linkage migration for any team_member rows in this
 * workspace that are still missing a linked team_member_profiles record.
 * Owner-only.
 */
router.post("/people/repair-orphans", async (req, res): Promise<void> => {
  const wreq = workspace(req);

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can repair orphan records" });
    return;
  }

  try {
    type OrphanRow = {
      id: number;
      first_name: string;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      department_id: number | null;
      employment_status: string | null;
      start_date: string | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
      archived_at: string | null;
    };

    const orphansResult = await db.query<OrphanRow>(
      `SELECT tm.id, tm.first_name, tm.last_name, tm.email, tm.phone,
              tm.department_id, tm.employment_status,
              tm.start_date, tm.emergency_contact_name, tm.emergency_contact_phone,
              tm.archived_at
         FROM team_members tm
        WHERE tm.workspace_owner_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM team_member_profiles tmp WHERE tmp.team_member_id = tm.id
          )`,
      [wreq.workspaceOwnerId],
    );

    let repaired = 0;
    for (const tm of orphansResult.rows) {
      let personId: number | null = null;

      if (tm.email) {
        const existing = await db.query<{ id: number }>(
          `SELECT id FROM people
            WHERE workspace_owner_id = $1 AND LOWER(email) = LOWER($2)
            LIMIT 1`,
          [wreq.workspaceOwnerId, tm.email],
        );
        if (existing.rows.length > 0) personId = existing.rows[0].id;
      }

      if (personId === null) {
        const inserted = await db.query<{ id: number }>(
          `INSERT INTO people (workspace_owner_id, first_name, last_name, email, phone, status, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            wreq.workspaceOwnerId,
            tm.first_name,
            tm.last_name,
            tm.email,
            tm.phone,
            tm.archived_at ? "archived" : "active",
            tm.archived_at,
          ],
        );
        personId = inserted.rows[0].id;
      }

      const insertResult = await db.query(
        `INSERT INTO team_member_profiles (
           person_id, workspace_owner_id, team_member_id,
           department_id, employment_type, start_date,
           emergency_contact_name, emergency_contact_phone, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          personId,
          wreq.workspaceOwnerId,
          tm.id,
          tm.department_id,
          tm.employment_status,
          tm.start_date,
          tm.emergency_contact_name,
          tm.emergency_contact_phone,
          tm.archived_at ? "archived" : "active",
        ],
      );

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        repaired++;
      }
    }

    logger.info(
      { workspace_owner_id: wreq.workspaceOwnerId, repaired },
      "people/repair-orphans: manual repair completed",
    );

    res.json({ repaired });
  } catch (err) {
    logger.error({ err }, "Failed to repair orphans");
    res.status(500).json({ error: "Failed to repair orphan records" });
  }
});

type WorkScheduleDay = {
  day_of_week: string;
  is_working_day: boolean;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
};

type PersonDetail = PersonRow & {
  birthday: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  notes: string | null;
  manager_id: number | null;
  manager_name: string | null;
  work_schedule_id: number | null;
  work_schedule_name: string | null;
  work_schedule_days: WorkScheduleDay[] | null;
  work_schedule_weekly_hours: number | null;
  department_id: number | null;
  employment_type: string | null;
  attendance_enabled: boolean | null;
  profile_status: string | null;
};

function calcWeeklyHours(days: WorkScheduleDay[]): number {
  let totalMinutes = 0;
  for (const day of days) {
    if (!day.is_working_day || !day.start_time || !day.end_time) continue;
    const [sh, sm] = day.start_time.split(":").map(Number);
    const [eh, em] = day.end_time.split(":").map(Number);
    const duration = (eh * 60 + em) - (sh * 60 + sm) - (day.break_minutes ?? 0);
    if (duration > 0) totalMinutes += duration;
  }
  return Math.round((totalMinutes / 60) * 10) / 10;
}

/**
 * GET /people/migration-summary
 * Returns counts of workspace_members and team_members that lack a linked people row.
 * Owner only — used to surface a migration health panel in the UI.
 * NOTE: Must be registered before GET /people/:id to avoid Express routing "migration-summary" as an id.
 */
router.get("/people/migration-summary", async (req, res): Promise<void> => {
  const wreq = workspace(req);

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can view the migration summary" });
    return;
  }

  try {
    const [
      membersWithoutPeople,
      teamMembersWithoutProfile,
      externalCount,
      duplicateEmails,
      pendingInvites,
    ] = await Promise.all([
      // Schema sentinel: reads workspace_members.member_email (LOWER compare in NOT EXISTS).
      // Update here if member_email is renamed.
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM workspace_members wm
          WHERE wm.workspace_owner_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM people p
               WHERE p.workspace_owner_id = $1
                 AND LOWER(p.email) = LOWER(wm.member_email)
            )`,
        [wreq.workspaceOwnerId],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM team_members tm
          WHERE tm.workspace_owner_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM team_member_profiles tmp
               WHERE tmp.team_member_id = tm.id
            )`,
        [wreq.workspaceOwnerId],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM external_profiles ep
          WHERE ep.workspace_owner_id = $1 AND ep.status = 'active'`,
        [wreq.workspaceOwnerId],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM (
          SELECT LOWER(email) FROM people
           WHERE workspace_owner_id = $1 AND email IS NOT NULL
          GROUP BY LOWER(email)
          HAVING COUNT(*) > 1
        ) dups`,
        [wreq.workspaceOwnerId],
      ),
      // Schema sentinel: reads workspace_members.member_user_id (IS NULL check) and revoked_at.
      // Update here if member_user_id or revoked_at is renamed.
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM workspace_members wm
          WHERE wm.workspace_owner_id = $1
            AND wm.member_user_id IS NULL
            AND wm.revoked_at IS NULL`,
        [wreq.workspaceOwnerId],
      ),
    ]);

    res.json({
      created: parseInt(membersWithoutPeople.rows[0]?.count ?? "0", 10),
      merged: parseInt(teamMembersWithoutProfile.rows[0]?.count ?? "0", 10),
      duplicates: parseInt(duplicateEmails.rows[0]?.count ?? "0", 10),
      manual_review: parseInt(externalCount.rows[0]?.count ?? "0", 10),
      pending_invites: parseInt(pendingInvites.rows[0]?.count ?? "0", 10),
    });
  } catch (err) {
    logger.error({ err }, "Failed to get migration summary");
    res.status(500).json({ error: "Failed to get migration summary" });
  }
});

/**
 * GET /people/:id
 * Get a single person by composite ID (wm_{memberId} or tm_{teamMemberId}).
 * Returns the base PersonRow plus richer HR fields fetched in a single extra query.
 */
router.get("/people/:id", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const rows = await buildPeopleList(wreq.workspaceOwnerId);

    const person = rows.find((p) => {
      if (rawId.startsWith("wm_")) {
        const numId = parseInt(rawId.slice(3), 10);
        return p.member_id === numId;
      }
      if (rawId.startsWith("tm_")) {
        const numId = parseInt(rawId.slice(3), 10);
        return p.team_member_id === numId;
      }
      return p.id === rawId;
    });

    if (!person) {
      res.status(404).json({ error: "Person not found" });
      return;
    }

    const detail = await enrichPersonDetail(person, wreq.workspaceOwnerId);
    res.json(detail);
  } catch (err) {
    logger.error({ err }, "Failed to get person");
    res.status(500).json({ error: "Failed to get person" });
  }
});

/**
 * POST /people
 * Create a new person — inserts a team_member record (owner only).
 */
router.post("/people", async (req, res): Promise<void> => {
  const wreq = workspace(req);

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can add people" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const firstName = typeof body.first_name === "string" ? body.first_name.trim() : null;

  if (!firstName) {
    res.status(400).json({ error: "first_name is required" });
    return;
  }

  try {
    const email = body.email ? String(body.email).trim() || null : null;
    const phone = body.phone ? String(body.phone).trim() || null : null;
    const lastName = body.last_name ? String(body.last_name).trim() || null : null;
    const jobTitle = body.job_title ? String(body.job_title).trim() || null : null;
    const departmentId = body.department_id ? Number(body.department_id) : null;
    const employmentStatus = typeof body.employment_status === "string" && body.employment_status
      ? body.employment_status
      : "full_time";

    // ── Duplicate detection ──────────────────────────────────────────────────
    if (email) {
      const dupCheck = await db.query<{ person_id: number; tm_id: number | null }>(
        `SELECT p.id AS person_id, tmp.team_member_id AS tm_id
           FROM people p
           LEFT JOIN team_member_profiles tmp
             ON tmp.person_id = p.id AND tmp.workspace_owner_id = $1
          WHERE p.workspace_owner_id = $1 AND LOWER(p.email) = LOWER($2)
          LIMIT 1`,
        [wreq.workspaceOwnerId, email],
      );
      if (dupCheck.rows.length > 0 && dupCheck.rows[0].tm_id != null) {
        const dup = dupCheck.rows[0];
        res.status(409).json({
          error: "A person with this email already exists",
          existing_person_id: `tm_${dup.tm_id}`,
        });
        return;
      }
    }

    const result = await db.query<{ id: number }>(
      `INSERT INTO team_members
         (workspace_owner_id, first_name, last_name, email, phone,
          department_id, employment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        wreq.workspaceOwnerId,
        firstName,
        lastName,
        email,
        phone,
        departmentId,
        employmentStatus,
      ],
    );

    const newId = result.rows[0].id;

    // Inline linkage: find or create a people row, then create team_member_profiles
    let personId: number;

    if (email) {
      const existingPerson = await db.query<{ id: number }>(
        `SELECT id FROM people
          WHERE workspace_owner_id = $1 AND LOWER(email) = LOWER($2)
          LIMIT 1`,
        [wreq.workspaceOwnerId, email],
      );
      if (existingPerson.rows.length > 0) {
        personId = existingPerson.rows[0].id;
      } else {
        const newPerson = await db.query<{ id: number }>(
          `INSERT INTO people (workspace_owner_id, first_name, last_name, email, phone, status)
           VALUES ($1, $2, $3, $4, $5, 'active')
           RETURNING id`,
          [wreq.workspaceOwnerId, firstName, lastName, email, phone],
        );
        personId = newPerson.rows[0].id;
      }
    } else {
      const newPerson = await db.query<{ id: number }>(
        `INSERT INTO people (workspace_owner_id, first_name, last_name, email, phone, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id`,
        [wreq.workspaceOwnerId, firstName, lastName, null, phone],
      );
      personId = newPerson.rows[0].id;
    }

    await db.query(
      `INSERT INTO team_member_profiles
         (person_id, workspace_owner_id, team_member_id, job_title, department_id,
          employment_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [personId, wreq.workspaceOwnerId, newId, jobTitle, departmentId, employmentStatus],
    );


    const rows = await buildPeopleList(wreq.workspaceOwnerId);
    const person = rows.find((p) => p.team_member_id === newId);

    if (!person) {
      res.status(500).json({ error: "Created but failed to retrieve person" });
      return;
    }

    res.status(201).json(person);
  } catch (err) {
    logger.error({ err }, "Failed to create person");
    res.status(500).json({ error: "Failed to create person" });
  }
});

/**
 * Shared helper — enrich a PersonRow with full HR detail for a team member.
 */
async function enrichPersonDetail(
  person: PersonRow,
  workspaceOwnerId: string,
): Promise<PersonDetail> {
  const detail: PersonDetail = {
    ...person,
    birthday: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    emergency_contact_relationship: null,
    notes: null,
    manager_id: null,
    manager_name: null,
    work_schedule_id: null,
    work_schedule_name: null,
    work_schedule_days: null,
    work_schedule_weekly_hours: null,
    department_id: null,
    employment_type: null,
    attendance_enabled: null,
    profile_status: null,
  };

  if (person.team_member_id == null) return detail;

  const enrichResult = await db.query<{
    birthday: string | null;
    tm_emergency_name: string | null;
    tm_emergency_phone: string | null;
    emergency_contact_relationship: string | null;
    notes: string | null;
    manager_id: number | null;
    manager_name: string | null;
    work_schedule_id: number | null;
    work_schedule_name: string | null;
    work_schedule_days: WorkScheduleDay[] | null;
    department_id: number | null;
    employment_type: string | null;
    attendance_enabled: boolean | null;
    profile_status: string | null;
    profile_emergency_name: string | null;
    profile_emergency_phone: string | null;
  }>(
    `SELECT
       tm.birthday,
       tm.emergency_contact_name   AS tm_emergency_name,
       tm.emergency_contact_phone  AS tm_emergency_phone,
       tm.emergency_contact_relationship,
       tm.notes,
       tm.manager_id,
       CASE
         WHEN mgr.id IS NOT NULL
           THEN mgr.first_name || COALESCE(' ' || mgr.last_name, '')
         ELSE NULL
       END AS manager_name,
       COALESCE(tmp.work_schedule_id, tm.work_schedule_id) AS work_schedule_id,
       ws.name                     AS work_schedule_name,
       (
         SELECT json_agg(
           json_build_object(
             'day_of_week', wsd.day_of_week,
             'is_working_day', wsd.is_working_day,
             'start_time', wsd.start_time,
             'end_time', wsd.end_time,
             'break_minutes', wsd.break_minutes
           ) ORDER BY ARRAY_POSITION(
             ARRAY['monday','tuesday','wednesday','thursday','friday','saturday','sunday'],
             wsd.day_of_week
           )
         )
         FROM work_schedule_days wsd
         WHERE wsd.schedule_id = COALESCE(tmp.work_schedule_id, tm.work_schedule_id)
       )                           AS work_schedule_days,
       tm.department_id,
       tmp.employment_type,
       tmp.attendance_enabled,
       tmp.status                  AS profile_status,
       tmp.emergency_contact_name  AS profile_emergency_name,
       tmp.emergency_contact_phone AS profile_emergency_phone
     FROM team_members tm
     LEFT JOIN team_members mgr
       ON mgr.id = tm.manager_id AND mgr.workspace_owner_id = $1
     LEFT JOIN team_member_profiles tmp
       ON tmp.team_member_id = tm.id AND tmp.workspace_owner_id = $1
     LEFT JOIN work_schedules ws
       ON ws.id = COALESCE(tmp.work_schedule_id, tm.work_schedule_id)
    WHERE tm.id = $2 AND tm.workspace_owner_id = $1`,
    [workspaceOwnerId, person.team_member_id],
  );

  if (enrichResult.rows.length > 0) {
    const r = enrichResult.rows[0];
    detail.birthday = r.birthday;
    detail.emergency_contact_name = r.profile_emergency_name ?? r.tm_emergency_name;
    detail.emergency_contact_phone = r.profile_emergency_phone ?? r.tm_emergency_phone;
    detail.emergency_contact_relationship = r.emergency_contact_relationship;
    detail.notes = r.notes;
    detail.manager_id = r.manager_id;
    detail.manager_name = r.manager_name;
    detail.work_schedule_id = r.work_schedule_id;
    detail.work_schedule_name = r.work_schedule_name;
    detail.work_schedule_days = r.work_schedule_days;
    detail.work_schedule_weekly_hours = r.work_schedule_days
      ? calcWeeklyHours(r.work_schedule_days)
      : null;
    detail.department_id = r.department_id;
    detail.employment_type = r.employment_type;
    detail.attendance_enabled = r.attendance_enabled;
    detail.profile_status = r.profile_status;
  }

  return detail;
}

/**
 * Batch-fetch Clerk display names for a list of user IDs.
 */
async function fetchClerkNames(
  userIds: string[],
): Promise<Map<string, {
  name: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}>> {
  const map = new Map<string, {
    name: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string | null;
  }>();
  if (userIds.length === 0) return map;
  try {
    const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 100 });
    for (const u of clerkUsers.data) {
      const parts = [u.firstName, u.lastName].filter(Boolean);
      const name = parts.length > 0 ? parts.join(" ") : (u.primaryEmailAddress?.emailAddress ?? u.id);
      const imageUrl = u.hasImage && u.imageUrl ? u.imageUrl : null;
      map.set(u.id, {
        name,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        imageUrl,
      });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to batch-fetch Clerk profile names");
  }
  return map;
}

/**
 * GET /people/:id/activity
 * Return paginated field-level change history for a person (owner only).
 */
router.get("/people/:id/activity", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can view activity" });
    return;
  }

  if (!rawId.startsWith("tm_")) {
    res.status(400).json({ error: "Activity is only available for team member (tm_) records" });
    return;
  }

  const tmId = parseInt(rawId.slice(3), 10);
  if (isNaN(tmId)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const offset = (page - 1) * limit;

    const [itemsResult, countResult] = await Promise.all([
      db.query<{
        id: number;
        field_name: string;
        old_value: string | null;
        new_value: string | null;
        changed_by_user_id: string;
        changed_at: string;
      }>(
        `SELECT id, field_name, old_value, new_value, changed_by_user_id, changed_at
           FROM people_audit_log
          WHERE team_member_id = $1 AND workspace_owner_id = $2
          ORDER BY changed_at DESC
          LIMIT $3 OFFSET $4`,
        [tmId, wreq.workspaceOwnerId, limit, offset],
      ),
      db.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM people_audit_log
          WHERE team_member_id = $1 AND workspace_owner_id = $2`,
        [tmId, wreq.workspaceOwnerId],
      ),
    ]);

    const userIds = [...new Set(itemsResult.rows.map((r) => r.changed_by_user_id))];
    const nameMap = await fetchClerkNames(userIds);

    const collectIds = (fieldName: string): number[] => {
      const ids: number[] = [];
      for (const r of itemsResult.rows) {
        if (r.field_name !== fieldName) continue;
        for (const v of [r.old_value, r.new_value]) {
          if (v != null && v !== "") {
            const n = parseInt(v, 10);
            if (!isNaN(n)) ids.push(n);
          }
        }
      }
      return [...new Set(ids)];
    };

    const departmentIds = collectIds("department_id");
    const managerIds = collectIds("manager_id");
    const workScheduleIds = collectIds("work_schedule_id");

    const [deptRows, tmRows, wsRows] = await Promise.all([
      departmentIds.length > 0
        ? db.query<{ id: number; name: string }>(
            `SELECT id, name FROM departments WHERE id = ANY($1) AND workspace_owner_id = $2`,
            [departmentIds, wreq.workspaceOwnerId],
          )
        : { rows: [] as { id: number; name: string }[] },
      managerIds.length > 0
        ? db.query<{ id: number; first_name: string; last_name: string | null }>(
            `SELECT id, first_name, last_name FROM team_members WHERE id = ANY($1) AND workspace_owner_id = $2`,
            [managerIds, wreq.workspaceOwnerId],
          )
        : { rows: [] as { id: number; first_name: string; last_name: string | null }[] },
      workScheduleIds.length > 0
        ? db.query<{ id: number; name: string }>(
            `SELECT id, name FROM work_schedules WHERE id = ANY($1) AND workspace_owner_id = $2`,
            [workScheduleIds, wreq.workspaceOwnerId],
          )
        : { rows: [] as { id: number; name: string }[] },
    ]);

    const deptMap = new Map(deptRows.rows.map((r) => [r.id, r.name]));
    const managerMap = new Map(
      tmRows.rows.map((r) => [
        r.id,
        [r.first_name, r.last_name].filter(Boolean).join(" "),
      ]),
    );
    const wsMap = new Map(wsRows.rows.map((r) => [r.id, r.name]));

    const resolveLabel = (fieldName: string, value: string | null): string | null => {
      if (value == null || value === "") return null;
      const n = parseInt(value, 10);
      if (isNaN(n)) return null;
      if (fieldName === "department_id") return deptMap.get(n) ?? null;
      if (fieldName === "manager_id") return managerMap.get(n) ?? null;
      if (fieldName === "work_schedule_id") return wsMap.get(n) ?? null;
      return null;
    };

    const items = itemsResult.rows.map((r) => ({
      id: r.id,
      field_name: r.field_name,
      old_value: r.old_value,
      new_value: r.new_value,
      old_label: resolveLabel(r.field_name, r.old_value),
      new_label: resolveLabel(r.field_name, r.new_value),
      changed_by_user_id: r.changed_by_user_id,
      changed_by_name: nameMap.get(r.changed_by_user_id)?.name ?? r.changed_by_user_id,
      changed_at: r.changed_at,
    }));

    res.json({
      items,
      total: parseInt(countResult.rows[0].total, 10),
      page,
      limit,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch person activity");
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

/**
 * PATCH /people/:id
 * Update person details (owner only).
 * Supports updating team_member HR fields for tm_ IDs.
 */
router.patch("/people/:id", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can update people" });
    return;
  }

  try {
    if (rawId.startsWith("tm_")) {
      const tmId = parseInt(rawId.slice(3), 10);
      if (isNaN(tmId)) {
        res.status(400).json({ error: "Invalid ID" });
        return;
      }

      const checkResult = await db.query<{ id: number }>(
        `SELECT id FROM team_members WHERE workspace_owner_id = $1 AND id = $2`,
        [wreq.workspaceOwnerId, tmId],
      );
      if (checkResult.rows.length === 0) {
        res.status(404).json({ error: "Person not found" });
        return;
      }

      const body = req.body as Record<string, unknown>;

      // ── Read before-state for audit logging ──────────────────────────────
      const beforeResult = await db.query<{
        first_name: string;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        department_id: number | null;
        employment_status: string;
        manager_id: number | null;
        work_schedule_id: number | null;
        birthday: string | null;
        start_date: string | null;
        emergency_contact_name: string | null;
        emergency_contact_phone: string | null;
        emergency_contact_relationship: string | null;
        notes: string | null;
        job_title: string | null;
        attendance_enabled: boolean | null;
      }>(
        `SELECT tm.first_name, tm.last_name, tm.email, tm.phone,
                tm.department_id, tm.employment_status, tm.manager_id,
                tm.work_schedule_id, tm.birthday, tm.start_date,
                tm.emergency_contact_name, tm.emergency_contact_phone,
                tm.emergency_contact_relationship, tm.notes,
                tmp.job_title, tmp.attendance_enabled
           FROM team_members tm
           LEFT JOIN team_member_profiles tmp
             ON tmp.team_member_id = tm.id AND tmp.workspace_owner_id = $1
          WHERE tm.id = $2 AND tm.workspace_owner_id = $1`,
        [wreq.workspaceOwnerId, tmId],
      );
      const beforeState = beforeResult.rows[0] ?? {};

      const tmAllowed = [
        "first_name", "last_name", "email", "phone",
        "department_id", "employment_status",
        "manager_id", "work_schedule_id",
        "birthday", "start_date",
        "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship",
        "notes",
      ];
      const tmFields: string[] = [];
      const tmParams: unknown[] = [];
      let i = 1;
      for (const key of tmAllowed) {
        if (key in body) {
          tmFields.push(`${key} = $${i++}`);
          const v = body[key];
          tmParams.push(v === "" ? null : v);
        }
      }

      if (tmFields.length > 0) {
        tmFields.push(`updated_at = NOW()`);
        const ownerIdx = i++;
        const idIdx = i++;
        tmParams.push(wreq.workspaceOwnerId, tmId);

        await db.query(
          `UPDATE team_members SET ${tmFields.join(", ")}
            WHERE workspace_owner_id = $${ownerIdx} AND id = $${idIdx}`,
          tmParams,
        );
      }

      // ── Sync people/team_member_profiles when email changes ──────────────
      if ("email" in body) {
        const newEmail = body.email ? String(body.email).trim() || null : null;

        // Find the profile row linked to this team_member
        const profileResult = await db.query<{ id: number; person_id: number }>(
          `SELECT id, person_id FROM team_member_profiles
            WHERE team_member_id = $1 AND workspace_owner_id = $2
            LIMIT 1`,
          [tmId, wreq.workspaceOwnerId],
        );

        if (profileResult.rows.length > 0) {
          const profile = profileResult.rows[0];

          if (newEmail) {
            // Check if a people row with the new email already exists
            const matchResult = await db.query<{ id: number }>(
              `SELECT id FROM people
                WHERE workspace_owner_id = $1 AND LOWER(email) = LOWER($2)
                LIMIT 1`,
              [wreq.workspaceOwnerId, newEmail],
            );

            if (matchResult.rows.length > 0) {
              const matchedPersonId = matchResult.rows[0].id;
              if (matchedPersonId !== profile.person_id) {
                // Re-link the profile to the already-existing people row
                await db.query(
                  `UPDATE team_member_profiles
                     SET person_id = $1, updated_at = NOW()
                   WHERE id = $2 AND workspace_owner_id = $3`,
                  [matchedPersonId, profile.id, wreq.workspaceOwnerId],
                );
              }
              // The matched people row already has the correct email — no further update needed
            } else {
              // No existing people row with that email — update the current one
              await db.query(
                `UPDATE people SET email = $1, updated_at = NOW()
                  WHERE id = $2 AND workspace_owner_id = $3`,
                [newEmail, profile.person_id, wreq.workspaceOwnerId],
              );
            }
          } else {
            // Email cleared — clear it on the linked people row too
            await db.query(
              `UPDATE people SET email = NULL, updated_at = NOW()
                WHERE id = $1 AND workspace_owner_id = $2`,
              [profile.person_id, wreq.workspaceOwnerId],
            );
          }
        }
      }

      // ── Sync first_name, last_name, phone on linked people row ──────────
      const namePhoneUpdates: Record<string, unknown> = {};
      for (const field of ["first_name", "last_name", "phone"] as const) {
        if (field in body) {
          const v = body[field];
          namePhoneUpdates[field] = v === "" ? null : v;
        }
      }

      if (Object.keys(namePhoneUpdates).length > 0) {
        const npProfileResult = await db.query<{ id: number; person_id: number }>(
          `SELECT id, person_id FROM team_member_profiles
            WHERE team_member_id = $1 AND workspace_owner_id = $2
            LIMIT 1`,
          [tmId, wreq.workspaceOwnerId],
        );

        if (npProfileResult.rows.length > 0) {
          const npProfile = npProfileResult.rows[0];
          const setClauses: string[] = [];
          const params: unknown[] = [];
          let idx = 1;

          for (const [field, value] of Object.entries(namePhoneUpdates)) {
            setClauses.push(`${field} = $${idx}`);
            params.push(value);
            idx++;
          }
          setClauses.push(`updated_at = NOW()`);
          params.push(npProfile.person_id, wreq.workspaceOwnerId);

          await db.query(
            `UPDATE people SET ${setClauses.join(", ")}
              WHERE id = $${idx} AND workspace_owner_id = $${idx + 1}`,
            params,
          );
        }
      }

      // ── Sync job_title on linked team_member_profiles row ───────────────
      if ("job_title" in body) {
        const jtValue = body.job_title === "" ? null : body.job_title;

        const jtProfileResult = await db.query<{ id: number }>(
          `SELECT id FROM team_member_profiles
            WHERE team_member_id = $1 AND workspace_owner_id = $2
            LIMIT 1`,
          [tmId, wreq.workspaceOwnerId],
        );

        if (jtProfileResult.rows.length > 0) {
          await db.query(
            `UPDATE team_member_profiles
               SET job_title = $1, updated_at = NOW()
             WHERE team_member_id = $2 AND workspace_owner_id = $3`,
            [jtValue, tmId, wreq.workspaceOwnerId],
          );
        }
      }

      if ("attendance_enabled" in body) {
        const enabled = body.attendance_enabled === true || body.attendance_enabled === "true";
        const profileCheck = await db.query<{ id: number }>(
          `SELECT id FROM team_member_profiles
            WHERE team_member_id = $1 AND workspace_owner_id = $2`,
          [tmId, wreq.workspaceOwnerId],
        );
        if (profileCheck.rows.length > 0) {
          await db.query(
            `UPDATE team_member_profiles
               SET attendance_enabled = $1, updated_at = NOW()
             WHERE team_member_id = $2 AND workspace_owner_id = $3`,
            [enabled, tmId, wreq.workspaceOwnerId],
          );
        } else {
          await db.query(
            `INSERT INTO team_member_profiles
               (workspace_owner_id, team_member_id, attendance_enabled)
             VALUES ($1, $2, $3)`,
            [wreq.workspaceOwnerId, tmId, enabled],
          );
        }
      }

      if (tmFields.length === 0 && !("attendance_enabled" in body) && !("job_title" in body)) {
        res.status(400).json({ error: "No fields to update" });
        return;
      }

      // ── Write audit log entries for changed fields ────────────────────────
      const auditableFields: Array<keyof typeof beforeState> = [
        "first_name", "last_name", "email", "phone",
        "department_id", "employment_status", "manager_id", "work_schedule_id",
        "birthday", "start_date",
        "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship",
        "notes", "job_title", "attendance_enabled",
      ];

      const auditChanges: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [];

      for (const field of auditableFields) {
        if (!(field in body)) continue;
        const rawNew = body[field];
        const newNorm = rawNew === "" || rawNew == null ? null : String(rawNew);
        const oldNorm = beforeState[field] == null ? null : String(beforeState[field]);
        if (oldNorm !== newNorm) {
          auditChanges.push({ field, oldVal: oldNorm, newVal: newNorm });
        }
      }

      if (auditChanges.length > 0) {
        const valuePlaceholders = auditChanges.map(
          (_, idx) => `($1, $2, $3, $${4 + idx * 3}, $${5 + idx * 3}, $${6 + idx * 3})`,
        );
        const auditParams: unknown[] = [wreq.workspaceOwnerId, tmId, wreq.userId];
        for (const { field, oldVal, newVal } of auditChanges) {
          auditParams.push(field, oldVal, newVal);
        }
        try {
          await db.query(
            `INSERT INTO people_audit_log
               (workspace_owner_id, team_member_id, changed_by_user_id, field_name, old_value, new_value)
             VALUES ${valuePlaceholders.join(", ")}`,
            auditParams,
          );
        } catch (auditErr) {
          logger.error({ err: auditErr, tmId }, "people_audit_log INSERT failed; person update itself succeeded");
        }
      }
    } else {
      res.status(400).json({ error: "Only team member (tm_) records can be updated via this endpoint" });
      return;
    }

    const rows = await buildPeopleList(wreq.workspaceOwnerId);
    const person = rows.find((p) => p.id === rawId);

    if (!person) {
      res.status(404).json({ error: "Person not found after update" });
      return;
    }

    const detail = await enrichPersonDetail(person, wreq.workspaceOwnerId);
    res.json(detail);
  } catch (err) {
    logger.error({ err }, "Failed to update person");
    res.status(500).json({ error: "Failed to update person" });
  }
});

/**
 * PATCH /people/:id/schedule
 * Assign or clear the work schedule for a team member.
 * Accessible to any authenticated workspace member (owners and managers alike).
 */
router.patch("/people/:id/schedule", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!rawId.startsWith("tm_")) {
    res.status(400).json({ error: "Only team member records support schedule assignment" });
    return;
  }

  const tmId = parseInt(rawId.slice(3), 10);
  if (isNaN(tmId)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const rawScheduleId = body.work_schedule_id;
  const scheduleId =
    rawScheduleId == null || rawScheduleId === ""
      ? null
      : Number(rawScheduleId);
  if (rawScheduleId !== null && rawScheduleId !== "" && isNaN(scheduleId as number)) {
    res.status(400).json({ error: "Invalid work_schedule_id" });
    return;
  }

  try {
    const checkResult = await db.query<{ id: number; work_schedule_id: number | null }>(
      `SELECT id, work_schedule_id FROM team_members
        WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL`,
      [wreq.workspaceOwnerId, tmId],
    );
    if (checkResult.rows.length === 0) {
      res.status(404).json({ error: "Person not found" });
      return;
    }

    const oldScheduleId = checkResult.rows[0].work_schedule_id;

    await db.query(
      `UPDATE team_members SET work_schedule_id = $1, updated_at = NOW()
        WHERE workspace_owner_id = $2 AND id = $3`,
      [scheduleId, wreq.workspaceOwnerId, tmId],
    );

    const oldNorm = oldScheduleId == null ? null : String(oldScheduleId);
    const newNorm = scheduleId == null ? null : String(scheduleId);
    if (oldNorm !== newNorm) {
      await db.query(
        `INSERT INTO people_audit_log
           (workspace_owner_id, team_member_id, changed_by_user_id, field_name, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [wreq.workspaceOwnerId, tmId, wreq.userId, "work_schedule_id", oldNorm, newNorm],
      );
    }

    const rows = await buildPeopleList(wreq.workspaceOwnerId);
    const person = rows.find((p) => p.id === rawId);
    if (!person) {
      res.status(404).json({ error: "Person not found after update" });
      return;
    }
    const detail = await enrichPersonDetail(person, wreq.workspaceOwnerId);
    res.json(detail);
  } catch (err) {
    logger.error({ err }, "Failed to update work schedule");
    res.status(500).json({ error: "Failed to update work schedule" });
  }
});

/**
 * DELETE /people/:id
 * Archive a person (owner only).
 * For tm_ IDs: sets archived_at on team_member.
 */
router.delete("/people/:id", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can remove people" });
    return;
  }

  try {
    if (rawId.startsWith("tm_")) {
      const tmId = parseInt(rawId.slice(3), 10);
      if (isNaN(tmId)) {
        res.status(400).json({ error: "Invalid ID" });
        return;
      }

      const result = await db.query<{ id: number }>(
        `UPDATE team_members SET archived_at = NOW(), updated_at = NOW()
          WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL
          RETURNING id`,
        [wreq.workspaceOwnerId, tmId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Person not found" });
        return;
      }
    } else {
      res.status(400).json({ error: "Only team member (tm_) records can be archived via this endpoint" });
      return;
    }

    res.sendStatus(204);
  } catch (err) {
    logger.error({ err }, "Failed to archive person");
    res.status(500).json({ error: "Failed to archive person" });
  }
});

/**
 * POST /people/:id/external-profile
 * Create an external profile for a person (owner only).
 * :id must be a person ID in any format (tm_, wm_, ep_, or numeric person_id).
 */
router.post("/people/:id/external-profile", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage external profiles" });
    return;
  }

  const body = req.body as Record<string, unknown>;

  try {
    // Resolve person_id from the composite ID
    let personId: number | null = null;

    if (rawId.startsWith("tm_")) {
      const tmId = parseInt(rawId.slice(3), 10);
      const profileResult = await db.query<{ person_id: number }>(
        `SELECT person_id FROM team_member_profiles
          WHERE team_member_id = $1 AND workspace_owner_id = $2 LIMIT 1`,
        [tmId, wreq.workspaceOwnerId],
      );
      if (profileResult.rows.length > 0) personId = profileResult.rows[0].person_id;
    } else if (rawId.startsWith("wm_")) {
      const wmId = parseInt(rawId.slice(3), 10);
      // Schema sentinel: reads workspace_members.member_email for wm_ ID resolution.
      // Update here if member_email is renamed.
      const wmResult = await db.query<{ member_email: string }>(
        `SELECT member_email FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
        [wmId, wreq.workspaceOwnerId],
      );
      if (wmResult.rows.length > 0) {
        const pResult = await db.query<{ id: number }>(
          `SELECT id FROM people WHERE workspace_owner_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
          [wreq.workspaceOwnerId, wmResult.rows[0].member_email],
        );
        if (pResult.rows.length > 0) personId = pResult.rows[0].id;
      }
    } else if (rawId.startsWith("ep_")) {
      personId = parseInt(rawId.slice(3), 10);
    } else {
      const numId = parseInt(rawId, 10);
      if (!isNaN(numId)) personId = numId;
    }

    if (!personId) {
      res.status(404).json({ error: "Person not found" });
      return;
    }

    // Verify the person belongs to this workspace
    const personCheck = await db.query<{ id: number }>(
      `SELECT id FROM people WHERE id = $1 AND workspace_owner_id = $2`,
      [personId, wreq.workspaceOwnerId],
    );
    if (personCheck.rows.length === 0) {
      res.status(404).json({ error: "Person not found" });
      return;
    }

    // Upsert external profile
    const externalType = typeof body.external_type === "string" ? body.external_type : "other";
    const companyName = body.company_name ? String(body.company_name).trim() || null : null;
    const reasonForAccess = body.reason_for_access ? String(body.reason_for_access).trim() || null : null;
    const notes = body.notes ? String(body.notes).trim() || null : null;
    const internalOwnerPersonId = body.internal_owner_person_id ? Number(body.internal_owner_person_id) || null : null;

    const result = await db.query<{ id: number }>(
      `INSERT INTO external_profiles
         (workspace_owner_id, person_id, external_type, company_name,
          internal_owner_person_id, reason_for_access, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       ON CONFLICT (workspace_owner_id, person_id) DO NOTHING
       RETURNING id`,
      [wreq.workspaceOwnerId, personId, externalType, companyName, internalOwnerPersonId, reasonForAccess, notes],
    );

    if (result.rows.length === 0) {
      res.status(409).json({ error: "An external profile already exists for this person" });
      return;
    }

    res.status(201).json({ id: result.rows[0].id, person_id: personId });
  } catch (err) {
    logger.error({ err }, "Failed to create external profile");
    res.status(500).json({ error: "Failed to create external profile" });
  }
});

/**
 * PATCH /people/:id/external-profile
 * Update the external profile for a person (owner only).
 */
router.patch("/people/:id/external-profile", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage external profiles" });
    return;
  }

  const body = req.body as Record<string, unknown>;

  try {
    // Resolve the external_profile row
    let epRow: { id: number } | null = null;

    if (rawId.startsWith("ep_")) {
      const personId = parseInt(rawId.slice(3), 10);
      const r = await db.query<{ id: number }>(
        `SELECT id FROM external_profiles WHERE person_id = $1 AND workspace_owner_id = $2 AND status = 'active' LIMIT 1`,
        [personId, wreq.workspaceOwnerId],
      );
      if (r.rows.length > 0) epRow = r.rows[0];
    } else if (rawId.startsWith("tm_")) {
      const tmId = parseInt(rawId.slice(3), 10);
      const r = await db.query<{ id: number }>(
        `SELECT ep.id FROM external_profiles ep
           JOIN team_member_profiles tmp ON tmp.person_id = ep.person_id
          WHERE tmp.team_member_id = $1 AND ep.workspace_owner_id = $2 AND ep.status = 'active'
          LIMIT 1`,
        [tmId, wreq.workspaceOwnerId],
      );
      if (r.rows.length > 0) epRow = r.rows[0];
    } else if (rawId.startsWith("wm_")) {
      const wmId = parseInt(rawId.slice(3), 10);
      // Schema sentinel: JOINs workspace_members on LOWER(wm.member_email) for wm_ ID resolution.
      // Update here if member_email is renamed.
      const r = await db.query<{ id: number }>(
        `SELECT ep.id FROM external_profiles ep
           JOIN people p ON p.id = ep.person_id
           JOIN workspace_members wm ON LOWER(wm.member_email) = LOWER(p.email)
          WHERE wm.id = $1 AND ep.workspace_owner_id = $2 AND ep.status = 'active'
          LIMIT 1`,
        [wmId, wreq.workspaceOwnerId],
      );
      if (r.rows.length > 0) epRow = r.rows[0];
    }

    if (!epRow) {
      res.status(404).json({ error: "External profile not found" });
      return;
    }

    const allowed = ["external_type", "company_name", "reason_for_access", "notes", "internal_owner_person_id"];
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const key of allowed) {
      if (key in body) {
        setClauses.push(`${key} = $${idx++}`);
        const v = body[key];
        params.push(v === "" ? null : v);
      }
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(epRow.id, wreq.workspaceOwnerId);

    await db.query(
      `UPDATE external_profiles SET ${setClauses.join(", ")}
        WHERE id = $${idx} AND workspace_owner_id = $${idx + 1}`,
      params,
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to update external profile");
    res.status(500).json({ error: "Failed to update external profile" });
  }
});

/**
 * DELETE /people/:id/external-profile
 * Archive (soft-delete) the external profile for a person (owner only).
 */
router.delete("/people/:id/external-profile", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage external profiles" });
    return;
  }

  try {
    let updateResult: { rowCount: number | null };

    if (rawId.startsWith("ep_")) {
      const personId = parseInt(rawId.slice(3), 10);
      updateResult = await db.query(
        `UPDATE external_profiles SET status = 'archived', updated_at = NOW()
          WHERE person_id = $1 AND workspace_owner_id = $2 AND status = 'active'`,
        [personId, wreq.workspaceOwnerId],
      );
    } else if (rawId.startsWith("tm_")) {
      const tmId = parseInt(rawId.slice(3), 10);
      updateResult = await db.query(
        `UPDATE external_profiles ep SET status = 'archived', updated_at = NOW()
           FROM team_member_profiles tmp
          WHERE tmp.person_id = ep.person_id
            AND tmp.team_member_id = $1
            AND ep.workspace_owner_id = $2
            AND ep.status = 'active'`,
        [tmId, wreq.workspaceOwnerId],
      );
    } else if (rawId.startsWith("wm_")) {
      const wmId = parseInt(rawId.slice(3), 10);
      // Schema sentinel: JOINs workspace_members on LOWER(wm.member_email) to resolve wm_ ID.
      // Update here if member_email is renamed.
      updateResult = await db.query(
        `UPDATE external_profiles ep SET status = 'archived', updated_at = NOW()
           FROM people p
           JOIN workspace_members wm ON LOWER(wm.member_email) = LOWER(p.email)
          WHERE p.id = ep.person_id
            AND wm.id = $1
            AND ep.workspace_owner_id = $2
            AND ep.status = 'active'`,
        [wmId, wreq.workspaceOwnerId],
      );
    } else {
      res.status(400).json({ error: "Unsupported ID format" });
      return;
    }

    if (!updateResult.rowCount || updateResult.rowCount === 0) {
      res.status(404).json({ error: "External profile not found" });
      return;
    }

    res.sendStatus(204);
  } catch (err) {
    logger.error({ err }, "Failed to delete external profile");
    res.status(500).json({ error: "Failed to delete external profile" });
  }
});

/**
 * POST /people/:id/revoke-access
 * Revoke workspace login access for a person identified by their wm_ ID.
 * Sets revoked_by and revoked_at on the workspace_members row. Owner only.
 */
router.post("/people/:id/revoke-access", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can revoke access" });
    return;
  }

  try {
    let memberId: number | null = null;

    if (rawId.startsWith("wm_")) {
      memberId = parseInt(rawId.slice(3), 10);
    } else if (rawId.startsWith("ep_")) {
      // External user — find their workspace_member row by email
      const personId = parseInt(rawId.slice(3), 10);
      const emailResult = await db.query<{ email: string }>(
        `SELECT email FROM people WHERE id = $1 AND workspace_owner_id = $2`,
        [personId, wreq.workspaceOwnerId],
      );
      if (emailResult.rows.length > 0 && emailResult.rows[0].email) {
        // Schema sentinel: reads workspace_members.member_email (LOWER match) for ep_ ID resolution.
        // The following UPDATE writes revoked_by and revoked_at.
        // Update here if member_email, revoked_by, or revoked_at is renamed.
        const wmResult = await db.query<{ id: number }>(
          `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND LOWER(member_email) = LOWER($2)`,
          [wreq.workspaceOwnerId, emailResult.rows[0].email],
        );
        if (wmResult.rows.length > 0) memberId = wmResult.rows[0].id;
      }
    }

    if (!memberId || isNaN(memberId)) {
      res.status(404).json({ error: "No workspace access record found for this person" });
      return;
    }

    const result = await db.query<{ id: number }>(
      `UPDATE workspace_members
          SET revoked_by = $1, revoked_at = NOW()
        WHERE id = $2 AND workspace_owner_id = $3 AND revoked_at IS NULL
        RETURNING id`,
      [wreq.userId, memberId, wreq.workspaceOwnerId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Workspace member not found or access already revoked" });
      return;
    }

    res.json({ success: true, member_id: memberId });
  } catch (err) {
    logger.error({ err }, "Failed to revoke access");
    res.status(500).json({ error: "Failed to revoke access" });
  }
});

/**
 * PATCH /people/:id/access-expiry
 * Set or clear the access_expires_at date for a workspace member. Owner only.
 * Body: { access_expires_at: ISO date string | null }
 */
router.patch("/people/:id/access-expiry", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can set access expiry" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const expiresAt = body.access_expires_at != null ? String(body.access_expires_at) || null : null;

  try {
    let memberId: number | null = null;

    if (rawId.startsWith("wm_")) {
      memberId = parseInt(rawId.slice(3), 10);
    } else if (rawId.startsWith("ep_")) {
      const personId = parseInt(rawId.slice(3), 10);
      const emailResult = await db.query<{ email: string }>(
        `SELECT email FROM people WHERE id = $1 AND workspace_owner_id = $2`,
        [personId, wreq.workspaceOwnerId],
      );
      if (emailResult.rows.length > 0 && emailResult.rows[0].email) {
        // Schema sentinel: reads workspace_members.member_email (LOWER match) for ep_ ID resolution.
        // The following UPDATE writes access_expires_at.
        // Update here if member_email or access_expires_at is renamed.
        const wmResult = await db.query<{ id: number }>(
          `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND LOWER(member_email) = LOWER($2)`,
          [wreq.workspaceOwnerId, emailResult.rows[0].email],
        );
        if (wmResult.rows.length > 0) memberId = wmResult.rows[0].id;
      }
    }

    if (!memberId || isNaN(memberId)) {
      res.status(404).json({ error: "No workspace access record found for this person" });
      return;
    }

    const result = await db.query<{ id: number }>(
      `UPDATE workspace_members
          SET access_expires_at = $1
        WHERE id = $2 AND workspace_owner_id = $3
        RETURNING id`,
      [expiresAt, memberId, wreq.workspaceOwnerId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Workspace member not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to update access expiry");
    res.status(500).json({ error: "Failed to update access expiry" });
  }
});

export default router;
