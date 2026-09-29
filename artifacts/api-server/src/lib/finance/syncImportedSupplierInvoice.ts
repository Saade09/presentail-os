import { db } from "../db.js";
import type pg from "pg";

/**
 * Mirrors one AI invoice import into the supplier invoice ledger.
 *
 * The unique ai_import_id relationship is the identity boundary: invoice
 * numbers are intentionally not used because unrelated invoices may share one.
 */
export async function syncImportedSupplierInvoice(
  importId: number,
  workspaceOwnerId: string,
  queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> = db,
): Promise<void> {
  await queryable.query(
    `WITH verified AS (
       SELECT i.id,
              i.provider_bill_id,
              i.odoo_bill_id
         FROM ai_invoice_imports i
        WHERE i.id = $1
          AND i.workspace_owner_id = $2
          AND NULLIF(i.provider_bill_id, '') IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM ai_invoice_import_sync_attempts a
             WHERE a.import_id = i.id
               AND a.destination = 'odoo'
               AND a.status = 'succeeded'
               AND a.verified_at IS NOT NULL
               AND a.external_reference IN (i.provider_bill_id, i.odoo_bill_id)
          )
     ),
     repaired AS (
       UPDATE ai_invoice_imports i
          SET sync_status = 'succeeded',
              provider_sync_status = 'succeeded',
              provider_sync_error = NULL,
              error_message = NULL,
              odoo_bill_id = COALESCE(NULLIF(i.provider_bill_id, ''), i.odoo_bill_id),
              odoo_bill_url = COALESCE(i.odoo_bill_url, i.provider_bill_url),
              updated_at = now()
         FROM verified v
        WHERE i.id = v.id
       RETURNING i.id, i.sync_status, i.odoo_bill_id, i.odoo_bill_url
     ),
     linked AS (
       UPDATE supplier_invoices si
          SET ai_import_id = $1
         FROM verified v
        WHERE si.workspace_owner_id = $2
          AND si.ai_import_id IS NULL
          AND si.provider_bill_id = v.provider_bill_id
       RETURNING si.id
     ),
     source AS (
       SELECT i.*,
              COALESCE(r.odoo_bill_id, i.odoo_bill_id) AS repaired_odoo_bill_id,
              COALESCE(r.odoo_bill_url, i.odoo_bill_url) AS repaired_odoo_bill_url,
               COALESCE(i.provider_synced_at, now()) AS repaired_odoo_synced_at,
              EXISTS (SELECT 1 FROM linked) AS existing_provider_link,
              EXISTS (
                SELECT 1 FROM ai_invoice_import_sync_attempts a
                 WHERE a.import_id=i.id
                   AND a.destination='odoo'
                   AND a.status='succeeded'
                   AND a.verified_at IS NOT NULL
                   AND a.external_reference IN (i.provider_bill_id, i.odoo_bill_id)
              ) AS odoo_verified,
              CASE
                WHEN i.accounting_destination IS NOT NULL THEN i.accounting_destination
                 WHEN upper(trim(coalesce(e.country, ''))) IN ('LB', 'LEBANON', 'LEBANESE')
                   OR upper(trim(coalesce(i.billing_country, ''))) IN ('LB', 'LEBANON', 'LEBANESE')
                  OR lower(coalesce(e.legal_name, '') || ' ' || coalesce(e.display_name, '')) ~ '\\m(lebanon|lebanese)\\M'
                  THEN 'odoo'
                ELSE e.accounting_system
              END AS accounting_system
         FROM ai_invoice_imports i
         LEFT JOIN repaired r ON r.id = i.id
         JOIN suppliers s
           ON s.id = i.supplier_id
          AND s.workspace_owner_id = i.workspace_owner_id
         JOIN finance_entities e ON e.id = i.entity_id
          AND e.workspace_owner_id = i.workspace_owner_id
        WHERE i.id = $1
          AND i.workspace_owner_id = $2
          AND i.supplier_id IS NOT NULL
     )
     INSERT INTO supplier_invoices (
       supplier_id,
       workspace_owner_id,
       amount,
       currency,
       status,
       invoice_number,
       issued_at,
       notes,
       due_date,
       vat_amount,
       subtotal,
       grand_total,
       payment_status,
       file_urls,
       line_items,
       ai_import_id,
        provider_bill_id,
        provider_bill_status,
        provider_bill_url,
        provider_synced_at,
        provider_sync_status,
        provider_sync_error,
        provider_sync_idempotency_key,
       odoo_bill_id,
       odoo_bill_url,
       odoo_synced_at,
       odoo_sync_status,
       odoo_sync_error
     )
     SELECT
       supplier_id,
       workspace_owner_id,
       COALESCE(total_amount, subtotal, 0),
       COALESCE(NULLIF(currency, ''), 'AED'),
       CASE
         WHEN status = 'duplicate_detected' THEN 'cancelled'
         WHEN status IN ('uploaded', 'processing', 'needs_review', 'failed') THEN 'draft'
         ELSE 'issued'
       END,
       invoice_number,
       COALESCE(invoice_date::timestamptz, created_at),
       CASE
         WHEN manual_notes IS NOT NULL THEN manual_notes
         WHEN original_filename IS NOT NULL THEN 'Imported from ' || original_filename
         ELSE 'AI-imported invoice'
       END,
       due_date,
       tax_amount,
       subtotal,
       total_amount,
       'unpaid',
       CASE WHEN pdf_storage_path IS NULL THEN NULL ELSE jsonb_build_array(pdf_storage_path) END,
       COALESCE(line_items, '[]'::jsonb),
       id,
        provider_bill_id,
        provider_bill_status,
        provider_bill_url,
        provider_synced_at,
        provider_sync_status,
        provider_sync_error,
        provider_sync_idempotency_key,
         CASE WHEN accounting_system = 'odoo' THEN repaired_odoo_bill_id ELSE NULL END,
         CASE WHEN accounting_system = 'odoo' THEN repaired_odoo_bill_url ELSE NULL END,
          CASE WHEN accounting_system = 'odoo' AND provider_sync_status = 'succeeded' AND provider_bill_id=repaired_odoo_bill_id AND repaired_odoo_bill_id IS NOT NULL AND odoo_verified THEN COALESCE(provider_synced_at, repaired_odoo_synced_at) ELSE NULL END,
          CASE WHEN accounting_system = 'odoo' THEN
           CASE
             WHEN provider_sync_status = 'succeeded' AND provider_bill_id=repaired_odoo_bill_id AND repaired_odoo_bill_id IS NOT NULL AND odoo_verified THEN 'synced'
             WHEN provider_sync_status = 'failed' THEN 'failed'
             ELSE 'pending'
           END
           ELSE NULL END,
          CASE WHEN accounting_system = 'odoo' AND provider_sync_status = 'failed' THEN provider_sync_error ELSE NULL END
     FROM source
     ON CONFLICT (ai_import_id) WHERE ai_import_id IS NOT NULL DO UPDATE SET
       supplier_id = EXCLUDED.supplier_id,
       workspace_owner_id = EXCLUDED.workspace_owner_id,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       status = EXCLUDED.status,
       invoice_number = EXCLUDED.invoice_number,
       issued_at = EXCLUDED.issued_at,
       notes = EXCLUDED.notes,
       due_date = EXCLUDED.due_date,
       vat_amount = EXCLUDED.vat_amount,
       subtotal = EXCLUDED.subtotal,
       grand_total = EXCLUDED.grand_total,
       payment_status = EXCLUDED.payment_status,
       file_urls = EXCLUDED.file_urls,
       line_items = EXCLUDED.line_items,
        provider_bill_id = EXCLUDED.provider_bill_id,
        provider_bill_status = EXCLUDED.provider_bill_status,
        provider_bill_url = EXCLUDED.provider_bill_url,
        provider_synced_at = EXCLUDED.provider_synced_at,
        provider_sync_status = EXCLUDED.provider_sync_status,
        provider_sync_error = EXCLUDED.provider_sync_error,
        provider_sync_idempotency_key = EXCLUDED.provider_sync_idempotency_key,
       odoo_bill_id = EXCLUDED.odoo_bill_id,
       odoo_bill_url = EXCLUDED.odoo_bill_url,
       odoo_synced_at = EXCLUDED.odoo_synced_at,
       odoo_sync_status = EXCLUDED.odoo_sync_status,
       odoo_sync_error = EXCLUDED.odoo_sync_error`,
    [importId, workspaceOwnerId],
  );

  // An unlink (or an import whose supplier became invalid) has no source row.
  await queryable.query(
    `DELETE FROM supplier_invoices si
      WHERE si.ai_import_id = $1
        AND si.workspace_owner_id = $2
        AND NOT EXISTS (
          SELECT 1
            FROM ai_invoice_imports i
            JOIN suppliers s
              ON s.id = i.supplier_id
             AND s.workspace_owner_id = i.workspace_owner_id
           WHERE i.id = $1
             AND i.workspace_owner_id = $2
             AND i.supplier_id IS NOT NULL
        )`,
    [importId, workspaceOwnerId],
  );
}