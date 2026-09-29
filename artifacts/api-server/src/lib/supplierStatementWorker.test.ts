import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbQuery, clientQuery, connect, sendEmail, sendWhatsApp } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  sendEmail: vi.fn(),
  sendWhatsApp: vi.fn(),
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
vi.mock("./supplierStatementDelivery", () => ({
  renderSupplierStatementMessage: () => "rendered supplier statement",
  sendSupplierStatementEmail: (...args: unknown[]) => sendEmail(...args),
  sendSupplierStatementWhatsApp: (...args: unknown[]) => sendWhatsApp(...args),
  supplierStatementProviderReadiness: () => ({
    email: { configured: true },
    whatsapp: { configured: true },
  }),
  supplierStatementReplyAddress: (requestId: string) => `supplier-statement+${requestId}@reply.example`,
}));

import { __test } from "./supplierStatementWorker";

const claimed = {
  id: 7,
  request_id: "request-1",
  workspace_owner_id: "owner-a",
  step_order: 1,
  channel: "email" as const,
  scheduled_at: new Date().toISOString(),
  attempt_count: 1,
  idempotency_key: "request-1:step:1",
};

const loadedStep = {
  ...claimed,
  request_status: "open",
  request_supplier_id: 12,
  request_entity_id: 8,
  period_start: "2026-09-01",
  period_end: "2026-09-30",
  period_label: "September 2026",
  recipients_snapshot: [{ id: 21, name: "Nora Finance", email: "nora@acme.example" }],
  journey_snapshot: {
    steps: [{ order: 1, channel: "email", delay_minutes: 0, subject: "Statement", message: "Please send it." }],
    version: 2,
  },
  supplier_name: "Acme Supplies",
  entity_name: "Presentail UAE",
  legal_name: "Presentail UAE",
  schedule_active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  connect.mockResolvedValue({
    query: (...args: unknown[]) => clientQuery(...args),
    release: vi.fn(),
  });
  sendEmail.mockResolvedValue({ ok: true, providerMessageId: "email-message-1" });
  sendWhatsApp.mockResolvedValue({
    ok: true,
    providerMessageId: "wa-message-1",
    providerContactId: "respondio-contact-1",
    providerChannelId: "543704",
    destination: "+9613159639",
    renderedVariables: ["Nora Finance", "Presentail UAE", "2026-09-01", "2026-09-30"],
    providerStatus: "accepted",
  });
});

describe("supplier statement worker", () => {
  it("claims due steps atomically with SKIP LOCKED and returns the claimed attempt", async () => {
    clientQuery.mockImplementation((sql: string) =>
      sql === "BEGIN" || sql === "COMMIT"
        ? Promise.resolve({ rows: [], rowCount: 1 })
        : Promise.resolve({ rows: [claimed], rowCount: 1 }));
    const result = await __test.claimDueSteps();
    expect(result).toEqual([claimed]);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE OF e, r SKIP LOCKED"))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("status='processing'"))).toBe(true);
  });

  it("creates scheduled requests with the schedule timezone and preserves relative journey delays", async () => {
    const schedule = {
      id: 31,
      workspace_owner_id: "owner-a",
      supplier_id: 12,
      finance_entity_id: 8,
      cadence: "monthly",
      local_day: 1,
      local_time: "09:30",
      timezone: "Asia/Beirut",
      first_run_date: "2026-10-01",
      journey_id: 4,
      next_run_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    };
    const journey = {
      id: 4,
      version: 2,
      version_id: 41,
      steps: [
        { order: 1, channel: "email", delay_minutes: 0, subject: "Statement", message: "Please send it." },
        { order: 2, channel: "whatsapp", delay_minutes: 60, message: "Following up." },
      ],
      recipients: [21],
      escalation_settings: {},
    };
    const contact = { id: 21, name: "Nora Finance", email: "nora@acme.example", whatsapp_phone: "+9613159639" };
    dbQuery.mockResolvedValueOnce({ rows: [schedule], rowCount: 1 });
    const insertedStepParams: unknown[][] = [];
    clientQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve({ rows: [], rowCount: 1 });
      if (sql.includes("FROM supplier_statement_schedules") && sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [schedule], rowCount: 1 });
      if (sql.includes("FROM supplier_statement_contacts")) return Promise.resolve({ rows: [contact], rowCount: 1 });
      if (sql.includes("FROM supplier_statement_journeys")) return Promise.resolve({ rows: [journey], rowCount: 1 });
      if (sql.includes("INSERT INTO supplier_statement_requests")) return Promise.resolve({ rows: [{ id: "scheduled-request-1" }], rowCount: 1 });
      if (sql.includes("INSERT INTO supplier_statement_step_executions")) {
        insertedStepParams.push(params ?? []);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.createDueScheduledRequests();

    const requestInsert = clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO supplier_statement_requests"));
    expect(requestInsert?.[1]?.at(-1)).toBe("Asia/Beirut");
    expect(insertedStepParams).toHaveLength(2);
    expect(insertedStepParams[1][5]).toEqual(new Date((insertedStepParams[0][5] as Date).getTime() + 60 * 60_000));
  });

  it("recovers stale processing claims as failed unknown outcomes", async () => {
    await __test.recoverStaleClaims();
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("status='processing'"),
    );
    expect(String(dbQuery.mock.calls[0][0])).toContain("stale_claim_unknown");
  });

  it("cancels a claimed step when the request was received before dispatch", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...loadedStep, request_status: "received" }], rowCount: 1 });
    await __test.dispatchStep(claimed);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status='cancelled'"),
      [claimed.id],
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("persists email provider IDs and sends the next mixed-channel step in order", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [loadedStep], rowCount: 1 }) // load
      .mockResolvedValueOnce({ rows: [loadedStep.recipients_snapshot[0]], rowCount: 1 }) // contact
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // save current contact and destination
      .mockResolvedValueOnce({ rows: [{ request_status: "open" }], rowCount: 1 }) // still eligible to send
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await __test.dispatchStep(claimed);
    expect(sendEmail, JSON.stringify(dbQuery.mock.calls.map(([sql]) => String(sql)))).toHaveBeenCalledWith(expect.objectContaining({
      to: ["nora@acme.example"],
      requestId: "request-1",
      stepId: "7",
      idempotencyKey: "request-1:step:1",
      replyTo: "supplier-statement+request-1@reply.example",
    }));
    expect(dbQuery.mock.calls.some(([sql, params]) =>
      String(sql).includes("provider_message_id=COALESCE") && Array.isArray(params) && params.includes("email-message-1"),
    )).toBe(true);
  });

  it("routes WhatsApp journeys to the explicit WhatsApp number rather than the contact's main phone", async () => {
    const phone = "+971501234567";
    const whatsappPhone = "+971559876543";
    const whatsappContact = {
      id: 21,
      name: "Nora Finance",
      phone,
      whatsapp_phone: whatsappPhone,
    };
    const whatsappStep = {
      ...claimed,
      channel: "whatsapp" as const,
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [{ ...loadedStep, channel: "whatsapp" }], rowCount: 1 }) // load
      .mockResolvedValueOnce({ rows: [whatsappContact], rowCount: 1 }) // contact
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // save current contact and destination
      .mockResolvedValueOnce({ rows: [{ request_status: "open" }], rowCount: 1 }) // still eligible to send
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await __test.dispatchStep(whatsappStep);

    expect(sendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      phone: whatsappPhone,
      supplierContactId: 21,
    }));
    const destinationUpdate = dbQuery.mock.calls.find(([sql]) => String(sql).includes("SET supplier_contact_id"));
    expect(destinationUpdate?.[1]?.[5]).toBe(whatsappPhone);
  });

  it("schedules retryable failures with bounded backoff", async () => {
    await __test.recordStepResult(claimed, {
      ok: false,
      retryable: true,
      errorCode: "http_503",
      errorMessage: "provider unavailable",
    });
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status=$2"),
      expect.arrayContaining(["pending", "http_503"]),
    );
    expect(String(dbQuery.mock.calls[0][0])).toContain("scheduled_at=COALESCE");
  });

  it("escalates after the final failed follow-up when no steps remain", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // step update
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner-a" }], rowCount: 1 }) // escalation update
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await __test.recordStepResult({ ...claimed, attempt_count: 4 }, {
      ok: false,
      retryable: true,
      errorCode: "provider_timeout",
      errorMessage: "timed out",
    });
    expect(dbQuery.mock.calls.some(([sql]) => String(sql).includes("escalation_due"))).toBe(true);
    expect(dbQuery.mock.calls.some(([, params]) =>
      Array.isArray(params) && params.some((value) => String(value).includes("final_journey_step_complete")),
    )).toBe(true);
  });
});