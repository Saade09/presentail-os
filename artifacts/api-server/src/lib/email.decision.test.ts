import { describe, it, expect, vi } from "vitest";

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: vi.fn() };
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildTimeOffDecisionHtml } from "./email";

const BASE_OPTS = {
  toEmail: "employee@example.com",
  employeeName: "Jane Smith",
  status: "APPROVED" as const,
  typeName: "Annual Leave",
  startDate: "2099-06-01",
  endDate: "2099-06-05",
  totalDays: 5,
  halfDay: false,
  halfDayPeriod: null as "AM" | "PM" | null,
  managerNote: null as string | null,
  reviewerName: null as string | null,
};

describe("buildTimeOffDecisionHtml — employee name in greeting", () => {
  it("uses the employee name in the greeting when employeeName is provided", () => {
    const html = buildTimeOffDecisionHtml(BASE_OPTS);

    expect(html).toContain("Hi Jane Smith,");
  });

  it("falls back to toEmail in the greeting when employeeName is null", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, employeeName: null });

    expect(html).toContain("Hi employee@example.com,");
    expect(html).not.toContain("Hi null");
  });

  it("falls back to toEmail in the greeting when employeeName is an empty string", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, employeeName: "" });

    expect(html).toContain("Hi employee@example.com,");
  });

  it("falls back to toEmail in the greeting when employeeName is only whitespace", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, employeeName: "   " });

    expect(html).toContain("Hi employee@example.com,");
  });

  it("trims leading/trailing whitespace from employeeName", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, employeeName: "  Jane Smith  " });

    expect(html).toContain("Hi Jane Smith,");
  });
});

describe("buildTimeOffDecisionHtml — date labels", () => {
  it("renders the start date as a human-readable label", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, startDate: "2099-06-01", endDate: "2099-06-01" });

    expect(html).toContain("Mon");
    expect(html).toContain("Jun");
    expect(html).toContain("2099");
  });

  it("renders a range separator when start and end dates differ", () => {
    const html = buildTimeOffDecisionHtml(BASE_OPTS);

    expect(html).toContain("–");
  });

  it("does not render a range separator when start and end dates are the same", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, startDate: "2099-06-01", endDate: "2099-06-01" });

    expect(html).not.toContain("–");
  });

  it("renders both start and end labels when dates differ", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      startDate: "2099-06-01",
      endDate: "2099-06-30",
    });

    expect(html).toContain("Jun 1, 2099");
    expect(html).toContain("Jun 30, 2099");
  });
});

describe("buildTimeOffDecisionHtml — manager note block", () => {
  it("omits the note block when managerNote is null", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, managerNote: null });

    expect(html).not.toContain("Note from");
  });

  it("omits the note block when managerNote is an empty string", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, managerNote: "" });

    expect(html).not.toContain("Note from");
  });

  it("omits the note block when managerNote is only whitespace", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, managerNote: "   " });

    expect(html).not.toContain("Note from");
  });

  it("renders the note block when managerNote is provided", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      managerNote: "Enjoy your break!",
    });

    expect(html).toContain("Note from");
    expect(html).toContain("Enjoy your break!");
  });

  it("uses 'Your manager' as the reviewer label when reviewerName is null", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      managerNote: "Approved.",
      reviewerName: null,
    });

    expect(html).toContain("Note from Your manager");
  });

  it("uses the provided reviewerName in the note block header", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      managerNote: "Approved.",
      reviewerName: "Alex Manager",
    });

    expect(html).toContain("Note from Alex Manager");
  });

  it("escapes HTML-special characters in the manager note", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      managerNote: "<b>Urgent</b> & important",
    });

    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("buildTimeOffDecisionHtml — approved vs declined", () => {
  it("renders the approved eyebrow text and green accent for APPROVED status", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, status: "APPROVED" });

    expect(html).toContain("Time off approved");
    expect(html).toContain("#16a34a");
    expect(html).not.toContain("#dc2626");
  });

  it("renders the declined eyebrow text and red accent for DECLINED status", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, status: "DECLINED" });

    expect(html).toContain("Time off declined");
    expect(html).toContain("#dc2626");
    expect(html).not.toContain("#16a34a");
  });

  it("renders 'has been approved' headline for APPROVED status", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, status: "APPROVED" });

    expect(html).toContain("has been approved");
  });

  it("renders 'was not approved' headline for DECLINED status", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, status: "DECLINED" });

    expect(html).toContain("was not approved");
  });
});

describe("buildTimeOffDecisionHtml — general structure", () => {
  it("includes the leave type name in the headline", () => {
    const html = buildTimeOffDecisionHtml(BASE_OPTS);

    expect(html).toContain("annual leave");
  });

  it("includes the recipient email in the footer note", () => {
    const html = buildTimeOffDecisionHtml(BASE_OPTS);

    expect(html).toContain("employee@example.com");
  });

  it("renders half-day period in the length field when halfDay is true", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      halfDay: true,
      halfDayPeriod: "AM",
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      totalDays: 0.5,
    });

    expect(html).toContain("Half day");
    expect(html).toContain("AM");
  });

  it("renders day count in the length field when halfDay is false", () => {
    const html = buildTimeOffDecisionHtml({ ...BASE_OPTS, totalDays: 3 });

    expect(html).toContain("3 days");
  });

  it("renders singular 'day' for totalDays of 1", () => {
    const html = buildTimeOffDecisionHtml({
      ...BASE_OPTS,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      totalDays: 1,
    });

    expect(html).toContain("1 day");
    expect(html).not.toContain("1 days");
  });
});
