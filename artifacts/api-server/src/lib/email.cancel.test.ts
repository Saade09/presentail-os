import { describe, it, expect, vi } from "vitest";

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: vi.fn() };
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildTimeOffCancelledHtml } from "./email";

const BASE_OPTS = {
  toEmail: "employee@example.com",
  employeeName: "Jane Smith",
  typeName: "Annual Leave",
  startDate: "2099-06-01",
  endDate: "2099-06-05",
  totalDays: 5,
  halfDay: false,
  halfDayPeriod: null as null,
  cancellationReason: null as string | null,
  cancelledByName: null as string | null,
  myRequestsUrl: "https://os.presentail.com/time-off/my-requests",
};

describe("buildTimeOffCancelledHtml — employee name in greeting", () => {
  it("uses the employee name in the greeting when employeeName is provided", () => {
    const html = buildTimeOffCancelledHtml(BASE_OPTS);

    expect(html).toContain("Hi Jane Smith,");
  });

  it("falls back to toEmail in the greeting when employeeName is null", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, employeeName: null });

    expect(html).toContain("Hi employee@example.com,");
    expect(html).not.toContain("Hi null");
  });

  it("falls back to toEmail in the greeting when employeeName is an empty string", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, employeeName: "" });

    expect(html).toContain("Hi employee@example.com,");
  });

  it("falls back to toEmail in the greeting when employeeName is only whitespace", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, employeeName: "   " });

    expect(html).toContain("Hi employee@example.com,");
  });

  it("trims leading/trailing whitespace from employeeName", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, employeeName: "  Jane Smith  " });

    expect(html).toContain("Hi Jane Smith,");
  });
});

describe("buildTimeOffCancelledHtml — date labels", () => {
  it("renders the start date as a human-readable label", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, startDate: "2099-06-01", endDate: "2099-06-01" });

    expect(html).toContain("Mon");
    expect(html).toContain("Jun");
    expect(html).toContain("2099");
  });

  it("renders a range separator when start and end dates differ", () => {
    const html = buildTimeOffCancelledHtml(BASE_OPTS);

    expect(html).toContain("–");
  });

  it("does not render a range separator when start and end dates are the same", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, startDate: "2099-06-01", endDate: "2099-06-01" });

    expect(html).not.toContain("–");
  });

  it("renders both start and end labels when dates differ", () => {
    const html = buildTimeOffCancelledHtml({
      ...BASE_OPTS,
      startDate: "2099-06-01",
      endDate: "2099-06-30",
    });

    expect(html).toContain("Jun 1, 2099");
    expect(html).toContain("Jun 30, 2099");
  });
});

describe("buildTimeOffCancelledHtml — cancellation reason block", () => {
  it("omits the reason block when cancellationReason is null", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, cancellationReason: null });

    expect(html).not.toContain("Reason from");
  });

  it("omits the reason block when cancellationReason is an empty string", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, cancellationReason: "" });

    expect(html).not.toContain("Reason from");
  });

  it("omits the reason block when cancellationReason is only whitespace", () => {
    const html = buildTimeOffCancelledHtml({ ...BASE_OPTS, cancellationReason: "   " });

    expect(html).not.toContain("Reason from");
  });

  it("renders the reason block when cancellationReason is provided", () => {
    const html = buildTimeOffCancelledHtml({
      ...BASE_OPTS,
      cancellationReason: "Business needs have changed.",
    });

    expect(html).toContain("Reason from");
    expect(html).toContain("Business needs have changed.");
  });

  it("uses 'Your manager' as the canceller label when cancelledByName is null", () => {
    const html = buildTimeOffCancelledHtml({
      ...BASE_OPTS,
      cancellationReason: "Scheduling conflict.",
      cancelledByName: null,
    });

    expect(html).toContain("Reason from Your manager");
  });

  it("uses the provided cancelledByName in the reason block header", () => {
    const html = buildTimeOffCancelledHtml({
      ...BASE_OPTS,
      cancellationReason: "Scheduling conflict.",
      cancelledByName: "Alex Manager",
    });

    expect(html).toContain("Reason from Alex Manager");
  });

  it("escapes HTML-special characters in the cancellation reason", () => {
    const html = buildTimeOffCancelledHtml({
      ...BASE_OPTS,
      cancellationReason: "<b>Urgent</b> & critical",
    });

    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("buildTimeOffCancelledHtml — general structure", () => {
  it("always contains the 'Time off cancelled' eyebrow text", () => {
    const html = buildTimeOffCancelledHtml(BASE_OPTS);

    expect(html).toContain("Time off cancelled");
  });

  it("includes the leave type name in the headline", () => {
    const html = buildTimeOffCancelledHtml(BASE_OPTS);

    expect(html).toContain("annual leave");
  });

  it("includes the recipient email in the footer note", () => {
    const html = buildTimeOffCancelledHtml(BASE_OPTS);

    expect(html).toContain("employee@example.com");
  });

  it("includes a link to the myRequestsUrl CTA", () => {
    const html = buildTimeOffCancelledHtml(BASE_OPTS);

    expect(html).toContain("https://os.presentail.com/time-off/my-requests");
  });

  it("renders half-day period in the length field when halfDay is true", () => {
    const html = buildTimeOffCancelledHtml({
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
});
