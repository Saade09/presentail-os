import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockSyncImportedSupplierInvoice = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_111";
let stubWorkspaceActualRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" ||
    !!wreq.allowedPages?.includes(pageKey),
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceActualRole;
    wreq.workspaceRole = stubWorkspaceActualRole;
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) },
  },
}));

const mockCreateDraftVendorBill = vi.fn();
const mockCreateConnector = vi.fn(() => ({
  createDraftVendorBill: mockCreateDraftVendorBill,
}));

vi.mock("../lib/finance/connectorFactory", () => ({
  createConnector: (...args: Parameters<typeof mockCreateConnector>) => mockCreateConnector(...args),
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    getObject = vi.fn();
    putObject = vi.fn();
    deleteObject = vi.fn();
    getPublicUrl = vi.fn();
    generateUploadUrl = vi.fn();
  },
}));

vi.mock("../lib/finance/aiExtraction", () => ({
  extractInvoiceDataFromBuffer: (...args: unknown[]) => mockExtractInvoiceDataFromBuffer(...args),
}));

const mockExtractInvoiceDataFromBuffer = vi.fn();

vi.mock("../lib/finance/syncImportedSupplierInvoice", () => ({
  syncImportedSupplierInvoice: (...args: unknown[]) => mockSyncImportedSupplierInvoice(...args),
}));

import financeRouter, { processInvoiceAsync } from "./finance";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, typeof mockReqLog> }).log = {
      error: mockReqLog,
      warn: mockReqLog,
      info: mockReqLog,
    };
    next();
  });
  app.use(financeRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMPORT_ROW = {
  id: 7,
  workspace_owner_id: "owner_111",
  entity_id: 3,
  status: "sent_to_odoo",
  original_filename: "invoice.pdf",
  pdf_storage_path: "invoices/invoice.pdf",
  vendor_name: "Acme Corp",
  vendor_tax_number: "TRN123",
  vendor_address: "123 Main St",
  invoice_number: "INV-001",
  invoice_date: "2026-01-15",
  due_date: "2026-02-15",
  currency: "USD",
  subtotal: "100.00",
  tax_amount: "5.00",
  total_amount: "105.00",
  line_items: [],
  confidence: "0.95",
  company_validation_status: "matched",
  company_validation_notes: null,
  odoo_bill_id: "bill_42",
  odoo_bill_url: "https://odoo.example.com/bills/42",
  manually_entered_by: null,
  manually_entered_at: null,
  manual_notes: null,
  manual_accounting_reference: null,
  error_message: null,
  is_reviewed: true,
  reviewed_at: "2026-01-20T10:00:00Z",
  reviewed_by: "user_abc",
  processing_step: "send_to_odoo",
  created_at: "2026-01-15T08:00:00Z",
  updated_at: "2026-01-20T10:00:00Z",
};

const ENTITY_ROW = {
  id: 3,
  workspace_owner_id: "owner_111",
  legal_name: "My Company Ltd",
  display_name: "My Company",
  country: "US",
  tax_registration_number: null,
  accounting_system: "odoo",
  odoo_company_id: 1,
  odoo_company_name: "My Company",
  odoo_database: "mycompany",
  odoo_base_url: "https://odoo.example.com",
  odoo_integration_token: "secret_token",
  default_currency: "USD",
  is_active: true,
  created_at: "2025-01-01T00:00:00Z",
};

describe("AI import supplier ledger synchronization", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceActualRole = "owner";
    stubAllowedPages = null;
    mockSyncImportedSupplierInvoice.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockDbQuery.mockReset();
    mockExtractInvoiceDataFromBuffer.mockReset();
    mockSyncImportedSupplierInvoice.mockReset();
  });

  it("synchronizes an automatically matched import after extraction", async () => {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, name, display_name FROM suppliers")) {
        return {
          rows: [{ id: 42, name: "Acme Corp", display_name: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    mockExtractInvoiceDataFromBuffer.mockResolvedValue({
      vendor_name: "Acme Corp",
      vendor_tax_number: "TRN123",
      vendor_address: "123 Main St",
      invoice_number: "INV-AUTO",
      invoice_date: "2026-01-15",
      due_date: "2026-02-15",
      currency: "USD",
      subtotal: 100,
      tax_amount: 5,
      total_amount: 105,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100 }],
      confidence: 0.98,
      company_validation_status: "matched",
      company_validation_notes: null,
      raw_ai_json: {},
      billing_country: "US",
    });

    await processInvoiceAsync(
      77,
      { buffer: Buffer.from("invoice"), mimeType: "application/pdf" },
      { ...ENTITY_ROW, accounting_system: "manual" },
      "owner_111",
    );

    const extractedUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => String(sql).includes("vendor_name = $1"),
    );
    expect(extractedUpdate?.[1]?.[16]).toBe(42);
    expect(mockSyncImportedSupplierInvoice).toHaveBeenCalledWith(77, "owner_111");
  });

  it("synchronizes immediately after manual linking and unlinking", async () => {
    const linkedRow = { ...IMPORT_ROW, supplier_id: 42 };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [linkedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const linked = await request(app)
      .patch("/finance/ai-invoice-import/imports/7")
      .send({ supplier_id: 42 });

    expect(linked.status).toBe(200);
    expect(mockSyncImportedSupplierInvoice).toHaveBeenLastCalledWith(7, "owner_111");

    mockDbQuery
      .mockResolvedValueOnce({ rows: [linkedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...linkedRow, supplier_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const unlinked = await request(app)
      .patch("/finance/ai-invoice-import/imports/7")
      .send({ supplier_id: null });

    expect(unlinked.status).toBe(200);
    expect(mockSyncImportedSupplierInvoice).toHaveBeenLastCalledWith(7, "owner_111");
    expect(mockSyncImportedSupplierInvoice).toHaveBeenCalledTimes(2);
  });
});

describe("GET /finance/suppliers/search", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceActualRole = "owner";
    stubAllowedPages = null;
  });

  it("searches active suppliers by aliases/name and normalized VAT across the full result set", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { id: 401, name: "Canonical Supplier", display_name: "Canonical Supplier Alias", tax_number: "AE-123 456", odoo_partner_id: null },
        { id: 402, name: "Later Candidate", display_name: "Vendor Trading", tax_number: "TRN-999", odoo_partner_id: null },
      ],
      rowCount: 2,
    });

    const response = await request(app)
      .get("/finance/suppliers/search")
      .query({ q: "123456", entity_id: 7, limit: 100 });

    expect(response.status).toBe(200);
    expect(response.body.suppliers).toHaveLength(2);
    expect(response.body.suppliers[0]).toMatchObject({ id: 401, tax_number: "AE-123 456" });
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("regexp_replace");
    expect(params).toEqual(["owner_111", "123456", 7, 100]);
  });
});

// ---------------------------------------------------------------------------
// Finance entity configuration and credential safety
// ---------------------------------------------------------------------------

describe("finance entity configuration", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceActualRole = "owner";
    stubAllowedPages = null;
  });

  it("allows finance-accounting members to read entities without exposing tokens", async () => {
    stubWorkspaceActualRole = "member";
    stubAllowedPages = ["finance_accounting"];
    mockDbQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 });

    const res = await request(app).get("/finance/entities");

    expect(res.status).toBe(200);
    expect(res.body.entities[0]).toMatchObject({
      id: ENTITY_ROW.id,
      odoo_integration_configured: true,
    });
    expect(res.body.entities[0]).not.toHaveProperty("odoo_integration_token");
    expect(JSON.stringify(res.body)).not.toContain(ENTITY_ROW.odoo_integration_token);
  });

  it("allows Invoice Scanners members to read workspace entities without exposing tokens", async () => {
    stubWorkspaceActualRole = "member";
    stubAllowedPages = ["invoice-scanners"];
    mockDbQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 });

    const res = await request(app).get("/finance/entities");

    expect(res.status).toBe(200);
    expect(res.body.entities[0]).toMatchObject({
      id: ENTITY_ROW.id,
      is_active: true,
      odoo_integration_configured: true,
    });
    expect(res.body.entities[0]).not.toHaveProperty("odoo_integration_token");
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE workspace_owner_id = \$1/),
      ["owner_111"],
    );
  });

  it("does not grant Invoice Scanners members access to invoice imports", async () => {
    stubWorkspaceActualRole = "member";
    stubAllowedPages = ["invoice-scanners"];

    const res = await request(app).get("/finance/ai-invoice-import");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/finance access required/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("keeps finance entity mutations owner-only", async () => {
    stubWorkspaceActualRole = "member";
    stubAllowedPages = ["finance_accounting"];

    const res = await request(app)
      .post("/finance/entities")
      .send({ legal_name: "Presentail SAL" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner access required/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("creates a complete Odoo entity and redacts its integration token", async () => {
    const created = {
      ...ENTITY_ROW,
      country: "LB",
      legal_name: "Presentail SAL",
      display_name: "Presentail Lebanon",
      odoo_integration_token: "new-secret-token",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [created], rowCount: 1 });

    const res = await request(app)
      .post("/finance/entities")
      .send({
        legal_name: created.legal_name,
        display_name: created.display_name,
        country: "LB",
        accounting_system: "odoo",
        odoo_base_url: created.odoo_base_url,
        odoo_database: created.odoo_database,
        odoo_company_id: created.odoo_company_id,
        odoo_company_name: created.odoo_company_name,
        odoo_integration_token: created.odoo_integration_token,
      });

    expect(res.status).toBe(201);
    expect(res.body.entity.odoo_integration_configured).toBe(true);
    expect(res.body.entity).not.toHaveProperty("odoo_integration_token");
    expect(JSON.stringify(res.body)).not.toContain(created.odoo_integration_token);
  });

  it("canonicalizes lowercase Lebanon country input before storing it", async () => {
    const created = { ...ENTITY_ROW, country: "LB", odoo_integration_token: "new-secret-token" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [created], rowCount: 1 });

    const res = await request(app)
      .post("/finance/entities")
      .send({
        legal_name: "Presentail SAL",
        display_name: "Presentail Lebanon",
        country: "lb",
        accounting_system: "odoo",
        odoo_base_url: "https://odoo.example.com",
        odoo_database: "presentail_prod",
        odoo_company_id: 9,
        odoo_company_name: "Presentail SAL",
        odoo_integration_token: "new-secret-token",
      });

    expect(res.status).toBe(201);
    const insertParams = mockDbQuery.mock.calls[1]?.[1] as unknown[];
    expect(insertParams[3]).toBe("LB");
  });

  it("returns 409 when a concurrent create hits the active-Lebanon unique index", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce({
        code: "23505",
        constraint: "finance_entities_one_active_lb_per_workspace",
      });

    const res = await request(app)
      .post("/finance/entities")
      .send({
        legal_name: "Presentail SAL",
        display_name: "Presentail Lebanon",
        country: "LB",
        accounting_system: "odoo",
        odoo_base_url: "https://odoo.example.com",
        odoo_database: "presentail_prod",
        odoo_company_id: 9,
        odoo_company_name: "Presentail SAL",
        odoo_integration_token: "new-secret-token",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active Lebanon finance entity already exists/i);
  });

  it("preserves the stored token when an update sends a blank token", async () => {
    const existing = { ...ENTITY_ROW, country: "LB" };
    const updated = { ...existing, display_name: "Lebanon Finance" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app)
      .patch(`/finance/entities/${existing.id}`)
      .send({
        display_name: updated.display_name,
        odoo_integration_token: "",
      });

    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[1]?.[0] ?? "");
    expect(updateSql).not.toContain("odoo_integration_token");
    expect(res.body.entity.odoo_integration_configured).toBe(true);
    expect(res.body.entity).not.toHaveProperty("odoo_integration_token");
  });

  it("revalidates a retained default account before any patch write", async () => {
    const existing = { ...ENTITY_ROW, country: "LB", odoo_default_expense_account_id: 0 };
    mockDbQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

    const res = await request(app)
      .patch(`/finance/entities/${existing.id}`)
      .send({ odoo_base_url: "https://new-odoo.example.com" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/default expense account|positive integer/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when a patch would create a second active Lebanon entity", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockRejectedValueOnce({
        code: "23505",
        constraint: "finance_entities_one_active_lb_per_workspace",
      });

    const res = await request(app)
      .patch(`/finance/entities/${ENTITY_ROW.id}`)
      .send({ country: "LB", is_active: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another active Lebanon finance entity/i);
  });
});

// ---------------------------------------------------------------------------
// POST /finance/ai-invoice-import/imports/:id/send-to-odoo
// ---------------------------------------------------------------------------

describe("POST /finance/ai-invoice-import/imports/:id/send-to-odoo", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 403 when the user has no finance access", async () => {
    stubWorkspaceActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/finance access/i);
  });

  it("allows access when user is a member with ai-invoice-import page permission", async () => {
    stubWorkspaceActualRole = "member";
    stubAllowedPages = ["ai-invoice-import"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateDraftVendorBill.mockResolvedValue({ success: true, provider_bill_id: "bill_99", provider_bill_url: "https://odoo.example.com/bills/99" });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when the import id is not a valid number", async () => {
    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/not-a-number/send-to-odoo");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid import id/i);
  });

  it("returns 404 when the import does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/999/send-to-odoo");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/import not found/i);
  });

  it("returns 404 when the finance entity is not found", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/finance entity not found/i);
  });

  it("returns 400 when the entity accounting system is not odoo", async () => {
    const manualEntity = { ...ENTITY_ROW, accounting_system: "manual", odoo_integration_token: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [manualEntity], rowCount: 1 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/odoo/i);
  });

  it("returns 400 when Odoo credentials are not configured on the entity", async () => {
    const unconfiguredEntity = { ...ENTITY_ROW, odoo_base_url: null, odoo_integration_token: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [unconfiguredEntity], rowCount: 1 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/credentials/i);
  });

  it("returns 200 with bill details on a successful Odoo send", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateDraftVendorBill.mockResolvedValue({
      success: true,
      provider_bill_id: "bill_55",
      provider_bill_url: "https://odoo.example.com/bills/55",
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, bill_id: "bill_55", bill_url: "https://odoo.example.com/bills/55" });
  });

  it("calls createConnector with the entity and invokes createDraftVendorBill", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateDraftVendorBill.mockResolvedValue({
      success: true,
      provider_bill_id: "bill_55",
      provider_bill_url: null,
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(mockCreateConnector).toHaveBeenCalledWith(expect.objectContaining({ id: 3, accounting_system: "odoo" }));
    expect(mockCreateDraftVendorBill).toHaveBeenCalledWith(
      3,
      7,
      expect.objectContaining({ vendor_name: "Acme Corp", invoice_number: "INV-001" }),
      "invoices/invoice.pdf",
      { workspaceOwnerId: "owner_111", approvedValuesAuthoritative: false },
    );
  });

  it("sets status to processing before calling Odoo, then to sent_to_odoo on success", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateDraftVendorBill.mockResolvedValue({ success: true, provider_bill_id: "b1", provider_bill_url: null });

    await request(app).post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    const calls = mockDbQuery.mock.calls;
    const updateProcessingCall = calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("processing"),
    );
    const updateSentCall = calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("sent_to_odoo"),
    );
    expect(updateProcessingCall).toBeTruthy();
    expect(updateSentCall).toBeTruthy();
  });

  it("returns 502 and sets status to failed when Odoo returns an error", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateDraftVendorBill.mockResolvedValue({ success: false, error: "Connection refused" });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false, error: "Connection refused" });

    const failedUpdateCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("failed"),
    );
    expect(failedUpdateCall).toBeTruthy();
  });

  it("returns 409 when the import is already being processed (optimistic lock)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already being processed/i);
    expect(mockCreateDraftVendorBill).not.toHaveBeenCalled();
  });

  it("includes a staleness window in the lock SQL so rows stuck in processing for over 5 minutes can be retried", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [IMPORT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateDraftVendorBill.mockResolvedValue({ success: true, provider_bill_id: "b2", provider_bill_url: null });

    const res = await request(app)
      .post("/finance/ai-invoice-import/imports/7/send-to-odoo");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const lockCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("processing"),
    );
    expect(lockCall).toBeTruthy();
    const lockSql: string = lockCall![0];
    expect(lockSql).toMatch(/interval\s+'5 minutes'/i);
    expect(lockSql).toMatch(/updated_at\s*</i);
  });
});
