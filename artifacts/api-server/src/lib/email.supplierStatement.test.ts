import { describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => send(...args) };
  },
}));
vi.mock("./logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import { sendSupplierStatementEmail } from "./email";

describe("supplier-only Resend send contract", () => {
  it("uses a stable provider idempotency key and a replyable request reference", async () => {
    process.env.RESEND_API_KEY = "test";
    const previousFrom = process.env.SUPPLIER_STATEMENT_FROM;
    delete process.env.SUPPLIER_STATEMENT_FROM;
    send.mockResolvedValue({ data: { id: "out-1" }, error: null });
    try {
      const result = await sendSupplierStatementEmail({
        to: ["supplier@example.com"], subject: "Please send your statement",
        message: "Please send a statement.", requestId: "b026773d-6001-49e5-9570-1c39c4a9b1a3",
        stepId: "45", entityId: 3,
        periodStart: "Tue Sep 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
        periodEnd: "Wed Sep 30 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
        replyTo: "statements@receiving.example", idempotencyKey: "request-1:step:45",
      });
      expect(result).toEqual({ ok: true, providerMessageId: "out-1" });
      expect(send.mock.calls[0][0]).toMatchObject({
        from: "Presentail Supplier Collections <supplier-statements@presentail.com>",
        replyTo: "statements@receiving.example",
        subject: "Please send your statement [Statement ref: b026773d-6001-49e5-9570-1c39c4a9b1a3]",
      });
      const payload = send.mock.calls[0][0] as { text: string; html: string };
      expect(payload.text).toContain("Hello,");
      expect(payload.text).toContain("Statement period: September 1, 2026 to September 30, 2026.");
      expect(payload.text).toContain("Thank you,");
      expect(payload.text).not.toContain("GMT+0000");
      expect(payload.html).toContain("<strong>Statement period:</strong> September 1, 2026 to September 30, 2026.");
      expect(send.mock.calls[0][1].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (previousFrom === undefined) delete process.env.SUPPLIER_STATEMENT_FROM;
      else process.env.SUPPLIER_STATEMENT_FROM = previousFrom;
    }
  });
});