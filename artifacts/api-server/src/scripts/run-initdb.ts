/**
 * Standalone script that runs initDb() against the database pointed to by
 * DATABASE_URL.  Used by test-integration-local.sh to boot a fresh
 * testdb_initdb_check database through initDb alone (no Drizzle push) so that
 * the initDb.schema.integration.test verifies the schema coverage.
 */
import { initDb } from "../lib/initDb.js";
import { db } from "../lib/db.js";

// Historical delivery schedule normalization is deliberately not part of
// startup. Run normalize:delivery-schedules explicitly after reviewing its
// default dry-run report.
await initDb();
await db.end();
console.log("run-initdb: initDb completed successfully");
process.exit(0);
