import { describe, expect, it } from "vitest";
import {
  formatOperationalDeliveryWindow,
  rescheduleErrorMessage,
  formatDeliverySchedule,
  marketDateKey,
  rescheduleInitialDate,
  resolveDeliverySchedule,
} from "./deliveryDate";

describe("rescheduleErrorMessage", () => {
  it("keeps an actionable availability conflict", () => {
    expect(
      rescheduleErrorMessage(
        Object.assign(new Error("Choose another slot."), { status: 409 }),
        "Please try again.",
      ),
    ).toBe("Choose another slot.");
  });

  it("uses the server payload without the generated client's HTTP prefix", () => {
    expect(
      rescheduleErrorMessage(
        {
          status: 409,
          message: "HTTP 409 Conflict: stale",
          data: { error: "That delivery slot is no longer available." },
        },
        "Please try again.",
      ),
    ).toBe("That delivery slot is no longer available.");
  });

  it("hides unexpected HTTP 500 transport and server details", () => {
    expect(
      rescheduleErrorMessage(
        {
          status: 500,
          message: "HTTP 500 Internal Server Error: database detail",
          data: { error: "Could not reschedule delivery" },
        },
        "Please try again.",
      ),
    ).toBe("Please try again.");
  });
});

describe("formatOperationalDeliveryWindow", () => {
  it("uses Beirut market time and retains the calendar date for Today", () => {
    const result = formatOperationalDeliveryWindow(
      "2026-08-27T11:00:00.000Z",
      "2026-08-27T15:00:00.000Z",
      "Asia/Beirut",
      new Date("2026-08-27T06:00:00.000Z"),
    );

    expect(result?.fullLabel).toBe("Today, Aug 27 · 2:00 PM–6:00 PM");
  });

  it("uses Dubai market time rather than the viewer timezone for Tomorrow", () => {
    const result = formatOperationalDeliveryWindow(
      "2026-08-28T10:00:00.000Z",
      "2026-08-28T14:00:00.000Z",
      "Asia/Dubai",
      new Date("2026-08-27T19:30:00.000Z"),
    );

    expect(result?.fullLabel).toBe("Tomorrow, Aug 28 · 2:00 PM–6:00 PM");
  });

  it("keeps later dates and overnight end times unambiguous", () => {
    const result = formatOperationalDeliveryWindow(
      "2026-08-29T19:00:00.000Z",
      "2026-08-30T01:00:00.000Z",
      "Asia/Beirut",
      new Date("2026-08-27T06:00:00.000Z"),
    );

    expect(result?.fullLabel).toBe("Sat, Aug 29 · 10:00 PM–4:00 AM");
  });

  it("creates market date keys at local midnight boundaries", () => {
    const instant = new Date("2026-08-27T21:30:00.000Z");
    expect(marketDateKey(instant, "Asia/Beirut")).toBe("2026-08-28");
    expect(marketDateKey(instant, "America/New_York")).toBe("2026-08-27");
  });
});

describe("resolveDeliverySchedule", () => {
  it("prefers a valid canonical window over conflicting legacy metadata", () => {
    const schedule = resolveDeliverySchedule({
      windowStart: "2026-08-29T11:00:00.000Z",
      windowEnd: "2026-08-29T15:00:00.000Z",
      legacyDate: "2026-08-31",
      legacySlot: "9:00 AM – 12:00 PM",
    });

    expect(schedule?.source).toBe("canonical");
    expect(
      formatDeliverySchedule(schedule, "Asia/Beirut", new Date("2026-08-28T06:00:00.000Z"))
        ?.fullLabel,
    ).toBe("Tomorrow, Aug 29 · 2:00 PM–6:00 PM");
  });

  it("uses a valid legacy date and slot when no canonical window exists", () => {
    const schedule = resolveDeliverySchedule({
      windowStart: null,
      windowEnd: undefined,
      legacyDate: " 2026-08-29 ",
      legacySlot: " 11:00 PM - 1:00 AM ",
    });

    expect(schedule?.source).toBe("legacy");
    expect(
      formatDeliverySchedule(schedule, "Asia/Beirut", new Date("2026-08-28T06:00:00.000Z"))
        ?.fullLabel,
    ).toBe("Tomorrow, Aug 29 · 11:00 PM - 1:00 AM");
  });

  it("renders the API-projected LB-style schedule as the established date and slot layout", () => {
    const schedule = resolveDeliverySchedule({
      legacyDate: "2026-08-29",
      legacySlot: "2:00 PM - 5:00 PM",
    });

    expect(
      formatDeliverySchedule(schedule, "Asia/Beirut", new Date("2026-08-28T06:00:00.000Z")),
    ).toMatchObject({
      relativeLabel: "Tomorrow",
      dateLabel: "Tomorrow, Aug 29",
      timeLabel: "2:00 PM - 5:00 PM",
    });
  });

  it("keeps a dated Express named slot schedulable without fabricating a time range", () => {
    const schedule = resolveDeliverySchedule({
      legacyDate: "2026-08-29",
      legacySlot: "Express",
    });

    expect(schedule.source).toBe("legacy");
    expect(
      formatDeliverySchedule(schedule, "Asia/Beirut", new Date("2026-08-28T06:00:00.000Z")),
    ).toMatchObject({
      dateLabel: "Tomorrow, Aug 29",
      timeLabel: "Express",
      fullLabel: "Tomorrow, Aug 29 · Express",
    });
  });

  it.each([
    [{ legacyDate: "", legacySlot: "10:00–12:00" }],
    [{ legacyDate: "2026-02-30", legacySlot: "10:00–12:00" }],
    [{ legacyDate: "2026-08-29", legacySlot: "not a time" }],
    [{ windowStart: "not-a-date", windowEnd: null }],
  ])("returns a neutral presentation for unusable delivery data", (input) => {
    const schedule = resolveDeliverySchedule(input);
    expect(schedule?.source).toBe("invalid");
    expect(formatDeliverySchedule(schedule, "Not/AZone")).toBeNull();
  });

  it("keeps truly unscheduled orders distinct from malformed input", () => {
    expect(resolveDeliverySchedule({}).source).toBe("unscheduled");
    expect(resolveDeliverySchedule({}).dateKey).toBe("");
  });

  it("falls back safely for an invalid timezone", () => {
    const schedule = resolveDeliverySchedule({
      windowStart: "2026-08-29T00:30:00.000Z",
      windowEnd: "2026-08-29T02:30:00.000Z",
    });
    expect(
      formatDeliverySchedule(schedule, "Not/AZone", new Date("2026-08-28T06:00:00.000Z"))
        ?.fullLabel,
    ).toBe("Tomorrow, Aug 29 · 12:30 AM–2:30 AM");
  });
});

describe("rescheduleInitialDate", () => {
  it("uses the canonical market date when legacy metadata disagrees", () => {
    expect(
      rescheduleInitialDate(
        {
          windowStart: "2026-08-30T21:30:00.000Z",
          windowEnd: "2026-08-31T01:00:00.000Z",
          legacyDate: "2026-09-04",
          legacySlot: "9:00 AM–2:00 PM",
        },
        "Asia/Beirut",
      ),
    ).toBe("2026-08-31");
  });

  it("keeps a legacy calendar date as the locale-independent native input value", () => {
    expect(
      rescheduleInitialDate(
        {
          windowStart: null,
          windowEnd: null,
          legacyDate: "2026-08-31",
          legacySlot: "9:00 AM–2:00 PM",
        },
        "America/Los_Angeles",
      ),
    ).toBe("2026-08-31");
  });

  it("falls back to the market's current date for incomplete legacy data", () => {
    expect(
      rescheduleInitialDate(
        { legacyDate: "2026-09-04", legacySlot: "" },
        "Asia/Dubai",
        new Date("2026-08-30T21:30:00.000Z"),
      ),
    ).toBe("2026-08-31");
  });
});