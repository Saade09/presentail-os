import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSend(...args) };
  },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendCmcMonthlyReportEmail } from "./email";

describe("sendCmcMonthlyReportEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "test-resend-key";
    mockSend.mockResolvedValue({ data: { id: "cmc-message-1" }, error: null });
  });

  it("sends the report summary with the generated PDF attachment", async () => {
    const pdfBuffer = Buffer.from("%PDF-cmc-report");
    const salesData = {
      months: [],
      totals: { gross: 100, net: 90, commission: 18, commissionVat: 2, payable: 20 },
      currency: "USD",
      fromMonth: "2026-08",
      toMonth: "2026-08",
    };

    await expect(sendCmcMonthlyReportEmail({
      toEmail: "owner@example.com",
      reportMonth: "2026-08",
      salesData,
      pdfBuffer,
    })).resolves.toBe("cmc-message-1");

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: "owner@example.com",
      subject: "CMC Monthly Sales Report — 2026-08",
      attachments: [{
        filename: "cmc-monthly-sales-2026-08.pdf",
        content: pdfBuffer,
      }],
    }));
  });
});