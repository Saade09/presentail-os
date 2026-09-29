import { describe, it, expect, vi } from "vitest";
import {
  computeVacationRemaining,
  calculateWorkingDays,
  getOrCreateBalance,
  DEFAULT_WORKING_DAYS,
} from "./timeOffBalances";
import type { Queryable, TimeOffBalance, WorkingDaysConfig } from "./timeOffBalances";

// ---------------------------------------------------------------------------
// computeVacationRemaining
// ---------------------------------------------------------------------------

describe("computeVacationRemaining", () => {
  it("returns entitled + carryover - used - pending", () => {
    const balance = {
      vacation_entitled: 15,
      vacation_carryover: 5,
      vacation_used: 8,
      vacation_pending: 2,
    };
    expect(computeVacationRemaining(balance)).toBe(10);
  });

  it("returns the full entitlement when nothing is used or pending", () => {
    const balance = {
      vacation_entitled: 15,
      vacation_carryover: 0,
      vacation_used: 0,
      vacation_pending: 0,
    };
    expect(computeVacationRemaining(balance)).toBe(15);
  });

  it("returns zero when used + pending equals entitled + carryover", () => {
    const balance = {
      vacation_entitled: 15,
      vacation_carryover: 5,
      vacation_used: 15,
      vacation_pending: 5,
    };
    expect(computeVacationRemaining(balance)).toBe(0);
  });

  it("handles numeric strings (as returned by pg driver) by coercing via Number()", () => {
    const balance = {
      vacation_entitled: "15" as unknown as number,
      vacation_carryover: "3" as unknown as number,
      vacation_used: "5" as unknown as number,
      vacation_pending: "1" as unknown as number,
    };
    expect(computeVacationRemaining(balance)).toBe(12);
  });

  it("can return a negative value when usage exceeds entitlement", () => {
    const balance = {
      vacation_entitled: 5,
      vacation_carryover: 0,
      vacation_used: 7,
      vacation_pending: 0,
    };
    expect(computeVacationRemaining(balance)).toBe(-2);
  });
});

// ---------------------------------------------------------------------------
// calculateWorkingDays
// ---------------------------------------------------------------------------

describe("calculateWorkingDays", () => {
  it("counts Mon–Fri over a standard week (no holidays)", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-10"); // Friday
    expect(calculateWorkingDays(start, end)).toBe(5);
  });

  it("excludes Saturday and Sunday", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-12"); // Sunday
    expect(calculateWorkingDays(start, end)).toBe(5);
  });

  it("returns 1 for same-day (weekday)", () => {
    const monday = new Date("2025-01-06");
    expect(calculateWorkingDays(monday, monday)).toBe(1);
  });

  it("returns 0 for same-day (weekend)", () => {
    const saturday = new Date("2025-01-04");
    expect(calculateWorkingDays(saturday, saturday)).toBe(0);
  });

  it("excludes public holidays passed as Date objects", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-10"); // Friday
    const holiday = new Date("2025-01-08"); // Wednesday
    expect(calculateWorkingDays(start, end, [holiday])).toBe(4);
  });

  it("excludes public holidays passed as YYYY-MM-DD strings", () => {
    const start = new Date("2025-01-06");
    const end = new Date("2025-01-10");
    expect(calculateWorkingDays(start, end, ["2025-01-07", "2025-01-08"])).toBe(3);
  });

  it("counts correctly across a two-week period", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-19"); // Sunday (2 full weeks)
    expect(calculateWorkingDays(start, end)).toBe(10);
  });

  it("returns 0 when start is after end", () => {
    const start = new Date("2025-01-10");
    const end = new Date("2025-01-06");
    expect(calculateWorkingDays(start, end)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Custom work schedule tests
  // -------------------------------------------------------------------------

  it("uses Mon–Fri default when workingDaysConfig is null", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-10"); // Friday
    expect(calculateWorkingDays(start, end, [], null)).toBe(5);
  });

  it("uses Mon–Fri default when workingDaysConfig is undefined", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-12"); // Sunday
    expect(calculateWorkingDays(start, end, [], undefined)).toBe(5);
  });

  it("counts Sun–Thu for a Sun–Thu custom schedule", () => {
    const sunThuSchedule: WorkingDaysConfig = {
      sunday: true,
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: false,
      saturday: false,
    };
    // 2025-01-05 is Sunday, 2025-01-11 is Saturday (full week)
    const start = new Date("2025-01-05"); // Sunday
    const end = new Date("2025-01-11"); // Saturday
    // Sun Mon Tue Wed Thu = 5 working days; Fri Sat = non-working
    expect(calculateWorkingDays(start, end, [], sunThuSchedule)).toBe(5);
  });

  it("skips non-working days in a Sun–Thu schedule (request spans Friday)", () => {
    const sunThuSchedule: WorkingDaysConfig = {
      sunday: true,
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: false,
      saturday: false,
    };
    // 2025-01-09 Thursday to 2025-01-12 Sunday: Thu, Fri(non-working), Sat(non-working), Sun = 2
    const start = new Date("2025-01-09"); // Thursday
    const end = new Date("2025-01-12"); // Sunday
    expect(calculateWorkingDays(start, end, [], sunThuSchedule)).toBe(2);
  });

  it("returns 0 when all days in range are non-working in the custom schedule", () => {
    const weekendOnlyNonWorking: WorkingDaysConfig = {
      ...DEFAULT_WORKING_DAYS,
      saturday: false,
      sunday: false,
    };
    // Request only covers a weekend
    const start = new Date("2025-01-04"); // Saturday
    const end = new Date("2025-01-05"); // Sunday
    expect(calculateWorkingDays(start, end, [], weekendOnlyNonWorking)).toBe(0);
  });

  it("default schedule constant matches Mon–Fri", () => {
    expect(DEFAULT_WORKING_DAYS).toEqual({
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
    });
  });

  it("rejects all-non-working schedule correctly (returns 0 for any range)", () => {
    const allOffSchedule: WorkingDaysConfig = {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: false,
      sunday: false,
    };
    const start = new Date("2025-01-06");
    const end = new Date("2025-01-10");
    expect(calculateWorkingDays(start, end, [], allOffSchedule)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateBalance
// ---------------------------------------------------------------------------

function makeClient(responses: Array<{ rows: object[] }>): Queryable {
  let callIndex = 0;
  return {
    query: vi.fn(async () => {
      const response = responses[callIndex++];
      if (!response) throw new Error("Unexpected extra query call");
      return response;
    }) as unknown as Queryable["query"],
  };
}

const MEMBER_ID = 42;
const WORKSPACE_OWNER_ID = "user_owner_abc";
const POLICY_YEAR = 2025;

const ACTIVE_POLICY = {
  policy_id: 7,
  vacation_days_per_year: 15,
  sick_leave_days_per_year: null,
};

const BALANCE_ROW: TimeOffBalance = {
  id: 1,
  member_id: MEMBER_ID,
  policy_id: 7,
  policy_year: POLICY_YEAR,
  vacation_entitled: 15,
  vacation_used: 0,
  vacation_pending: 0,
  vacation_carryover: 0,
  sick_leave_entitled: null,
  sick_leave_used: 0,
  sick_leave_pending: 0,
  manually_adjusted_by_member_id: null,
  adjustment_reason: null,
  updated_at: new Date(),
};

describe("getOrCreateBalance", () => {
  it("throws when no active policy assignment exists for the member", async () => {
    const client = makeClient([{ rows: [] }]);
    await expect(
      getOrCreateBalance(client, MEMBER_ID, WORKSPACE_OWNER_ID, POLICY_YEAR),
    ).rejects.toThrow(/no active time-off policy assignment/i);
  });

  it("upserts and returns the balance row when an active policy exists", async () => {
    const client = makeClient([
      { rows: [ACTIVE_POLICY] },
      { rows: [BALANCE_ROW] },
    ]);
    const result = await getOrCreateBalance(
      client,
      MEMBER_ID,
      WORKSPACE_OWNER_ID,
      POLICY_YEAR,
    );
    expect(result).toEqual(BALANCE_ROW);
  });

  it("passes the correct parameters to the upsert query", async () => {
    const querySpy = vi.fn()
      .mockResolvedValueOnce({ rows: [ACTIVE_POLICY] })
      .mockResolvedValueOnce({ rows: [BALANCE_ROW] });

    const client: Queryable = { query: querySpy };
    await getOrCreateBalance(client, MEMBER_ID, WORKSPACE_OWNER_ID, POLICY_YEAR);

    const upsertCall = querySpy.mock.calls[1];
    const upsertParams = upsertCall[1] as unknown[];
    expect(upsertParams).toEqual([
      MEMBER_ID,
      ACTIVE_POLICY.policy_id,
      POLICY_YEAR,
      ACTIVE_POLICY.vacation_days_per_year,
      ACTIVE_POLICY.sick_leave_days_per_year,
    ]);
  });

  it("first query filters by member_id and workspace_owner_id from the arguments", async () => {
    const querySpy = vi.fn()
      .mockResolvedValueOnce({ rows: [] });

    const client: Queryable = { query: querySpy };
    await expect(
      getOrCreateBalance(client, 99, WORKSPACE_OWNER_ID, POLICY_YEAR),
    ).rejects.toThrow();

    const firstCall = querySpy.mock.calls[0];
    expect(firstCall[1]).toEqual([99, WORKSPACE_OWNER_ID]);
  });
});
