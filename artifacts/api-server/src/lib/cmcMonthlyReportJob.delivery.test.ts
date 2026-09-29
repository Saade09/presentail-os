import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockQuery,
  mockComputeMonthlySales,
  mockGeneratePdf,
  mockSendCmcMonthlyReportEmail,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockComputeMonthlySales: vi.fn(),
  mockGeneratePdf: vi.fn(),
  mockSendCmcMonthlyReportEmail: vi.fn(),
}));

vi.mock("./db", () => ({ db: { query: mockQuery } }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./cmcMonthlySales", () => ({
  computeMonthlySales: mockComputeMonthlySales,
}));
vi.mock("./cmcMonthlySalesPdf", () => ({
  generateCmcMonthlySalesPdf: mockGeneratePdf,
}));
vi.mock("./email", () => ({
  sendCmcMonthlyReportEmail: mockSendCmcMonthlyReportEmail,
}));

import { runMonthlyReport } from "./cmcMonthlyReportJob";

describe("CMC monthly report delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeMonthlySales.mockResolvedValue({
      months: [],
      totals: { gross: 100, net: 90, commission: 18, commissionVat: 2, payable: 20 },
      currency: "USD",
      fromMonth: "2026-08",
      toMonth: "2026-08",
    });
    mockGeneratePdf.mockResolvedValue(Buffer.from("%PDF-test"));
    mockSendCmcMonthlyReportEmail.mockResolvedValue("resend-message-1");
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ user_id: "owner-1", email: "owner@example.com" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          workspace_owner_id: "workspace-1",
          report_month: "2026-08",
          recipient_email: "owner@example.com",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // mark sent
  });

  it("sends the PDF attachment and marks the delivery sent", async () => {
    await runMonthlyReport("workspace-1", "2026-08");

    expect(mockGeneratePdf).toHaveBeenCalledWith(
      "2026-08",
      expect.objectContaining({ currency: "USD" }),
    );
    expect(mockSendCmcMonthlyReportEmail).toHaveBeenCalledWith({
      toEmail: "owner@example.com",
      reportMonth: "2026-08",
      salesData: expect.objectContaining({ currency: "USD" }),
      pdfBuffer: Buffer.from("%PDF-test"),
    });

    const claimSql = mockQuery.mock.calls[3][0] as string;
    expect(claimSql).toContain("attempt_count = attempt_count + 1");
    expect(claimSql).toContain("last_attempt_at = now()");

    const sentSql = mockQuery.mock.calls[4][0] as string;
    expect(sentSql).toContain("status = 'sent'");
    expect(mockQuery.mock.calls[4][1]).toEqual(["resend-message-1", 42]);
  });
});