import { describe, expect, it } from "vitest";
import {
  buildStepSchedule,
  calculateNextRun,
  normalizeJourneySteps,
  parseIsoDate,
  periodForCycle,
  periodLabelForDates,
} from "./supplierStatementCollection";

describe("supplier statement collection period rules", () => {
  it("uses the immediately preceding month for a monthly cycle", () => {
    expect(periodForCycle("monthly", new Date("2026-10-15T12:00:00Z"))).toMatchObject({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      periodLabel: "September 2026",
    });
  });

  it("uses the preceding quarter when an October quarterly cycle runs", () => {
    expect(periodForCycle("quarterly", new Date("2026-10-01T09:00:00Z"))).toMatchObject({
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      periodLabel: "Q3 2026",
    });
    expect(periodLabelForDates("2026-07-01", "2026-09-30", "quarterly")).toBe("Q3 2026");
  });

  it("handles year boundaries and calendar-month end dates exactly", () => {
    expect(periodForCycle("monthly", new Date("2027-01-01T00:00:00Z"))).toMatchObject({
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      periodLabel: "December 2026",
    });
    expect(periodForCycle("quarterly", new Date("2027-01-01T00:00:00Z"))).toMatchObject({
      periodStart: "2026-10-01",
      periodEnd: "2026-12-31",
      periodLabel: "Q4 2026",
    });
  });

  it("rejects impossible and non-ISO dates instead of silently normalizing them", () => {
    expect(parseIsoDate("2026-02-29")).toBeNull();
    expect(parseIsoDate("2026-2-01")).toBeNull();
    expect(parseIsoDate("2026-02-28")).toBe("2026-02-28");
  });
});

describe("supplier statement journey rules", () => {
  it("normalizes ordered channels and accumulates delays from the previous step", () => {
    const steps = normalizeJourneySteps([
      { channel: "email", delay_minutes: 0, subject: "Statement" },
      { channel: "whatsapp", delay_minutes: 60 },
      { channel: "email", delay_minutes: 120 },
    ]);
    expect(steps.map((step) => [step.order, step.channel, step.delay_minutes])).toEqual([
      [1, "email", 0],
      [2, "whatsapp", 60],
      [3, "email", 120],
    ]);
    const scheduled = buildStepSchedule(steps, new Date("2026-09-22T10:00:00Z"));
    expect(scheduled.map((step) => step.scheduled_at.toISOString())).toEqual([
      "2026-09-22T10:00:00.000Z",
      "2026-09-22T11:00:00.000Z",
      "2026-09-22T13:00:00.000Z",
    ]);
  });

  it("calculates a local-time run in the configured timezone", () => {
    const next = calculateNextRun({
      first_run_date: "2026-09-01",
      cadence: "monthly",
      local_day: 15,
      local_time: "09:30",
      timezone: "Asia/Beirut",
    }, new Date("2026-09-16T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-10-15T06:30:00.000Z");
  });

  it("keeps a first run in the future rather than creating an immediate catch-up run", () => {
    const next = calculateNextRun({
      first_run_date: "2026-12-15",
      cadence: "monthly",
      local_day: 15,
      local_time: "09:30",
      timezone: "Asia/Beirut",
    }, new Date("2026-09-23T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-12-15T07:30:00.000Z");
  });

  it("carries each step delay from the prior scheduled step", () => {
    const steps = normalizeJourneySteps([
      { channel: "email", delay_minutes: 15 },
      { channel: "whatsapp", delay_minutes: 45 },
    ]);
    expect(buildStepSchedule(steps, new Date("2026-09-22T10:00:00Z")).map((step) =>
      step.scheduled_at.toISOString(),
    )).toEqual([
      "2026-09-22T10:15:00.000Z",
      "2026-09-22T11:00:00.000Z",
    ]);
  });
});