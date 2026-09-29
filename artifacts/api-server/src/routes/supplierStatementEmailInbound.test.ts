import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { dbQuery, clientQuery, connect, fileExists, fileSave, markReceived, enabled } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  fileExists: vi.fn(),
  fileSave: vi.fn(),
  markReceived: vi.fn(),
  enabled: vi.fn(() => true),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => dbQuery(...args),
    connect: (...args: unknown[]) => connect(...args),
  },
  withTransaction: async (
    client: { query: (...args: unknown[]) => Promise<unknown> },
    callback: () => Promise<unknown>,
  ) => {
    await client.query("BEGIN");
    try {
      const result = await callback();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        exists: (...args: unknown[]) => fileExists(...args),
        save: (...args: unknown[]) => fileSave(...args),
      }),
    }),
  },
}));
vi.mock("../lib/supplierStatementDelivery", () => ({
  supplierStatementInboundConfigured: () => enabled(),
  markSupplierStatementReceivedById: (...args: unknown[]) => markReceived(...args),
}));

import supplierStatementEmailInboundRouter from "./supplierStatementEmailInbound";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(supplierStatementEmailInboundRouter);
  return instance;
}

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const requestRow = {
  id: REQUEST_ID,
  workspace_owner_id: "owner-a",
  supplier_id: 12,
  finance_entity_id: 8,
  period_start: "2026-09-01",
  period_end: "2026-09-30",
  status: "awaiting_reply",
};
const PDF = Buffer.from("%PDF-1.4 statement").toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPPLIER_STATEMENT_INBOUND_SECRET", "inbound-secret");
  vi.stubEnv("PRIVATE_OBJECT_DIR", "/private");
  enabled.mockReturnValue(true);
  dbQuery.mockResolvedValue({ rows: [requestRow], rowCount: 1 });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  connect.mockResolvedValue({
    query: (...args: unknown[]) => clientQuery(...args),
    release: vi.fn(),
  });
  fileExists.mockResolvedValue([false]);
  fileSave.mockResolvedValue(undefined);
  markReceived.mockResolvedValue(true);
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    MessageID: "email-message-1",
    From: "Supplier Finance <finance@acme.example>",
    To: `supplier-statement+${REQUEST_ID}@reply.example`,
    Subject: "Statement 2026-09",
    TextBody: "Please find the statement attached.",
    Attachments: [{ Name: "acme-2026-09.pdf", Content: PDF, ContentType: "application/pdf" }],
    ...overrides,
  };
}

describe("supplier statement email inbound", () => {
  it("rejects missing configuration and invalid signatures", async () => {
    enabled.mockReturnValue(false);
    expect((await request(app()).post("/webhooks/supplier-statement-email/inbound").send(payload())).status).toBe(404);
    enabled.mockReturnValue(true);
    expect((await request(app()).post("/webhooks/supplier-statement-email/inbound").send(payload())).status).toBe(401);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("correlates an approved sender, deduplicates attachment storage, and closes the request for an exact period", async () => {
    const response = await request(app())
      .post("/webhooks/supplier-statement-email/inbound")
      .set("x-supplier-statement-webhook-secret", "inbound-secret")
      .send(payload());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      accepted: true,
      request_id: REQUEST_ID,
      classification: "statement_document",
      attachment_count: 1,
    });
    expect(fileSave).toHaveBeenCalledOnce();
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("ON CONFLICT DO NOTHING"))).toBe(true);
    expect(markReceived).toHaveBeenCalledWith(REQUEST_ID, "owner-a", "resend_inbound", expect.objectContaining({
      classification: "statement_document",
    }));
  });

  it("keeps wrong-period documents in Needs attention without closing the request", async () => {
    const response = await request(app())
      .post("/webhooks/supplier-statement-email/inbound")
      .set("x-supplier-statement-webhook-secret", "inbound-secret")
      .send(payload({ Subject: "Statement 2026-08", Attachments: [{ Name: "acme-2026-08.pdf", Content: PDF }] }));

    expect(response.status).toBe(202);
    expect(response.body.classification).toBe("ambiguous_document");
    expect(markReceived).not.toHaveBeenCalled();
  });

  it("ignores an unapproved or uncorrelated sender without storing a document", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await request(app())
      .post("/webhooks/supplier-statement-email/inbound")
      .set("x-supplier-statement-webhook-secret", "inbound-secret")
      .send(payload({ From: "Other Supplier <other@example.com>" }));

    expect(response.status).toBe(202);
    expect(response.body.reason).toBe("uncorrelated_or_invalid_sender");
    expect(fileSave).not.toHaveBeenCalled();
    expect(markReceived).not.toHaveBeenCalled();
  });

  it("does not close twice when the inbound ledger reports a duplicate callback", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // inbound conflict
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // COMMIT
    const response = await request(app())
      .post("/webhooks/supplier-statement-email/inbound")
      .set("x-supplier-statement-webhook-secret", "inbound-secret")
      .send(payload());

    expect(response.status).toBe(202);
    expect(markReceived).not.toHaveBeenCalled();
  });
});