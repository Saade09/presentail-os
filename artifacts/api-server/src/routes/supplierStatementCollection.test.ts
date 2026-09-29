import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  dbQuery,
  clientQuery,
  connect,
  canAccess,
  markReceived,
  readiness,
} = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  canAccess: vi.fn(() => true),
  markReceived: vi.fn(),
  readiness: vi.fn(),
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

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const workspaceRequest = req as express.Request & Record<string, unknown>;
    workspaceRequest.workspaceOwnerId = "owner-a";
    workspaceRequest.userId = "member-a";
    workspaceRequest.workspaceActualRole = "owner";
    workspaceRequest.workspaceRole = "owner";
    workspaceRequest.allowedPages = null;
    next();
  },
  workspace: (req: express.Request) => req,
  hasPageAccess: () => canAccess(),
}));

vi.mock("../lib/supplierStatementDelivery", () => ({
  markSupplierStatementReceivedById: (...args: unknown[]) => markReceived(...args),
  supplierStatementProviderReadiness: () => readiness(),
}));

import supplierStatementRouter from "./supplierStatementCollection";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(supplierStatementRouter);
  return instance;
}

const supplier = { id: 12, name: "Acme Supplies" };
const entity = { id: 8, legal_name: "Presentail UAE" };
const journey = {
  id: 4,
  name: "Monthly collection",
  version_id: 41,
  version: 2,
  steps: [{ channel: "email", delay_minutes: 0, subject: "Statement" }],
  recipients: [21],
  escalation_settings: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockReturnValue(true);
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  connect.mockResolvedValue({
    query: (...args: unknown[]) => clientQuery(...args),
    release: vi.fn(),
  });
  readiness.mockReturnValue({
    email: { configured: false, deliveryWebhook: false, inbound: false, replyDomain: null, missing: ["RESEND_API_KEY"] },
    whatsapp: { configured: false, incomingWebhook: false, statusWebhook: false, template: "supplier_statement_request", missing: ["RESPONDIO_API_TOKEN"] },
  });
});

describe("supplier statement collection API", () => {
  it("keeps contact listing tenant-scoped", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...supplier, workspace_owner_id: "owner-a" }], rowCount: 1 });
    const response = await request(app()).get("/supplier-statement-contacts?supplier_id=12");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("c.workspace_owner_id = $1"),
      ["owner-a", 12],
    );
  });

  it("stores journey step and recipient arrays as JSONB values", async () => {
    const steps = [{
      order: 1,
      channel: "email",
      delay_minutes: 0,
      subject: "Statement",
      message: "Please send the statement.",
    }];
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 });
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // begin
      .mockResolvedValueOnce({ rows: [{ id: 71, supplier_id: 12, name: "Test journey" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 81, version: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // commit

    const response = await request(app()).post("/supplier-statement-journeys").send({
      supplier_id: 12,
      name: "Test journey",
      steps,
      recipient_contact_ids: [21],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const versionInsert = clientQuery.mock.calls[2];
    expect(String(versionInsert[0])).toContain("INSERT INTO supplier_statement_journey_versions");
    expect(JSON.parse(String(versionInsert[1][2]))).toMatchObject(steps);
    expect(JSON.parse(String(versionInsert[1][3]))).toEqual([21]);
    expect(clientQuery.mock.calls[3][0]).toContain("INSERT INTO supplier_statement_audit_events");
    expect(clientQuery.mock.calls[4][0]).toBe("COMMIT");
  });

  it("requires explicit approval before a contact can be used", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...supplier, id: 21, is_approved: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const response = await request(app()).post("/supplier-statement-contacts").send({
      supplier_id: 12,
      name: "Supplier Finance",
      email: "finance@acme.example",
      is_approved: false,
      is_selected: true,
    });

    expect(response.status).toBe(201);
    expect(dbQuery.mock.calls[1][1]).toEqual([
      "owner-a", 12, "Supplier Finance", null, null, "finance@acme.example", null,
      null, "manual", null, false, true, "member-a",
    ]);
  });

  it("stores both supplier contact phone numbers as E.164", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 22 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const response = await request(app()).post("/supplier-statement-contacts").send({
      supplier_id: 12,
      name: "Supplier Finance",
      phone: "+971 50 123 4567",
      whatsapp_phone: "+971 55 987 6543",
    });

    expect(response.status).toBe(201);
    expect(dbQuery.mock.calls[1][1]).toEqual([
      "owner-a", 12, "Supplier Finance", null, null, null,
      "+971501234567", "+971559876543", "manual", null, false, false, "member-a",
    ]);
  });

  it("uses the main phone as the WhatsApp fallback when no separate number is supplied", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 23 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const response = await request(app()).post("/supplier-statement-contacts").send({
      supplier_id: 12,
      name: "Supplier Finance",
      phone: "+971 50 123 4567",
    });

    expect(response.status).toBe(201);
    expect(dbQuery.mock.calls[1][1]).toEqual([
      "owner-a", 12, "Supplier Finance", null, null, null,
      "+971501234567", "+971501234567", "manual", null, false, false, "member-a",
    ]);
  });

  it("rejects invalid international supplier phone numbers before inserting a contact", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [supplier], rowCount: 1 });
    const response = await request(app()).post("/supplier-statement-contacts").send({
      supplier_id: 12,
      name: "Supplier Finance",
      email: "finance@acme.example",
      whatsapp_phone: "03 123 456",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("whatsapp_phone");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("normalizes updated supplier contact phone numbers", async () => {
    const existingContact = { id: 22, workspace_owner_id: "owner-a", phone: null, whatsapp_phone: null };
    dbQuery
      .mockResolvedValueOnce({ rows: [existingContact], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [existingContact], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const response = await request(app()).patch("/supplier-statement-contacts/22").send({
      phone: "+971 50 123 4567",
      whatsapp_phone: "+971 55 987 6543",
    });

    expect(response.status).toBe(200);
    expect(dbQuery.mock.calls[1][1]).toEqual([
      "+971501234567", "+971559876543", 22, "owner-a",
    ]);
  });

  it("reports Needs setup instead of activating a schedule without a journey/recipient", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [entity], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // approved recipients
    const response = await request(app()).post("/supplier-statement-schedules").send({
      supplier_id: 12,
      finance_entity_id: 8,
      cadence: "monthly",
      first_run_date: "2026-10-01",
      local_day: 1,
      local_time: "09:00",
      timezone: "Asia/Beirut",
      journey_id: 4,
      is_active: true,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("NEEDS_SETUP");
    expect(dbQuery).toHaveBeenCalledTimes(4);
  });

  it("creates an inactive quarterly schedule with exact readiness metadata", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [entity], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 55, is_active: false, cadence: "quarterly" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const response = await request(app()).post("/supplier-statement-schedules").send({
      supplier_id: 12,
      finance_entity_id: 8,
      cadence: "quarterly",
      first_run_date: "2026-10-01",
      local_day: 1,
      local_time: "09:00",
      timezone: "UTC",
      is_active: false,
    });

    expect(response.status).toBe(201);
    expect(response.body.schedule).toMatchObject({ cadence: "quarterly", readiness: "Needs setup" });
    expect(dbQuery.mock.calls[2][1][3]).toBe("quarterly");
    expect(dbQuery.mock.calls[2][1][7]).toBe("2026-10-01");
  });

  it("captures the current journey version and recipients on a request", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [entity], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 21, name: "Supplier Finance", email: "finance@acme.example" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [journey], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // duplicate check
      .mockResolvedValueOnce({ rows: [{ id: "request-1", journey_version_id: 41, period_start: "2026-09-01" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // step
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // audit
    const response = await request(app()).post("/supplier-statement-requests").send({
      supplier_id: 12,
      finance_entity_id: 8,
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      cadence: "monthly",
      journey_id: 4,
      recipient_contact_ids: [21],
    });

    expect(response.status).toBe(201);
    expect(dbQuery.mock.calls[5][1][13]).toBe(41);
    expect(JSON.parse(String(dbQuery.mock.calls[5][1][14]))).toMatchObject({
      journey_id: 4,
      version: 2,
      steps: [{ channel: "email", delay_minutes: 0, order: 1 }],
    });
    expect(JSON.parse(String(dbQuery.mock.calls[5][1][15]))).toEqual([
      expect.objectContaining({ id: 21 }),
    ]);
  });

  it("reuses an open request for the same exact supplier/entity period", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [supplier], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [entity], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // selected approved recipients
      .mockResolvedValueOnce({ rows: [{ id: "existing", status: "open" }], rowCount: 1 });
    const response = await request(app()).post("/supplier-statement-requests").send({
      supplier_id: 12,
      finance_entity_id: 8,
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      cadence: "monthly",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ reused: true, request: { id: "existing" } });
  });

  it("deletes a cancelled request with no delivery or statement history and retains an audit event", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // begin
      .mockResolvedValueOnce({ rows: [{ status: "cancelled" }], rowCount: 1 }) // lock request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // lock step executions
      .mockResolvedValueOnce({ rows: [{ has_statement: false, has_communication: false, has_inbound: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // deletion audit event
      .mockResolvedValueOnce({ rows: [{ id: "request-1" }], rowCount: 1 }) // delete request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // commit

    const response = await request(app()).delete("/supplier-statement-requests/request-1");

    expect(response.status).toBe(204);
    expect(clientQuery.mock.calls[1][1]).toEqual(["request-1", "owner-a"]);
    expect(clientQuery.mock.calls[2][0]).toContain("FOR UPDATE");
    expect(clientQuery.mock.calls[4][0]).toContain("'deleted'");
    expect(clientQuery.mock.calls[5][0]).toContain("DELETE FROM supplier_statement_requests");
    expect(clientQuery.mock.calls[5][1]).toEqual(["request-1", "owner-a"]);
  });

  it("requires active requests to be cancelled before deletion", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // begin
      .mockResolvedValueOnce({ rows: [{ status: "open" }], rowCount: 1 }) // lock request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // commit

    const response = await request(app()).delete("/supplier-statement-requests/request-1");

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Cancel active requests");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM supplier_statement_requests"))).toBe(false);
  });

  it("preserves requests with communication or linked statement history", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // begin
      .mockResolvedValueOnce({ rows: [{ status: "cancelled" }], rowCount: 1 }) // lock request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // lock step executions
      .mockResolvedValueOnce({ rows: [{ has_statement: true, has_communication: false, has_inbound: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // commit

    const response = await request(app()).delete("/supplier-statement-requests/request-1");

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("linked to a supplier statement");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM supplier_statement_requests"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("action, actor_id"))).toBe(false);
  });

  it("does not expose a request from another tenant", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await request(app()).get("/supplier-statement-requests/foreign-request");
    expect(response.status).toBe(404);
    expect(dbQuery.mock.calls[0][1]).toEqual(["foreign-request", "owner-a"]);
  });

  it("normalizes a legacy object recipient snapshot in request details", async () => {
    dbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "legacy-request", recipients_snapshot: {}, journey_snapshot: {} }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(app()).get("/supplier-statement-requests/legacy-request");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.request.recipients_snapshot).toEqual([]);
  });

  it.each(["manual", "scheduled"] as const)("updates only pending delivery steps on a %s request", async (source) => {
    const current = {
      id: "request-1",
      workspace_owner_id: "owner-a",
      supplier_id: 12,
      status: "open",
      source,
      timezone: "Asia/Beirut",
      recipients_snapshot: [{ id: 21, name: "Supplier Finance", email: "finance@acme.example", whatsapp_phone: "+96170000000" }],
      journey_snapshot: {
        steps: [
          { order: 1, channel: "email", delay_minutes: 0, subject: "Statement" },
          { order: 2, channel: "whatsapp", delay_minutes: 60, message: "Follow up" },
        ],
      },
    };
    const approvedContact = {
      id: 21,
      name: "Supplier Finance",
      email: "finance@acme.example",
      whatsapp_phone: "+96170000000",
      is_approved: true,
      is_active: true,
    };
    const dueAt = new Date("2026-10-02T07:15:00.000Z");
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // begin
      .mockResolvedValueOnce({ rows: [current], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { id: 31, step_order: 1, channel: "email", delay_minutes: 0, status: "pending" },
        { id: 32, step_order: 2, channel: "whatsapp", delay_minutes: 60, status: "pending" },
      ], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [approvedContact], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ step_order: 1, channel: "email", next_at: dueAt }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...current, recipients_snapshot: [approvedContact] }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(app()).patch("/supplier-statement-requests/request-1").send({
      recipient_contact_ids: [21],
      email_due_at: dueAt.toISOString(),
    });

    expect(response.status).toBe(200);
    expect(response.body.request.source).toBe(source);
    expect(clientQuery.mock.calls[1][0]).toContain("workspace_owner_id=$2");
    expect(clientQuery.mock.calls[3][1]).toEqual(["owner-a", 12, [21]]);
    expect(clientQuery.mock.calls[4][1][0]).toEqual(dueAt);
    expect(clientQuery.mock.calls[5][1][0]).toEqual(new Date(dueAt.getTime() + 60 * 60_000));
    expect(clientQuery.mock.calls[7][0]).toContain("recipients_snapshot=$1::jsonb");
    expect(clientQuery.mock.calls[8][0]).toContain("delivery_settings_updated");
    expect(clientQuery.mock.calls[8][1][3]).toContain('"rescheduled_step_orders":[1,2]');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM supplier_statement_communication_events"))).toBe(false);
  });

  it("does not change a sent execution when recipients are updated", async () => {
    const current = {
      id: "request-1",
      workspace_owner_id: "owner-a",
      supplier_id: 12,
      status: "open",
      recipients_snapshot: [{ id: 21, name: "Supplier Finance", email: "finance@acme.example" }],
      journey_snapshot: { steps: [{ order: 1, channel: "email", delay_minutes: 0 }, { order: 2, channel: "whatsapp", delay_minutes: 60 }] },
    };
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // begin
      .mockResolvedValueOnce({ rows: [current], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { id: 31, step_order: 1, channel: "email", status: "sent" },
        { id: 32, step_order: 2, channel: "whatsapp", status: "pending" },
      ], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ id: 21, name: "Supplier Finance", email: "finance@acme.example", whatsapp_phone: "+96170000000", is_active: true, is_approved: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ step_order: 2, channel: "whatsapp", next_at: new Date("2026-10-03T12:00:00.000Z") }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...current }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(app()).patch("/supplier-statement-requests/request-1").send({
      recipient_contact_ids: [21],
    });

    expect(response.status).toBe(200);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_step_executions"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_communication_events"))).toBe(false);
  });

  it("rejects inactive contacts and changes racing with a processing step", async () => {
    const current = {
      id: "request-1",
      workspace_owner_id: "owner-a",
      supplier_id: 12,
      status: "open",
      recipients_snapshot: [{ id: 21, name: "Supplier Finance", email: "finance@acme.example" }],
      journey_snapshot: { steps: [{ order: 1, channel: "email", delay_minutes: 0 }] },
    };
    clientQuery
      .mockResolvedValueOnce({ rows: [current], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 31, step_order: 1, channel: "email", status: "pending" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const invalidContact = await request(app()).patch("/supplier-statement-requests/request-1").send({
      recipient_contact_ids: [99],
    });
    expect(invalidContact.status).toBe(400);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_requests"))).toBe(false);

    clientQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // begin
      .mockResolvedValueOnce({ rows: [current], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 31, step_order: 1, channel: "email", status: "processing" }], rowCount: 1 });
    const racingEdit = await request(app()).patch("/supplier-statement-requests/request-1").send({
      recipient_contact_ids: [21],
    });
    expect(racingEdit.status).toBe(409);
    expect(racingEdit.body.error).toContain("already being sent");
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE supplier_statement_requests"))).toBe(false);
  });

  it("blocks unauthorized readers and writers", async () => {
    canAccess.mockReturnValue(false);
    const read = await request(app()).get("/supplier-statement-requests");
    const write = await request(app()).post("/supplier-statement-contacts").send({});
    const requestEdit = await request(app()).patch("/supplier-statement-requests/request-1").send({
      recipient_contact_ids: [21],
    });
    const requestDelete = await request(app()).delete("/supplier-statement-requests/request-1");
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(requestEdit.status).toBe(403);
    expect(requestDelete.status).toBe(403);
    expect(dbQuery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});