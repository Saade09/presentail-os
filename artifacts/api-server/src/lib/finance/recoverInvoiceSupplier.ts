import type pg from "pg";
import { db } from "../db.js";
import { logger } from "../logger.js";
import { normalizeSupplierName } from "../supplierMatcher.js";

type HistoricalSupplierRow = {
  supplier_id: number;
  vendor_name: string | null;
  canonical_supplier_name?: string | null;
  canonical_tax_number?: string | null;
  canonical_odoo_partner_id?: string | null;
};

export type InvoiceSupplierRecoveryInput = {
  id: number;
  entity_id: number;
  workspace_owner_id?: string | null;
  supplier_id: number | null;
  vendor_name: string | null;
  vendor_tax_number?: string | null;
  supplier_name?: string | null;
  supplier_tax_number?: string | null;
  odoo_partner_id?: string | null;
};

export type InvoiceSupplierRecoveryResult =
  | { status: "not_needed"; invoice: InvoiceSupplierRecoveryInput }
  | { status: "recovered"; invoice: InvoiceSupplierRecoveryInput; supplier_id: number }
  | { status: "unresolved" | "ambiguous"; invoice: InvoiceSupplierRecoveryInput };

/**
 * Recover a missing local supplier only from exact normalized identity history.
 *
 * The historical rows must belong to the same workspace and accounting entity
 * and must either have a verified Odoo attempt, a finalized successful sync,
 * or an explicitly mapped Odoo supplier record. Ambiguous local IDs are never
 * reduced to the first database row.
 */
export async function recoverMissingInvoiceSupplier(
  invoice: InvoiceSupplierRecoveryInput,
  workspaceOwnerId: string,
  queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> = db,
): Promise<InvoiceSupplierRecoveryResult> {
  let currentName = invoice.supplier_name ?? invoice.vendor_name;
  let currentTax = invoice.supplier_tax_number ?? invoice.vendor_tax_number;
  if (invoice.supplier_id != null) {
    try {
      const current = await queryable.query<{
        id: number;
        supplier_name: string | null;
        tax_number: string | null;
        odoo_partner_id: string | number | null;
      }>(
        `SELECT id,name AS supplier_name,tax_number,odoo_partner_id
           FROM suppliers
          WHERE id=$1 AND workspace_owner_id=$2 AND is_archived=false`,
        [invoice.supplier_id, workspaceOwnerId],
      );
      const supplier = current.rows[0];
      if (!supplier) return { status: "unresolved", invoice };
      if (String(supplier.odoo_partner_id ?? "").trim()) return { status: "not_needed", invoice };
      currentName = supplier.supplier_name;
      currentTax = supplier.tax_number;
    } catch (error) {
      logger.warn({ err: error, importId: invoice.id }, "finance: current supplier lookup failed");
      return { status: "unresolved", invoice };
    }
  }

  const normalizedIdentity = normalizeSupplierName(invoice.vendor_name ?? "");
  if (!normalizedIdentity) {
    return { status: "unresolved", invoice };
  }

  let history: HistoricalSupplierRow[];
  try {
    const result = await queryable.query<HistoricalSupplierRow>(
      `SELECT i.supplier_id,i.vendor_name,
               s.name AS canonical_supplier_name,
              s.tax_number AS canonical_tax_number,
              s.odoo_partner_id AS canonical_odoo_partner_id
         FROM ai_invoice_imports i
         JOIN suppliers s
           ON s.id=i.supplier_id
          AND s.workspace_owner_id=i.workspace_owner_id
          AND s.is_archived=false
        WHERE i.workspace_owner_id=$1
          AND i.entity_id=$2
          AND i.id<>$3
          AND i.supplier_id IS NOT NULL
          AND i.review_status IN ('approved','reviewed')
           AND s.odoo_partner_id IS NOT NULL
          AND (
            EXISTS (
              SELECT 1
                FROM ai_invoice_import_sync_attempts a
               WHERE a.import_id=i.id
                 AND a.destination='odoo'
                 AND a.status='succeeded'
                 AND a.verified_at IS NOT NULL
                 AND a.external_reference=i.odoo_bill_id
            )
            OR (
              i.provider_sync_status='succeeded'
              AND nullif(i.provider_bill_id,'') IS NOT NULL
              AND i.provider_bill_id=i.odoo_bill_id
              AND nullif(i.odoo_bill_id,'') IS NOT NULL
            )
          )`,
      [workspaceOwnerId, invoice.entity_id, invoice.id],
    );
    history = result.rows;
  } catch (error) {
    logger.warn({ err: error, importId: invoice.id }, "finance: historical supplier recovery lookup failed");
    return { status: "unresolved", invoice };
  }

  const normalizedCurrentName = normalizeSupplierName(currentName ?? "");
  const normalizedCurrentTax = String(currentTax ?? "").trim().toUpperCase();
  const identityCandidates = history.filter((row) => {
    const canonicalName = normalizeSupplierName(row.canonical_supplier_name ?? row.vendor_name ?? "");
    const canonicalTax = String(row.canonical_tax_number ?? "").trim().toUpperCase();
    return (normalizedCurrentName && canonicalName === normalizedCurrentName)
      || (!!normalizedCurrentTax && !!canonicalTax && normalizedCurrentTax === canonicalTax)
      || (!normalizedCurrentName && canonicalName === normalizedIdentity);
  });
  if (normalizedCurrentTax && identityCandidates.some((row) => {
    const canonicalTax = String(row.canonical_tax_number ?? "").trim().toUpperCase();
    return !!canonicalTax && canonicalTax !== normalizedCurrentTax;
  })) return { status: "ambiguous", invoice };
  const candidates = identityCandidates.filter((row) => {
    const canonicalTax = String(row.canonical_tax_number ?? "").trim().toUpperCase();
    return !normalizedCurrentTax || !canonicalTax || canonicalTax === normalizedCurrentTax;
  });
  const supplierIds = new Set(
    candidates
      .map((row) => Number(row.supplier_id))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
  const partnerIds = new Set(
    candidates
      .map((row) => String(row.canonical_odoo_partner_id ?? row.supplier_id).trim())
      .filter(Boolean),
  );

  if (supplierIds.size === 0) return { status: "unresolved", invoice };
  if (supplierIds.size !== 1 || partnerIds.size !== 1) return { status: "ambiguous", invoice };

  const supplierId = [...supplierIds][0];
  const updateSql = invoice.supplier_id == null
    ? `UPDATE ai_invoice_imports
        SET supplier_id=$1,
            supplier_confirmation=NULL,
            error_message=NULL,
            updated_at=now()
      WHERE id=$2
        AND workspace_owner_id=$3
        AND entity_id=$4
        AND supplier_id IS NULL
      RETURNING supplier_id`
    : `UPDATE ai_invoice_imports
        SET supplier_id=$1,
            supplier_confirmation=NULL,
            error_message=NULL,
            updated_at=now()
      WHERE id=$2 AND workspace_owner_id=$3 AND entity_id=$4
        AND supplier_id=$5
      RETURNING supplier_id`;
  const updateParams = invoice.supplier_id == null
    ? [supplierId, invoice.id, workspaceOwnerId, invoice.entity_id]
    : [supplierId, invoice.id, workspaceOwnerId, invoice.entity_id, invoice.supplier_id];
  const updated = await queryable.query<{ supplier_id: number }>(
    updateSql,
    updateParams,
  );

  if (!updated.rowCount) {
    return { status: "unresolved", invoice };
  }

  return {
    status: "recovered",
    supplier_id: supplierId,
    invoice: { ...invoice, supplier_id: supplierId },
  };
}