import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbQuery,
  clientQuery,
  connect,
  findOrCreate,
  setAttributes,
  sendTemplate,
  sendEmail,
} = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  findOrCreate: vi.fn(),
  setAttributes: vi.fn(),
  sendTemplate: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("./db", () => ({
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
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./email", () => ({
  sendSupplierStatementEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock("./respondio", () => ({
  findOrCreateContactByPhone: (...args: unknown[]) => findOrCreate(...args),
  normalizePhoneForCountry: (value: string) => value.startsWith("+") ? value.replace(/\s/g, "") : null,
  sendWhatsAppTemplateToContact: (...args: unknown[]) => sendTemplate(...args),
  setContactCustomAttributes: (...args: unknown[]) => setAttributes(...args),
}));

import {
  isSupplierStatementPayload,
  markSupplierStatementReceivedById,
  renderSupplierStatementMessage,
  sendSupplierStatementWhatsApp,
  supplierStatementEmailIdempotencyHeader,
  supplierStatementProviderReadiness,
} from "./supplierStatementDelivery";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const key of [
    "RESEND_API_KEY",
    "RESEND_WEBHOOK_SECRET",
    "SUPPLIER_STATEMENT_REPLY_DOMAIN",
    "SUPPLIER_STATEMENT_INBOUND_ENABLED",
    "RESPONDIO_API_TOKEN",
    "RESPONDIO_INCOMING_WEBHOOK_SECRET",
    "RESPONDIO_STATUS_WEBHOOK_SECRET",
  ]) vi.stubEnv(key, "");
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  connect.mockResolvedValue({
    query: (...args: unknown[]) => clientQuery(...args),
    release: vi.fn(),
  });
  findOrCreate.mockResolvedValue("respondio-contact-1");
  setAttributes.mockResolvedValue(true);
  sendTemplate.mockResolvedValue({ ok: true, providerRef: "wa-message-1" });
  sendEmail.mockResolvedValue({ ok: true, providerMessageId: "email-1" });
});

describe("supplier statement provider boundaries", () => {
  it("recognizes only the supplier namespace, not ordinary customer payloads", () => {
    expect(isSupplierStatementPayload({ type: "message.received", data: {} })).toBe(false);
    expect(isSupplierStatementPayload({ data: { supplier_statement_namespace: "supplier_statement_collection" } })).toBe(true);
    expect(isSupplierStatementPayload({ data: { tags: [{ name: "namespace", value: "supplier_statement_collection" }] } })).toBe(true);
  });

  it("reports each missing provider prerequisite", () => {
    vi.stubEnv("RESEND_API_KEY", "key");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "secret");
    vi.stubEnv("SUPPLIER_STATEMENT_REPLY_DOMAIN", "reply.example");
    vi.stubEnv("SUPPLIER_STATEMENT_INBOUND_ENABLED", "true");
    vi.stubEnv("RESPONDIO_API_TOKEN", "token");
    const readiness = supplierStatementProviderReadiness();
    expect(readiness.email).toMatchObject({ configured: true, deliveryWebhook: true, inbound: true, missing: [] });
    expect(readiness.whatsapp).toMatchObject({ configured: true, missing: ["RESPONDIO_INCOMING_WEBHOOK_SECRET", "RESPONDIO_STATUS_WEBHOOK_SECRET"] });
  });

  it("renders the exact period variables and hashes idempotency keys", () => {
    expect(renderSupplierStatementMessage("Hi {{contact_name}} — {{entity_name}} {{period_start}} to {{period_end}}", {
      supplierName: "Acme",
      contactName: "Nora",
      entityName: "Presentail UAE",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      periodLabel: "September 2026",
    })).toBe("Hi Nora — Presentail UAE 2026-09-01 to 2026-09-30");
    expect(supplierStatementEmailIdempotencyHeader("request-1:step:1")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the dedicated namespace and mixed-channel variables for WhatsApp", async () => {
    vi.stubEnv("RESPONDIO_CHANNEL_ID", "543704");
    vi.stubEnv("SUPPLIER_STATEMENT_WHATSAPP_LANGUAGE", "en");
    const result = await sendSupplierStatementWhatsApp({
      requestId: "request-1",
      stepId: "step-1",
      supplierContactId: 21,
      contactName: "Nora Finance",
      phone: "+961 3 159 639",
      entityName: "Presentail UAE",
      periodStart: "Tue Sep 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
      periodEnd: "Wed Sep 30 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
    });

    expect(result).toMatchObject({
      ok: true,
      providerMessageId: "wa-message-1",
      providerContactId: "respondio-contact-1",
      providerChannelId: "543704",
      renderedVariables: ["Nora Finance", "Presentail UAE", "September 1, 2026", "September 30, 2026"],
    });
    expect(findOrCreate).toHaveBeenCalledWith("+9613159639", "Nora", "Finance");
    expect(setAttributes).toHaveBeenCalledWith("respondio-contact-1", expect.objectContaining({
      supplier_statement_namespace: "supplier_statement_collection",
      supplier_statement_request_id: "request-1",
      supplier_statement_step_id: "step-1",
    }));
    expect(sendTemplate).toHaveBeenCalledWith("respondio-contact-1", expect.objectContaining({
      templateName: "supplier_statement_request",
      bodyParameters: ["Nora Finance", "Presentail UAE", "September 1, 2026", "September 30, 2026"],
      channelId: 543704,
    }));
    expect(setAttributes.mock.invocationCallOrder[0]).toBeLessThan(sendTemplate.mock.invocationCallOrder[0]);
  });

  it("does not call a provider for an invalid phone", async () => {
    const result = await sendSupplierStatementWhatsApp({
      requestId: "request-1",
      stepId: "step-1",
      supplierContactId: 21,
      contactName: "Nora",
      phone: "03 159 639",
      entityName: "Presentail UAE",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_phone", retryable: false });
    expect(findOrCreate).not.toHaveBeenCalled();
  });
});

describe("markSupplierStatementReceivedById", () => {
  it("locks the open request, cancels queued steps, and writes audit/communication records", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "request-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // COMMIT
    await expect(markSupplierStatementReceivedById("request-1", "owner-a", "actor-a", { source: "email" })).resolves.toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("status IN ('pending','processing')"))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql, params]) =>
      String(sql).includes("statement_received") && Array.isArray(params) && params.includes("actor-a"),
    )).toBe(true);
  });

  it("returns false when another callback already closed the request", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // locked request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // COMMIT
    await expect(markSupplierStatementReceivedById("request-1", "owner-a", "actor-a")).resolves.toBe(false);
    expect(clientQuery).toHaveBeenCalledTimes(3); // BEGIN + locked request + COMMIT
  });
});