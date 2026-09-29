import type { PoolClient } from "pg";
import { db } from "./db";

export type OrderContact = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
  source?: string | null;
};

type DbExecutor = Pick<typeof db, "query"> | PoolClient;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  return digits;
}

type CustomerRow = { id: number };

/**
 * Find or create a customer row keyed on (workspace, normalized email).
 * Falls back to (workspace, normalized phone) if no email is present.
 * Returns null if neither identifier is available.
 */
export async function upsertCustomerFromOrder(
  workspaceOwnerId: string,
  contact: OrderContact,
  exec: DbExecutor = db,
): Promise<number | null> {
  const email = normalizeEmail(contact.email ?? null);
  const phone = normalizePhone(contact.phone ?? null);
  if (!email && !phone) return null;

  const firstName = contact.firstName?.trim() || null;
  const lastName = contact.lastName?.trim() || null;
  const country = contact.country?.trim() || null;
  const city = contact.city?.trim() || null;
  const source = contact.source?.trim() || null;

  if (email) {
    // Email-first matching: insert or update on (workspace, email).
    const r = await exec.query<CustomerRow>(
      `INSERT INTO customers
         (workspace_owner_id, first_name, last_name, email, phone, country, city, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (workspace_owner_id, email)
         WHERE email IS NOT NULL
         DO UPDATE SET
           first_name = COALESCE(customers.first_name, EXCLUDED.first_name),
           last_name  = COALESCE(customers.last_name,  EXCLUDED.last_name),
           phone      = COALESCE(customers.phone,      EXCLUDED.phone),
           country    = COALESCE(EXCLUDED.country,     customers.country),
           city       = COALESCE(EXCLUDED.city,        customers.city),
           source     = COALESCE(customers.source,     EXCLUDED.source),
           updated_at = now()
       RETURNING id`,
      [workspaceOwnerId, firstName, lastName, email, phone, country, city, source],
    );
    return r.rows[0]?.id ?? null;
  }

  // Phone-only fallback: try to find an existing customer in this workspace
  // by phone, otherwise create a new row.
  const existing = await exec.query<CustomerRow>(
    `SELECT id FROM customers
      WHERE workspace_owner_id = $1 AND phone = $2
      ORDER BY created_at ASC LIMIT 1`,
    [workspaceOwnerId, phone],
  );
  if (existing.rows[0]) {
    await exec.query(
      `UPDATE customers
          SET first_name = COALESCE(first_name, $2),
              last_name  = COALESCE(last_name,  $3),
              country    = COALESCE($4, country),
              city       = COALESCE($5, city),
              updated_at = now()
        WHERE id = $1`,
      [existing.rows[0].id, firstName, lastName, country, city],
    );
    return existing.rows[0].id;
  }
  const inserted = await exec.query<CustomerRow>(
    `INSERT INTO customers
       (workspace_owner_id, first_name, last_name, email, phone, country, city, source, updated_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7, now())
     RETURNING id`,
    [workspaceOwnerId, firstName, lastName, phone, country, city, source],
  );
  return inserted.rows[0]?.id ?? null;
}

/**
 * Recompute total_orders, total_spent, and last_order_at for a customer.
 * Orders are managed in the native orders table.
 * This function is a no-op placeholder reserved for future aggregate computation.
 */
export async function recomputeCustomerAggregates(
  _customerId: number,
  _exec: DbExecutor = db,
): Promise<void> {
  // No-op: aggregates are computed on demand from the native orders table.
}
