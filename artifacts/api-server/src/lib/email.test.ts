import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSend = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

const mockWarn = vi.fn();
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
  },
}));

import { sendTimeOffRequestSubmittedEmail, sendTimeOffRequestConfirmationEmail } from "./email";

describe("sendTimeOffRequestSubmittedEmail", () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = ORIGINAL_KEY;
    }
  });

  it("no-ops and logs a warning when RESEND_API_KEY is not configured", async () => {
    delete process.env.RESEND_API_KEY;

    await expect(
      sendTimeOffRequestSubmittedEmail({
        toEmail: "manager@example.com",
        requesterName: "Alex Doe",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        totalDays: 2,
        halfDay: false,
        halfDayPeriod: null,
        reason: null,
        approvalsUrl: "https://os.presentail.com/time-off/approvals",
      }),
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "manager@example.com" }),
      expect.stringMatching(/RESEND_API_KEY not configured/),
    );
  });
});

describe("sendTimeOffRequestConfirmationEmail", () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = ORIGINAL_KEY;
    }
  });

  it("no-ops and logs a warning when RESEND_API_KEY is not configured", async () => {
    delete process.env.RESEND_API_KEY;

    await expect(
      sendTimeOffRequestConfirmationEmail({
        toEmail: "employee@example.com",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-05",
        totalDays: 5,
        halfDay: false,
        halfDayPeriod: null,
        reason: null,
        myRequestsUrl: "https://os.presentail.com/time-off/my",
      }),
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "employee@example.com" }),
      expect.stringMatching(/RESEND_API_KEY not configured/),
    );
  });

});
