export interface TimeOffBalance {
  id: number;
  member_id: number;
  policy_id: number;
  policy_year: number;
  vacation_entitled: number;
  vacation_used: number;
  vacation_pending: number;
  vacation_carryover: number;
  sick_leave_entitled: number | null;
  sick_leave_used: number;
  sick_leave_pending: number;
  manually_adjusted_by_member_id: number | null;
  adjustment_reason: string | null;
  updated_at: Date;
}

/**
 * Minimal interface for a queryable database handle.
 * Accepts both Pool and PoolClient so callers can pass a transaction client.
 */
export interface Queryable {
  query<T extends object = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Computes the remaining vacation days for a given balance row.
 *
 * Formula: entitled + carryover - used - pending
 */
export function computeVacationRemaining(
  balance: Pick<
    TimeOffBalance,
    "vacation_entitled" | "vacation_carryover" | "vacation_used" | "vacation_pending"
  >,
): number {
  return (
    Number(balance.vacation_entitled) +
    Number(balance.vacation_carryover) -
    Number(balance.vacation_used) -
    Number(balance.vacation_pending)
  );
}

/**
 * Fetches or creates the `time_off_balances` row for a member in a given policy year.
 *
 * The member MUST have an active `user_time_off_policies` assignment covering
 * `CURRENT_DATE`. If no such assignment exists, the function throws — it will
 * not silently fall back to an arbitrary workspace policy or grant leave without
 * an explicit policy assignment.
 *
 * On INSERT the entitlement columns are set from the active policy; on conflict
 * (the row already exists) it touches `updated_at` and returns the existing row.
 *
 * @param client          A Pool or PoolClient (allows use inside transactions)
 * @param memberId        `workspace_members.id` of the target member
 * @param workspaceOwnerId  Workspace scope (used only for logging clarity)
 * @param policyYear      Calendar year (e.g. 2025)
 */
export async function getOrCreateBalance(
  client: Queryable,
  memberId: number,
  workspaceOwnerId: string,
  policyYear: number,
): Promise<TimeOffBalance> {
  const policyResult = await client.query<{
    policy_id: number;
    vacation_days_per_year: number;
    sick_leave_days_per_year: number | null;
  }>(
    `SELECT utp.policy_id,
            p.vacation_days_per_year,
            p.sick_leave_days_per_year
       FROM user_time_off_policies utp
       JOIN workspace_members wm ON wm.id = utp.member_id
       JOIN time_off_policies p ON p.id = utp.policy_id
      WHERE utp.member_id = $1
        AND wm.workspace_owner_id = $2
        AND p.workspace_owner_id = $2
        AND utp.effective_from <= CURRENT_DATE
        AND (utp.effective_to IS NULL OR utp.effective_to >= CURRENT_DATE)
      ORDER BY utp.effective_from DESC
      LIMIT 1`,
    [memberId, workspaceOwnerId],
  );

  const activePolicy = policyResult.rows[0];
  if (!activePolicy) {
    throw new Error(
      `Member ${memberId} in workspace ${workspaceOwnerId} has no active time-off policy assignment. ` +
        `Assign a policy via user_time_off_policies before fetching balances.`,
    );
  }

  const upsertResult = await client.query<TimeOffBalance>(
    `INSERT INTO time_off_balances
       (member_id, policy_id, policy_year, vacation_entitled, sick_leave_entitled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_id, policy_year) DO UPDATE
       SET updated_at = now()
     RETURNING *`,
    [
      memberId,
      activePolicy.policy_id,
      policyYear,
      activePolicy.vacation_days_per_year,
      activePolicy.sick_leave_days_per_year,
    ],
  );

  return upsertResult.rows[0];
}

/**
 * Per-employee working days configuration stored in `workspace_members.working_days`.
 * A `null` value on the DB column means use the Mon–Fri default.
 */
export type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

export const DEFAULT_WORKING_DAYS: WorkingDaysConfig = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

const DAY_KEYS: (keyof WorkingDaysConfig)[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Calculates the number of working days between two dates (inclusive).
 *
 * Workweek defaults to Monday–Friday when no `workingDaysConfig` is provided
 * (or when it is null/undefined). An optional array of public holiday dates
 * (as YYYY-MM-DD strings or Date objects) are excluded from the count.
 *
 * @param start               Start date (inclusive)
 * @param end                 End date (inclusive)
 * @param publicHolidayDates  Dates to treat as non-working days
 * @param workingDaysConfig   Per-employee schedule; null/undefined = Mon–Fri default
 * @returns Number of working days in the range
 */
export function calculateWorkingDays(
  start: Date,
  end: Date,
  publicHolidayDates: (Date | string)[] = [],
  workingDaysConfig?: WorkingDaysConfig | null,
): number {
  const config = workingDaysConfig ?? DEFAULT_WORKING_DAYS;

  const holidaySet = new Set<string>(
    publicHolidayDates.map((d) => {
      const date = d instanceof Date ? d : new Date(d);
      return date.toISOString().slice(0, 10);
    }),
  );

  let count = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);

  const endNorm = new Date(end);
  endNorm.setHours(0, 0, 0, 0);

  while (cursor <= endNorm) {
    const dayOfWeek = cursor.getDay();
    const dayKey = DAY_KEYS[dayOfWeek];
    const isWorkingDay = config[dayKey];
    const dateStr = cursor.toISOString().slice(0, 10);
    if (isWorkingDay && !holidaySet.has(dateStr)) {
      count++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return count;
}
