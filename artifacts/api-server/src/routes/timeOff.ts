import { Router } from "express";
import { z } from "zod";
import { clerkClient } from "@clerk/express";
import multer from "multer";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../lib/db";
import { drizzleDb } from "../lib/drizzle.js";
import {
  timeOffTypes,
  timeOffPolicies,
  userTimeOffPolicies,
  timeOffBalances,
  timeOffRequests,
  timeOffNotifications,
  timeOffBalanceAdjustments,
  blackoutDates,
  workspaceMembers,
  memberLocations,
  locations,
  publicHolidayCalendars,
  publicHolidays,
  userHolidayCalendars,
} from "@workspace/db/schema";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { getOrCreateBalance, calculateWorkingDays, computeVacationRemaining } from "../lib/timeOffBalances";
import type { WorkingDaysConfig } from "../lib/timeOffBalances";
import { subscribe, broadcast } from "../lib/timeOffSse";
import { sendTimeOffDecisionEmail, sendTimeOffRequestSubmittedEmail, sendTimeOffRequestConfirmationEmail, sendAnnualLeavePolicyAssignedEmail, sendTimeOffCancelledEmail } from "../lib/email";
import { logger } from "../lib/logger";
import {
  getSupportedCountries,
  getSupportedRegions,
  getHolidays,
  getAvailableTypes,
} from "../lib/holidayImportService";
import { COUNTRY_CATALOGUE } from "../lib/defaults";
import type { NormalizedHoliday } from "../lib/holidayImportService";

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * Batch-fetch first/last names from Clerk for the given userIds.
 * Returns a map keyed by Clerk user id. Failures are non-fatal — callers
 * fall back to the workspace member email.
 */
async function fetchClerkNames(
  userIds: string[],
): Promise<Map<string, { firstName: string | null; lastName: string | null; imageUrl: string | null }>> {
  const map = new Map<string, { firstName: string | null; lastName: string | null; imageUrl: string | null }>();
  if (userIds.length === 0) return map;
  try {
    const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 100 });
    for (const u of clerkUsers.data) {
      map.set(u.id, {
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        imageUrl: u.hasImage && u.imageUrl ? u.imageUrl : null,
      });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to batch-fetch Clerk profile names");
  }
  return map;
}

/**
 * Build a deep link to the Team Time Off approvals page from the incoming
 * request's host. Falls back to the production dashboard URL if the host
 * header isn't usable.
 */
function buildApprovalsUrl(req: { protocol?: string; get?: (h: string) => string | undefined; headers?: Record<string, string | string[] | undefined> }): string {
  const fallback = "https://os.presentail.com/time-off/approvals";
  try {
    const forwardedProto = req.headers?.["x-forwarded-proto"];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
      || req.protocol
      || "https";
    const host = req.get?.("host") ?? (req.headers?.["host"] as string | undefined);
    if (!host) return fallback;
    return `${proto}://${host}/time-off/approvals`;
  } catch {
    return fallback;
  }
}

function displayName(
  firstName: string | null,
  lastName: string | null,
  email: string,
): string {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || email;
}

/**
 * Fetch manual balance adjustment history rows for a given workspace member.
 *
 * Schema sentinel — this function reads the following workspace_members columns
 * via a LEFT JOIN.  If either column is ever renamed in a schema migration you
 * MUST update both the SQL below and the integration tests that seed those rows:
 *   - workspace_members.member_user_id  (aliased → adjusted_by_user_id)
 *   - workspace_members.member_email    (aliased → adjusted_by_email)
 *
 * Having the query in exactly one place means column-name drift can only happen
 * here, not silently diverge across multiple raw-SQL call sites.
 */
async function fetchBalanceAdjustments(memberId: number): Promise<
  Array<{
    id: number;
    policy_year: number;
    vacation_entitled_before: number;
    vacation_entitled_after: number;
    amount_changed: number;
    reason: string;
    adjusted_by_name: string;
    adjusted_at: string;
  }>
> {
  const adjWm = alias(workspaceMembers, "adj");
  const rows = await drizzleDb.select({
    id: timeOffBalanceAdjustments.id,
    policy_year: timeOffBalanceAdjustments.policyYear,
    vacation_entitled_before: timeOffBalanceAdjustments.vacationEntitledBefore,
    vacation_entitled_after: timeOffBalanceAdjustments.vacationEntitledAfter,
    reason: timeOffBalanceAdjustments.reason,
    created_at: timeOffBalanceAdjustments.createdAt,
    adjusted_by_user_id: adjWm.memberUserId,
    adjusted_by_email: adjWm.memberEmail,
  }).from(timeOffBalanceAdjustments)
    .leftJoin(adjWm, eq(adjWm.id, timeOffBalanceAdjustments.adjustedByMemberId))
    .where(eq(timeOffBalanceAdjustments.memberId, memberId))
    .orderBy(desc(timeOffBalanceAdjustments.createdAt));

  const userIds = [
    ...new Set(
      rows
        .map((r) => r.adjusted_by_user_id)
        .filter((id): id is string => id != null),
    ),
  ];
  const nameMap = await fetchClerkNames(userIds);

  return rows.map((r) => {
    const clerkInfo = r.adjusted_by_user_id
      ? nameMap.get(r.adjusted_by_user_id)
      : undefined;
    const adjustedByName = clerkInfo
      ? displayName(clerkInfo.firstName, clerkInfo.lastName, r.adjusted_by_email ?? "")
      : (r.adjusted_by_email ?? "Unknown");
    const before = Number(r.vacation_entitled_before);
    const after = Number(r.vacation_entitled_after);
    return {
      id: r.id,
      policy_year: r.policy_year,
      vacation_entitled_before: before,
      vacation_entitled_after: after,
      amount_changed: after - before,
      reason: r.reason,
      adjusted_by_name: adjustedByName,
      adjusted_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
  });
}

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * GET /time-off/balance
 * Returns the current year balance for the authenticated member.
 */
router.get("/time-off/balance", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  try {
    const policyYear = new Date().getFullYear();
    const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
    const vacationRemaining = computeVacationRemaining(balance);

    // Look up the member's manager to surface their name in the request dialog.
    // Schema sentinel: reads workspace_members.manager_member_id (JOIN key),
    // mgr.member_user_id (→ manager_user_id), mgr.member_email (→ manager_email).
    // Update here if any of these columns are renamed in a migration.
    const mgrWm = alias(workspaceMembers, "mgr");
    const [managerRow] = await drizzleDb.select({
      manager_user_id: mgrWm.memberUserId,
      manager_email: mgrWm.memberEmail,
    }).from(workspaceMembers)
      .leftJoin(mgrWm, eq(mgrWm.id, workspaceMembers.managerMemberId))
      .where(eq(workspaceMembers.id, memberId))
      .limit(1);
    let managerName: string | null = null;
    if (managerRow?.manager_user_id && managerRow?.manager_email) {
      const nameMap = await fetchClerkNames([managerRow.manager_user_id]);
      const names = nameMap.get(managerRow.manager_user_id);
      managerName = displayName(names?.firstName ?? null, names?.lastName ?? null, managerRow.manager_email);
    }

    res.json({ balance: { ...balance, vacation_remaining: vacationRemaining, manager_name: managerName } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no active time-off policy")) {
      res.json({ balance: null, message: "No time-off policy assigned" });
      return;
    }
    logger.error({ err, memberId }, "Failed to fetch time-off balance");
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

/**
 * GET /time-off/balance/adjustments
 * Returns manual balance adjustment history for the authenticated member.
 */
router.get("/time-off/balance/adjustments", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const adjustments = await fetchBalanceAdjustments(memberId);
  res.json({ adjustments });
});

/**
 * GET /time-off/members/:memberId/balance
 * Returns the current year balance for a specific member.
 * Only accessible to workspace owners or the member's assigned manager.
 */
router.get("/time-off/members/:memberId/balance", async (req, res) => {
  const wreq = workspace(req);
  const viewerMemberId = wreq.memberDbId;
  if (!viewerMemberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const targetMemberId = parseInt(req.params.memberId, 10);
  if (isNaN(targetMemberId)) {
    res.status(400).json({ error: "Invalid member ID" });
    return;
  }

  const isOwner = wreq.workspaceRole === "owner";

  if (!isOwner) {
    // Schema sentinel: reads workspace_members.manager_member_id to verify
    // the viewer is the assigned manager. Update here if manager_member_id is renamed.
    const [managerCheck] = await drizzleDb.select({ manager_member_id: workspaceMembers.managerMemberId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, targetMemberId), eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);
    const isAssignedManager = managerCheck?.manager_member_id === viewerMemberId;
    if (!isAssignedManager) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
  }

  const [memberCheck] = await drizzleDb.select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, targetMemberId), eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!memberCheck) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  try {
    const policyYear = new Date().getFullYear();
    const balance = await getOrCreateBalance(db, targetMemberId, wreq.workspaceOwnerId, policyYear);
    const vacationRemaining = computeVacationRemaining(balance);
    res.json({ balance: { ...balance, vacation_remaining: vacationRemaining, manager_name: null } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no active time-off policy")) {
      res.json({ balance: null, message: "No time-off policy assigned" });
      return;
    }
    logger.error({ err, memberId: targetMemberId }, "Failed to fetch member time-off balance");
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

/**
 * GET /time-off/members/:memberId/balance/adjustments
 * Returns manual balance adjustment history for a specific member (owner only).
 */
router.get("/time-off/members/:memberId/balance/adjustments", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const targetMemberId = parseInt(req.params.memberId, 10);
  if (isNaN(targetMemberId)) {
    res.status(400).json({ error: "Invalid member ID" });
    return;
  }

  const [memberCheck] = await drizzleDb.select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, targetMemberId), eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!memberCheck) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  const adjustments = await fetchBalanceAdjustments(targetMemberId);
  res.json({ adjustments });
});

/**
 * GET /time-off/requests
 * Returns the authenticated member's own requests, optionally filtered by ?year= and ?type=
 */
router.get("/time-off/requests", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const year = req.query.year ? parseInt(req.query.year as string, 10) : null;
  const typeCode = req.query.type as string | undefined;

  const revWm = alias(workspaceMembers, "rev");
  const drizzleConditions = [
    eq(timeOffRequests.memberId, memberId),
    eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
    isNull(timeOffRequests.deletedAt),
  ];
  if (year && !Number.isNaN(year)) {
    drizzleConditions.push(eq(sql<number>`EXTRACT(YEAR FROM ${timeOffRequests.startDate})`, year) as typeof drizzleConditions[0]);
  }
  if (typeCode) {
    drizzleConditions.push(eq(timeOffTypes.code, typeCode.toUpperCase()) as typeof drizzleConditions[0]);
  }

  // Schema sentinel: reads workspace_members.member_user_id (→ reviewed_by_user_id)
  // and member_email (→ reviewed_by_email) via LEFT JOIN on rev.id = reviewed_by_member_id.
  // Update here if either column is renamed in a migration.
  const rows = await drizzleDb.select({
    id: timeOffRequests.id,
    type_id: timeOffRequests.typeId,
    type_code: timeOffTypes.code,
    type_name: timeOffTypes.name,
    type_color: timeOffTypes.color,
    start_date: sql<string>`TO_CHAR(${timeOffRequests.startDate}, 'YYYY-MM-DD')`,
    end_date: sql<string>`TO_CHAR(${timeOffRequests.endDate}, 'YYYY-MM-DD')`,
    total_days: timeOffRequests.totalDays,
    half_day: timeOffRequests.halfDay,
    half_day_period: timeOffRequests.halfDayPeriod,
    reason: timeOffRequests.reason,
    status: timeOffRequests.status,
    manager_note: timeOffRequests.managerNote,
    created_at: timeOffRequests.createdAt,
    reviewed_at: timeOffRequests.reviewedAt,
    reviewed_by_member_id: timeOffRequests.reviewedByMemberId,
    reviewed_by_user_id: revWm.memberUserId,
    reviewed_by_email: revWm.memberEmail,
    cancelled_at: timeOffRequests.cancelledAt,
    cancelled_by: timeOffRequests.cancelledBy,
    cancellation_reason: timeOffRequests.cancellationReason,
  }).from(timeOffRequests)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
    .leftJoin(revWm, eq(revWm.id, timeOffRequests.reviewedByMemberId))
    .where(and(...drizzleConditions))
    .orderBy(desc(timeOffRequests.startDate));

  const reviewerUserIds = Array.from(
    new Set(
      rows
        .map((r) => r.reviewed_by_user_id)
        .filter((id): id is string => !!id),
    ),
  );

  const cancellerUserIds = Array.from(
    new Set(
      rows
        .map((r) => r.cancelled_by)
        .filter((id): id is string => !!id && id !== wreq.userId),
    ),
  );

  const allUserIdsToFetch = Array.from(new Set([...reviewerUserIds, ...cancellerUserIds]));
  const clerkNameMap = await fetchClerkNames(allUserIdsToFetch);

  const requests = rows.map((r) => {
    const reviewerNames = r.reviewed_by_user_id ? clerkNameMap.get(r.reviewed_by_user_id) : undefined;
    const reviewedByName =
      r.reviewed_by_email != null
        ? displayName(reviewerNames?.firstName ?? null, reviewerNames?.lastName ?? null, r.reviewed_by_email)
        : null;

    let cancelledByName: string | null = null;
    const cancelledBySelf = r.cancelled_by != null && r.cancelled_by === wreq.userId;
    if (r.cancelled_by != null && !cancelledBySelf) {
      const cancellerNames = clerkNameMap.get(r.cancelled_by);
      if (cancellerNames) {
        cancelledByName = displayName(cancellerNames.firstName ?? null, cancellerNames.lastName ?? null, "");
      }
    }

    return {
      id: r.id,
      type_id: r.type_id,
      type_code: r.type_code,
      type_name: r.type_name,
      type_color: r.type_color,
      start_date: r.start_date,
      end_date: r.end_date,
      total_days: r.total_days,
      half_day: r.half_day,
      half_day_period: r.half_day_period,
      reason: r.reason,
      status: r.status,
      manager_note: r.manager_note,
      created_at: r.created_at,
      reviewed_at: r.reviewed_at,
      reviewed_by_name: reviewedByName,
      cancelled_at: r.cancelled_at,
      cancelled_by: r.cancelled_by,
      cancelled_by_name: cancelledByName,
      cancelled_by_self: r.cancelled_by != null ? cancelledBySelf : null,
      cancellation_reason: r.cancellation_reason,
    };
  });

  res.json({ requests });
});

const createRequestBody = z.object({
  typeCode: z.enum(["VACATION", "SICK_LEAVE"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
  halfDay: z.boolean().optional().default(false),
  halfDayPeriod: z.enum(["AM", "PM"]).optional().nullable(),
  // Partial-day selections from the UI for multi-day ranges (accepted for future use).
  startPartial: z.enum(["full", "morning", "afternoon"]).optional().nullable(),
  endPartial: z.enum(["full", "morning", "afternoon"]).optional().nullable(),
  reason: z.string().max(1000).optional().nullable(),
});

/**
 * POST /time-off/requests
 * Create a new time-off request for the authenticated member.
 */
router.post("/time-off/requests", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const parsed = createRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { typeCode, startDate, endDate, halfDay, halfDayPeriod, reason } = parsed.data;

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (start > end) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  // Look up the time_off_type for this workspace.
  const [typeResult] = await drizzleDb.select({ id: timeOffTypes.id, name: timeOffTypes.name })
    .from(timeOffTypes)
    .where(and(
      eq(timeOffTypes.workspaceOwnerId, wreq.workspaceOwnerId),
      eq(timeOffTypes.code, typeCode),
      eq(timeOffTypes.isActive, true),
    ))
    .limit(1);
  if (!typeResult) {
    res.status(404).json({ error: `Time off type '${typeCode}' not found in this workspace` });
    return;
  }
  const typeId = typeResult.id;
  const typeName = typeResult.name;

  // Calculate working days — will be overridden once we have the member row.
  // We resolve it after the member lookup below; for now set a placeholder.
  let totalDays = 0;
  if (halfDay) totalDays = 0.5;

  // Check for overlapping PENDING or APPROVED requests.
  const overlapRows = await drizzleDb.select({ id: timeOffRequests.id })
    .from(timeOffRequests)
    .where(and(
      eq(timeOffRequests.memberId, memberId),
      eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
      isNull(timeOffRequests.deletedAt),
      or(eq(timeOffRequests.status, "PENDING"), eq(timeOffRequests.status, "APPROVED")),
      sql`${timeOffRequests.startDate} <= ${endDate}::date`,
      sql`${timeOffRequests.endDate} >= ${startDate}::date`,
    ))
    .limit(1);
  if (overlapRows.length > 0) {
    res.status(409).json({ error: "You already have a pending or approved request that overlaps these dates" });
    return;
  }

  // Look up the member's manager and work schedule.
  // Schema sentinel: reads workspace_members.member_email (→ requester_email),
  // member_user_id (→ requester_user_id), manager_member_id (JOIN key),
  // mgr.member_user_id (→ manager_user_id), mgr.member_email (→ manager_email),
  // mgr.notify_email_on_time_off_request (→ manager_notify_email), working_days.
  // Update here if any of these columns are renamed in a migration.
  const mgrWm2 = alias(workspaceMembers, "mgr");
  const [memberRow] = await drizzleDb.select({
    manager_member_id: workspaceMembers.managerMemberId,
    requester_email: workspaceMembers.memberEmail,
    requester_user_id: workspaceMembers.memberUserId,
    manager_user_id: mgrWm2.memberUserId,
    manager_email: mgrWm2.memberEmail,
    manager_notify_email: mgrWm2.notifyEmailOnTimeOffRequest,
    working_days: workspaceMembers.workingDays,
  }).from(workspaceMembers)
    .leftJoin(mgrWm2, eq(mgrWm2.id, workspaceMembers.managerMemberId))
    .where(eq(workspaceMembers.id, memberId))
    .limit(1);

  // Now that we have the member's work schedule, compute the real working-day count.
  if (!halfDay) {
    totalDays = calculateWorkingDays(start, end, [], (memberRow?.working_days as WorkingDaysConfig | null) ?? null);
  }

  // Reject requests that span zero working days (e.g. employee requests Fri–Sat on a Sun–Thu schedule).
  if (!halfDay && totalDays === 0) {
    res.status(400).json({ error: "The selected date range contains no working days based on your work schedule." });
    return;
  }

  // For half-day requests, validate that the chosen date falls on a working day.
  if (halfDay) {
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
    const dayKey = dayNames[start.getDay()];
    const effectiveWorkingDays = memberRow?.working_days ?? {
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
    };
    if (!(effectiveWorkingDays as Record<string, boolean>)[dayKey]) {
      res.status(400).json({ error: "Half-day requests must fall on a working day based on your work schedule." });
      return;
    }
  }

  // Resolve the requesting employee's Clerk full name for the notification
  // body, falling back to email (and finally a generic label).
  const memberNameMap = await fetchClerkNames([wreq.userId]);
  const memberNames = memberNameMap.get(wreq.userId);
  const memberName = displayName(
    memberNames?.firstName ?? null,
    memberNames?.lastName ?? null,
    wreq.userEmail ?? "",
  ) || (wreq.userEmail ?? "A team member");

  // Insert the request.
  const [insertResult] = await drizzleDb.insert(timeOffRequests).values({
    workspaceOwnerId: wreq.workspaceOwnerId,
    memberId,
    managerMemberId: memberRow?.manager_member_id ?? null,
    typeId,
    startDate,
    endDate,
    totalDays: String(totalDays),
    halfDay,
    halfDayPeriod: halfDayPeriod ?? null,
    reason: reason ?? null,
    status: "PENDING",
  }).returning({ id: timeOffRequests.id });
  const requestId = insertResult.id;

  // Increment pending balance for vacation type.
  if (typeCode === "VACATION") {
    try {
      const policyYear = start.getFullYear();
      const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
      await drizzleDb.update(timeOffBalances)
        .set({ vacationPending: sql`${timeOffBalances.vacationPending} + ${String(totalDays)}`, updatedAt: new Date() })
        .where(eq(timeOffBalances.id, balance.id));
    } catch (err) {
      logger.warn({ err, memberId }, "Could not increment vacation_pending (no policy assigned?)");
    }
  } else if (typeCode === "SICK_LEAVE") {
    try {
      const policyYear = start.getFullYear();
      const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
      await drizzleDb.update(timeOffBalances)
        .set({ sickLeavePending: sql`${timeOffBalances.sickLeavePending} + ${String(totalDays)}`, updatedAt: new Date() })
        .where(eq(timeOffBalances.id, balance.id));
    } catch (err) {
      logger.warn({ err, memberId }, "Could not increment sick_leave_pending (no policy assigned?)");
    }
  }

  // Notify the assigned manager via time_off_notifications table + SSE.
  // If the requester has no manager assigned, fall back to the workspace
  // owner(s) so the request is not silently dropped.
  const managerMemberId = memberRow?.manager_member_id ?? null;

  type NotifyRecipient = {
    memberId: number;
    email: string | null;
    role: "manager" | "owner";
    notifyEmail: boolean;
  };
  const recipients: NotifyRecipient[] = [];

  if (managerMemberId) {
    recipients.push({
      memberId: managerMemberId,
      email: memberRow?.manager_email ?? null,
      role: "manager",
      notifyEmail: memberRow?.manager_notify_email ?? true,
    });
  } else {
    try {
      // Schema sentinel: owner email fetch reads workspace_members.member_email.
      // Update here if member_email is renamed.
      const ownersResult = await drizzleDb.select({
        id: workspaceMembers.id,
        member_email: workspaceMembers.memberEmail,
        notify_email_on_time_off_request: workspaceMembers.notifyEmailOnTimeOffRequest,
      }).from(workspaceMembers)
        .where(and(
          eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
          eq(workspaceMembers.role, "owner"),
        ));
      for (const owner of ownersResult) {
        // Don't notify the requester even if they happen to be an owner.
        if (owner.id === memberId) continue;
        recipients.push({
          memberId: owner.id,
          email: owner.member_email,
          role: "owner",
          notifyEmail: owner.notify_email_on_time_off_request ?? true,
        });
      }
    } catch (err) {
      logger.warn(
        { err, requestId, workspaceOwnerId: wreq.workspaceOwnerId },
        "Failed to look up workspace owners for manager-less time-off notification",
      );
    }
  }

  // If the requester is a workspace owner and there is no one else to notify
  // (no manager, no other owner), auto-approve the request immediately.
  // Owners are their own authority — they should not need to self-approve from
  // the Approvals page.
  let autoApproved = false;
  if (recipients.length === 0 && wreq.workspaceRole === "owner") {
    try {
      await drizzleDb.update(timeOffRequests)
        .set({ status: "APPROVED", reviewedByMemberId: memberId, reviewedAt: new Date(), updatedAt: new Date() })
        .where(eq(timeOffRequests.id, requestId));
      // Reverse the pending increment and add to used.
      if (typeCode === "VACATION") {
        const policyYear = start.getFullYear();
        const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
        await drizzleDb.update(timeOffBalances)
          .set({
            vacationPending: sql`GREATEST(0, ${timeOffBalances.vacationPending} - ${String(totalDays)})`,
            vacationUsed: sql`${timeOffBalances.vacationUsed} + ${String(totalDays)}`,
            updatedAt: new Date(),
          })
          .where(eq(timeOffBalances.id, balance.id));
      } else if (typeCode === "SICK_LEAVE") {
        const policyYear = start.getFullYear();
        const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
        await drizzleDb.update(timeOffBalances)
          .set({
            sickLeavePending: sql`GREATEST(0, ${timeOffBalances.sickLeavePending} - ${String(totalDays)})`,
            sickLeaveUsed: sql`${timeOffBalances.sickLeaveUsed} + ${String(totalDays)}`,
            updatedAt: new Date(),
          })
          .where(eq(timeOffBalances.id, balance.id));
      }
      autoApproved = true;
    } catch (err) {
      logger.warn({ err, requestId, memberId }, "Auto-approval of owner self-request failed — request left as PENDING");
    }
  }

  if (recipients.length > 0) {
    // Resolve the requester's display name once (used for both the in-app
    // notification body and the email subject/body).
    const requesterUserId = memberRow?.requester_user_id ?? null;
    let firstName: string | null = null;
    let lastName: string | null = null;
    if (requesterUserId) {
      const clerkNames = await fetchClerkNames([requesterUserId]);
      const c = clerkNames.get(requesterUserId);
      if (c) {
        firstName = c.firstName ?? null;
        lastName = c.lastName ?? null;
      }
    }
    const requesterEmail = memberRow?.requester_email ?? wreq.userEmail ?? "a teammate";
    const requesterName = displayName(firstName, lastName, requesterEmail);

    const title = `New ${typeName} request`;
    const body = `${memberName} has requested ${typeName.toLowerCase()} from ${startDate} to ${endDate}.`;
    const approvalsUrl = buildApprovalsUrl(req);

    for (const recipient of recipients) {
      try {
        await drizzleDb.insert(timeOffNotifications).values({
          workspaceOwnerId: wreq.workspaceOwnerId,
          recipientMemberId: recipient.memberId,
          actorMemberId: memberId,
          type: "TIME_OFF_REQUEST",
          title,
          body,
          entityType: "time_off_request",
          entityId: requestId,
        });
        broadcast(recipient.memberId);
      } catch (err) {
        logger.warn(
          { err, recipientMemberId: recipient.memberId, recipientRole: recipient.role },
          "Failed to send time-off notification to recipient",
        );
      }

      // Best-effort: email the recipient so they don't have to be in the app.
      try {
        if (recipient.email) {
          await sendTimeOffRequestSubmittedEmail({
            toEmail: recipient.email,
            requesterName,
            typeName,
            startDate,
            endDate,
            totalDays,
            halfDay,
            halfDayPeriod: halfDayPeriod ?? null,
            reason: reason ?? null,
            approvalsUrl,
          });
        } else {
          logger.warn(
            { recipientMemberId: recipient.memberId, recipientRole: recipient.role, requestId },
            "Recipient has no email on file — skipping time-off request submitted email",
          );
        }
      } catch (err) {
        logger.warn(
          { err, recipientMemberId: recipient.memberId, recipientRole: recipient.role, requestId },
          "Failed to send time-off request submitted email",
        );
      }
    }
  } else {
    logger.warn(
      { requestId, memberId, workspaceOwnerId: wreq.workspaceOwnerId },
      "No manager and no workspace owner found to notify about time-off request",
    );
  }

  // Best-effort: send a confirmation email to the employee who submitted the request.
  const requesterEmail = memberRow?.requester_email ?? wreq.userEmail ?? null;
  if (requesterEmail) {
    try {
      const myRequestsUrl = (() => {
        const fallback = "https://os.presentail.com/time-off/my";
        try {
          const forwardedProto = req.headers?.["x-forwarded-proto"];
          const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
            || req.protocol
            || "https";
          const host = req.get?.("host");
          if (!host) return fallback;
          return `${proto}://${host}/time-off/my`;
        } catch {
          return fallback;
        }
      })();

      await sendTimeOffRequestConfirmationEmail({
        toEmail: requesterEmail,
        typeName,
        startDate,
        endDate,
        totalDays,
        halfDay,
        halfDayPeriod: halfDayPeriod ?? null,
        reason: reason ?? null,
        myRequestsUrl,
      });
    } catch (err) {
      logger.warn({ err, memberId, requestId }, "Failed to send time-off request confirmation email to employee");
    }
  } else {
    logger.warn({ memberId, requestId }, "Requester has no email on file — skipping time-off request confirmation email");
  }

  res.status(201).json({ request: { id: requestId, status: autoApproved ? "APPROVED" : "PENDING", totalDays }, autoApproved });
});

const cancelRequestBody = z.object({
  cancellation_reason: z.string().max(1000).optional().nullable(),
});

/**
 * POST /time-off/requests/:id/cancel
 * Cancel a PENDING or APPROVED (future start date) time-off request.
 *
 * Permission:
 *  - The request owner can always cancel their own request.
 *  - Workspace owners can cancel any member's request.
 */
router.post("/time-off/requests/:id/cancel", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const requestId = parseInt(req.params.id, 10);
  if (Number.isNaN(requestId)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }

  const bodyParsed = cancelRequestBody.safeParse(req.body ?? {});
  const cancellationReason = bodyParsed.success ? (bodyParsed.data.cancellation_reason ?? null) : null;

  // Fetch the request.
  const [tor] = await drizzleDb.select({
    id: timeOffRequests.id,
    member_id: timeOffRequests.memberId,
    status: timeOffRequests.status,
    type_id: timeOffRequests.typeId,
    total_days: timeOffRequests.totalDays,
    start_date: sql<string>`TO_CHAR(${timeOffRequests.startDate}, 'YYYY-MM-DD')`,
    end_date: sql<string>`TO_CHAR(${timeOffRequests.endDate}, 'YYYY-MM-DD')`,
    type_code: timeOffTypes.code,
    type_name: timeOffTypes.name,
    half_day: timeOffRequests.halfDay,
    half_day_period: timeOffRequests.halfDayPeriod,
  }).from(timeOffRequests)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
    .where(and(
      eq(timeOffRequests.id, requestId),
      eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
      isNull(timeOffRequests.deletedAt),
    ))
    .limit(1);

  if (!tor) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  // Permission check: must be the request owner OR a workspace owner.
  const isWorkspaceOwner = wreq.workspaceRole === "owner";
  if (tor.member_id !== memberId && !isWorkspaceOwner) {
    res.status(403).json({ error: "You can only cancel your own requests" });
    return;
  }

  // Status check: only PENDING or APPROVED-future requests can be cancelled.
  const todayStr = new Date().toISOString().slice(0, 10);
  if (tor.status === "PENDING") {
    // Allowed — no extra date check needed.
  } else if (tor.status === "APPROVED" && tor.start_date > todayStr) {
    // Allowed — approved and hasn't started yet.
  } else if (tor.status === "APPROVED") {
    res.status(409).json({ error: "Cannot cancel an approved request that has already started" });
    return;
  } else {
    res.status(409).json({ error: `Requests in status ${tor.status} cannot be cancelled` });
    return;
  }

  // Mark cancelled.
  await drizzleDb.update(timeOffRequests)
    .set({
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledBy: wreq.userId,
      cancellationReason,
      updatedAt: new Date(),
    })
    .where(and(eq(timeOffRequests.id, requestId), eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId)));

  // Clear any pending manager "Action Required" notification for this request
  // so the manager's bell does not stay stuck with stale Approve/Deny buttons.
  try {
    await drizzleDb.update(timeOffNotifications)
      .set({ isRead: true })
      .where(and(
        eq(timeOffNotifications.entityType, "time_off_request"),
        eq(timeOffNotifications.entityId, requestId),
        eq(timeOffNotifications.isRead, false),
      ));
  } catch (err) {
    logger.warn({ err, requestId }, "Could not clear pending manager notification on cancel");
  }

  // Reverse the balance impact based on previous status.
  const totalDays = parseFloat(tor.total_days);
  if (tor.status === "PENDING") {
    // Reverse pending increment.
    if (tor.type_code === "VACATION") {
      try {
        const policyYear = new Date(tor.start_date).getFullYear();
        const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
        await drizzleDb.update(timeOffBalances)
          .set({ vacationPending: sql`GREATEST(0, ${timeOffBalances.vacationPending} - ${String(totalDays)})`, updatedAt: new Date() })
          .where(eq(timeOffBalances.id, balance.id));
      } catch (err) {
        logger.warn({ err, memberId }, "Could not decrement vacation_pending on cancel");
      }
    } else if (tor.type_code === "SICK_LEAVE") {
      try {
        const policyYear = new Date(tor.start_date).getFullYear();
        const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
        await drizzleDb.update(timeOffBalances)
          .set({ sickLeavePending: sql`GREATEST(0, ${timeOffBalances.sickLeavePending} - ${String(totalDays)})`, updatedAt: new Date() })
          .where(eq(timeOffBalances.id, balance.id));
      } catch (err) {
        logger.warn({ err, memberId }, "Could not decrement sick_leave_pending on cancel");
      }
    }
  } else {
    // Was APPROVED — reverse the used balance so days are returned.
    if (tor.type_code === "VACATION") {
      try {
        const policyYear = new Date(tor.start_date).getFullYear();
        const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
        await drizzleDb.update(timeOffBalances)
          .set({ vacationUsed: sql`GREATEST(0, ${timeOffBalances.vacationUsed} - ${String(totalDays)})`, updatedAt: new Date() })
          .where(eq(timeOffBalances.id, balance.id));
      } catch (err) {
        logger.warn({ err, memberId }, "Could not decrement vacation_used on approved-cancel");
      }
    } else if (tor.type_code === "SICK_LEAVE") {
      try {
        const policyYear = new Date(tor.start_date).getFullYear();
        const balance = await getOrCreateBalance(db, memberId, wreq.workspaceOwnerId, policyYear);
        await drizzleDb.update(timeOffBalances)
          .set({ sickLeaveUsed: sql`GREATEST(0, ${timeOffBalances.sickLeaveUsed} - ${String(totalDays)})`, updatedAt: new Date() })
          .where(eq(timeOffBalances.id, balance.id));
      } catch (err) {
        logger.warn({ err, memberId }, "Could not decrement sick_leave_used on approved-cancel");
      }
    }
  }

  // Notify the employee by email when a manager/owner cancels their approved request.
  // Self-cancellations (tor.member_id === memberId) do not trigger the email.
  if (tor.member_id !== memberId) {
    try {
      // Schema sentinel: cancellation notification reads workspace_members:
      //   - member_email, member_user_id
      // Update here if either column is renamed.
      // Fetch the affected employee's email and Clerk user id.
      const [employeeRow] = await drizzleDb.select({ member_email: workspaceMembers.memberEmail, member_user_id: workspaceMembers.memberUserId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.id, tor.member_id))
        .limit(1);
      const employeeEmail = employeeRow?.member_email ?? null;

      if (employeeEmail) {
        // Resolve the employee's display name from Clerk.
        let employeeName: string | null = null;
        if (employeeRow?.member_user_id) {
          const nameMap = await fetchClerkNames([employeeRow.member_user_id]);
          const names = nameMap.get(employeeRow.member_user_id);
          employeeName = displayName(names?.firstName ?? null, names?.lastName ?? null, employeeEmail);
        }

        // Resolve the canceller's display name from Clerk.
        let cancelledByName: string | null = null;
        try {
          // Schema sentinel: canceller lookup reads workspace_members:
          //   - member_email, member_user_id (WHERE filter)
          // Update here if either column is renamed.
          const [cancellerRow] = await drizzleDb.select({ member_email: workspaceMembers.memberEmail, member_user_id: workspaceMembers.memberUserId })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.memberUserId, wreq.userId!), eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId)))
            .limit(1);
          if (cancellerRow?.member_user_id) {
            const nameMap = await fetchClerkNames([cancellerRow.member_user_id]);
            const names = nameMap.get(cancellerRow.member_user_id);
            cancelledByName = displayName(
              names?.firstName ?? null,
              names?.lastName ?? null,
              cancellerRow.member_email ?? wreq.userEmail ?? "",
            );
          } else if (wreq.userEmail) {
            cancelledByName = wreq.userEmail;
          }
        } catch (err) {
          logger.warn({ err }, "Could not resolve canceller name for time-off cancellation email");
        }

        const myRequestsUrl = (() => {
          const fallback = "https://os.presentail.com/time-off/my";
          try {
            const forwardedProto = req.headers?.["x-forwarded-proto"];
            const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
              || req.protocol
              || "https";
            const host = req.get?.("host");
            if (!host) return fallback;
            return `${proto}://${host}/time-off/my`;
          } catch {
            return fallback;
          }
        })();

        await sendTimeOffCancelledEmail({
          toEmail: employeeEmail,
          employeeName,
          typeName: tor.type_name,
          startDate: tor.start_date,
          endDate: tor.end_date,
          totalDays: parseFloat(tor.total_days),
          halfDay: tor.half_day,
          halfDayPeriod: (tor.half_day_period as "AM" | "PM" | null) ?? null,
          cancellationReason,
          cancelledByName,
          myRequestsUrl,
        });
      } else {
        logger.warn(
          { requestId, employeeMemberId: tor.member_id },
          "Employee has no email on file — skipping time-off cancellation email",
        );
      }
    } catch (err) {
      logger.warn({ err, requestId }, "Failed to send time-off cancellation email to employee");
    }
  }

  res.json({ ok: true });
});

/**
 * GET /time-off/team/balances
 * Returns balance summaries for the current manager's direct reports.
 *
 * For each direct report:
 *  - their identity (id, name, email)
 *  - their current-year balance row, if a policy is assigned (else has_policy=false)
 *
 * The balance row is fetched with a LEFT JOIN so members without a policy
 * still appear in the list (with null balance fields and has_policy=false).
 */
router.get("/time-off/team/balances", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const isOwner = wreq.workspaceRole === "owner";
  const policyYear = new Date().getFullYear();

  // Owners may pass ?all=true to see every workspace member; otherwise only
  // direct reports are returned. Non-owners cannot use ?all=true.
  const showAll = isOwner && req.query.all === "true";

  // Schema sentinel: reads workspace_members.member_user_id, member_email,
  // manager_member_id (used in WHERE for direct-reports filter). Update here
  // and in time-off team-balances test mocks if any column is renamed.
  const result = await drizzleDb.select({
    member_id: workspaceMembers.id,
    member_user_id: workspaceMembers.memberUserId,
    member_email: workspaceMembers.memberEmail,
    policy_year: timeOffBalances.policyYear,
    vacation_entitled: timeOffBalances.vacationEntitled,
    vacation_used: timeOffBalances.vacationUsed,
    vacation_pending: timeOffBalances.vacationPending,
    vacation_carryover: timeOffBalances.vacationCarryover,
    sick_leave_entitled: timeOffBalances.sickLeaveEntitled,
    sick_leave_used: timeOffBalances.sickLeaveUsed,
    sick_leave_pending: timeOffBalances.sickLeavePending,
  }).from(workspaceMembers)
    .leftJoin(timeOffBalances, and(
      eq(timeOffBalances.memberId, workspaceMembers.id),
      eq(timeOffBalances.policyYear, policyYear),
    ))
    .where(and(
      eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
      showAll ? undefined : eq(workspaceMembers.managerMemberId, memberId),
      isNotNull(workspaceMembers.joinedAt),
      not(eq(workspaceMembers.id, memberId)),
    ))
    .orderBy(asc(workspaceMembers.memberEmail));

  const userIds = result
    .map((r) => r.member_user_id)
    .filter((id): id is string => !!id);
  const nameMap = await fetchClerkNames(userIds);

  const balances = result.map((r) => {
    const hasPolicy = r.policy_year != null;
    const names = r.member_user_id ? nameMap.get(r.member_user_id) : undefined;
    const vacationEntitled = r.vacation_entitled != null ? Number(r.vacation_entitled) : null;
    const vacationUsed = r.vacation_used != null ? Number(r.vacation_used) : null;
    const vacationPending = r.vacation_pending != null ? Number(r.vacation_pending) : null;
    const vacationCarryover =
      r.vacation_carryover != null ? Number(r.vacation_carryover) : null;
    const vacationRemaining =
      hasPolicy &&
      vacationEntitled != null &&
      vacationCarryover != null &&
      vacationUsed != null &&
      vacationPending != null
        ? vacationEntitled + vacationCarryover - vacationUsed - vacationPending
        : null;
    return {
      member_id: r.member_id,
      member_name: displayName(names?.firstName ?? null, names?.lastName ?? null, r.member_email),
      member_email: r.member_email,
      policy_year: r.policy_year,
      vacation_entitled: vacationEntitled,
      vacation_used: vacationUsed,
      vacation_pending: vacationPending,
      vacation_carryover: vacationCarryover,
      vacation_remaining: vacationRemaining,
      sick_leave_entitled:
        r.sick_leave_entitled != null ? Number(r.sick_leave_entitled) : null,
      sick_leave_used: r.sick_leave_used != null ? Number(r.sick_leave_used) : null,
      sick_leave_pending: r.sick_leave_pending != null ? Number(r.sick_leave_pending) : null,
      has_policy: hasPolicy,
    };
  });

  res.json({ balances });
});

const updateStatusBody = z.object({
  status: z.enum(["APPROVED", "DECLINED"]),
  managerNote: z.string().max(1000).optional().nullable(),
});

/**
 * PATCH /time-off/requests/:id/status
 * Manager approves or denies a pending time-off request.
 *
 * Authorization: caller must be either the workspace owner or the
 * `manager_member_id` recorded on the request.
 */
router.patch("/time-off/requests/:id/status", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const requestId = parseInt(req.params.id, 10);
  if (Number.isNaN(requestId)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }

  const parsed = updateStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { status, managerNote } = parsed.data;

  // Schema sentinel: cancel/update-status request lookup JOINs workspace_members and reads:
  //   - wm.member_email, wm.member_user_id, tor.manager_member_id
  // Update here if any of those columns is renamed.
  const revWm2 = alias(workspaceMembers, "revWm2");
  const [tor] = await drizzleDb.select({
    id: timeOffRequests.id,
    member_id: timeOffRequests.memberId,
    manager_member_id: timeOffRequests.managerMemberId,
    status: timeOffRequests.status,
    type_id: timeOffRequests.typeId,
    type_code: timeOffTypes.code,
    type_name: timeOffTypes.name,
    total_days: timeOffRequests.totalDays,
    start_date: timeOffRequests.startDate,
    end_date: timeOffRequests.endDate,
    half_day: timeOffRequests.halfDay,
    half_day_period: timeOffRequests.halfDayPeriod,
    member_email: revWm2.memberEmail,
    member_user_id: revWm2.memberUserId,
    member_notify_email_on_decision: revWm2.notifyEmailOnTimeOffDecision,
  }).from(timeOffRequests)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
    .innerJoin(revWm2, eq(revWm2.id, timeOffRequests.memberId))
    .where(and(
      eq(timeOffRequests.id, requestId),
      eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
      isNull(timeOffRequests.deletedAt),
    ))
    .limit(1);

  if (!tor) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  const isOwner = wreq.workspaceRole === "owner";
  const isAssignedManager = tor.manager_member_id === memberId;
  if (!isOwner && !isAssignedManager) {
    res.status(403).json({ error: "Only the assigned manager or workspace owner can review this request" });
    return;
  }

  if (tor.status !== "PENDING") {
    res.status(409).json({ error: "Only PENDING requests can be reviewed" });
    return;
  }

  await drizzleDb.update(timeOffRequests)
    .set({ status, managerNote: managerNote ?? null, reviewedByMemberId: memberId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(timeOffRequests.id, requestId));

  // Adjust balances. Always decrement the pending column; if approved,
  // also increment the used column.
  const totalDays = parseFloat(tor.total_days);
  const policyYear = new Date(tor.start_date).getFullYear();
  if (tor.type_code === "VACATION") {
    try {
      const balance = await getOrCreateBalance(db, tor.member_id, wreq.workspaceOwnerId, policyYear);
      if (status === "APPROVED") {
        await drizzleDb.update(timeOffBalances)
          .set({
            vacationPending: sql`GREATEST(0, ${timeOffBalances.vacationPending} - ${String(totalDays)})`,
            vacationUsed: sql`${timeOffBalances.vacationUsed} + ${String(totalDays)}`,
            updatedAt: new Date(),
          })
          .where(eq(timeOffBalances.id, balance.id));
      } else {
        await drizzleDb.update(timeOffBalances)
          .set({ vacationPending: sql`GREATEST(0, ${timeOffBalances.vacationPending} - ${String(totalDays)})`, updatedAt: new Date() })
          .where(eq(timeOffBalances.id, balance.id));
      }
    } catch (err) {
      logger.warn({ err, memberId: tor.member_id }, "Could not update vacation balance on review");
    }
  } else if (tor.type_code === "SICK_LEAVE") {
    try {
      const balance = await getOrCreateBalance(db, tor.member_id, wreq.workspaceOwnerId, policyYear);
      if (status === "APPROVED") {
        await drizzleDb.update(timeOffBalances)
          .set({
            sickLeavePending: sql`GREATEST(0, ${timeOffBalances.sickLeavePending} - ${String(totalDays)})`,
            sickLeaveUsed: sql`${timeOffBalances.sickLeaveUsed} + ${String(totalDays)}`,
            updatedAt: new Date(),
          })
          .where(eq(timeOffBalances.id, balance.id));
      } else {
        await drizzleDb.update(timeOffBalances)
          .set({ sickLeavePending: sql`GREATEST(0, ${timeOffBalances.sickLeavePending} - ${String(totalDays)})`, updatedAt: new Date() })
          .where(eq(timeOffBalances.id, balance.id));
      }
    } catch (err) {
      logger.warn({ err, memberId: tor.member_id }, "Could not update sick-leave balance on review");
    }
  }

  // Mark any related notifications for this request as read so the
  // notification disappears from the manager's bell after action.
  await drizzleDb.update(timeOffNotifications)
    .set({ isRead: true })
    .where(and(
      eq(timeOffNotifications.recipientMemberId, memberId),
      eq(timeOffNotifications.entityType, "time_off_request"),
      eq(timeOffNotifications.entityId, requestId),
    ));

  // Push an SSE event so any other open tabs of this manager refresh too.
  broadcast(memberId);

  // Send a transactional email to the requesting employee so they don't have
  // to visit the Time Off page to learn the decision. Failures are logged but
  // never block the API response. Respect the employee's per-user opt-out.
  if (tor.member_notify_email_on_decision === false) {
    res.json({ ok: true, status });
    return;
  }
  try {
    const userIdsToResolve = [wreq.userId];
    if (tor.member_user_id) userIdsToResolve.push(tor.member_user_id);
    const nameMap = await fetchClerkNames(userIdsToResolve);
    const reviewerNames = nameMap.get(wreq.userId);
    const reviewerName = reviewerNames
      ? displayName(
          reviewerNames.firstName,
          reviewerNames.lastName,
          wreq.userEmail ?? "",
        ) || (wreq.userEmail ?? null)
      : (wreq.userEmail ?? null);

    const employeeNames = tor.member_user_id ? nameMap.get(tor.member_user_id) : undefined;
    const employeeName = employeeNames
      ? displayName(
          employeeNames.firstName,
          employeeNames.lastName,
          tor.member_email,
        ) || tor.member_email
      : tor.member_email;

    const toIsoDate = (value: string | Date): string => {
      if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, "0");
        const d = String(value.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
      return String(value).slice(0, 10);
    };

    await sendTimeOffDecisionEmail({
      toEmail: tor.member_email,
      employeeName,
      status,
      typeName: tor.type_name,
      startDate: toIsoDate(tor.start_date),
      endDate: toIsoDate(tor.end_date),
      totalDays: parseFloat(tor.total_days),
      halfDay: tor.half_day,
      halfDayPeriod: tor.half_day_period as "AM" | "PM" | null,
      managerNote: managerNote ?? null,
      reviewerName,
    });
  } catch (err) {
    logger.warn(
      { err, requestId, memberId: tor.member_id },
      "Failed to send time-off decision email",
    );
  }

  res.json({ ok: true, status });
});

/**
 * GET /time-off/notifications
 * Returns unread time-off notifications for the current member (as manager).
 */
router.get("/time-off/notifications", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.json({ notifications: [] });
    return;
  }

  // Schema sentinel: notifications query JOINs workspace_members and reads:
  //   - wm.member_user_id (→ actor_user_id), wm.member_email (→ actor_email)
  // Update here if either column is renamed.
  const actorWm = alias(workspaceMembers, "actorWm");
  const result = await drizzleDb.select({
    id: timeOffNotifications.id,
    type: timeOffNotifications.type,
    title: timeOffNotifications.title,
    body: timeOffNotifications.body,
    entity_id: timeOffNotifications.entityId,
    is_read: timeOffNotifications.isRead,
    created_at: timeOffNotifications.createdAt,
    actor_user_id: actorWm.memberUserId,
    actor_email: actorWm.memberEmail,
  }).from(timeOffNotifications)
    .innerJoin(actorWm, eq(actorWm.id, timeOffNotifications.actorMemberId))
    .where(and(
      eq(timeOffNotifications.recipientMemberId, memberId),
      eq(timeOffNotifications.isRead, false),
    ))
    .orderBy(desc(timeOffNotifications.createdAt))
    .limit(50);

  const actorUserIds = [
    ...new Set(result.map((r) => r.actor_user_id).filter((id): id is string => !!id)),
  ];
  const actorNameMap = await fetchClerkNames(actorUserIds);
  const notifications = result.map((r) => {
    const names = r.actor_user_id ? actorNameMap.get(r.actor_user_id) : undefined;
    const fullName = [names?.firstName, names?.lastName].filter(Boolean).join(" ").trim();
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      entity_id: r.entity_id,
      is_read: r.is_read,
      created_at: r.created_at,
      actor_name: fullName || null,
      actor_email: r.actor_email,
    };
  });

  res.json({ notifications });
});

/**
 * POST /time-off/notifications/seen
 * Mark time-off notifications as read.
 */
router.post("/time-off/notifications/seen", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const schema = z.object({ ids: z.array(z.number().int().positive()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ids must be a non-empty array of positive integers" });
    return;
  }

  const { ids } = parsed.data;
  await drizzleDb.update(timeOffNotifications)
    .set({ isRead: true })
    .where(and(
      eq(timeOffNotifications.recipientMemberId, memberId),
      inArray(timeOffNotifications.id, ids),
    ));

  res.json({ ok: true });
});

/**
 * POST /time-off/notifications/seen-all
 * Mark all unread "request submitted" (type=TIME_OFF_REQUEST) notifications
 * for the current manager as read. Called when the manager opens the
 * Team Time Off page so the bell badge clears in one shot.
 */
router.post("/time-off/notifications/seen-all", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const updated = await drizzleDb.update(timeOffNotifications)
    .set({ isRead: true })
    .where(and(
      eq(timeOffNotifications.recipientMemberId, memberId),
      eq(timeOffNotifications.type, "TIME_OFF_REQUEST"),
      eq(timeOffNotifications.isRead, false),
    ))
    .returning({ id: timeOffNotifications.id });

  res.json({ ok: true, updated: updated.length });
});

/**
 * GET /time-off/notifications/events
 * SSE stream — emits a "changed" event whenever this member receives a new time-off notification.
 */
router.get("/time-off/notifications/events", (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(": connected\n\n");

  subscribe(memberId, res);
});

// ============================================================
// Phase 3: Manager approvals, admin policies & public holidays
// ============================================================

function canManageTimeOff(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner" || (wreq.allowedPages?.includes("time-off.manage") ?? false);
}

/**
 * GET /time-off/team
 * Returns pending requests for the manager's direct reports, or all requests for owners/admins.
 */
router.get("/time-off/team", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const statusFilter = req.query.status as string | undefined;
  const yearFilter = req.query.year ? parseInt(req.query.year as string, 10) : null;

  const isAdmin = canManageTimeOff(wreq);

  const empWm = alias(workspaceMembers, "empWm");
  const teamRevWm = alias(workspaceMembers, "teamRevWm");

  const drizzleConditions = [
    eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
    isNull(timeOffRequests.deletedAt),
  ] as ReturnType<typeof eq>[];

  if (!isAdmin) {
    drizzleConditions.push(eq(empWm.managerMemberId, memberId) as ReturnType<typeof eq>);
  }

  if (statusFilter) {
    drizzleConditions.push(eq(timeOffRequests.status, statusFilter.toUpperCase()) as ReturnType<typeof eq>);
  } else {
    drizzleConditions.push(eq(timeOffRequests.status, "PENDING") as ReturnType<typeof eq>);
  }

  if (yearFilter && !Number.isNaN(yearFilter)) {
    drizzleConditions.push(sql`EXTRACT(YEAR FROM ${timeOffRequests.startDate}) = ${yearFilter}` as unknown as ReturnType<typeof eq>);
  }

  // Schema sentinel: team pending requests query JOINs workspace_members twice.
  // Reads the following drift-prone columns. Update here if any are renamed:
  //   - emp.member_user_id, emp.member_email, emp.manager_member_id (WHERE filter),
  //     rev.member_user_id (→ reviewed_by_user_id), rev.member_email (→ reviewed_by_email)
  const result = await drizzleDb.select({
    id: timeOffRequests.id,
    member_id: timeOffRequests.memberId,
    member_user_id: empWm.memberUserId,
    member_email: empWm.memberEmail,
    member_working_days: empWm.workingDays,
    type_id: timeOffRequests.typeId,
    type_code: timeOffTypes.code,
    type_name: timeOffTypes.name,
    type_color: timeOffTypes.color,
    start_date: sql<string>`TO_CHAR(${timeOffRequests.startDate}, 'YYYY-MM-DD')`,
    end_date: sql<string>`TO_CHAR(${timeOffRequests.endDate}, 'YYYY-MM-DD')`,
    total_days: timeOffRequests.totalDays,
    half_day: timeOffRequests.halfDay,
    half_day_period: timeOffRequests.halfDayPeriod,
    reason: timeOffRequests.reason,
    status: timeOffRequests.status,
    manager_note: timeOffRequests.managerNote,
    created_at: timeOffRequests.createdAt,
    reviewed_at: timeOffRequests.reviewedAt,
    reviewed_by_user_id: teamRevWm.memberUserId,
    reviewed_by_email: teamRevWm.memberEmail,
    vacation_remaining: sql<number | null>`(${timeOffBalances.vacationEntitled} + COALESCE(${timeOffBalances.vacationCarryover},0) - ${timeOffBalances.vacationUsed} - ${timeOffBalances.vacationPending})`,
  }).from(timeOffRequests)
    .innerJoin(empWm, eq(empWm.id, timeOffRequests.memberId))
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
    .leftJoin(teamRevWm, eq(teamRevWm.id, timeOffRequests.reviewedByMemberId))
    .leftJoin(timeOffBalances, and(
      eq(timeOffBalances.memberId, timeOffRequests.memberId),
      sql`${timeOffBalances.policyYear} = EXTRACT(YEAR FROM ${timeOffRequests.startDate})`,
    ))
    .where(and(...drizzleConditions))
    .orderBy(desc(timeOffRequests.createdAt));

  const teamUserIds = [...new Set(result.map((r) => r.member_user_id).filter((id): id is string => Boolean(id)))];
  const reviewerUserIds = [
    ...new Set(
      result
        .map((r) => r.reviewed_by_user_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const allUserIds = [...new Set([...teamUserIds, ...reviewerUserIds])];
  const nameMap = await fetchClerkNames(allUserIds);
  const requests = result.map((r) => {
    const names = r.member_user_id ? nameMap.get(r.member_user_id) : undefined;
    const reviewerNames = r.reviewed_by_user_id ? nameMap.get(r.reviewed_by_user_id) : undefined;
    const reviewedByName =
      r.reviewed_by_email != null
        ? displayName(reviewerNames?.firstName ?? null, reviewerNames?.lastName ?? null, r.reviewed_by_email)
        : null;
    const {
      reviewed_by_user_id: _ruid,
      reviewed_by_email: _remail,
      ...rest
    } = r;
    return {
      ...rest,
      member_name: displayName(names?.firstName ?? null, names?.lastName ?? null, r.member_email),
      member_image_url: names?.imageUrl ?? null,
      reviewed_by_name: reviewedByName,
      reviewed_by_image_url: r.reviewed_by_user_id ? (nameMap.get(r.reviewed_by_user_id)?.imageUrl ?? null) : null,
    };
  });

  res.json({ requests });
});

/**
 * POST /time-off/requests/:id/approve
 * Approve a pending time-off request. Requester must be the direct manager or have time-off.manage.
 */
router.post("/time-off/requests/:id/approve", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const requestId = parseInt(req.params.id, 10);
  if (Number.isNaN(requestId)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }

  // Schema sentinel: approve request query JOINs workspace_members and reads:
  //   - emp.member_email, emp.member_user_id
  // Update here if either column is renamed.
  const approveEmpWm = alias(workspaceMembers, "approveEmpWm");
  const [tor] = await drizzleDb.select({
    id: timeOffRequests.id,
    member_id: timeOffRequests.memberId,
    manager_member_id: timeOffRequests.managerMemberId,
    status: timeOffRequests.status,
    type_code: timeOffTypes.code,
    type_name: timeOffTypes.name,
    total_days: timeOffRequests.totalDays,
    start_date: timeOffRequests.startDate,
    end_date: timeOffRequests.endDate,
    half_day: timeOffRequests.halfDay,
    half_day_period: timeOffRequests.halfDayPeriod,
    member_email: approveEmpWm.memberEmail,
    member_user_id: approveEmpWm.memberUserId,
  }).from(timeOffRequests)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
    .innerJoin(approveEmpWm, eq(approveEmpWm.id, timeOffRequests.memberId))
    .where(and(
      eq(timeOffRequests.id, requestId),
      eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
      isNull(timeOffRequests.deletedAt),
    ))
    .limit(1);

  if (!tor) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  if (tor.status !== "PENDING") {
    res.status(409).json({ error: "Only PENDING requests can be approved" });
    return;
  }

  // Block self-approval regardless of role — even admins with time-off.manage
  // must not be able to approve their own requests.
  if (tor.member_id === memberId) {
    res.status(403).json({ error: "You cannot approve your own time-off request" });
    return;
  }

  const isAdmin = canManageTimeOff(wreq);
  const isDirectManager = tor.manager_member_id === memberId;

  if (!isAdmin && !isDirectManager) {
    res.status(403).json({ error: "You are not authorized to approve this request" });
    return;
  }

  const totalDays = parseFloat(tor.total_days);

  await drizzleDb.update(timeOffRequests)
    .set({ status: "APPROVED", reviewedByMemberId: memberId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(timeOffRequests.id, requestId));

  if (tor.type_code === "VACATION") {
    try {
      const policyYear = new Date(tor.start_date).getFullYear();
      const balance = await getOrCreateBalance(db, tor.member_id, wreq.workspaceOwnerId, policyYear);
      await drizzleDb.update(timeOffBalances)
        .set({
          vacationPending: sql`GREATEST(0, ${timeOffBalances.vacationPending} - ${String(totalDays)})`,
          vacationUsed: sql`${timeOffBalances.vacationUsed} + ${String(totalDays)}`,
          updatedAt: new Date(),
        })
        .where(eq(timeOffBalances.id, balance.id));
    } catch (err) {
      logger.warn({ err, memberId: tor.member_id }, "Could not update balance on approve");
    }
  } else if (tor.type_code === "SICK_LEAVE") {
    try {
      const policyYear = new Date(tor.start_date).getFullYear();
      const balance = await getOrCreateBalance(db, tor.member_id, wreq.workspaceOwnerId, policyYear);
      await drizzleDb.update(timeOffBalances)
        .set({
          sickLeavePending: sql`GREATEST(0, ${timeOffBalances.sickLeavePending} - ${String(totalDays)})`,
          sickLeaveUsed: sql`${timeOffBalances.sickLeaveUsed} + ${String(totalDays)}`,
          updatedAt: new Date(),
        })
        .where(eq(timeOffBalances.id, balance.id));
    } catch (err) {
      logger.warn({ err, memberId: tor.member_id }, "Could not update sick balance on approve");
    }
  }

  try {
    const approverNameMap = await fetchClerkNames([wreq.userId]);
    const approverNames = approverNameMap.get(wreq.userId);
    const approverName = displayName(
      approverNames?.firstName ?? null,
      approverNames?.lastName ?? null,
      wreq.userEmail ?? "",
    ) || (wreq.userEmail ?? "Your manager");
    await drizzleDb.insert(timeOffNotifications).values({
      workspaceOwnerId: wreq.workspaceOwnerId,
      recipientMemberId: tor.member_id,
      actorMemberId: memberId,
      type: "TIME_OFF_APPROVED",
      title: `${tor.type_name} request approved`,
      body: `${approverName} approved your ${tor.type_name.toLowerCase()} request.`,
      entityType: "time_off_request",
      entityId: requestId,
    });
    broadcast(tor.member_id);
  } catch (err) {
    logger.warn({ err, memberId: tor.member_id }, "Failed to send approval notification");
  }

  try {
    const userIdsToResolve = [wreq.userId];
    if (tor.member_user_id) userIdsToResolve.push(tor.member_user_id);
    const nameMap = await fetchClerkNames(userIdsToResolve);
    const approverNames = nameMap.get(wreq.userId);
    const approverName = displayName(
      approverNames?.firstName ?? null,
      approverNames?.lastName ?? null,
      wreq.userEmail ?? "",
    ) || (wreq.userEmail ?? null);
    const employeeNames = tor.member_user_id ? nameMap.get(tor.member_user_id) : undefined;
    const employeeName = employeeNames
      ? displayName(employeeNames.firstName, employeeNames.lastName, tor.member_email) || tor.member_email
      : tor.member_email;
    await sendTimeOffDecisionEmail({
      toEmail: tor.member_email,
      employeeName,
      status: "APPROVED",
      typeName: tor.type_name,
      startDate: tor.start_date,
      endDate: tor.end_date,
      totalDays: parseFloat(tor.total_days),
      halfDay: tor.half_day,
      halfDayPeriod: tor.half_day_period as "AM" | "PM" | null,
      managerNote: null,
      reviewerName: approverName,
    });
  } catch (err) {
    logger.warn({ err, memberId: tor.member_id }, "Failed to send approval decision email");
  }

  res.json({ ok: true });
});

/**
 * POST /time-off/requests/:id/decline
 * Decline a pending time-off request. Requester must be the direct manager or have time-off.manage.
 */
router.post("/time-off/requests/:id/decline", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const requestId = parseInt(req.params.id, 10);
  if (Number.isNaN(requestId)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }

  const body = z.object({ managerNote: z.string().max(1000).optional().nullable() }).safeParse(req.body ?? {});
  const managerNote = body.success ? (body.data.managerNote ?? null) : null;

  // Schema sentinel: decline request query JOINs workspace_members and reads:
  //   - emp.member_email, emp.member_user_id
  // Update here if either column is renamed.
  const declineEmpWm = alias(workspaceMembers, "declineEmpWm");
  const [tor] = await drizzleDb.select({
    id: timeOffRequests.id,
    member_id: timeOffRequests.memberId,
    manager_member_id: timeOffRequests.managerMemberId,
    status: timeOffRequests.status,
    type_code: timeOffTypes.code,
    type_name: timeOffTypes.name,
    total_days: timeOffRequests.totalDays,
    start_date: timeOffRequests.startDate,
    end_date: timeOffRequests.endDate,
    half_day: timeOffRequests.halfDay,
    half_day_period: timeOffRequests.halfDayPeriod,
    member_email: declineEmpWm.memberEmail,
    member_user_id: declineEmpWm.memberUserId,
  }).from(timeOffRequests)
    .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
    .innerJoin(declineEmpWm, eq(declineEmpWm.id, timeOffRequests.memberId))
    .where(and(
      eq(timeOffRequests.id, requestId),
      eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
      isNull(timeOffRequests.deletedAt),
    ))
    .limit(1);

  if (!tor) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  if (tor.status !== "PENDING") {
    res.status(409).json({ error: "Only PENDING requests can be declined" });
    return;
  }

  // Block self-decline regardless of role — mirrors the self-approval guard.
  if (tor.member_id === memberId) {
    res.status(403).json({ error: "You cannot decline your own time-off request" });
    return;
  }

  const isAdmin = canManageTimeOff(wreq);
  const isDirectManager = tor.manager_member_id === memberId;

  if (!isAdmin && !isDirectManager) {
    res.status(403).json({ error: "You are not authorized to decline this request" });
    return;
  }

  const totalDays = parseFloat(tor.total_days);

  await drizzleDb.update(timeOffRequests)
    .set({ status: "DECLINED", managerNote, reviewedByMemberId: memberId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(timeOffRequests.id, requestId));

  if (tor.type_code === "VACATION") {
    try {
      const policyYear = new Date(tor.start_date).getFullYear();
      const balance = await getOrCreateBalance(db, tor.member_id, wreq.workspaceOwnerId, policyYear);
      await drizzleDb.update(timeOffBalances)
        .set({ vacationPending: sql`GREATEST(0, ${timeOffBalances.vacationPending} - ${String(totalDays)})`, updatedAt: new Date() })
        .where(eq(timeOffBalances.id, balance.id));
    } catch (err) {
      logger.warn({ err, memberId: tor.member_id }, "Could not decrement balance on decline");
    }
  } else if (tor.type_code === "SICK_LEAVE") {
    try {
      const policyYear = new Date(tor.start_date).getFullYear();
      const balance = await getOrCreateBalance(db, tor.member_id, wreq.workspaceOwnerId, policyYear);
      await drizzleDb.update(timeOffBalances)
        .set({ sickLeavePending: sql`GREATEST(0, ${timeOffBalances.sickLeavePending} - ${String(totalDays)})`, updatedAt: new Date() })
        .where(eq(timeOffBalances.id, balance.id));
    } catch (err) {
      logger.warn({ err, memberId: tor.member_id }, "Could not decrement sick balance on decline");
    }
  }

  try {
    const declinerNameMap = await fetchClerkNames([wreq.userId]);
    const declinerNames = declinerNameMap.get(wreq.userId);
    const declinerName = displayName(
      declinerNames?.firstName ?? null,
      declinerNames?.lastName ?? null,
      wreq.userEmail ?? "",
    ) || (wreq.userEmail ?? "Your manager");
    const declineBody = managerNote
      ? `${declinerName} declined your ${tor.type_name.toLowerCase()} request: "${managerNote}"`
      : `${declinerName} declined your ${tor.type_name.toLowerCase()} request.`;
    await drizzleDb.insert(timeOffNotifications).values({
      workspaceOwnerId: wreq.workspaceOwnerId,
      recipientMemberId: tor.member_id,
      actorMemberId: memberId,
      type: "TIME_OFF_DECLINED",
      title: `${tor.type_name} request declined`,
      body: declineBody,
      entityType: "time_off_request",
      entityId: requestId,
    });
    broadcast(tor.member_id);
  } catch (err) {
    logger.warn({ err, memberId: tor.member_id }, "Failed to send decline notification");
  }

  try {
    const userIdsToResolve = [wreq.userId];
    if (tor.member_user_id) userIdsToResolve.push(tor.member_user_id);
    const nameMap = await fetchClerkNames(userIdsToResolve);
    const declinerNames = nameMap.get(wreq.userId);
    const declinerName = displayName(
      declinerNames?.firstName ?? null,
      declinerNames?.lastName ?? null,
      wreq.userEmail ?? "",
    ) || (wreq.userEmail ?? null);
    const employeeNames = tor.member_user_id ? nameMap.get(tor.member_user_id) : undefined;
    const employeeName = employeeNames
      ? displayName(employeeNames.firstName, employeeNames.lastName, tor.member_email) || tor.member_email
      : tor.member_email;
    await sendTimeOffDecisionEmail({
      toEmail: tor.member_email,
      employeeName,
      status: "DECLINED",
      typeName: tor.type_name,
      startDate: tor.start_date,
      endDate: tor.end_date,
      totalDays: parseFloat(tor.total_days),
      halfDay: tor.half_day,
      halfDayPeriod: tor.half_day_period as "AM" | "PM" | null,
      managerNote: managerNote ?? null,
      reviewerName: declinerName,
    });
  } catch (err) {
    logger.warn({ err, memberId: tor.member_id }, "Failed to send decline decision email");
  }

  res.json({ ok: true });
});

// ============================================================
// Policy management (requires time-off.manage or owner)
// ============================================================

/**
 * GET /time-off/policies
 */
router.get("/time-off/policies", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const result = await drizzleDb.select().from(timeOffPolicies)
    .where(eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId))
    .orderBy(asc(timeOffPolicies.name));

  res.json({ policies: result });
});

const policyInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  vacation_days_per_year: z.coerce.number().min(0).max(365),
  sick_leave_days_per_year: z.coerce.number().min(0).max(365).optional().nullable(),
  accrual_type: z.enum(["ANNUAL_GRANT", "MONTHLY_ACCRUAL", "MANUAL"]).optional(),
  annual_grant_month: z.coerce.number().int().min(1).max(12).optional(),
  carryover_allowed: z.boolean().optional(),
  max_carryover_days: z.coerce.number().min(0).optional().nullable(),
  applies_after_months_of_employment: z.coerce.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});

/**
 * POST /time-off/policies
 */
router.post("/time-off/policies", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const parsed = policyInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const [inserted] = await drizzleDb.insert(timeOffPolicies).values({
    workspaceOwnerId: wreq.workspaceOwnerId,
    name: d.name,
    description: d.description ?? null,
    vacationDaysPerYear: String(d.vacation_days_per_year),
    sickLeaveDaysPerYear: d.sick_leave_days_per_year != null ? String(d.sick_leave_days_per_year) : null,
    accrualType: d.accrual_type ?? "ANNUAL_GRANT",
    annualGrantMonth: d.annual_grant_month ?? 1,
    carryoverAllowed: d.carryover_allowed ?? false,
    maxCarryoverDays: d.max_carryover_days != null ? String(d.max_carryover_days) : null,
    appliesAfterMonthsOfEmployment: d.applies_after_months_of_employment ?? 0,
    isActive: d.is_active ?? true,
  }).returning();

  res.status(201).json({ policy: inserted });
});

/**
 * GET /time-off/policies/:id
 */
router.get("/time-off/policies/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const policyId = parseInt(req.params.id, 10);
  if (Number.isNaN(policyId)) {
    res.status(400).json({ error: "Invalid policy id" });
    return;
  }

  const result = await drizzleDb.select().from(timeOffPolicies)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);

  if (result.length === 0) {
    res.status(404).json({ error: "Policy not found" });
    return;
  }

  res.json({ policy: result[0] });
});

/**
 * PATCH /time-off/policies/:id
 */
router.patch("/time-off/policies/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const policyId = parseInt(req.params.id, 10);
  if (Number.isNaN(policyId)) {
    res.status(400).json({ error: "Invalid policy id" });
    return;
  }

  const [existingPolicy] = await drizzleDb.select({ id: timeOffPolicies.id }).from(timeOffPolicies)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!existingPolicy) {
    res.status(404).json({ error: "Policy not found" });
    return;
  }

  const parsed = policyInputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) setValues.name = d.name;
  if (d.description !== undefined) setValues.description = d.description;
  if (d.vacation_days_per_year !== undefined) setValues.vacationDaysPerYear = String(d.vacation_days_per_year);
  if (d.sick_leave_days_per_year !== undefined) setValues.sickLeaveDaysPerYear = d.sick_leave_days_per_year != null ? String(d.sick_leave_days_per_year) : null;
  if (d.accrual_type !== undefined) setValues.accrualType = d.accrual_type;
  if (d.annual_grant_month !== undefined) setValues.annualGrantMonth = d.annual_grant_month;
  if (d.carryover_allowed !== undefined) setValues.carryoverAllowed = d.carryover_allowed;
  if (d.max_carryover_days !== undefined) setValues.maxCarryoverDays = d.max_carryover_days != null ? String(d.max_carryover_days) : null;
  if (d.applies_after_months_of_employment !== undefined) setValues.appliesAfterMonthsOfEmployment = d.applies_after_months_of_employment;
  if (d.is_active !== undefined) setValues.isActive = d.is_active;

  const [updatedPolicy] = await drizzleDb.update(timeOffPolicies)
    .set(setValues)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)))
    .returning();
  res.json({ policy: updatedPolicy });
});

/**
 * DELETE /time-off/policies/:id
 * Hard-delete a time-off policy. Clears any employee assignments first.
 */
router.delete("/time-off/policies/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const policyId = parseInt(req.params.id, 10);
  if (Number.isNaN(policyId)) {
    res.status(400).json({ error: "Invalid policy id" });
    return;
  }

  const [existingForDelete] = await drizzleDb.select({ id: timeOffPolicies.id }).from(timeOffPolicies)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!existingForDelete) {
    res.status(404).json({ error: "Policy not found" });
    return;
  }

  await drizzleDb.delete(userTimeOffPolicies).where(eq(userTimeOffPolicies.policyId, policyId));
  await drizzleDb.delete(timeOffPolicies)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)));

  res.status(204).end();
});

const assignPolicySchema = z.object({
  scope: z.enum(["member", "location", "all", "specific_user"]),
  memberIds: z.array(z.number().int().positive()).optional().nullable(),
  locationId: z.number().int().positive().optional().nullable(),
  userId: z.number().int().positive().optional().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * POST /time-off/policies/:id/assign
 */
router.post("/time-off/policies/:id/assign", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const policyId = parseInt(req.params.id, 10);
  if (Number.isNaN(policyId)) {
    res.status(400).json({ error: "Invalid policy id" });
    return;
  }

  const [policy] = await drizzleDb.select({
    id: timeOffPolicies.id,
    name: timeOffPolicies.name,
    vacation_days_per_year: timeOffPolicies.vacationDaysPerYear,
    sick_leave_days_per_year: timeOffPolicies.sickLeaveDaysPerYear,
  }).from(timeOffPolicies)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!policy) {
    res.status(404).json({ error: "Policy not found" });
    return;
  }

  const parsed = assignPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { scope, memberIds, locationId, userId, effectiveFrom } = parsed.data;
  const assignerId = wreq.memberDbId;

  // --- Single-user assignment (specific_user scope) ---
  if (scope === "specific_user") {
    if (!userId) {
      res.status(400).json({ error: "userId required when scope is 'specific_user'" });
      return;
    }

    // Schema sentinel: policy assignment member-verify reads workspace_members:
    //   - member_email, member_user_id, joined_at (WHERE IS NOT NULL)
    // Update here if any of those columns is renamed.
    // Verify the member belongs to this workspace
    const [targetMember] = await drizzleDb.select({
      id: workspaceMembers.id,
      member_email: workspaceMembers.memberEmail,
      member_user_id: workspaceMembers.memberUserId,
    }).from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.id, userId),
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        isNotNull(workspaceMembers.joinedAt),
      ))
      .limit(1);
    if (!targetMember) {
      res.status(404).json({ error: "Member not found in this workspace" });
      return;
    }

    const policyYear = new Date().getFullYear();

    // Duplicate check: does this member already have an annual leave policy for the current year?
    const dupPolicyAlias = alias(timeOffPolicies, "dupPol");
    const [dupResult] = await drizzleDb.select({ policy_name: dupPolicyAlias.name })
      .from(timeOffBalances)
      .innerJoin(dupPolicyAlias, eq(dupPolicyAlias.id, timeOffBalances.policyId))
      .where(and(eq(timeOffBalances.memberId, userId), eq(timeOffBalances.policyYear, policyYear)))
      .limit(1);
    if (dupResult) {
      res.status(409).json({
        error: `This user already has an annual leave policy assigned for ${policyYear}: ${dupResult.policy_name}`,
      });
      return;
    }

    // Insert policy assignment
    await drizzleDb.insert(userTimeOffPolicies).values({
      memberId: userId,
      policyId,
      effectiveFrom,
      assignedByMemberId: assignerId!,
    }).onConflictDoNothing();

    // Upsert balance for the current year
    try {
      await drizzleDb.insert(timeOffBalances).values({
        memberId: userId,
        policyId,
        policyYear,
        vacationEntitled: String(policy.vacation_days_per_year),
        sickLeaveEntitled: policy.sick_leave_days_per_year != null ? String(policy.sick_leave_days_per_year) : null,
      }).onConflictDoUpdate({
        target: [timeOffBalances.memberId, timeOffBalances.policyYear],
        set: {
          policyId,
          vacationEntitled: String(policy.vacation_days_per_year),
          sickLeaveEntitled: policy.sick_leave_days_per_year != null ? String(policy.sick_leave_days_per_year) : null,
          updatedAt: new Date(),
        },
      });
    } catch (err) {
      logger.warn({ err, userId }, "Could not upsert balance on single-user policy assignment");
    }

    // Resolve first name from Clerk
    let firstName: string | null = null;
    if (targetMember.member_user_id) {
      try {
        const nameMap = await fetchClerkNames([targetMember.member_user_id]);
        firstName = nameMap.get(targetMember.member_user_id)?.firstName ?? null;
      } catch {
        // non-fatal
      }
    }

    // Send email notification — surface failure to caller
    let emailSent = true;
    try {
      await sendAnnualLeavePolicyAssignedEmail({
        toEmail: targetMember.member_email,
        firstName,
        policyName: policy.name,
        vacationDaysPerYear: Number(policy.vacation_days_per_year),
        sickDaysPerYear: policy.sick_leave_days_per_year != null ? Number(policy.sick_leave_days_per_year) : null,
        effectiveYear: policyYear,
      });
    } catch (err) {
      logger.warn({ err, userId, policyId }, "Failed to send annual leave policy assigned email");
      emailSent = false;
    }

    res.json({ ok: true, emailSent });
    return;
  }

  // --- Multi-user assignment (member / location / all scopes) ---
  // Schema sentinel: the location and all scope branches below read workspace_members:
  //   - id (pk), joined_at (WHERE IS NOT NULL)
  // Update here if joined_at is renamed.
  let targetMemberIds: number[] = [];

  if (scope === "member") {
    if (!memberIds || memberIds.length === 0) {
      res.status(400).json({ error: "memberIds required when scope is 'member'" });
      return;
    }
    targetMemberIds = memberIds;
  } else if (scope === "location") {
    if (!locationId) {
      res.status(400).json({ error: "locationId required when scope is 'location'" });
      return;
    }
    const locResult = await drizzleDb.select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(memberLocations, eq(memberLocations.memberId, workspaceMembers.id))
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        eq(memberLocations.locationId, locationId!),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = locResult.map((r) => r.id);
  } else if (scope === "all") {
    const allResult = await drizzleDb.select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = allResult.map((r) => r.id);
  }

  const policyYear = new Date().getFullYear();

  if (targetMemberIds.length > 0) {
    // Batch all inserts into a single transaction to avoid N×2 round trips.
    await drizzleDb.transaction(async (tx) => {
      // Bulk insert policy assignments (skip duplicates — member already has a
      // policy assignment row for this policy).
      const policyRows = targetMemberIds.map((memberId) => ({
        memberId,
        policyId,
        effectiveFrom,
        assignedByMemberId: assignerId!,
      }));
      await tx.insert(userTimeOffPolicies).values(policyRows).onConflictDoNothing();

      // Bulk upsert balances — one row per member for the current policy year.
      const balanceRows = targetMemberIds.map((memberId) => ({
        memberId,
        policyId,
        policyYear,
        vacationEntitled: String(policy.vacation_days_per_year),
        sickLeaveEntitled:
          policy.sick_leave_days_per_year != null
            ? String(policy.sick_leave_days_per_year)
            : null,
      }));
      await tx
        .insert(timeOffBalances)
        .values(balanceRows)
        .onConflictDoUpdate({
          target: [timeOffBalances.memberId, timeOffBalances.policyYear],
          set: {
            policyId,
            vacationEntitled: String(policy.vacation_days_per_year),
            sickLeaveEntitled:
              policy.sick_leave_days_per_year != null
                ? String(policy.sick_leave_days_per_year)
                : null,
            updatedAt: new Date(),
          },
        });
    });
  }

  res.json({ ok: true });
});

/**
 * GET /time-off/member-policy-check?userId=X
 * Returns whether a workspace member already has any policy assigned for the current year.
 */
router.get("/time-off/member-policy-check", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const userId = parseInt(req.query.userId as string, 10);
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }

  const policyYear = new Date().getFullYear();

  const policyAlias2 = alias(timeOffPolicies, "policyAlias2");
  const [policyCheckResult] = await drizzleDb.select({ policy_name: policyAlias2.name })
    .from(timeOffBalances)
    .innerJoin(policyAlias2, eq(policyAlias2.id, timeOffBalances.policyId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.id, timeOffBalances.memberId))
    .where(and(
      eq(timeOffBalances.memberId, userId),
      eq(timeOffBalances.policyYear, policyYear),
      eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
    ))
    .limit(1);

  if (policyCheckResult) {
    res.json({ assigned: true, policyName: policyCheckResult.policy_name });
  } else {
    res.json({ assigned: false, policyName: null });
  }
});

/**
 * GET /time-off/policies/:id/assignees
 */
router.get("/time-off/policies/:id/assignees", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const policyId = parseInt(req.params.id, 10);
  if (Number.isNaN(policyId)) {
    res.status(400).json({ error: "Invalid policy id" });
    return;
  }

  // Schema sentinel: policy assignees query JOINs workspace_members twice.
  // Reads the following drift-prone columns. Update here if any are renamed:
  //   - wm.member_user_id, wm.member_email, wm.manager_member_id (→ JOIN key),
  //     mgr.member_user_id (→ manager_user_id), mgr.member_email (→ manager_email)
  const assigneeMgrWm = alias(workspaceMembers, "assigneeMgrWm");
  const result = await drizzleDb.select({
    member_id: userTimeOffPolicies.memberId,
    member_user_id: workspaceMembers.memberUserId,
    member_email: workspaceMembers.memberEmail,
    location_name: locations.name,
    manager_user_id: assigneeMgrWm.memberUserId,
    manager_email: assigneeMgrWm.memberEmail,
    effective_from: sql<string>`${userTimeOffPolicies.effectiveFrom}::text`,
    vacation_remaining: sql<number | null>`(${timeOffBalances.vacationEntitled} + COALESCE(${timeOffBalances.vacationCarryover},0) - ${timeOffBalances.vacationUsed} - ${timeOffBalances.vacationPending})`,
  }).from(userTimeOffPolicies)
    .innerJoin(workspaceMembers, eq(workspaceMembers.id, userTimeOffPolicies.memberId))
    .leftJoin(assigneeMgrWm, eq(assigneeMgrWm.id, workspaceMembers.managerMemberId))
    .leftJoin(memberLocations, eq(memberLocations.memberId, workspaceMembers.id))
    .leftJoin(locations, eq(locations.id, memberLocations.locationId))
    .leftJoin(timeOffBalances, and(
      eq(timeOffBalances.memberId, workspaceMembers.id),
      sql`${timeOffBalances.policyYear} = EXTRACT(YEAR FROM CURRENT_DATE)`,
    ))
    .where(and(
      eq(userTimeOffPolicies.policyId, policyId),
      eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
      or(isNull(userTimeOffPolicies.effectiveTo), sql`${userTimeOffPolicies.effectiveTo} >= CURRENT_DATE`),
    ))
    .orderBy(asc(workspaceMembers.memberEmail));

  const assigneeUserIds = [
    ...new Set(
      [
        ...result.map((r) => r.member_user_id),
        ...result.map((r) => r.manager_user_id),
      ].filter((id): id is string => !!id),
    ),
  ];
  const assigneeNameMap = await fetchClerkNames(assigneeUserIds);
  const assignees = result.map((r) => {
    const memberNames = r.member_user_id ? assigneeNameMap.get(r.member_user_id) : undefined;
    const managerNames = r.manager_user_id ? assigneeNameMap.get(r.manager_user_id) : undefined;
    return {
      ...r,
      member_name: displayName(memberNames?.firstName ?? null, memberNames?.lastName ?? null, r.member_email),
      member_image_url: memberNames?.imageUrl ?? null,
      manager_name: r.manager_email
        ? displayName(managerNames?.firstName ?? null, managerNames?.lastName ?? null, r.manager_email)
        : null,
    };
  });

  res.json({ assignees });
});

/**
 * POST /time-off/policies/:id/balance-adjustment
 */
router.post("/time-off/policies/:id/balance-adjustment", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const policyId = parseInt(req.params.id, 10);
  if (Number.isNaN(policyId)) {
    res.status(400).json({ error: "Invalid policy id" });
    return;
  }

  const schema = z.object({
    memberId: z.number().int().positive(),
    vacationEntitled: z.number().min(0).max(365),
    adjustmentReason: z.string().min(1).max(1000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { memberId, vacationEntitled, adjustmentReason } = parsed.data;
  const policyYear = new Date().getFullYear();

  const [adjMemberCheck] = await drizzleDb.select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!adjMemberCheck) {
    res.status(404).json({ error: "Member not found in this workspace" });
    return;
  }

  const [adjPolicyCheck] = await drizzleDb.select({ id: timeOffPolicies.id })
    .from(timeOffPolicies)
    .where(and(eq(timeOffPolicies.id, policyId), eq(timeOffPolicies.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!adjPolicyCheck) {
    res.status(404).json({ error: "Policy not found in this workspace" });
    return;
  }

  try {
    await drizzleDb.transaction(async (tx) => {
      const [beforeRow] = await tx.select({ vacation_entitled: timeOffBalances.vacationEntitled })
        .from(timeOffBalances)
        .where(and(
          eq(timeOffBalances.memberId, memberId),
          eq(timeOffBalances.policyYear, policyYear),
          eq(timeOffBalances.policyId, policyId),
        ))
        .limit(1);
      if (!beforeRow) {
        throw Object.assign(new Error("No balance row found for this member/policy/year"), { status: 404 });
      }
      const vacationEntitledBefore = Number(beforeRow.vacation_entitled);

      const updateResult = await tx.update(timeOffBalances)
        .set({
          vacationEntitled: String(vacationEntitled),
          manuallyAdjustedByMemberId: wreq.memberDbId,
          adjustmentReason,
          updatedAt: new Date(),
        })
        .where(and(
          eq(timeOffBalances.memberId, memberId),
          eq(timeOffBalances.policyYear, policyYear),
          eq(timeOffBalances.policyId, policyId),
        ))
        .returning({ id: timeOffBalances.id });

      if (updateResult.length !== 1) {
        throw Object.assign(new Error("Balance update matched no rows"), { status: 404 });
      }

      await tx.insert(timeOffBalanceAdjustments).values({
        memberId,
        policyId,
        policyYear,
        vacationEntitledBefore: String(vacationEntitledBefore),
        vacationEntitledAfter: String(vacationEntitled),
        reason: adjustmentReason,
        adjustedByMemberId: wreq.memberDbId!,
      });
    });
  } catch (err: unknown) {
    const status = (err !== null && typeof err === "object" && "status" in err)
      ? (err as { status?: number }).status
      : undefined;
    if (status === 404) {
      res.status(404).json({ error: (err as Error).message });
      return;
    }
    throw err;
  }

  res.json({ ok: true });
});

/**
 * GET /time-off/calendar
 * Returns calendar events (requests + public holidays) for a given month.
 */
router.get("/time-off/calendar", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const year = parseInt(req.query.year as string, 10);
  const month = parseInt(req.query.month as string, 10);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "Valid year and month (1-12) are required" });
    return;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(year, month, 0).toISOString().slice(0, 10);

  const isAdmin = canManageTimeOff(wreq);

  let isManager = false;
  if (!isAdmin) {
    // Schema sentinel: reads workspace_members.manager_member_id to detect team membership.
    // Update here if manager_member_id is renamed.
    const [managerCheckRow] = await drizzleDb.select({ count: count() })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.managerMemberId, memberId), eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId)));
    isManager = (managerCheckRow?.count ?? 0) > 0;
  }

  const calEmpWm = alias(workspaceMembers, "calEmpWm");
  const drizzleCalConditions = [
    eq(timeOffRequests.workspaceOwnerId, wreq.workspaceOwnerId),
    isNull(timeOffRequests.deletedAt),
    or(eq(timeOffRequests.status, "PENDING"), eq(timeOffRequests.status, "APPROVED")),
    sql`${timeOffRequests.startDate} <= ${endDate}::date`,
    sql`${timeOffRequests.endDate} >= ${startDate}::date`,
  ] as ReturnType<typeof eq>[];

  if (!isAdmin) {
    if (isManager) {
      drizzleCalConditions.push(or(eq(timeOffRequests.memberId, memberId), eq(calEmpWm.managerMemberId, memberId))! as ReturnType<typeof eq>);
    } else {
      drizzleCalConditions.push(eq(timeOffRequests.memberId, memberId) as ReturnType<typeof eq>);
    }
  }

  // Schema sentinel: calendar month view JOINs workspace_members and reads:
  //   - emp.member_user_id, emp.member_email, emp.manager_member_id (WHERE filter)
  // Update here if any of those columns is renamed.
  const [requestsResult, holidaysResult] = await Promise.all([
    drizzleDb.select({
      id: timeOffRequests.id,
      type: sql<string>`'request'`,
      title: sql<string>`${timeOffTypes.name} || ' — ' || ${calEmpWm.memberEmail}`,
      start_date: sql<string>`${timeOffRequests.startDate}::text`,
      end_date: sql<string>`${timeOffRequests.endDate}::text`,
      status: timeOffRequests.status,
      color: timeOffTypes.color,
      member_user_id: calEmpWm.memberUserId,
      member_email: calEmpWm.memberEmail,
      member_name: calEmpWm.memberEmail,
    }).from(timeOffRequests)
      .innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffRequests.typeId))
      .innerJoin(calEmpWm, eq(calEmpWm.id, timeOffRequests.memberId))
      .where(and(...drizzleCalConditions))
      .orderBy(asc(timeOffRequests.startDate)),
    drizzleDb.select({
      id: publicHolidays.id,
      type: sql<string>`'holiday'`,
      title: publicHolidays.name,
      start_date: sql<string>`${publicHolidays.date}::text`,
      end_date: sql<string>`COALESCE(${publicHolidays.endDate}, ${publicHolidays.date})::text`,
      is_paid: publicHolidays.isPaid,
    }).from(publicHolidays)
      .innerJoin(publicHolidayCalendars, eq(publicHolidayCalendars.id, publicHolidays.calendarId))
      .innerJoin(userHolidayCalendars, and(
        eq(userHolidayCalendars.calendarId, publicHolidayCalendars.id),
        eq(userHolidayCalendars.memberId, memberId),
      ))
      .where(and(
        eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId),
        sql`${publicHolidays.date} <= ${endDate}::date`,
        sql`COALESCE(${publicHolidays.endDate}, ${publicHolidays.date}) >= ${startDate}::date`,
        eq(publicHolidayCalendars.isActive, true),
      ))
      .orderBy(asc(publicHolidays.date)),
  ]);

  const calUserIds = [...new Set(requestsResult.map((r) => r.member_user_id).filter((id): id is string => Boolean(id)))];
  const calNameMap = await fetchClerkNames(calUserIds);
  const resolvedRequests = requestsResult.map((r) => {
    const names = r.member_user_id ? calNameMap.get(r.member_user_id) : undefined;
    const name = displayName(names?.firstName ?? null, names?.lastName ?? null, r.member_email);
    return {
      ...r,
      member_name: name,
      title: r.title.replace(r.member_email, name),
    };
  });

  const events = [
    ...resolvedRequests.map((r) => ({ ...r, is_paid: null })),
    ...holidaysResult.map((r) => ({ ...r, status: null, color: "#6b7280", member_name: null })),
  ];

  res.json({ events });
});

// ============================================================
// Public holiday calendars (admin routes)
// ============================================================

/**
 * GET /public-holidays/import/countries
 */
router.get("/public-holidays/import/countries", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  const countries = getSupportedCountries();
  res.json({ countries });
});

/**
 * GET /public-holidays/import/regions/:countryCode
 */
router.get("/public-holidays/import/regions/:countryCode", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  const regions = getSupportedRegions(req.params.countryCode);
  res.json({ regions });
});

/**
 * GET /public-holidays/import/types
 */
router.get("/public-holidays/import/types", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  res.json({ types: getAvailableTypes() });
});

/**
 * GET /public-holidays/calendars
 * Enriched: includes holiday_count, assigned_count, next_holiday, source, last_updated
 */
router.get("/public-holidays/calendars", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);

  const ph2sub = alias(publicHolidays, "ph2sub");
  const result = await drizzleDb.select({
    id: publicHolidayCalendars.id,
    workspace_owner_id: publicHolidayCalendars.workspaceOwnerId,
    name: publicHolidayCalendars.name,
    country_code: publicHolidayCalendars.countryCode,
    location_id: publicHolidayCalendars.locationId,
    location_name: locations.name,
    is_active: publicHolidayCalendars.isActive,
    created_at: publicHolidayCalendars.createdAt,
    updated_at: publicHolidayCalendars.updatedAt,
    holiday_count: sql<string>`COUNT(DISTINCT ${publicHolidays.id}) FILTER (WHERE EXTRACT(YEAR FROM ${publicHolidays.date}) = ${String(year)})`,
    assigned_count: sql<string>`COUNT(DISTINCT ${userHolidayCalendars.memberId})`,
    next_holiday_name: sql<string | null>`(SELECT ${ph2sub.name} FROM ${ph2sub} WHERE ${ph2sub.calendarId} = ${publicHolidayCalendars.id} AND ${ph2sub.date} >= ${today}::date ORDER BY ${ph2sub.date} ASC LIMIT 1)`,
    next_holiday_date: sql<string | null>`(SELECT TO_CHAR(${ph2sub.date}, 'YYYY-MM-DD') FROM ${ph2sub} WHERE ${ph2sub.calendarId} = ${publicHolidayCalendars.id} AND ${ph2sub.date} >= ${today}::date ORDER BY ${ph2sub.date} ASC LIMIT 1)`,
    source: sql<string | null>`(CASE WHEN COUNT(DISTINCT ${publicHolidays.id}) FILTER (WHERE ${publicHolidays.source} = 'Imported') > 0 AND COUNT(DISTINCT ${publicHolidays.id}) FILTER (WHERE ${publicHolidays.source} = 'Manual' OR ${publicHolidays.source} IS NULL) > 0 THEN 'Mixed' WHEN COUNT(DISTINCT ${publicHolidays.id}) FILTER (WHERE ${publicHolidays.source} = 'Imported') > 0 THEN 'Imported' ELSE 'Manual' END)`,
  }).from(publicHolidayCalendars)
    .leftJoin(locations, eq(locations.id, publicHolidayCalendars.locationId))
    .leftJoin(publicHolidays, eq(publicHolidays.calendarId, publicHolidayCalendars.id))
    .leftJoin(userHolidayCalendars, eq(userHolidayCalendars.calendarId, publicHolidayCalendars.id))
    .where(eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId))
    .groupBy(publicHolidayCalendars.id, locations.name)
    .orderBy(asc(publicHolidayCalendars.name));

  const calendars = result.map((r) => ({
    ...r,
    holiday_count: parseInt(r.holiday_count, 10) || 0,
    assigned_count: parseInt(r.assigned_count, 10) || 0,
    next_holiday: r.next_holiday_name
      ? { name: r.next_holiday_name, date: r.next_holiday_date }
      : null,
  }));

  res.json({ calendars });
});

const calendarInputSchema = z.object({
  name: z.string().min(1).max(200),
  country_code: z.string().max(10).optional().nullable(),
  location_id: z.number().int().positive().optional().nullable(),
  is_active: z.boolean().optional(),
});

const createCalendarSchema = z.object({
  name: z.string().min(1).max(200),
  country_code: z
    .string()
    .min(2)
    .max(5)
    .transform((s) => s.toUpperCase())
    .refine(
      (code) =>
        COUNTRY_CATALOGUE.some((c) => c.code.toUpperCase() === code),
      { message: "Unsupported country code" },
    ),
  location_id: z.number().int().positive().optional().nullable(),
  is_active: z.boolean().optional(),
});

/**
 * POST /public-holidays/calendars
 */
router.post("/public-holidays/calendars", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const parsed = createCalendarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const [newCalendar] = await drizzleDb.insert(publicHolidayCalendars).values({
    workspaceOwnerId: wreq.workspaceOwnerId,
    name: d.name,
    countryCode: d.country_code ?? null,
    locationId: d.location_id ?? null,
    isActive: d.is_active ?? true,
  }).returning({ id: publicHolidayCalendars.id });

  const [created] = await drizzleDb.select({
    id: publicHolidayCalendars.id,
    workspace_owner_id: publicHolidayCalendars.workspaceOwnerId,
    name: publicHolidayCalendars.name,
    country_code: publicHolidayCalendars.countryCode,
    location_id: publicHolidayCalendars.locationId,
    location_name: locations.name,
    is_active: publicHolidayCalendars.isActive,
    created_at: publicHolidayCalendars.createdAt,
    updated_at: publicHolidayCalendars.updatedAt,
  }).from(publicHolidayCalendars)
    .leftJoin(locations, eq(locations.id, publicHolidayCalendars.locationId))
    .where(eq(publicHolidayCalendars.id, newCalendar.id))
    .limit(1);

  res.status(201).json({ calendar: created });
});

/**
 * PATCH /public-holidays/calendars/:id
 */
router.patch("/public-holidays/calendars/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [existingCal] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!existingCal) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const parsed = calendarInputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const calSetValues: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) calSetValues.name = d.name;
  if (d.country_code !== undefined) calSetValues.countryCode = d.country_code;
  if (d.location_id !== undefined) calSetValues.locationId = d.location_id;
  if (d.is_active !== undefined) calSetValues.isActive = d.is_active;

  await drizzleDb.update(publicHolidayCalendars)
    .set(calSetValues)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)));

  const [updatedCal] = await drizzleDb.select({
    id: publicHolidayCalendars.id,
    workspace_owner_id: publicHolidayCalendars.workspaceOwnerId,
    name: publicHolidayCalendars.name,
    country_code: publicHolidayCalendars.countryCode,
    location_id: publicHolidayCalendars.locationId,
    location_name: locations.name,
    is_active: publicHolidayCalendars.isActive,
    created_at: publicHolidayCalendars.createdAt,
    updated_at: publicHolidayCalendars.updatedAt,
  }).from(publicHolidayCalendars)
    .leftJoin(locations, eq(locations.id, publicHolidayCalendars.locationId))
    .where(eq(publicHolidayCalendars.id, calendarId))
    .limit(1);

  res.json({ calendar: updatedCal });
});

/**
 * DELETE /public-holidays/calendars/:id
 */
router.delete("/public-holidays/calendars/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [existingCalDel] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!existingCalDel) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  await drizzleDb.delete(userHolidayCalendars).where(eq(userHolidayCalendars.calendarId, calendarId));
  await drizzleDb.delete(publicHolidays).where(eq(publicHolidays.calendarId, calendarId));
  await drizzleDb.delete(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)));

  res.json({ success: true });
});

/**
 * GET /public-holidays/calendars/:id/holidays
 */
router.get("/public-holidays/calendars/:id/holidays", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [existingCalForHols] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!existingCalForHols) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const holidays = await drizzleDb.select({
    id: publicHolidays.id,
    calendar_id: publicHolidays.calendarId,
    workspace_owner_id: publicHolidays.workspaceOwnerId,
    name: publicHolidays.name,
    date: sql<string>`TO_CHAR(${publicHolidays.date}, 'YYYY-MM-DD')`,
    end_date: sql<string | null>`TO_CHAR(${publicHolidays.endDate}, 'YYYY-MM-DD')`,
    is_paid: publicHolidays.isPaid,
    description: publicHolidays.description,
    created_by_member_id: publicHolidays.createdByMemberId,
    created_at: publicHolidays.createdAt,
    updated_at: publicHolidays.updatedAt,
  }).from(publicHolidays)
    .where(eq(publicHolidays.calendarId, calendarId))
    .orderBy(asc(publicHolidays.date));

  res.json({ holidays });
});

const holidayInputSchema = z.object({
  name: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  is_paid: z.boolean().optional(),
  description: z.string().max(1000).optional().nullable(),
});

/**
 * POST /public-holidays/calendars/:id/holidays
 */
router.post("/public-holidays/calendars/:id/holidays", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [existingCalForPost] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!existingCalForPost) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const parsed = holidayInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const [newHoliday] = await drizzleDb.insert(publicHolidays).values({
    calendarId,
    workspaceOwnerId: wreq.workspaceOwnerId,
    name: d.name,
    date: d.date,
    endDate: d.end_date ?? null,
    isPaid: d.is_paid ?? true,
    description: d.description ?? null,
    createdByMemberId: wreq.memberDbId,
  }).returning({ id: publicHolidays.id });

  const [createdHoliday] = await drizzleDb.select({
    id: publicHolidays.id,
    calendar_id: publicHolidays.calendarId,
    workspace_owner_id: publicHolidays.workspaceOwnerId,
    name: publicHolidays.name,
    date: sql<string>`TO_CHAR(${publicHolidays.date}, 'YYYY-MM-DD')`,
    end_date: sql<string | null>`TO_CHAR(${publicHolidays.endDate}, 'YYYY-MM-DD')`,
    is_paid: publicHolidays.isPaid,
    description: publicHolidays.description,
    created_by_member_id: publicHolidays.createdByMemberId,
    created_at: publicHolidays.createdAt,
    updated_at: publicHolidays.updatedAt,
  }).from(publicHolidays)
    .where(eq(publicHolidays.id, newHoliday.id))
    .limit(1);
  res.status(201).json({ holiday: createdHoliday });
});

/**
 * PATCH /public-holidays/calendars/:id/holidays/:holidayId
 */
router.patch("/public-holidays/calendars/:id/holidays/:holidayId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  const holidayId = parseInt(req.params.holidayId, 10);
  if (Number.isNaN(calendarId) || Number.isNaN(holidayId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const phcAlias = alias(publicHolidayCalendars, "phcAlias");
  const [existingHol] = await drizzleDb.select({ id: publicHolidays.id })
    .from(publicHolidays)
    .innerJoin(phcAlias, eq(phcAlias.id, publicHolidays.calendarId))
    .where(and(
      eq(publicHolidays.id, holidayId),
      eq(publicHolidays.calendarId, calendarId),
      eq(phcAlias.workspaceOwnerId, wreq.workspaceOwnerId),
    ))
    .limit(1);
  if (!existingHol) {
    res.status(404).json({ error: "Holiday not found" });
    return;
  }

  const parsed = holidayInputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const holSetValues: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) holSetValues.name = d.name;
  if (d.date !== undefined) holSetValues.date = d.date;
  if (d.end_date !== undefined) holSetValues.endDate = d.end_date;
  if (d.is_paid !== undefined) holSetValues.isPaid = d.is_paid;
  if (d.description !== undefined) holSetValues.description = d.description;

  await drizzleDb.update(publicHolidays).set(holSetValues).where(eq(publicHolidays.id, holidayId));

  const [updatedHoliday] = await drizzleDb.select({
    id: publicHolidays.id,
    calendar_id: publicHolidays.calendarId,
    workspace_owner_id: publicHolidays.workspaceOwnerId,
    name: publicHolidays.name,
    date: sql<string>`TO_CHAR(${publicHolidays.date}, 'YYYY-MM-DD')`,
    end_date: sql<string | null>`TO_CHAR(${publicHolidays.endDate}, 'YYYY-MM-DD')`,
    is_paid: publicHolidays.isPaid,
    description: publicHolidays.description,
    created_by_member_id: publicHolidays.createdByMemberId,
    created_at: publicHolidays.createdAt,
    updated_at: publicHolidays.updatedAt,
  }).from(publicHolidays)
    .where(eq(publicHolidays.id, holidayId))
    .limit(1);
  res.json({ holiday: updatedHoliday });
});

/**
 * DELETE /public-holidays/calendars/:id/holidays/:holidayId
 */
router.delete("/public-holidays/calendars/:id/holidays/:holidayId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  const holidayId = parseInt(req.params.holidayId, 10);
  if (Number.isNaN(calendarId) || Number.isNaN(holidayId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const deleted = await drizzleDb.delete(publicHolidays)
    .where(and(
      eq(publicHolidays.id, holidayId),
      eq(publicHolidays.calendarId, calendarId),
      eq(publicHolidays.workspaceOwnerId, wreq.workspaceOwnerId),
    ))
    .returning({ id: publicHolidays.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Holiday not found" });
    return;
  }

  res.json({ ok: true });
});

// ============================================================
// Import preview + approve routes
// ============================================================

const importPreviewSchema = z.object({
  countryCode: z.string().min(1).max(10),
  year: z.number().int().min(1900).max(2100),
  regionCode: z.string().max(20).optional().nullable(),
  types: z.array(z.string()).optional().nullable(),
  mode: z.enum(["all", "select"]).optional().default("all"),
});

/**
 * POST /public-holidays/calendars/:id/import/preview
 * Returns normalized holidays with duplicate flags. No DB writes.
 */
router.post("/public-holidays/calendars/:id/import/preview", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [calExistsPreview] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!calExistsPreview) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const parsed = importPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { countryCode, year, regionCode, types } = parsed.data;

  let holidays: NormalizedHoliday[];
  try {
    holidays = getHolidays({ countryCode, year, regionCode: regionCode ?? null, types: types ?? undefined });
  } catch (err) {
    logger.warn({ err, countryCode, year }, "date-holidays getHolidays failed");
    res.status(400).json({ error: "Could not fetch holidays for the given country/year" });
    return;
  }

  // Check for existing duplicates in this calendar.
  const existingPreviewRows = await drizzleDb.select({
    name: publicHolidays.name,
    date: sql<string>`TO_CHAR(${publicHolidays.date}, 'YYYY-MM-DD')`,
  }).from(publicHolidays).where(eq(publicHolidays.calendarId, calendarId));
  const existingSet = new Set(existingPreviewRows.map((r) => `${r.date}:${r.name}`));

  const items = holidays.map((h) => ({
    ...h,
    already_exists: existingSet.has(`${h.date}:${h.name}`),
  }));

  res.json({ holidays: items, total: items.length });
});

const importApproveItemSchema = z.object({
  name: z.string().min(1).max(500),
  local_name: z.string().max(500).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  observed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  type: z.string().max(50).optional().nullable(),
  status: z.string().max(20).optional().nullable(),
  source: z.string().max(20).optional().default("Imported"),
  country_code: z.string().max(10).optional().nullable(),
  region_code: z.string().max(20).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  is_paid: z.boolean().optional().default(true),
  is_full_day: z.boolean().optional().default(true),
});

const importApproveSchema = z.object({
  holidays: z.array(importApproveItemSchema).min(1),
});

/**
 * POST /public-holidays/calendars/:id/import/approve
 * Inserts non-duplicate holidays, writes audit log.
 */
router.post("/public-holidays/calendars/:id/import/approve", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [calExistsApprove] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!calExistsApprove) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const parsed = importApproveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { holidays } = parsed.data;
  let inserted = 0;
  let skipped = 0;

  for (const h of holidays) {
    const year = parseInt(h.date.slice(0, 4), 10);
    try {
      const insertResult = await drizzleDb.insert(publicHolidays).values({
        calendarId,
        workspaceOwnerId: wreq.workspaceOwnerId,
        name: h.name,
        date: h.date,
        observedDate: h.observed_date ?? null,
        localName: h.local_name ?? null,
        type: h.type ?? null,
        status: h.status ?? "Confirmed",
        source: h.source ?? "Imported",
        countryCode: h.country_code ?? null,
        regionCode: h.region_code ?? null,
        notes: h.notes ?? null,
        isPaid: h.is_paid ?? true,
        year,
        createdByMemberId: wreq.memberDbId ?? null,
      }).onConflictDoNothing().returning({ id: publicHolidays.id });
      if (insertResult.length > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      logger.warn({ err, calendarId, holiday: h.name }, "Holiday insert failed — skipping");
      skipped++;
    }
  }

  // Update calendar updated_at.
  await drizzleDb.update(publicHolidayCalendars)
    .set({ updatedAt: new Date() })
    .where(eq(publicHolidayCalendars.id, calendarId));

  res.json({ ok: true, inserted, skipped });
});

// ============================================================
// CSV export / import routes
// ============================================================

/**
 * GET /public-holidays/calendars/:id/export-csv
 */
router.get("/public-holidays/calendars/:id/export-csv", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [calExistsExport] = await drizzleDb.select({ name: publicHolidayCalendars.name })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!calExistsExport) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const exportRows = await drizzleDb.select({
    name: publicHolidays.name,
    date: sql<string>`TO_CHAR(${publicHolidays.date}, 'YYYY-MM-DD')`,
    observed_date: sql<string | null>`TO_CHAR(${publicHolidays.observedDate}, 'YYYY-MM-DD')`,
    type: publicHolidays.type,
    is_paid: publicHolidays.isPaid,
    is_full_day: sql<boolean>`true`,
    notes: publicHolidays.notes,
  }).from(publicHolidays)
    .where(eq(publicHolidays.calendarId, calendarId))
    .orderBy(asc(publicHolidays.date));

  function csvEscape(v: string | null | undefined | boolean): string {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  const calendarName = calExistsExport.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="holidays-${calendarName}.csv"`);

  const header = "holiday_name,date,observed_date,type,is_paid,is_full_day,notes\r\n";
  res.write(header);
  for (const row of exportRows) {
    const line = [
      csvEscape(row.name),
      csvEscape(row.date),
      csvEscape(row.observed_date),
      csvEscape(row.type),
      csvEscape(row.is_paid),
      csvEscape(row.is_full_day),
      csvEscape(row.notes),
    ].join(",") + "\r\n";
    res.write(line);
  }
  res.end();
});

/**
 * POST /public-holidays/calendars/:id/import-csv
 * Accepts multipart CSV upload, parses and returns preview payload.
 */
router.post("/public-holidays/calendars/:id/import-csv", csvUpload.single("file"), async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params["id"] as string, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [calExistsCsv] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!calExistsCsv) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const text = req.file.buffer.toString("utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    res.status(400).json({ error: "CSV must have a header row and at least one data row" });
    return;
  }

  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const nameIdx = headers.indexOf("holiday_name");
  const dateIdx = headers.indexOf("date");
  const observedIdx = headers.indexOf("observed_date");
  const typeIdx = headers.indexOf("type");
  const isPaidIdx = headers.indexOf("is_paid");
  const notesIdx = headers.indexOf("notes");

  if (nameIdx === -1 || dateIdx === -1) {
    res.status(400).json({ error: "CSV must have columns: holiday_name, date" });
    return;
  }

  // Check existing duplicates.
  const existingCsvRows = await drizzleDb.select({
    name: publicHolidays.name,
    date: sql<string>`TO_CHAR(${publicHolidays.date}, 'YYYY-MM-DD')`,
  }).from(publicHolidays).where(eq(publicHolidays.calendarId, calendarId));
  const existingSet = new Set(existingCsvRows.map((r) => `${r.date}:${r.name}`));

  const holidays = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = cols[nameIdx] ?? "";
    const date = cols[dateIdx] ?? "";

    if (!name.trim() || !date.trim()) continue;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      errors.push(`Row ${i + 1}: invalid date format "${date}" (expected YYYY-MM-DD)`);
      continue;
    }

    const h = {
      name: name.trim(),
      local_name: null as string | null,
      date: date.trim(),
      observed_date: observedIdx >= 0 && cols[observedIdx]?.trim() ? cols[observedIdx].trim() : null,
      type: typeIdx >= 0 && cols[typeIdx]?.trim() ? cols[typeIdx].trim() : "public",
      status: "Confirmed" as const,
      source: "CSV" as const,
      country_code: null as string | null,
      region_code: null as string | null,
      notes: notesIdx >= 0 && cols[notesIdx]?.trim() ? cols[notesIdx].trim() : null,
      is_paid: isPaidIdx >= 0 ? (cols[isPaidIdx]?.toLowerCase() !== "false") : true,
      already_exists: existingSet.has(`${date.trim()}:${name.trim()}`),
    };
    holidays.push(h);
  }

  res.json({ holidays, total: holidays.length, errors });
});

// ============================================================
// Assign route (improved with enriched scopes + dry-run)
// ============================================================

const assignCalendarSchema = z.object({
  scope: z.enum(["member", "location", "all", "by_country", "by_location", "by_department", "individual"]),
  memberIds: z.array(z.number().int().positive()).optional().nullable(),
  locationId: z.number().int().positive().optional().nullable(),
  filterValue: z.string().optional().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dryRun: z.boolean().optional().default(false),
});

/**
 * POST /public-holidays/calendars/:id/assign
 */
router.post("/public-holidays/calendars/:id/assign", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageTimeOff(wreq)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const calendarId = parseInt(req.params.id, 10);
  if (Number.isNaN(calendarId)) {
    res.status(400).json({ error: "Invalid calendar id" });
    return;
  }

  const [calExistsAssign] = await drizzleDb.select({ id: publicHolidayCalendars.id })
    .from(publicHolidayCalendars)
    .where(and(eq(publicHolidayCalendars.id, calendarId), eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId)))
    .limit(1);
  if (!calExistsAssign) {
    res.status(404).json({ error: "Calendar not found" });
    return;
  }

  const parsed = assignCalendarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }

  const { scope, memberIds, locationId, filterValue, effectiveFrom, dryRun } = parsed.data;
  let targetMemberIds: number[] = [];
  let targetMemberEmails: string[] = [];

  // Schema sentinel: all scope branches below read workspace_members:
  //   - id (pk), member_email, joined_at (WHERE IS NOT NULL)
  // Update here if member_email or joined_at is renamed.
  if (scope === "member" || scope === "individual") {
    if (!memberIds || memberIds.length === 0) {
      res.status(400).json({ error: "memberIds required when scope is 'individual'" });
      return;
    }
    const membersResult = await drizzleDb.select({ id: workspaceMembers.id, member_email: workspaceMembers.memberEmail })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        inArray(workspaceMembers.id, memberIds),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = membersResult.map((r) => r.id);
    targetMemberEmails = membersResult.map((r) => r.member_email);
  } else if (scope === "location" || scope === "by_location") {
    const locId = locationId ?? (filterValue ? parseInt(filterValue, 10) : null);
    if (!locId) {
      res.status(400).json({ error: "locationId or filterValue required when scope is 'by_location'" });
      return;
    }
    const locResult = await drizzleDb.select({ id: workspaceMembers.id, member_email: workspaceMembers.memberEmail })
      .from(workspaceMembers)
      .innerJoin(memberLocations, eq(memberLocations.memberId, workspaceMembers.id))
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        eq(memberLocations.locationId, locId),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = locResult.map((r) => r.id);
    targetMemberEmails = locResult.map((r) => r.member_email);
  } else if (scope === "by_country") {
    const countryCode = filterValue ?? null;
    if (!countryCode) {
      res.status(400).json({ error: "filterValue (country code) required when scope is 'by_country'" });
      return;
    }
    // Resolve country code → canonical name for the DB query (locations.country stores names)
    const countryMeta = COUNTRY_CATALOGUE.find(
      (c) => c.code.toUpperCase() === countryCode.toUpperCase(),
    );
    if (!countryMeta) {
      res.status(400).json({ error: `Unknown country code: ${countryCode}` });
      return;
    }
    const countryResult = await drizzleDb.select({ id: workspaceMembers.id, member_email: workspaceMembers.memberEmail })
      .from(workspaceMembers)
      .innerJoin(memberLocations, eq(memberLocations.memberId, workspaceMembers.id))
      .innerJoin(locations, eq(locations.id, memberLocations.locationId))
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        eq(locations.country, countryMeta.name),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = countryResult.map((r) => r.id);
    targetMemberEmails = countryResult.map((r) => r.member_email);
  } else if (scope === "by_department") {
    const department = filterValue ?? null;
    if (!department) {
      res.status(400).json({ error: "filterValue (department) required when scope is 'by_department'" });
      return;
    }
    const deptResult = await drizzleDb.select({ id: workspaceMembers.id, member_email: workspaceMembers.memberEmail })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        eq(workspaceMembers.department, department),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = deptResult.map((r) => r.id);
    targetMemberEmails = deptResult.map((r) => r.member_email);
  } else {
    // scope === "all"
    const allResult = await drizzleDb.select({ id: workspaceMembers.id, member_email: workspaceMembers.memberEmail })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceOwnerId, wreq.workspaceOwnerId),
        isNotNull(workspaceMembers.joinedAt),
      ));
    targetMemberIds = allResult.map((r) => r.id);
    targetMemberEmails = allResult.map((r) => r.member_email);
  }

  // Dry-run: return affected count + preview list only.
  if (dryRun) {
    res.json({
      ok: true,
      dry_run: true,
      affected_count: targetMemberIds.length,
      members: targetMemberEmails.map((email, i) => ({ id: targetMemberIds[i], email })),
    });
    return;
  }

  for (const targetMemberId of targetMemberIds) {
    await drizzleDb.insert(userHolidayCalendars).values({
      memberId: targetMemberId,
      calendarId,
      workspaceOwnerId: wreq.workspaceOwnerId,
      effectiveFrom,
      assignedByMemberId: wreq.memberDbId,
    }).onConflictDoUpdate({
      target: [userHolidayCalendars.memberId, userHolidayCalendars.calendarId],
      set: {
        effectiveFrom,
        assignedByMemberId: wreq.memberDbId,
      },
    });
  }

  res.json({ ok: true, assigned: targetMemberIds.length });
});

/**
 * GET /public-holidays/my
 * Returns public holidays assigned to the authenticated member.
 */
router.get("/public-holidays/my", async (req, res) => {
  const wreq = workspace(req);
  const memberId = wreq.memberDbId;
  if (!memberId) {
    res.json({ holidays: [] });
    return;
  }

  const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();

  const myHolidays = await drizzleDb.select({
    id: publicHolidays.id,
    calendar_id: publicHolidays.calendarId,
    workspace_owner_id: publicHolidays.workspaceOwnerId,
    name: publicHolidays.name,
    date: sql<string>`${publicHolidays.date}::text`,
    end_date: sql<string | null>`${publicHolidays.endDate}::text`,
    is_paid: publicHolidays.isPaid,
    description: publicHolidays.description,
    created_at: publicHolidays.createdAt,
    updated_at: publicHolidays.updatedAt,
  }).from(publicHolidays)
    .innerJoin(publicHolidayCalendars, eq(publicHolidayCalendars.id, publicHolidays.calendarId))
    .innerJoin(userHolidayCalendars, and(
      eq(userHolidayCalendars.calendarId, publicHolidayCalendars.id),
      eq(userHolidayCalendars.memberId, memberId),
    ))
    .where(and(
      eq(publicHolidayCalendars.workspaceOwnerId, wreq.workspaceOwnerId),
      sql`EXTRACT(YEAR FROM ${publicHolidays.date}) = ${String(year)}`,
      eq(publicHolidayCalendars.isActive, true),
      or(isNull(userHolidayCalendars.effectiveTo), sql`${userHolidayCalendars.effectiveTo} >= CURRENT_DATE`),
    ))
    .orderBy(asc(publicHolidays.date));

  res.json({ holidays: myHolidays });
});

export default router;
