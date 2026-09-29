/**
 * Real-PostgreSQL coverage for the invoice review approval boundary.
 *
 * The router and database are real; only authentication/workspace middleware,
 * object storage, and the accounting provider are isolated.  This catches
 * SQL/transaction regressions which the query-mocked review tests cannot see.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__invoice_review_route_integration__";
const USER_ID = "__invoice_review_route_integration_user__";

const provider = vi.hoisted(() => ({
  createDraftVendorBill: vi.fn(),
}));

vi.mock("../lib/auth.js", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../lib/workspace.js", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, {
      workspaceOwnerId: OWNER_ID,
      workspaceActualRole: "owner",
      workspaceRole: "owner",
      userId: USER_ID,
      allowedPages: [],
    });
    next();
  },
  workspace: (req: express.Request) => req,
  hasPageAccess: (req: express.Request & { workspaceRole?: string; allowedPages?: string[] }, page: string) =>
    req.workspaceRole === "owner" || req.allowedPages?.includes(page) === true,
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}));
vi.mock("../lib/finance/connectorFactory.js", () => ({
  createConnector: vi.fn(() => provider),
}));
vi.mock("../lib/objectStorage.js", () => ({
  ObjectStorageService: class {
    getObjectEntityFile = vi.fn().mockResolvedValue({
      exists: vi.fn().mockResolvedValue([true]),
      download: vi.fn().mockResolvedValue([Buffer.from("invoice-source")]),
    });
  },
}));

import financeRouter from "./finance.js";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(financeRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("invoice review approval (real PostgreSQL)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let entityId: number;
  let importId: number;

  async function cleanup() {
    await pool.query(`DELETE FROM finance_entities WHERE workspace_owner_id=$1`, [OWNER_ID]);
    await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id=$1`, [OWNER_ID]);
  }

  async function insertImport(overrides: Record<string, unknown> = {}) {
    const values = {
      supplierId: null,
      filename: "invoice-page.pdf",
      pdfPath: "/objects/invoice-page.pdf",
      sourceMetadata: { filename: "invoice-page.pdf", mime_type: "application/pdf" },
      extractionEvidence: {},
      vendorName: "Integration Supplier",
      vendorTaxNumber: "LB123",
      invoiceNumber: "INT-MULTI",
      invoiceDate: "2026-01-10",
      currency: "USD",
      subtotal: 100,
      taxAmount: 5,
      totalAmount: 105,
      lineItems: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, account_code: "601101" }],
      rawAiJson: {},
      reviewStatus: "needs_review",
      syncStatus: "not_requested",
      reviewVersion: 1,
      billingCountry: "LB",
      sourceBatchId: null,
      sourcePageNumber: null,
      sourcePageCount: null,
      supersededByImportId: null,
      providerBillId: null,
      providerBillStatus: null,
      odooBillId: null,
      providerSyncStatus: "not_requested",
      ...overrides,
    };
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ai_invoice_imports
         (workspace_owner_id,entity_id,supplier_id,status,original_filename,pdf_storage_path,
          source_metadata,extraction_evidence,vendor_name,vendor_tax_number,invoice_number,
          invoice_date,currency,subtotal,tax_amount,total_amount,line_items,raw_ai_json,
          review_status,sync_status,review_version,billing_country,source_batch_id,
          source_page_number,source_page_count,superseded_by_import_id,provider_bill_id,
          provider_bill_status,odoo_bill_id,provider_sync_status)
       VALUES
         ($1,$2,$3,'ready_for_review',$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,
          $15,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING id`,
      [
        OWNER_ID, entityId, values.supplierId, values.filename, values.pdfPath,
        JSON.stringify(values.sourceMetadata), JSON.stringify(values.extractionEvidence),
        values.vendorName, values.vendorTaxNumber, values.invoiceNumber, values.invoiceDate,
        values.currency, values.subtotal, values.taxAmount, values.totalAmount,
        JSON.stringify(values.lineItems), JSON.stringify(values.rawAiJson), values.reviewStatus,
        values.syncStatus, values.reviewVersion, values.billingCountry, values.sourceBatchId,
        values.sourcePageNumber, values.sourcePageCount, values.supersededByImportId,
        values.providerBillId, values.providerBillStatus, values.odooBillId,
        values.providerSyncStatus,
      ],
    );
    return result.rows[0].id;
  }

  async function insertSplitPages() {
    const supplierId = (await pool.query<{ id: number }>(
      "SELECT id FROM suppliers WHERE workspace_owner_id=$1 LIMIT 1",
      [OWNER_ID],
    )).rows[0].id;
    const pageOne = await insertImport({
      supplierId,
      filename: "invoice-page-1.pdf",
      pdfPath: "/objects/invoice-page-1.pdf",
      sourceMetadata: { filename: "invoice-page-1.pdf", mime_type: "application/pdf" },
      extractionEvidence: { page: 1, total_label: "SUBTOTAL" },
      subtotal: 10,
      taxAmount: 0,
      totalAmount: 10,
      lineItems: [{ description: "Page one flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
      sourceBatchId: "batch-int-multi",
      sourcePageNumber: 1,
      sourcePageCount: 2,
    });
    const pageTwo = await insertImport({
      supplierId,
      filename: "invoice-page-2.pdf",
      pdfPath: "/objects/invoice-page-2.pdf",
      sourceMetadata: { filename: "invoice-page-2.pdf", mime_type: "application/pdf" },
      extractionEvidence: { page: 2, total_label: "GRAND TOTAL" },
      rawAiJson: { total_label: "GRAND TOTAL" },
      subtotal: 20,
      taxAmount: 0,
      totalAmount: 30,
      lineItems: [{ description: "Page two flowers", quantity: 1, unit_price: 20, total: 20, account_code: "601101" }],
      sourceBatchId: "batch-int-multi",
      sourcePageNumber: 2,
      sourcePageCount: 2,
    });
    return { pageOne, pageTwo };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    provider.createDraftVendorBill.mockReset();
    provider.createDraftVendorBill.mockResolvedValue({
      success: true,
      provider_bill_id: "provider-bill-100",
      provider_bill_url: "https://accounting.example/bills/100",
      provider_supplier_id: 301,
      provider_supplier_name: "Integration Supplier",
      provider_supplier_tax_number: "LB123",
    });

    const entity = await pool.query<{ id: number }>(
      `INSERT INTO finance_entities
          (workspace_owner_id, legal_name, country, accounting_system, default_currency)
        VALUES ($1, 'Integration Review Entity', 'LB', 'wafeq', 'USD')
       RETURNING id`,
      [OWNER_ID],
    );
    entityId = entity.rows[0].id;
    const supplier = await pool.query<{ id: number }>(
      `INSERT INTO suppliers (workspace_owner_id, name)
       VALUES ($1, 'Integration Supplier')
       RETURNING id`,
      [OWNER_ID],
    );
    const invoice = await pool.query<{ id: number }>(
      `INSERT INTO ai_invoice_imports
         (workspace_owner_id, entity_id, supplier_id, status, original_filename, pdf_storage_path,
          source_metadata, vendor_name, invoice_number, invoice_date, currency,
          subtotal, tax_amount, total_amount, line_items, review_status, sync_status,
           review_version, billing_country)
       VALUES ($1, $2, $3, 'ready_for_review', 'invoice.pdf', '/objects/invoice-review-test',
          '{"mime_type":"application/pdf"}', 'Integration Supplier', 'INT-100',
          '2026-01-10', 'USD', 100, 5, 105,
           '[{"description":"Flowers","quantity":1,"unit_price":100,"total":100,"account_code":"601101"}]',
           'needs_review', 'not_requested', 1, 'LB')
       RETURNING id`,
      [OWNER_ID, entityId, supplier.rows[0].id],
    );
    importId = invoice.rows[0].id;
  });

  it("persists approval, audit metadata, and a successful provider attempt", async () => {
    const response = await request(app)
      .post(`/finance/invoice-review/${importId}/approve`)
      .send({ version: 1, idempotency_key: `approval:${importId}:integration` });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.invoice.review_status).toBe("approved");
    expect(response.body.sync.status).toBe("succeeded");

    const fresh = await pool.query(
      `SELECT review_status,sync_status,approved_by,approved_at,review_version
         FROM ai_invoice_imports WHERE id=$1`,
      [importId],
    );
    expect(fresh.rows[0]).toMatchObject({
      review_status: "approved",
      sync_status: "succeeded",
      approved_by: USER_ID,
      review_version: 2,
    });
    expect(fresh.rows[0].approved_at).toBeTruthy();

    const audit = await pool.query(
      `SELECT actor_id,event_type,details FROM ai_invoice_import_audit_events
       WHERE import_id=$1 ORDER BY id`,
      [importId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(["approved", "sync_succeeded"]);
    expect(audit.rows[0]).toMatchObject({ actor_id: USER_ID });
    const attempt = await pool.query(
      `SELECT idempotency_key,review_version,status,destination,external_reference,completed_at
       FROM ai_invoice_import_sync_attempts WHERE import_id=$1`,
      [importId],
    );
    expect(attempt.rows[0]).toMatchObject({
      idempotency_key: `approval:${importId}:integration`,
      review_version: 2,
      status: "succeeded",
      destination: "odoo",
      external_reference: "provider-bill-100",
    });
    expect(attempt.rows[0].completed_at).toBeTruthy();
  });

  it("saves a valid failed invoice edit with blank optional dates and preserves attempt history", async () => {
    await pool.query(
      `UPDATE finance_entities
          SET accounting_system='odoo',odoo_default_expense_account_id=601101
        WHERE id=$1`,
      [entityId],
    );
    await pool.query(
      `UPDATE ai_invoice_imports
          SET sync_status='failed',provider_sync_status='failed',
              provider_sync_error='Previous provider failure',error_message='Previous provider failure'
        WHERE id=$1`,
      [importId],
    );
    await pool.query(
      `INSERT INTO ai_invoice_import_sync_attempts
        (import_id,idempotency_key,review_version,status,destination,error,completed_at)
       VALUES ($1,$2,1,'failed','odoo','Previous provider failure',now())`,
      [importId, `failed-before-edit:${importId}`],
    );

    const response = await request(app)
      .patch(`/finance/invoice-review/${importId}/draft`)
      .send({
        version: 1,
        vendor_name: "Integration Supplier Updated",
        invoice_number: "INT-100-UPDATED",
        invoice_date: "2026-01-11",
        due_date: "",
        subtotal: 100,
        tax_amount: 5,
        total_amount: 105,
        line_items: [{ description: "Updated flowers", quantity: 1, unit_price: 100, total: 100 }],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.invoice).toMatchObject({
      review_version: 2,
      sync_status: "not_requested",
      provider_sync_status: "not_requested",
      due_date: null,
      error_message: null,
    });
    const persisted = await pool.query(
      `SELECT review_version,review_status,sync_status,provider_sync_status,due_date,error_message
         FROM ai_invoice_imports WHERE id=$1`,
      [importId],
    );
    expect(persisted.rows[0]).toMatchObject({
      review_version: 2,
      review_status: "needs_review",
      sync_status: "not_requested",
      provider_sync_status: "not_requested",
      due_date: null,
      error_message: null,
    });
    const history = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ai_invoice_import_sync_attempts WHERE import_id=$1) attempt_count,
         (SELECT count(*)::int FROM ai_invoice_import_edits WHERE import_id=$1) edit_count,
         (SELECT count(*)::int FROM ai_invoice_import_audit_events WHERE import_id=$1 AND event_type='draft_updated') audit_count`,
      [importId],
    );
    expect(history.rows[0]).toEqual({ attempt_count: 1, edit_count: 1, audit_count: 1 });
  });

  it("returns 502 for provider failure while preserving approved state and retry metadata", async () => {
    provider.createDraftVendorBill.mockRejectedValueOnce(new Error("provider unavailable"));
    const key = `provider-failure:${importId}`;
    const response = await request(app)
      .post(`/finance/invoice-review/${importId}/approve`)
      .send({ version: 1, idempotency_key: key });

    expect(response.status).toBe(502);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining("provider unavailable"),
    }));

    const fresh = await pool.query(
      `SELECT review_status,sync_status,approved_at,review_version FROM ai_invoice_imports WHERE id=$1`,
      [importId],
    );
    expect(fresh.rows[0]).toMatchObject({
      review_status: "approved",
      sync_status: "failed",
      review_version: 2,
    });
    expect(fresh.rows[0].approved_at).toBeTruthy();

    const attempt = await pool.query(
      `SELECT status,error,completed_at FROM ai_invoice_import_sync_attempts
       WHERE import_id=$1 AND idempotency_key=$2`,
      [importId, key],
    );
    expect(attempt.rows[0]).toMatchObject({ status: "failed" });
    expect(attempt.rows[0].error).toMatch(/provider unavailable/);
    expect(attempt.rows[0].completed_at).toBeTruthy();

    provider.createDraftVendorBill.mockResolvedValueOnce({
      success: true,
      provider_bill_id: "provider-bill-retry",
        provider_supplier_id: 301,
        provider_supplier_name: "Integration Supplier",
        provider_supplier_tax_number: "LB123",
    });
    const retry = await request(app)
      .post(`/finance/invoice-review/${importId}/retry-sync`)
      .send({ version: 2, idempotency_key: `${key}:retry` });
    expect(retry.status).toBe(200);

    const retryFresh = await pool.query(
      `SELECT status,destination,external_reference,completed_at FROM ai_invoice_import_sync_attempts
       WHERE import_id=$1 ORDER BY id DESC LIMIT 1`,
      [importId],
    );
    expect(retryFresh.rows[0]).toMatchObject({
      status: "succeeded",
      destination: "odoo",
      external_reference: "provider-bill-retry",
    });
    expect(retryFresh.rows[0].completed_at).toBeTruthy();

    const ledger = await pool.query(
      `SELECT provider_bill_id,provider_sync_status,odoo_bill_id,odoo_sync_status
         FROM supplier_invoices WHERE ai_import_id=$1`,
      [importId],
    );
    expect(ledger.rows[0]).toMatchObject({
      provider_bill_id: "provider-bill-retry",
      provider_sync_status: "succeeded",
      odoo_bill_id: "provider-bill-retry",
      odoo_sync_status: "synced",
    });
  });

  it("returns a specific 503 for connector configuration failure without losing approval", async () => {
    provider.createDraftVendorBill.mockRejectedValueOnce(new Error("Accounting configuration unavailable"));
    const response = await request(app)
      .post(`/finance/invoice-review/${importId}/approve`)
      .send({ version: 1, idempotency_key: `config-failure:${importId}` });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("Accounting configuration unavailable");

    const fresh = await pool.query(
      `SELECT review_status,sync_status,approved_at FROM ai_invoice_imports WHERE id=$1`,
      [importId],
    );
    expect(fresh.rows[0]).toMatchObject({
      review_status: "approved",
      sync_status: "failed",
    });
    expect(fresh.rows[0].approved_at).toBeTruthy();
  });

  it("A: persists one canonical invoice and supersedes the second split page", async () => {
    const { pageOne, pageTwo } = await insertSplitPages();

    const response = await request(app)
      .post(`/finance/invoice-review/${pageOne}/approve`)
      .send({ version: 1, sync: false });

    expect(response.status).toBe(200);
    expect(response.body.invoice.id).toBe(pageTwo);
    expect(Number(response.body.invoice.total_amount)).toBe(30);
    expect(response.body.invoice.line_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: "Page one flowers" }),
      expect.objectContaining({ description: "Page two flowers" }),
    ]));

    const rows = await pool.query(
      `SELECT id,review_status,sync_status,superseded_by_import_id,line_items,total_amount,review_version
         FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[pageOne, pageTwo]],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: pageOne,
        review_status: "superseded",
        sync_status: "superseded",
        superseded_by_import_id: pageTwo,
      }),
      expect.objectContaining({
        id: pageTwo,
        review_status: "approved",
        superseded_by_import_id: null,
        total_amount: "30.0000",
        review_version: 3,
      }),
    ]);
  });

  it("B: keeps both source documents/evidence and records merge audit history", async () => {
    const { pageOne, pageTwo } = await insertSplitPages();

    const response = await request(app)
      .post(`/finance/invoice-review/${pageOne}/approve`)
      .send({ version: 1, sync: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const sourcePages = await request(app).get(`/finance/invoice-review/${pageOne}/source-pages`);
    expect(sourcePages.status).toBe(200);
    expect(sourcePages.body.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ import_id: pageOne, available: true, superseded_by_import_id: pageTwo }),
      expect.objectContaining({ import_id: pageTwo, available: true, superseded_by_import_id: null }),
    ]));
    expect((await request(app).get(`/finance/invoice-review/${pageOne}/source`)).status).toBe(200);
    expect((await request(app).get(`/finance/invoice-review/${pageTwo}/source`)).status).toBe(200);
    const oldReviewLink = await request(app).get(`/finance/invoice-review/${pageOne}`);
    expect(oldReviewLink.status, JSON.stringify(oldReviewLink.body)).toBe(200);
    expect(oldReviewLink.body).toMatchObject({
      requested_invoice_id: pageOne,
      canonical_invoice_id: pageTwo,
      invoice: { id: pageTwo },
    });

    const evidence = await pool.query(
      `SELECT id,pdf_storage_path,source_metadata,extraction_evidence,raw_ai_json
         FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[pageOne, pageTwo]],
    );
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows.map((row) => row.pdf_storage_path)).toEqual([
      "/objects/invoice-page-1.pdf",
      "/objects/invoice-page-2.pdf",
    ]);
    expect(evidence.rows[1].extraction_evidence).toMatchObject({ page: 2, total_label: "GRAND TOTAL" });
    expect(evidence.rows[1].raw_ai_json).toMatchObject({ total_label: "GRAND TOTAL" });

    const audit = await pool.query(
      `SELECT import_id,event_type,details FROM ai_invoice_import_audit_events
        WHERE import_id=ANY($1::int[]) ORDER BY id`,
      [[pageOne, pageTwo]],
    );
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ import_id: pageTwo, event_type: "multi_page_merged", details: expect.objectContaining({ canonical_id: pageTwo, final_page_id: pageTwo }) }),
      expect.objectContaining({ import_id: pageOne, event_type: "multi_page_superseded", details: expect.objectContaining({ canonical_id: pageTwo, final_page_id: pageTwo }) }),
      expect.objectContaining({ import_id: pageTwo, event_type: "approved" }),
    ]));
  });

  it("self-heals historical split rows during queue refresh and excludes the superseded source", async () => {
    const { pageOne, pageTwo } = await insertSplitPages();
    await pool.query(
      `UPDATE ai_invoice_imports
          SET provider_bill_id='no-accounting-destination',
              odoo_bill_id='no-accounting-destination',
              provider_sync_status='blocked',
              sync_status='blocked',
              source_metadata=coalesce(source_metadata,'{}'::jsonb)
                || jsonb_build_object(
                     'multi_page_merge_evaluation',
                     jsonb_build_object(
                       'status','not_eligible',
                       'reason','Authoritative synced invoices are immutable',
                       'review_version',review_version
                     )
                   )
        WHERE id=ANY($1::int[])`,
      [[pageOne, pageTwo]],
    );

    const queue = await request(app).get("/finance/invoice-review/queue?limit=100");

    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(queue.body.imports.map((invoice: { id: number }) => invoice.id)).toContain(pageTwo);
    expect(queue.body.imports.map((invoice: { id: number }) => invoice.id)).not.toContain(pageOne);
    expect(queue.body.canonicalized_ids).toMatchObject({ [pageOne]: pageTwo });
    const rows = await pool.query(
      `SELECT id,superseded_by_import_id,review_status,sync_status
         FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[pageOne, pageTwo]],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: pageOne,
        superseded_by_import_id: pageTwo,
        review_status: "superseded",
        sync_status: "superseded",
      }),
      expect.objectContaining({
        id: pageTwo,
        superseded_by_import_id: null,
        review_status: "needs_review",
      }),
    ]);
  });

  it("runs the live metadata-free SF2602426 shape through queue discovery and merge persistence", async () => {
    const supplierId = (await pool.query<{ id: number }>(
      "SELECT id FROM suppliers WHERE workspace_owner_id=$1 LIMIT 1",
      [OWNER_ID],
    )).rows[0].id;
    const partial = await insertImport({
      supplierId,
      filename: "SF2602426-partial.pdf",
      pdfPath: "/objects/SF2602426-partial.pdf",
      invoiceNumber: "SF2602426",
      invoiceDate: "2026-08-29",
      subtotal: 481,
      taxAmount: null,
      totalAmount: 481,
      lineItems: [{ description: "Detailed flowers", quantity: 1, unit_price: 481, total: 481 }],
      sourceBatchId: null,
      sourcePageNumber: null,
      sourcePageCount: null,
      providerBillId: "no-accounting-destination",
      odooBillId: "no-accounting-destination",
      providerSyncStatus: "blocked",
      syncStatus: "blocked",
      sourceMetadata: {
        multi_page_merge_evaluation: {
          status: "not_eligible",
          reason: "Authoritative synced invoices are immutable",
          review_version: 1,
        },
      },
    });
    const final = await insertImport({
      supplierId,
      filename: "SF2602426-final.pdf",
      pdfPath: "/objects/SF2602426-final.pdf",
      invoiceNumber: "SF2602426",
      invoiceDate: "2026-08-29",
      subtotal: 481,
      taxAmount: 52.91,
      totalAmount: 533.91,
      lineItems: [{ description: "Net total", quantity: 1, unit_price: 5, total: 5 }],
      sourceBatchId: null,
      sourcePageNumber: null,
      sourcePageCount: null,
      providerBillId: "no-accounting-destination",
      odooBillId: "no-accounting-destination",
      providerSyncStatus: "blocked",
      syncStatus: "blocked",
      sourceMetadata: {
        multi_page_merge_evaluation: {
          status: "not_eligible",
          reason: "Authoritative synced invoices are immutable",
          review_version: 1,
        },
      },
    });

    const queue = await request(app).get("/finance/invoice-review/queue?limit=100");
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(queue.body.canonicalized_ids).toMatchObject({ [partial]: final });
    const persisted = await pool.query(
      `SELECT id,superseded_by_import_id,subtotal,tax_amount,total_amount,line_items,
              source_metadata #>> '{multi_page_merge_policy_version}' AS policy_version
         FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[partial, final]],
    );
    expect(persisted.rows[0]).toMatchObject({
      id: partial,
      superseded_by_import_id: final,
    });
    expect(persisted.rows[1]).toMatchObject({
      id: final,
      superseded_by_import_id: null,
      subtotal: "481.0000",
      tax_amount: "52.9100",
      total_amount: "533.9100",
      line_items: [{ description: "Detailed flowers", quantity: 1, unit_price: 481, total: 481 }],
      policy_version: "2",
    });
  });

  it("stamps the current merge policy without falsely canonicalizing a non-mergeable group", async () => {
    const supplierId = (await pool.query<{ id: number }>(
      "SELECT id FROM suppliers WHERE workspace_owner_id=$1 LIMIT 1",
      [OWNER_ID],
    )).rows[0].id;
    const first = await insertImport({
      supplierId,
      invoiceNumber: "INT-NOT-MERGEABLE",
      invoiceDate: "2026-09-20",
      sourceBatchId: null,
      sourcePageNumber: null,
      sourcePageCount: null,
      sourceMetadata: {
        multi_page_merge_evaluation: {
          status: "not_eligible",
          reason: "Old policy decision",
          review_version: 1,
        },
      },
    });
    const second = await insertImport({
      supplierId,
      invoiceNumber: "INT-NOT-MERGEABLE",
      invoiceDate: "2026-09-21",
      sourceBatchId: null,
      sourcePageNumber: null,
      sourcePageCount: null,
      sourceMetadata: {
        multi_page_merge_evaluation: {
          status: "not_eligible",
          reason: "Old policy decision",
          review_version: 1,
        },
      },
    });

    const firstRefresh = await request(app).get("/finance/invoice-review/queue?limit=100");
    expect(firstRefresh.status, JSON.stringify(firstRefresh.body)).toBe(200);
    expect(firstRefresh.body.canonicalized_ids).not.toHaveProperty(String(first));
    expect(firstRefresh.body.canonicalized_ids).not.toHaveProperty(String(second));
    expect(firstRefresh.body.imports.map((invoice: { id: number }) => invoice.id)).toEqual(
      expect.arrayContaining([first, second]),
    );
    const markers = await pool.query(
      `SELECT id,source_metadata #>> '{multi_page_merge_evaluation,policy_version}' AS policy_version
         FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[first, second]],
    );
    expect(markers.rows).toEqual([
      { id: first, policy_version: "2" },
      { id: second, policy_version: "2" },
    ]);

    const secondRefresh = await request(app).get("/finance/invoice-review/queue?limit=100");
    expect(secondRefresh.status).toBe(200);
    expect(secondRefresh.body.canonicalized_ids).toEqual({});
  });

  it("resolves selected split IDs to one canonical row in database-only bulk approval", async () => {
    const { pageOne, pageTwo } = await insertSplitPages();

    const response = await request(app)
      .post("/finance/invoice-review/approve-selected")
      .send({ invoice_ids: [pageOne, pageTwo], versions: { [pageOne]: 1, [pageTwo]: 1 } });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ approved: 1, blocked: 0, skipped: 1 });
    expect(response.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoice_id: pageOne, canonical_invoice_id: pageTwo, status: "approved" }),
      expect.objectContaining({ invoice_id: pageTwo, canonical_invoice_id: pageTwo, status: "skipped" }),
    ]));
    expect(provider.createDraftVendorBill).not.toHaveBeenCalled();
    const canonical = await pool.query(
      `SELECT review_status,sync_status,review_version FROM ai_invoice_imports WHERE id=$1`,
      [pageTwo],
    );
    expect(canonical.rows[0]).toEqual({
      review_status: "approved",
      sync_status: "not_requested",
      review_version: 3,
    });
  });

  it("C: excludes superseded pages and repairs authoritative provider successes locally", async () => {
    const supplierId = (await pool.query<{ id: number }>(
      "SELECT id FROM suppliers WHERE workspace_owner_id=$1 LIMIT 1",
      [OWNER_ID],
    )).rows[0].id;
    const canonical = await insertImport({
      supplierId,
      reviewStatus: "approved",
      syncStatus: "failed",
      invoiceNumber: "INT-CANONICAL",
      sourceBatchId: "batch-int-c",
      sourcePageNumber: 1,
      sourcePageCount: 2,
    });
    const superseded = await insertImport({
      supplierId,
      reviewStatus: "approved",
      syncStatus: "failed",
      invoiceNumber: "INT-CANONICAL",
      sourceBatchId: "batch-int-c",
      sourcePageNumber: 2,
      sourcePageCount: 2,
      supersededByImportId: canonical,
    });
    const blocked = await insertImport({ supplierId, reviewStatus: "approved", syncStatus: "blocked", invoiceNumber: "INT-BLOCKED" });
    const authoritative = await insertImport({
      supplierId,
      reviewStatus: "approved",
      syncStatus: "succeeded",
      providerSyncStatus: "succeeded",
      providerBillId: "odoo-authoritative",
      providerBillStatus: "draft",
      odooBillId: "odoo-authoritative",
      invoiceNumber: "INT-AUTHORITATIVE",
    });
    await pool.query(
      `UPDATE finance_entities
          SET accounting_system='odoo',
              odoo_base_url='https://odoo.example',
              odoo_database='presentail',
               odoo_company_id=2,
               odoo_default_expense_account_id=601101
        WHERE id=$1`,
      [entityId],
    );
    await pool.query(
      `INSERT INTO ai_invoice_import_sync_attempts
        (import_id,idempotency_key,review_version,status,destination,external_reference,completed_at,verified_at)
       VALUES ($1,$2,1,'succeeded','odoo',$3,now(),now())`,
      [authoritative, `authoritative:${authoritative}`, "odoo-authoritative"],
    );
    provider.createDraftVendorBill.mockResolvedValue({
      success: true,
      provider_bill_id: "odoo-bulk-result",
      provider_bill_status: "draft",
      provider_supplier_id: 301,
      provider_supplier_name: "Integration Supplier",
      provider_supplier_tax_number: "LB123",
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: entityId });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.selected).toBe(3);
    expect(response.body.failed).toBe(0);
    expect(response.body.synced).toBe(3);
    expect(provider.createDraftVendorBill.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([canonical, blocked]),
    );
    expect(provider.createDraftVendorBill.mock.calls.map((call) => call[1])).not.toContain(superseded);
    expect(provider.createDraftVendorBill.mock.calls.map((call) => call[1])).not.toContain(authoritative);
    const repairedLedger = await pool.query(
      `SELECT odoo_sync_status,odoo_bill_id FROM supplier_invoices WHERE ai_import_id=$1`,
      [authoritative],
    );
    expect(repairedLedger.rows[0]).toEqual({
      odoo_sync_status: "synced",
      odoo_bill_id: "odoo-authoritative",
    });
  });

  it("D: retries the canonical invoice through Odoo and never syncs a superseded page", async () => {
    await pool.query(
      `UPDATE finance_entities
          SET accounting_system='odoo',odoo_default_expense_account_id=601101
        WHERE id=$1`,
      [entityId],
    );
    const supplierId = (await pool.query<{ id: number }>(
      "SELECT id FROM suppliers WHERE workspace_owner_id=$1 LIMIT 1",
      [OWNER_ID],
    )).rows[0].id;
    const canonical = await insertImport({
      supplierId,
      reviewStatus: "approved",
      syncStatus: "failed",
      providerSyncStatus: "failed",
      invoiceNumber: "INT-RETRY",
    });
    const superseded = await insertImport({
      supplierId,
      reviewStatus: "superseded",
      syncStatus: "superseded",
      providerSyncStatus: "failed",
      invoiceNumber: "INT-RETRY",
      supersededByImportId: canonical,
    });
    provider.createDraftVendorBill
      .mockResolvedValueOnce({
      success: true,
      provider_bill_id: "odoo-created",
      provider_bill_status: "draft",
      provider_supplier_id: 301,
      provider_supplier_name: "Integration Supplier",
      provider_supplier_tax_number: "LB123",
      outcome: "created",
      })
      .mockResolvedValueOnce({
        success: true,
        provider_bill_id: "odoo-created",
        provider_bill_status: "draft",
        provider_supplier_id: 301,
        provider_supplier_name: "Integration Supplier",
        provider_supplier_tax_number: "LB123",
        outcome: "recovered",
      });

    const retry = await request(app)
      .post(`/finance/invoice-review/${canonical}/retry-sync`)
      .send({ version: 1, idempotency_key: `retry:${canonical}` });

    expect(retry.status).toBe(200);
    expect(retry.body.sync.status).toBe("succeeded");
    expect(provider.createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(provider.createDraftVendorBill.mock.calls[0][1]).toBe(canonical);

    const recoveredRetry = await request(app)
      .post(`/finance/invoice-review/${canonical}/retry-sync`)
      .send({ version: 1, idempotency_key: `retry:${canonical}:recovery` });
    expect(recoveredRetry.status).toBe(200);
    expect(recoveredRetry.body.sync.status).toBe("succeeded");
    expect(recoveredRetry.body.ledger_repair).toBe(true);
    expect(provider.createDraftVendorBill).toHaveBeenCalledTimes(1);
    const recoveryAudit = await pool.query(
      `SELECT event_type,details FROM ai_invoice_import_audit_events
        WHERE import_id=$1 ORDER BY id DESC LIMIT 1`,
      [canonical],
    );
    expect(recoveryAudit.rows[0]).toMatchObject({
      event_type: "ledger_repaired",
      details: { external_reference: "odoo-created" },
    });

    const supersededRetry = await request(app)
      .post(`/finance/invoice-review/${superseded}/retry-sync`)
      .send({ version: 1, idempotency_key: `retry:${superseded}` });
    expect(supersededRetry.status).toBe(409);
    expect(provider.createDraftVendorBill).toHaveBeenCalledTimes(1);
  });

  it("E: leaves unrelated/conflicting pages separate and blocks ambiguous totals for review", async () => {
    const supplierId = (await pool.query<{ id: number }>(
      "SELECT id FROM suppliers WHERE workspace_owner_id=$1 LIMIT 1",
      [OWNER_ID],
    )).rows[0].id;
    const unrelated = await insertImport({ supplierId, invoiceNumber: "INT-E", sourceBatchId: "batch-e-one", sourcePageNumber: 1, sourcePageCount: 2 });
    const differentSource = await insertImport({ supplierId, invoiceNumber: "INT-E", sourceBatchId: "batch-e-two", sourcePageNumber: 2, sourcePageCount: 2 });
    const conflictingSupplier = await insertImport({ supplierId: null, vendorName: "Different Supplier", invoiceNumber: "INT-E", sourceBatchId: "batch-e-one", sourcePageNumber: 2, sourcePageCount: 2 });
    const ambiguousOne = await insertImport({ supplierId, invoiceNumber: "INT-E-AMBIG", filename: "ambiguous-1.pdf", pdfPath: "/objects/ambiguous-1.pdf", sourceBatchId: "batch-e-ambig", sourcePageNumber: 1, sourcePageCount: 2, totalAmount: 10 });
    const ambiguousTwo = await insertImport({ supplierId, invoiceNumber: "INT-E-AMBIG", filename: "ambiguous-2.pdf", pdfPath: "/objects/ambiguous-2.pdf", sourceBatchId: "batch-e-ambig", sourcePageNumber: 2, sourcePageCount: 2, totalAmount: 20, lineItems: [{ description: "Printed total", total: 20 }] });

    const response = await request(app)
      .post(`/finance/invoice-review/${unrelated}/approve`)
      .send({ version: 1, sync: false });
    expect(response.status, JSON.stringify(response.body)).not.toBe(500);

    await request(app)
      .post(`/finance/invoice-review/${ambiguousOne}/approve`)
      .send({ version: 1, sync: false });

    const unchanged = await pool.query(
      `SELECT id,superseded_by_import_id FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[unrelated, differentSource, conflictingSupplier]],
    );
    expect(unchanged.rows.every((row) => row.superseded_by_import_id === null)).toBe(true);

    const ambiguous = await pool.query(
      `SELECT sync_status,provider_sync_status,error_message FROM ai_invoice_imports WHERE id=ANY($1::int[]) ORDER BY id`,
      [[ambiguousOne, ambiguousTwo]],
    );
    expect(ambiguous.rows).toEqual([
      expect.objectContaining({ sync_status: "blocked", provider_sync_status: "failed", error_message: "Needs multi-page invoice review" }),
      expect.objectContaining({ sync_status: "blocked", provider_sync_status: "failed", error_message: "Needs multi-page invoice review" }),
    ]);
  });
});