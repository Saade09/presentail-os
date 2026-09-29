import { describe, it, expect, vi } from "vitest";

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: vi.fn() };
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildTimeOffRequestSubmittedHtml } from "./email";

const BASE_OPTS = {
  toEmail: "manager@example.com",
  requesterName: "Jane Smith" as string | null,
  typeName: "Annual Leave",
  startDate: "2099-06-01",
  endDate: "2099-06-05",
  totalDays: 5,
  halfDay: false,
  halfDayPeriod: null as "AM" | "PM" | null,
  reason: null as string | null,
  approvalsUrl: "https://os.presentail.com/time-off/approvals",
};

describe("buildTimeOffRequestSubmittedHtml — requester name in headline", () => {
  it("uses the requester name in the headline when requesterName is provided", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("Jane Smith");
  });

  it("falls back to toEmail in the headline when requesterName is null", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, requesterName: null });

    expect(html).toContain("manager@example.com");
    expect(html).not.toContain("null");
  });

  it("falls back to toEmail in the headline when requesterName is an empty string", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, requesterName: "" });

    expect(html).toContain("manager@example.com");
  });

  it("falls back to toEmail in the headline when requesterName is only whitespace", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, requesterName: "   " });

    expect(html).toContain("manager@example.com");
  });

  it("trims leading/trailing whitespace from requesterName", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, requesterName: "  Jane Smith  " });

    expect(html).toContain("Jane Smith");
  });

  it("escapes HTML-special characters in requesterName", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      requesterName: "<script>alert('xss')</script>",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("buildTimeOffRequestSubmittedHtml — date labels", () => {
  it("renders the start date as a human-readable label", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
    });

    expect(html).toContain("Mon");
    expect(html).toContain("Jun");
    expect(html).toContain("2099");
  });

  it("renders a range separator when start and end dates differ", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("–");
  });

  it("does not render a range separator when start and end dates are the same", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
    });

    expect(html).not.toContain("–");
  });

  it("renders both start and end labels when dates differ", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      startDate: "2099-06-01",
      endDate: "2099-06-30",
    });

    expect(html).toContain("Jun 1, 2099");
    expect(html).toContain("Jun 30, 2099");
  });
});

describe("buildTimeOffRequestSubmittedHtml — half-day period", () => {
  it("renders Half day with the period in the length field", () => {
    const html = buildTimeOffRequestSubmittedHtml({
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

  it("renders Half day with PM period", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      halfDay: true,
      halfDayPeriod: "PM",
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      totalDays: 0.5,
    });

    expect(html).toContain("Half day");
    expect(html).toContain("PM");
  });

  it("renders Half day without a period when halfDayPeriod is null", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      halfDay: true,
      halfDayPeriod: null,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      totalDays: 0.5,
    });

    expect(html).toContain("Half day");
    expect(html).not.toContain("(AM)");
    expect(html).not.toContain("(PM)");
  });

  it("renders the day count label when halfDay is false", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      halfDay: false,
      totalDays: 3,
    });

    expect(html).toContain("3 days");
    expect(html).not.toContain("Half day");
  });

  it("uses singular 'day' when totalDays is 1", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      halfDay: false,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      totalDays: 1,
    });

    expect(html).toContain("1 day");
    expect(html).not.toContain("1 days");
  });
});

describe("buildTimeOffRequestSubmittedHtml — reason block", () => {
  it("omits the reason block when reason is null", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, reason: null });

    expect(html).not.toContain("Note from");
  });

  it("omits the reason block when reason is an empty string", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, reason: "" });

    expect(html).not.toContain("Note from");
  });

  it("omits the reason block when reason is only whitespace", () => {
    const html = buildTimeOffRequestSubmittedHtml({ ...BASE_OPTS, reason: "   " });

    expect(html).not.toContain("Note from");
  });

  it("renders the reason block with the requester name when reason is provided", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      reason: "Family event.",
    });

    expect(html).toContain("Note from Jane Smith");
    expect(html).toContain("Family event.");
  });

  it("uses toEmail in the reason block header when requesterName is null", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      requesterName: null,
      reason: "Family event.",
    });

    expect(html).toContain("Note from manager@example.com");
  });

  it("escapes HTML-special characters in the reason text", () => {
    const html = buildTimeOffRequestSubmittedHtml({
      ...BASE_OPTS,
      reason: "<b>Urgent</b> & important",
    });

    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("buildTimeOffRequestSubmittedHtml — action link", () => {
  it("includes the approvalsUrl in the Review request CTA button", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("https://os.presentail.com/time-off/approvals");
  });

  it("includes the 'Review request' CTA text linking to the approvals page", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("Review request");
  });

  it("includes the approvalsUrl as an anchor href", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain(`href="${BASE_OPTS.approvalsUrl}"`);
  });
});

describe("buildTimeOffRequestSubmittedHtml — general structure", () => {
  it("always contains the 'New time-off request' eyebrow text", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("New time-off request");
  });

  it("includes the leave type name in the headline", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("annual leave");
  });

  it("includes the recipient (manager) email in the footer note", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("manager@example.com");
  });

  it("attributes the notification to the requester's manager role in the footer", () => {
    const html = buildTimeOffRequestSubmittedHtml(BASE_OPTS);

    expect(html).toContain("listed as");
    expect(html).toContain("manager");
  });
});
