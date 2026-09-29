import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResendReceivedEmail } from "./supplierStatementDelivery";

const query = vi.fn();
const clientQuery = vi.fn();
const save = vi.fn();
const exists = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => query(...args),
    connect: async () => ({ query: (...args: unknown[]) => clientQuery(...args), release: vi.fn() }),
  },
  withTransaction: async (_client: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("./objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({ file: () => ({ exists: (...args: unknown[]) => exists(...args), save: (...args: unknown[]) => save(...args) }) }),
  },
}));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isSupplierStatementPayload,
  processSupplierStatementResendInbound,
  supplierStatementReplyAddress,
} from "./supplierStatementDelivery";

const requestId = "b026773d-6001-49e5-9570-1c39c4a9b1a3";
const matched = {
  request_id: requestId, workspace_owner_id: "ws1", supplier_id: 1,
  finance_entity_id: 2, period_start: "2026-08-01", period_end: "2026-08-31",
  status: "in_progress", step_id: null, sender_approved: true,
};
const email = (overrides: Partial<ResendReceivedEmail> = {}): ResendReceivedEmail => ({
  id: "inbound-1", to: ["statements@receiving.example"], from: "Supplier <supplier@example.com>",
  created_at: "2026-09-23T10:00:00Z", subject: `Re: Request [Statement ref: ${requestId}]`,
  cc: null, bcc: null, reply_to: null, html: null, text: "Attached", headers: null,
  message_id: "<inbound-1@example.com>",
  attachments: [], ...overrides,
});
const input = (message: ResendReceivedEmail) => ({
  providerEventId: "evt-1", providerEmailId: message.id, email: message,
});

beforeEach(() => {
  query.mockReset();
  clientQuery.mockReset();
  exists.mockReset().mockResolvedValue([false]);
  save.mockReset().mockResolvedValue(undefined);
  process.env.SUPPLIER_STATEMENT_RESEND_INBOUND_ADDRESS = "statements@receiving.example";
  process.env.PRIVATE_OBJECT_DIR = "/private-bucket/private";
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("supplier statement inbound isolation and correlation", () => {
  it("requires a supplier namespace, not a WhatsApp template name", () => {
    expect(isSupplierStatementPayload({ data: { message: { templateName: "supplier_statement_request" } } })).toBe(false);
    expect(isSupplierStatementPayload({ data: { namespace: "supplier_statement_collection" } })).toBe(true);
  });

  it("uses only the configured Resend receiving address, not the obsolete reply domain", () => {
    process.env.SUPPLIER_STATEMENT_REPLY_DOMAIN = "old.example";
    expect(supplierStatementReplyAddress(requestId)).toBe("statements@receiving.example");
    delete process.env.SUPPLIER_STATEMENT_RESEND_INBOUND_ADDRESS;
    expect(supplierStatementReplyAddress(requestId)).toBeNull();
    delete process.env.SUPPLIER_STATEMENT_REPLY_DOMAIN;
  });

  it("ignores mail to another inbox even from a known supplier", async () => {
    const result = await processSupplierStatementResendInbound(input(email({ to: ["support@example.com"] })));
    expect(result.handled).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("does not fall back to another request for an invalid explicit reference", async () => {
    const result = await processSupplierStatementResendInbound(input(email()));
    expect(result.handled).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects two open requests for the same sender when no reference is supplied", async () => {
    query.mockResolvedValueOnce({ rows: [] }) // dedupe
      .mockResolvedValueOnce({ rows: [] }) // provider reference
      .mockResolvedValueOnce({ rows: [matched, { ...matched, request_id: "other" }] });
    const result = await processSupplierStatementResendInbound(input(email({ subject: "Statement" })));
    expect(result).toMatchObject({ classification: "ambiguous_request" });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("stores a reply without closing the request", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [matched] });
    const result = await processSupplierStatementResendInbound(input(email()));
    expect(result).toMatchObject({ classification: "reply", documentStatus: null });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_requests"))).toBe(false);
  });

  it("stores a wrong-period document for review without closing", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [matched] });
    const result = await processSupplierStatementResendInbound(input(email({
      subject: `Re: Statement 2026-08-01 to 2026-08-31 [Statement ref: ${requestId}]`,
      text: "On 2026-08-01 to 2026-08-31 you asked us for a statement.",
      attachments: [{
        id: "att1", filename: "2026-07-01_2026-07-31.pdf", size: 5,
        content_type: "application/pdf", content_disposition: "attachment", content_id: null,
        bytes: Buffer.from("hello"),
      }],
    })));
    expect(result).toMatchObject({ classification: "ambiguous_document", documentStatus: "needs_attention" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_requests"))).toBe(false);
  });

  it("closes the matching exact-period document and cancels later steps", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [matched] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM supplier_statement_requests")) return { rows: [{ id: requestId }] };
      return { rows: [], rowCount: 1 };
    });
    const result = await processSupplierStatementResendInbound(input(email({
      attachments: [{
        id: "att1", filename: "statement_2026-08-01_2026-08-31.pdf", size: 5,
        content_type: "application/pdf", content_disposition: "attachment", content_id: null,
        bytes: Buffer.from("hello"),
      }],
    })));
    expect(result.documentStatus).toBe("exact_period");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_step_executions"))).toBe(true);
  });

  it("deduplicates a redelivered provider email without writing a second inbound row", async () => {
    query.mockResolvedValueOnce({
      rows: [{ request_id: requestId, workspace_owner_id: "ws1", classification: "reply", document_status: null }],
    });
    const result = await processSupplierStatementResendInbound(input(email()));
    expect(result).toMatchObject({ handled: true, duplicate: true });
    expect(clientQuery).not.toHaveBeenCalled();
  });
});