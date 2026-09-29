import { db } from "../db.js";
import type pg from "pg";

export type VerifiedOdooSupplier = {
  id: number;
  name: string;
  taxNumber?: string | null;
};

function normaliseIdentity(value: string | null | undefined): string {
  return String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

/**
 * Resolves one verified Odoo partner to exactly one workspace supplier and
 * links the import to it. The single SQL statement plus partial unique index
 * makes reruns and concurrent bulk workers idempotent.
 */
export async function linkImportedInvoiceToVerifiedOdooSupplier(
  importId: number,
  workspaceOwnerId: string,
  supplier: VerifiedOdooSupplier,
  queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> = db,
): Promise<number> {
  if (!Number.isInteger(supplier.id) || supplier.id <= 0 || !supplier.name.trim()) {
    throw new Error("Verified Odoo supplier identity is incomplete");
  }
  const tax = normaliseIdentity(supplier.taxNumber);
  const name = normaliseIdentity(supplier.name);
  const result = await queryable.query<{ supplier_id: number }>(
    `WITH lock_key AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($2 || ':odoo-supplier:' || $3::integer::text, 0))
     ),
     candidates AS MATERIALIZED (
       SELECT s.id,s.odoo_partner_id,s.is_archived,
              regexp_replace(upper(coalesce(s.tax_number,'')), '[^A-Z0-9]', '', 'g') AS normalized_tax
         FROM suppliers s
         CROSS JOIN lock_key
        WHERE s.workspace_owner_id=$2
          AND (
            s.odoo_partner_id=$3::integer
            OR ($4 <> '' AND regexp_replace(upper(coalesce(s.tax_number,'')), '[^A-Z0-9]', '', 'g')=$4)
            OR regexp_replace(upper(coalesce(s.display_name,s.name)), '[^A-Z0-9]', '', 'g')=$5
          )
     ),
     unique_candidate AS (
       SELECT min(id)::integer AS id
         FROM candidates
         HAVING count(*)=1
           AND bool_and(odoo_partner_id IS NULL OR odoo_partner_id=$3::integer)
           AND bool_and(odoo_partner_id=$3::integer OR $4='' OR normalized_tax IN ('',$4))
     ),
     adopted AS (
       UPDATE suppliers s
           SET odoo_partner_id=$3::integer,
               tax_number=COALESCE(NULLIF($6,''),NULLIF(s.tax_number,'')),
               is_archived=false,
              updated_at=now()
         FROM unique_candidate u
        WHERE s.id=u.id
        RETURNING s.id
     ),
     created AS (
       INSERT INTO suppliers(workspace_owner_id,name,display_name,tax_number,odoo_partner_id,is_archived,created_at,updated_at)
       SELECT $2,$7,$7,NULLIF($6,''),$3::integer,false,now(),now()
         FROM lock_key
         WHERE NOT EXISTS (SELECT 1 FROM adopted)
       ON CONFLICT (workspace_owner_id,odoo_partner_id) WHERE odoo_partner_id IS NOT NULL
       DO UPDATE SET updated_at=now()
       RETURNING id
     ),
     chosen AS (
       SELECT id FROM adopted
       UNION ALL
       SELECT id FROM created
     ),
     linked AS (
       UPDATE ai_invoice_imports i
          SET supplier_id=c.id,updated_at=now()
         FROM chosen c
        WHERE i.id=$1 AND i.workspace_owner_id=$2
        RETURNING c.id AS supplier_id
     )
     SELECT supplier_id FROM linked`,
    [importId, workspaceOwnerId, supplier.id, tax, name, supplier.taxNumber?.trim() ?? "", supplier.name.trim()],
  );
  const supplierId = Number(result.rows[0]?.supplier_id);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw new Error("Verified Odoo supplier could not be linked unambiguously in OS");
  }
  return supplierId;
}