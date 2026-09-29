import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { syncImportedSupplierInvoice } from "./syncImportedSupplierInvoice";
import { linkImportedInvoiceToVerifiedOdooSupplier } from "./linkImportedInvoiceSupplier";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__imported_invoice_sync_owner__";

describe.skipIf(!DATABASE_URL)("imported supplier invoice synchronization", () => {
  let pool: InstanceType<typeof Pool>;
  let importId: number;
  let entityId: number;
  let supplierA: number;
  let supplierB: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM finance_entities WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);

    const entity = await pool.query<{ id: number }>(
      `INSERT INTO finance_entities (
         workspace_owner_id, legal_name, accounting_system, default_currency
       ) VALUES ($1, 'Import Sync Entity', 'manual', 'USD')
       RETURNING id`,
      [OWNER_ID],
    );
    const suppliers = await pool.query<{ id: number }>(
      `INSERT INTO suppliers (workspace_owner_id, name, currency_pref)
       VALUES ($1, 'Import Sync Supplier A', 'USD'),
              ($1, 'Import Sync Supplier B', 'USD')
       RETURNING id`,
      [OWNER_ID],
    );
    supplierA = suppliers.rows[0].id;
    supplierB = suppliers.rows[1].id;
    entityId = entity.rows[0].id;

    const imported = await pool.query<{ id: number }>(
      `INSERT INTO ai_invoice_imports (
         workspace_owner_id, entity_id, supplier_id, status, original_filename,
         pdf_storage_path, invoice_number, invoice_date, due_date, currency,
         subtotal, tax_amount, total_amount, line_items
       ) VALUES (
         $1, $2, $3, 'ready_for_manual_entry', 'source.pdf', '/objects/source.pdf',
         'AI-100', '2026-08-01', '2026-08-31', 'USD',
         100, 5, 105, '[{"description":"Flowers","quantity":1,"unit_price":100,"total":100}]'
       )
       RETURNING id`,
      [OWNER_ID, entity.rows[0].id, supplierA],
    );
    importId = imported.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM finance_entities WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.end();
  });

  it("creates one complete ledger row and remains idempotent", async () => {
    await syncImportedSupplierInvoice(importId, OWNER_ID);
    await syncImportedSupplierInvoice(importId, OWNER_ID);

    const result = await pool.query(
      `SELECT * FROM supplier_invoices WHERE ai_import_id = $1`,
      [importId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      supplier_id: supplierA,
      invoice_number: "AI-100",
      currency: "USD",
      status: "issued",
      payment_status: "unpaid",
      odoo_sync_status: null,
    });
    expect(result.rows[0].amount).toBe("105.0000");
    expect(result.rows[0].subtotal).toBe("100.0000");
    expect(result.rows[0].vat_amount).toBe("5.0000");
    expect(result.rows[0].file_urls).toEqual(["/objects/source.pdf"]);
    expect(result.rows[0].line_items).toHaveLength(1);
  });

  it("updates fields, moves suppliers, and reflects accounting failure", async () => {
    await pool.query(
      `UPDATE ai_invoice_imports
          SET supplier_id = $1,
              status = 'failed',
              total_amount = 210,
              subtotal = 200,
              tax_amount = 10,
              error_message = 'Odoo unavailable',
              invoice_number = 'AI-100-EDITED'
        WHERE id = $2`,
      [supplierB, importId],
    );
    await syncImportedSupplierInvoice(importId, OWNER_ID);

    const result = await pool.query(
      `SELECT * FROM supplier_invoices WHERE ai_import_id = $1`,
      [importId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      supplier_id: supplierB,
      invoice_number: "AI-100-EDITED",
      status: "draft",
      odoo_sync_status: null,
      odoo_sync_error: null,
    });
    expect(result.rows[0].amount).toBe("210.0000");
    expect(result.rows[0].vat_amount).toBe("10.0000");
  });

  it("retains an explicitly linked archived supplier and removes an unlinked row", async () => {
    await pool.query(`UPDATE suppliers SET is_archived = true WHERE id = $1`, [supplierB]);
    await syncImportedSupplierInvoice(importId, OWNER_ID);
    expect(
      await pool.query(`SELECT id FROM supplier_invoices WHERE ai_import_id = $1`, [importId]),
    ).toHaveProperty("rowCount", 1);

    await pool.query(`UPDATE ai_invoice_imports SET supplier_id = NULL WHERE id = $1`, [importId]);
    await syncImportedSupplierInvoice(importId, OWNER_ID);
    expect(
      await pool.query(`SELECT id FROM supplier_invoices WHERE ai_import_id = $1`, [importId]),
    ).toHaveProperty("rowCount", 0);
  });

  it("creates and links one supplier from verified Odoo identity without duplicates on rerun", async () => {
    const imported = await pool.query<{ id: number }>(
      `INSERT INTO ai_invoice_imports (
         workspace_owner_id,entity_id,supplier_id,status,pdf_storage_path,
         invoice_number,invoice_date,currency,total_amount,line_items
       ) VALUES ($1,$2,NULL,'approved','/objects/odoo-source.pdf',
                 'ODOO-100','2026-09-17','USD',25,'[]'::jsonb)
       RETURNING id`,
      [OWNER_ID, entityId],
    );
    const odooImportId = imported.rows[0].id;

    const firstSupplierId = await linkImportedInvoiceToVerifiedOdooSupplier(
      odooImportId,
      OWNER_ID,
      { id: 9301, name: "Verified Odoo Supplier", taxNumber: "LB-9301" },
    );
    const secondSupplierId = await linkImportedInvoiceToVerifiedOdooSupplier(
      odooImportId,
      OWNER_ID,
      { id: 9301, name: "Verified Odoo Supplier", taxNumber: "LB-9301" },
    );
    await syncImportedSupplierInvoice(odooImportId, OWNER_ID);
    await syncImportedSupplierInvoice(odooImportId, OWNER_ID);

    expect(secondSupplierId).toBe(firstSupplierId);
    expect(await pool.query(
      `SELECT id FROM suppliers WHERE workspace_owner_id=$1 AND odoo_partner_id=9301`,
      [OWNER_ID],
    )).toHaveProperty("rowCount", 1);
    const linked = await pool.query(
      `SELECT i.supplier_id,si.supplier_id AS ledger_supplier_id
         FROM ai_invoice_imports i
         JOIN supplier_invoices si ON si.ai_import_id=i.id
        WHERE i.id=$1`,
      [odooImportId],
    );
    expect(linked.rows).toEqual([{ supplier_id: firstSupplierId, ledger_supplier_id: firstSupplierId }]);
  });
});