import { db } from "./db";

const MUTATION_TABLES = [
  "products",
  "workspace_members",
  "ai_invoice_imports",
  "ai_invoice_import_sync_attempts",
  "supplier_invoices",
  "cash_sessions",
  "cash_activity_audit_log",
  "order_florist_assignments",
  "web_events",
] as const;

type DatabaseModeRow = {
  is_replica: boolean;
  transaction_read_only: string;
};

type PrivilegeRow = {
  table_name: string;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

/**
 * Prove that startup is connected to a writable PostgreSQL primary and that the
 * deployed role has mutation privileges on representative shared write tables.
 * The SQL write-stage probes affect zero rows and the transaction is always
 * rolled back, so this cannot alter business data.
 */
export async function assertMutationDatabaseReady(): Promise<void> {
  const client = await db.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const mode = await client.query<DatabaseModeRow>(
      `SELECT pg_is_in_recovery() AS is_replica,
              current_setting('transaction_read_only') AS transaction_read_only`,
    );
    const databaseMode = mode.rows[0];
    if (
      !databaseMode ||
      databaseMode.is_replica ||
      databaseMode.transaction_read_only !== "off"
    ) {
      throw new Error(
        "Mutation readiness failed: database connection is read-only or points to a replica.",
      );
    }

    const privileges = await client.query<PrivilegeRow>(
      `SELECT table_name,
              has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS can_delete
         FROM unnest($1::text[]) AS required(table_name)
        ORDER BY table_name`,
      [MUTATION_TABLES],
    );
    const missingPrivileges = privileges.rows.filter(
      (row) => !row.can_insert || !row.can_update || !row.can_delete,
    );
    if (
      privileges.rows.length !== MUTATION_TABLES.length ||
      missingPrivileges.length > 0
    ) {
      const missing = missingPrivileges
        .map((row) => row.table_name)
        .join(", ");
      throw new Error(
        `Mutation readiness failed: deployed database role lacks write privileges${missing ? ` on ${missing}` : ""}.`,
      );
    }

    // Reach PostgreSQL's write execution stage without touching any rows on
    // every representative mutation table.  Privilege checks above can pass
    // while a table is missing (or a role has an unusual RLS/policy setup);
    // preparing these statements makes startup fail closed before traffic is
    // enabled.  `id = id` is deliberately schema-stable and the false
    // predicate guarantees that no row, trigger, or business side effect is
    // reached.  Keep this list in lockstep with MUTATION_TABLES.
    for (const tableName of MUTATION_TABLES) {
      await client.query(`UPDATE "${tableName}" SET id = id WHERE false`);
      await client.query(`DELETE FROM "${tableName}" WHERE false`);
    }
    await client.query(
      `INSERT INTO products (workspace_owner_id, name, price_usd, price_aed)
       SELECT '', '', 0, 0
       WHERE false`,
    );

    await client.query("ROLLBACK");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}