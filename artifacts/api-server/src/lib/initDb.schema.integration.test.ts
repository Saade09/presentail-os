/**
 * Integration test: verifies that running initDb() against a completely fresh
 * PostgreSQL database (no Drizzle push, no manual DDL) creates every table
 * and every index that the Drizzle schema in lib/db/src/schema/* declares.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * initDb.ts is the sole migration mechanism for production deployments.
 * Drizzle push is never run in production.  When a developer adds a new table
 * or index to lib/db/src/schema/* but forgets to add the corresponding DDL
 * block in initDb.ts, production deployments start up missing those objects.
 * This test catches that drift before it ships.
 *
 * HOW IT WORKS
 * ────────────
 * A second throwaway database (testdb_initdb_check) is initialised by running
 * run-initdb.ts against it — no Drizzle push involved.  INITDB_CHECK_DATABASE_URL
 * is set to that database's connection string.
 *
 * Locally:  test-integration-local.sh creates the second database, runs
 *           run-initdb.ts, and exports INITDB_CHECK_DATABASE_URL before
 *           invoking vitest.
 *
 * CI:       .github/workflows/ci.yml creates testdb_initdb_check using psql,
 *           runs run-initdb.ts, and passes INITDB_CHECK_DATABASE_URL to the
 *           test:integration step.
 *
 * The expected table list is derived programmatically by importing all exports
 * from @workspace/db/schema and filtering for PgTable objects, and the expected
 * index list is derived by parsing the schema source files for index() /
 * uniqueIndex() calls — so no manual list maintenance is required when a new
 * table or index is added.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";
import { is, getTableName, getTableColumns } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import {
  applyNormalization,
  buildNormalizationReport,
} from "../scripts/normalize-order-delivery-schedules";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INITDB_CHECK_DATABASE_URL = process.env.INITDB_CHECK_DATABASE_URL;

/**
 * Every table name exported from lib/db/src/schema/*.
 * Derived automatically by inspecting each export — when you add a new
 * pgTable() definition there, it is automatically included here without any
 * manual update required.
 */
const DRIZZLE_SCHEMA_TABLES: string[] = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableName(t));

/**
 * Every index name declared via index("…") or uniqueIndex("…") in the Drizzle
 * schema source files.  Derived by static text parsing so that adding a new
 * index() call automatically includes it without any manual list update.
 */
const SCHEMA_DIR = join(__dirname, "../../../../lib/db/src/schema");
const schemaSource = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(SCHEMA_DIR, f), "utf-8"))
  .join("\n");

const SCHEMA_INDEXES: string[] = [
  ...new Set(
    [...schemaSource.matchAll(/(?:uniqueIndex|index)\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1]!,
    ),
  ),
];

// Recipe-intelligence foreign keys are intentionally workspace-scoped. These
// parent constraints must remain composite and unique so the publish diff
// recognizes them as prerequisites for the dependent foreign keys.
const RECIPE_INTELLIGENCE_PARENT_KEYS = [
  {
    tableName: "products",
    constraintName: "recipe_intelligence_products_workspace_id_unique",
  },
  {
    tableName: "base_items",
    constraintName: "recipe_intelligence_base_items_workspace_id_unique",
  },
] as const;

/**
 * Map of table name → set of DB column names, derived automatically from the
 * Drizzle schema exports.  When a developer adds a column to a pgTable()
 * definition in lib/db/src/schema/*, it is included here without any manual
 * update — so the column-parity checks below pick it up for free.
 */
const DRIZZLE_TABLE_COLUMNS: Map<string, string[]> = new Map(
  (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => [
      getTableName(t),
      Object.values(getTableColumns(t)).map((c) => c.name),
    ]),
);

/**
 * High-traffic tables whose columns are individually verified against the
 * initDb-created database.  The Purchase Order create endpoint once 500'd in
 * production because columns existed in the Drizzle schema and were used by
 * route code, but were never added to initDb.ts — and integration tests build
 * their DB via Drizzle push, so they could not catch the drift.  These
 * column-level parity checks (run against an initDb-only database) close that
 * gap for the tables most likely to be touched.
 *
 * Add a table here when its columns are written/read by hot path route code and
 * you want a guarantee that every Drizzle column is also created by initDb.ts.
 */
const COLUMN_PARITY_TABLES = [
  "ai_usage_log",
  "orders",
  "order_card_messages",
  "purchase_orders",
  "purchase_order_line_items",
  "base_item_stock_adjustments",
  "base_item_location_statuses",
  "base_item_ledger_settings",
  "wastage_records",
] as const;

const PUBLISH_PRESERVED_COLUMN_CONTRACTS = [
  {
    tableName: "products",
    columns: [
      "image_display_public_path",
      "image_thumbnail_public_path",
      "additional_image_display_public_paths",
      "additional_image_thumbnail_public_paths",
    ],
  },
  {
    tableName: "address_collection_inbound_messages",
    columns: [
      "attempt_count",
      "processing_started_at",
      "next_attempt_at",
      "claim_token",
    ],
  },
] as const;

describe.skipIf(!INITDB_CHECK_DATABASE_URL)(
  "initDb schema coverage — every Drizzle table and index is created by initDb on a fresh database",
  () => {
    let pool: InstanceType<typeof Pool>;
    let existingTables: Set<string>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: INITDB_CHECK_DATABASE_URL });

      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type   = 'BASE TABLE'`,
      );

      existingTables = new Set(result.rows.map((r) => r.table_name));
    });

    afterAll(async () => {
      if (pool) await pool.end();
    });

    it("DRIZZLE_SCHEMA_TABLES is non-empty (schema import sanity check)", () => {
      expect(DRIZZLE_SCHEMA_TABLES.length).toBeGreaterThan(0);
    });

    it("SCHEMA_INDEXES is non-empty (schema source sanity check)", () => {
      expect(SCHEMA_INDEXES.length).toBeGreaterThan(0);
    });

    // ─── Table existence checks ───────────────────────────────────────────────

    for (const tableName of DRIZZLE_SCHEMA_TABLES) {
      it(`table "${tableName}" exists after initDb`, () => {
        expect(
          existingTables.has(tableName),
          `Table "${tableName}" is defined in lib/db/src/schema/* but was NOT ` +
          `created by initDb.ts on a fresh database.\n` +
          `Add a "CREATE TABLE IF NOT EXISTS ${tableName} ..." block to ` +
          `artifacts/api-server/src/lib/initDb.ts to fix this.`,
        ).toBe(true);
      });
    }

    // ─── Index existence checks (derived from schema source) ─────────────────

    it("all schema-declared indexes exist in pg_indexes (aggregate report)", async () => {
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname  = ANY($1)`,
        [SCHEMA_INDEXES],
      );

      const foundIndexes = new Set(result.rows.map((r) => r.indexname));
      const missingIndexes = SCHEMA_INDEXES.filter((idx) => !foundIndexes.has(idx));

      expect(
        missingIndexes,
        `The following schema-declared indexes are missing from the fresh initDb database:\n` +
        missingIndexes.map((i) => `  - ${i}`).join("\n") +
        `\nEnsure initDb.ts creates these indexes with CREATE [UNIQUE] INDEX IF NOT EXISTS.`,
      ).toHaveLength(0);
    });

    for (const indexName of SCHEMA_INDEXES) {
      it(`index "${indexName}" exists after initDb`, async () => {
        const result = await pool.query<{ indexname: string }>(
          `SELECT indexname
             FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname  = $1`,
          [indexName],
        );
        expect(
          result.rowCount,
          `Index "${indexName}" is declared in a Drizzle schema index() / uniqueIndex() ` +
          `call but was NOT created by initDb.ts. Add a ` +
          `"CREATE [UNIQUE] INDEX IF NOT EXISTS ${indexName} ..." ` +
          `block to initDb.ts.`,
        ).toBe(1);
      });
    }

    it("serializes concurrent weekly-slot identities and keeps restart seeding idempotent", async () => {
      const suffix = `${process.pid}_${Date.now()}`;
      const ownerId = `weekly_slot_guard_${suffix}`;
      const city = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug)
         VALUES ($1, 'LB', 'Weekly slot guard city', $2)
         RETURNING id`,
        [ownerId, `weekly-slot-guard-${suffix}`],
      );
      const cityId = city.rows[0].id;
      const repoRoot = join(__dirname, "../../../..");
      const runInitDbAsync = () =>
        new Promise<{ status: number | null; output: string }>((resolve, reject) => {
          const child = spawn(
            "pnpm",
            ["--filter", "@workspace/api-server", "exec", "tsx", "./src/scripts/run-initdb.ts"],
            {
              cwd: repoRoot,
              env: { ...process.env, DATABASE_URL: INITDB_CHECK_DATABASE_URL },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk) => { output += String(chunk); });
          child.stderr.on("data", (chunk) => { output += String(chunk); });
          child.on("error", reject);
          child.on("close", (status) => resolve({ status, output }));
        });

      const concurrentRuns = await Promise.all([runInitDbAsync(), runInitDbAsync()]);
      for (const run of concurrentRuns) {
        expect(run.status, `concurrent initDb failed:\n${run.output}`).toBe(0);
      }
      const firstCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM district_weekly_delivery_slots
          WHERE city_id = $1`,
        [cityId],
      );
      expect(Number(firstCount.rows[0]?.count)).toBe(25);

      const restartRun = await runInitDbAsync();
      expect(
        restartRun.status,
        `initDb restart run failed:\n${restartRun.output}`,
      ).toBe(0);
      const restartCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM district_weekly_delivery_slots
          WHERE city_id = $1`,
        [cityId],
      );
      expect(Number(restartCount.rows[0]?.count)).toBe(25);

      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      try {
        await firstClient.query("BEGIN");
        await secondClient.query("BEGIN");
        await firstClient.query(
          `INSERT INTO district_weekly_delivery_slots
             (city_id, workspace_owner_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, 0, '9:00', '10:00')`,
          [cityId, ownerId],
        );

        const concurrentInsert = secondClient.query(
          `INSERT INTO district_weekly_delivery_slots
             (city_id, workspace_owner_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, 0, '09:00', '10:00')`,
          [cityId, ownerId],
        );
        await firstClient.query("COMMIT");
        await expect(concurrentInsert).rejects.toMatchObject({
          code: "23505",
          constraint: "uq_dwds_natural_key",
        });
        await secondClient.query("ROLLBACK");
      } finally {
        await firstClient.query("ROLLBACK").catch(() => {});
        await secondClient.query("ROLLBACK").catch(() => {});
        firstClient.release();
        secondClient.release();
        await pool.query(
          `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
          [ownerId],
        );
      }
    }, 300_000);

    it("guards one active contact-address association per contact and Place", async () => {
      const result = await pool.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'idx_contact_addresses_active_contact_place'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/i);
      expect(result.rows[0]?.indexdef).toMatch(
        /workspace_owner_id, contact_id, place_id/i,
      );
      expect(result.rows[0]?.indexdef).toMatch(
        /archived_at IS NULL.*place_id IS NOT NULL/i,
      );
    });

    it("creates unique composite parent constraints for recipe intelligence foreign keys", async () => {
      const result = await pool.query<{
        table_name: string;
        constraint_name: string;
        index_name: string;
        definition: string;
      }>(
        `SELECT table_ref.relname AS table_name,
                constraint_ref.conname AS constraint_name,
                index_ref.relname AS index_name,
                pg_get_constraintdef(constraint_ref.oid) AS definition
           FROM pg_constraint AS constraint_ref
           JOIN pg_class AS table_ref ON table_ref.oid = constraint_ref.conrelid
           JOIN pg_class AS index_ref ON index_ref.oid = constraint_ref.conindid
          WHERE constraint_ref.contype = 'u'
            AND constraint_ref.conname = ANY($1)`,
        [RECIPE_INTELLIGENCE_PARENT_KEYS.map((key) => key.constraintName)],
      );
      const found = new Map(
        result.rows.map((row) => [row.constraint_name, row]),
      );

      for (const expected of RECIPE_INTELLIGENCE_PARENT_KEYS) {
        expect(found.get(expected.constraintName)).toMatchObject({
          table_name: expected.tableName,
          index_name: expected.constraintName,
          definition: "UNIQUE (workspace_owner_id, id)",
        });
      }
    });

    // ─── Column parity checks — high-traffic tables ──────────────────────────
    //
    // WHY THESE CHECKS EXIST
    // ──────────────────────
    // The Purchase Order create endpoint 500'd in production because columns
    // existed in the Drizzle schema (and were written by route code) but were
    // never added to initDb.ts — the real DDL source for dev + prod.  Drizzle
    // push builds the integration DB, so the regular integration suite could not
    // catch this drift.  These checks compare the Drizzle-declared columns for a
    // curated set of hot-path tables against information_schema.columns on the
    // initDb-only database, failing if any schema column is missing from the
    // initDb-created table.

    it("column-parity tables are all known to the Drizzle schema (sanity check)", () => {
      const unknownTables = COLUMN_PARITY_TABLES.filter(
        (t) => !DRIZZLE_TABLE_COLUMNS.has(t),
      );
      expect(
        unknownTables,
        `These COLUMN_PARITY_TABLES are not exported from lib/db/src/schema/*:\n` +
        unknownTables.map((t) => `  - ${t}`).join("\n") +
        `\nRemove them from COLUMN_PARITY_TABLES or fix the table name.`,
      ).toHaveLength(0);
    });

    for (const tableName of COLUMN_PARITY_TABLES) {
      const expectedColumns = DRIZZLE_TABLE_COLUMNS.get(tableName) ?? [];

      it(`every Drizzle column on "${tableName}" exists after initDb`, async () => {
        const result = await pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name   = $1`,
          [tableName],
        );
        const found = new Set(result.rows.map((r) => r.column_name));
        const missing = expectedColumns.filter((c) => !found.has(c));

        expect(
          missing,
          `The following column(s) are declared on the "${tableName}" Drizzle ` +
          `table but were NOT created by initDb.ts on a fresh database:\n` +
          missing.map((c) => `  - ${c}`).join("\n") +
          `\n\ninitDb.ts is the real DDL source for dev + prod (Drizzle push is ` +
          `never run in production).  Add a "CREATE TABLE … ${tableName}" column ` +
          `or an "ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS …" block to ` +
          `artifacts/api-server/src/lib/initDb.ts for each missing column.`,
        ).toHaveLength(0);
      });
    }

    it("preserves publish-critical product media and inbound-reply columns", async () => {
      for (const contract of PUBLISH_PRESERVED_COLUMN_CONTRACTS) {
        const result = await pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = $1
              AND column_name = ANY($2)`,
          [contract.tableName, contract.columns],
        );
        const found = new Set(result.rows.map((row) => row.column_name));
        const missing = contract.columns.filter((column) => !found.has(column));

        expect(
          missing,
          `The following publish-critical columns are missing from the ` +
          `initDb-created "${contract.tableName}" table:\n` +
          missing.map((column) => `  - ${column}`).join("\n"),
        ).toHaveLength(0);
      }
    });

    // ─── Sentinel column checks — workspace_members ───────────────────────────
    //
    // WHY THESE CHECKS EXIST
    // ──────────────────────
    // A real silent bug was found where `user_id` was used in a query instead
    // of `member_user_id`, causing every workspace lookup to return 0 rows
    // (404s in production) without any error.  These integration-level checks
    // query information_schema.columns against the initDb-created database to
    // give a runtime guarantee that the column names live query code depends on
    // actually exist in the real schema — not just in the DDL source text.
    //
    // They complement the static drift check in initDb.drift.test.ts (which
    // catches the same drift without a DB connection) by providing a second,
    // independent verification path using real database metadata.

    const WORKSPACE_MEMBERS_SENTINEL_COLUMNS = [
      "member_user_id",
      "member_email",
      "manager_member_id",
      "invited_by_email",
      "invite_token",
      "invite_expires_at",
    ] as const;

    it("workspace_members sentinel columns all exist (aggregate report)", async () => {
      const result = await pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'workspace_members'
            AND column_name  = ANY($1)`,
        [WORKSPACE_MEMBERS_SENTINEL_COLUMNS as unknown as string[]],
      );
      const found = new Set(result.rows.map((r) => r.column_name));
      const missing = WORKSPACE_MEMBERS_SENTINEL_COLUMNS.filter((c) => !found.has(c));
      expect(
        missing,
        `The following column(s) are missing from workspace_members in the ` +
        `initDb-created database:\n` +
        missing.map((c) => `  - ${c}`).join("\n") +
        `\n\nEither the column was dropped/renamed in initDb.ts, or the ` +
        `ALTER TABLE ADD COLUMN block is missing.  Live query code depends on ` +
        `these names — update initDb.ts and any affected query sites together.`,
      ).toHaveLength(0);
    });

    for (const column of WORKSPACE_MEMBERS_SENTINEL_COLUMNS) {
      it(`workspace_members column "${column}" exists after initDb`, async () => {
        const result = await pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name   = 'workspace_members'
              AND column_name  = $1`,
          [column],
        );
        expect(
          result.rowCount,
          `Column "${column}" is missing from workspace_members in the ` +
          `initDb-created database.\n` +
          `Either the column was dropped/renamed in initDb.ts, or the ` +
          `ALTER TABLE ADD COLUMN block is missing.  Live query code depends on ` +
          `this column name — update initDb.ts and any affected query sites together.`,
        ).toBe(1);
      });
    }

    it("creates the unique Apple identity mapping contract", async () => {
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='apple_identities'`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining([
          "apple_subject",
          "clerk_user_id",
          "linked_email",
          "last_signed_in_at",
        ]),
      );
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname='public' AND tablename='apple_identities'`,
      );
      expect(indexes.rows.some((row) =>
        row.indexdef.includes("UNIQUE") && row.indexdef.includes("(clerk_user_id)"),
      )).toBe(true);
    });

    it("creates the single-use Apple authentication challenge store", async () => {
      const result = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='apple_auth_challenges'`,
      );
      expect(result.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(["nonce_hash", "expires_at"]),
      );
    });

    it(
      "canonical UOM seed and supplier-pricing backfill are idempotent and non-destructive",
      async () => {
        const suffix = `${process.pid}_${Date.now()}`;
        const workspaceA = `uom_ws_a_${suffix}`;
        const workspaceB = `uom_ws_b_${suffix}`;
        const workspaces = [workspaceA, workspaceB];
        const rowWorkspaces = [workspaceA, workspaceA, workspaceB];
        const baseItemIds: number[] = [];
        const supplierIds: number[] = [];

        try {
          for (let i = 0; i < rowWorkspaces.length; i++) {
            const workspaceOwnerId = rowWorkspaces[i];
            const baseItem = await pool.query<{ id: number }>(
              `INSERT INTO base_items (workspace_owner_id, name, code)
               VALUES ($1, $2, $3)
               RETURNING id`,
              [workspaceOwnerId, `UOM test item ${i}`, `UOM-${suffix}-${i}`],
            );
            const supplier = await pool.query<{ id: number }>(
              `INSERT INTO suppliers (workspace_owner_id, name)
               VALUES ($1, $2)
               RETURNING id`,
              [workspaceOwnerId, `UOM test supplier ${i}`],
            );
            baseItemIds.push(baseItem.rows[0].id);
            supplierIds.push(supplier.rows[0].id);
          }

          await pool.query(
            `INSERT INTO base_item_suppliers
               (workspace_owner_id, base_item_id, supplier_id, pricing_uom)
             VALUES
               ($1, $2, $3, '  PIECES  '),
               ($1, $4, $5, 'Kilograms'),
               ($6, $7, $8, 'crate')`,
            [
              workspaceA,
              baseItemIds[0],
              supplierIds[0],
              baseItemIds[1],
              supplierIds[1],
              workspaceB,
              baseItemIds[2],
              supplierIds[2],
            ],
          );

          const repoRoot = join(__dirname, "../../../..");
          const rerunInitDb = () =>
            spawnSync(
              "pnpm",
              ["--filter", "@workspace/api-server", "exec", "tsx", "./src/scripts/run-initdb.ts"],
              {
                cwd: repoRoot,
                env: { ...process.env, DATABASE_URL: INITDB_CHECK_DATABASE_URL },
                encoding: "utf8",
                timeout: 120_000,
                maxBuffer: 10 * 1024 * 1024,
              },
            );

          const firstRun = rerunInitDb();
          expect(
            firstRun.status,
            `initDb rerun failed:\n${firstRun.stdout}\n${firstRun.stderr}`,
          ).toBe(0);

          const rowsAfterFirstRun = await pool.query<{
            workspace_owner_id: string;
            pricing_uom: string;
            pricing_uom_code: string | null;
          }>(
            `SELECT workspace_owner_id, pricing_uom, pricing_uom_code
               FROM base_item_suppliers
              WHERE workspace_owner_id = ANY($1)
              ORDER BY id`,
            [workspaces],
          );
          expect(rowsAfterFirstRun.rows).toEqual([
            {
              workspace_owner_id: workspaceA,
              pricing_uom: "  PIECES  ",
              pricing_uom_code: "piece",
            },
            {
              workspace_owner_id: workspaceA,
              pricing_uom: "Kilograms",
              pricing_uom_code: "kg",
            },
            {
              workspace_owner_id: workspaceB,
              pricing_uom: "crate",
              pricing_uom_code: null,
            },
          ]);

          const secondRun = rerunInitDb();
          expect(
            secondRun.status,
            `second initDb rerun failed:\n${secondRun.stdout}\n${secondRun.stderr}`,
          ).toBe(0);

          const seeded = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM uom_catalog
              WHERE code = ANY($1)`,
            [[
              "piece", "stem", "bunch", "pack", "box", "kg", "g",
              "liter", "ml", "meter", "cm", "set", "pair", "dozen",
            ]],
          );
          expect(Number(seeded.rows[0].count)).toBe(14);

          await expect(
            pool.query(
              `UPDATE base_item_suppliers
                  SET pricing_uom_code = 'not-a-real-code'
                WHERE workspace_owner_id = $1`,
              [workspaceB],
            ),
          ).rejects.toMatchObject({ code: "23503" });
        } finally {
          await pool.query(
            `DELETE FROM base_item_suppliers WHERE workspace_owner_id = ANY($1)`,
            [workspaces],
          );
          await pool.query(`DELETE FROM base_items WHERE id = ANY($1)`, [baseItemIds]);
          await pool.query(`DELETE FROM suppliers WHERE id = ANY($1)`, [supplierIds]);
        }
      },
      180_000,
    );

    it(
      "upgrades a legacy Search Console connection-only database without deleting its encrypted connection",
      async () => {
        const suffix = `${process.pid}_${Date.now()}`;
        const workspaceOwnerId = `gsc_legacy_${suffix}`;
        const legacySiteUrl = `https://legacy-${suffix}.example.com/`;
        const legacyEncryptedCredentials = `legacy-encrypted-credentials-${suffix}`;
        const legacyState = `legacy-state-${suffix}`;
        const repoRoot = join(__dirname, "../../../..");
        const rerunInitDb = () =>
          spawnSync(
            "pnpm",
            ["--filter", "@workspace/api-server", "exec", "tsx", "./src/scripts/run-initdb.ts"],
            {
              cwd: repoRoot,
              env: { ...process.env, DATABASE_URL: INITDB_CHECK_DATABASE_URL },
              encoding: "utf8",
              timeout: 120_000,
              maxBuffer: 10 * 1024 * 1024,
            },
          );

        try {
          // Simulate the restored schema from before workspace OAuth overrides
          // and callback-state records existed. The legacy connection itself
          // must survive the additive bootstrap unchanged.
          await pool.query(`DROP TABLE IF EXISTS search_console_oauth_states`);
          await pool.query(`DROP TABLE IF EXISTS search_console_oauth_config`);
          await pool.query(
            `INSERT INTO search_console_connections
               (workspace_owner_id, site_url, credentials_encrypted)
             VALUES ($1, $2, $3)`,
            [workspaceOwnerId, legacySiteUrl, legacyEncryptedCredentials],
          );

          const firstRun = rerunInitDb();
          expect(
            firstRun.status,
            `legacy Search Console upgrade failed:\n${firstRun.stdout}\n${firstRun.stderr}`,
          ).toBe(0);
          const secondRun = rerunInitDb();
          expect(
            secondRun.status,
            `repeat legacy Search Console upgrade failed:\n${secondRun.stdout}\n${secondRun.stderr}`,
          ).toBe(0);

          const connection = await pool.query<{
            site_url: string;
            credentials_encrypted: string;
          }>(
            `SELECT site_url, credentials_encrypted
               FROM search_console_connections
              WHERE workspace_owner_id = $1`,
            [workspaceOwnerId],
          );
          expect(connection.rows).toEqual([{
            site_url: legacySiteUrl,
            credentials_encrypted: legacyEncryptedCredentials,
          }]);

          const storage = await pool.query<{
            table_name: string;
            column_name: string;
          }>(
            `SELECT table_name, column_name
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = ANY($1)
              ORDER BY table_name, column_name`,
            [[
              "search_console_oauth_config",
              "search_console_oauth_states",
            ]],
          );
          expect(storage.rows).toEqual(expect.arrayContaining([
            {
              table_name: "search_console_oauth_config",
              column_name: "workspace_owner_id",
            },
            {
              table_name: "search_console_oauth_config",
              column_name: "oauth_client_encrypted",
            },
            {
              table_name: "search_console_oauth_states",
              column_name: "state",
            },
            {
              table_name: "search_console_oauth_states",
              column_name: "expires_at",
            },
          ]));

          const indexes = await pool.query<{ indexname: string }>(
            `SELECT indexname
               FROM pg_indexes
              WHERE schemaname = 'public'
                AND indexname = ANY($1)`,
            [[
              "idx_search_console_oauth_config_unique",
              "idx_search_console_oauth_states_expires_at",
            ]],
          );
          expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
            "idx_search_console_oauth_config_unique",
            "idx_search_console_oauth_states_expires_at",
          ]);

          await pool.query(
            `INSERT INTO search_console_oauth_config
               (workspace_owner_id, oauth_client_encrypted)
             VALUES ($1, $2)`,
            [workspaceOwnerId, `workspace-oauth-client-${suffix}`],
          );
          await expect(
            pool.query(
              `INSERT INTO search_console_oauth_config
                 (workspace_owner_id, oauth_client_encrypted)
               VALUES ($1, $2)`,
              [workspaceOwnerId, `duplicate-workspace-oauth-client-${suffix}`],
            ),
          ).rejects.toMatchObject({ code: "23505" });

          await pool.query(
            `INSERT INTO search_console_oauth_states
               (state, workspace_owner_id, expires_at)
             VALUES ($1, $2, now() + INTERVAL '10 minutes')`,
            [legacyState, workspaceOwnerId],
          );
          const consumed = await pool.query<{ workspace_owner_id: string }>(
            `DELETE FROM search_console_oauth_states
              WHERE state = $1 AND expires_at > now()
              RETURNING workspace_owner_id`,
            [legacyState],
          );
          expect(consumed.rows).toEqual([{ workspace_owner_id: workspaceOwnerId }]);
          const replay = await pool.query(
            `DELETE FROM search_console_oauth_states
              WHERE state = $1 AND expires_at > now()
              RETURNING workspace_owner_id`,
            [legacyState],
          );
          expect(replay.rowCount).toBe(0);
        } finally {
          await pool.query(
            `DELETE FROM search_console_oauth_states WHERE workspace_owner_id = $1`,
            [workspaceOwnerId],
          ).catch(() => {});
          await pool.query(
            `DELETE FROM search_console_oauth_config WHERE workspace_owner_id = $1`,
            [workspaceOwnerId],
          ).catch(() => {});
          await pool.query(
            `DELETE FROM search_console_connections WHERE workspace_owner_id = $1`,
            [workspaceOwnerId],
          ).catch(() => {});
        }
      },
      300_000,
    );

    it(
      "normalizes legacy order schedules safely against PostgreSQL",
      async () => {
        const suffix = `${process.pid}_${Date.now()}`;
        const workspaceOwnerId = `schedule_normalization_${suffix}`;
        const orderIds = new Map<string, string>();

        const seedCity = async (name: string, slug: string): Promise<number> => {
          const result = await pool.query<{ id: number }>(
            `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug)
             VALUES ($1, 'LB', $2, $3)
             RETURNING id`,
            [workspaceOwnerId, name, slug],
          );
          const id = result.rows[0]?.id;
          if (id === undefined) throw new Error(`Failed to seed city ${name}`);
          return id;
        };

        const seedOrder = async (
          caseName: string,
          deliveryAddress: Record<string, unknown>,
          windows: { start?: string; end?: string } = {},
        ): Promise<void> => {
          const result = await pool.query<{ id: string }>(
            `INSERT INTO orders
               (workspace_owner_id, source, status, delivery_address,
                window_start, window_end)
             VALUES ($1, 'integration-test', 'pending', $2::jsonb, $3::timestamptz, $4::timestamptz)
             RETURNING id`,
            [
              workspaceOwnerId,
              JSON.stringify({ ...deliveryAddress, test_case: caseName }),
              windows.start ?? null,
              windows.end ?? null,
            ],
          );
          const id = result.rows[0]?.id;
          if (!id) throw new Error(`Failed to seed order ${caseName}`);
          orderIds.set(caseName, id);
        };

        const snapshot = async () => {
          const result = await pool.query<{
            id: string;
            window_start: string | null;
            window_end: string | null;
            updated_at: string;
          }>(
            `SELECT id, window_start::text, window_end::text, updated_at::text
               FROM orders
              WHERE workspace_owner_id = $1
              ORDER BY id`,
            [workspaceOwnerId],
          );
          return result.rows;
        };

        try {
          const exactCityId = await seedCity(
            "Schedule normalization exact city",
            `schedule-normalization-exact-${suffix}`,
          );
          await seedCity(
            "Schedule normalization ambiguous city",
            `schedule-normalization-ambiguous-a-${suffix}`,
          );
          await seedCity(
            "Schedule normalization ambiguous city",
            `schedule-normalization-ambiguous-b-${suffix}`,
          );

          await seedOrder("day-range", {
            cityId: String(exactCityId),
            date: "2026-08-29",
            slot: "09:00 - 11:00",
          });
          await seedOrder("overnight-range", {
            cityId: String(exactCityId),
            date: "2026-08-29",
            slot: "11:00 PM - 1:00 AM",
          });
          await seedOrder("named-slot", {
            cityId: String(exactCityId),
            date: "2026-08-29",
            slot: "morning",
          });
          await seedOrder("malformed-date", {
            cityId: String(exactCityId),
            date: "2026-02-30",
            slot: "10:00 - 12:00",
          });
          await seedOrder("ambiguous-city", {
            cityName: "Schedule normalization ambiguous city",
            date: "2026-08-29",
            slot: "10:00 - 12:00",
          });
          await seedOrder(
            "partial-canonical-window",
            {
              cityId: String(exactCityId),
              date: "2026-08-29",
              slot: "1:00 PM - 2:00 PM",
            },
            { start: "2026-08-29T13:00:00.000Z" },
          );

          const beforeDryRun = await snapshot();
          const dryRun = await buildNormalizationReport(pool, {
            mode: "dry-run",
            workspaceOwnerId,
          });
          expect(dryRun.mode).toBe("dry-run");
          expect(dryRun.summary).toMatchObject({
            candidate_rows: 5,
            valid_rows: 2,
            invalid_rows: 1,
            ambiguous_rows: 2,
            migrated_rows: 0,
            skipped_due_to_concurrent_change: 0,
          });
          expect(new Set(dryRun.decisions.map((decision) => decision.order_id))).toEqual(
            new Set([
              orderIds.get("day-range"),
              orderIds.get("overnight-range"),
              orderIds.get("named-slot"),
              orderIds.get("malformed-date"),
              orderIds.get("ambiguous-city"),
            ]),
          );
          expect(
            dryRun.decisions.find((decision) => decision.order_id === orderIds.get("named-slot")),
          ).toMatchObject({
            classification: "ambiguous",
            reasons: ["named_slot_has_no_exact_window"],
          });
          expect(
            dryRun.decisions.find((decision) => decision.order_id === orderIds.get("malformed-date")),
          ).toMatchObject({
            classification: "invalid",
            reasons: ["malformed_date"],
          });
          expect(
            dryRun.decisions.find((decision) => decision.order_id === orderIds.get("ambiguous-city")),
          ).toMatchObject({
            classification: "ambiguous",
            reasons: ["delivery_city_is_ambiguous"],
          });
          expect(await snapshot()).toEqual(beforeDryRun);

          const applyInput = await buildNormalizationReport(pool, {
            mode: "apply",
            workspaceOwnerId,
          });
          const applied = await applyNormalization(pool, applyInput);
          expect(applied.mode).toBe("apply");
          expect(applied.summary).toMatchObject({
            candidate_rows: 5,
            valid_rows: 2,
            invalid_rows: 1,
            ambiguous_rows: 2,
            migrated_rows: 2,
            skipped_due_to_concurrent_change: 0,
          });

          const afterApply = await snapshot();
          const appliedRows = new Map(afterApply.map((row) => [row.id, row]));
          expect(appliedRows.get(orderIds.get("day-range")!)).toMatchObject({
            window_start: "2026-08-29 09:00:00+00",
            window_end: "2026-08-29 11:00:00+00",
          });
          expect(appliedRows.get(orderIds.get("overnight-range")!)).toMatchObject({
            window_start: "2026-08-29 23:00:00+00",
            window_end: "2026-08-30 01:00:00+00",
          });
          for (const caseName of [
            "named-slot",
            "malformed-date",
            "ambiguous-city",
            "partial-canonical-window",
          ]) {
            expect(appliedRows.get(orderIds.get(caseName)!)).toMatchObject({
              window_start:
                caseName === "partial-canonical-window"
                  ? "2026-08-29 13:00:00+00"
                  : null,
              window_end: null,
            });
          }

          const secondApplyInput = await buildNormalizationReport(pool, {
            mode: "apply",
            workspaceOwnerId,
          });
          expect(secondApplyInput.summary).toMatchObject({
            candidate_rows: 3,
            valid_rows: 0,
            invalid_rows: 1,
            ambiguous_rows: 2,
          });
          const secondApplied = await applyNormalization(pool, secondApplyInput);
          expect(secondApplied.summary).toMatchObject({
            migrated_rows: 0,
            skipped_due_to_concurrent_change: 0,
          });
          expect(await snapshot()).toEqual(afterApply);
        } finally {
          await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [workspaceOwnerId]);
          await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [workspaceOwnerId]);
        }
      },
      120_000,
    );

    it(
      "repairs only identity-free AI invoice sync rows without violating provider nullability",
      async () => {
        const suffix = `${process.pid}_${Date.now()}`;
        const workspaceOwnerId = `ai_invoice_sync_guard_${suffix}`;
        const invoiceValues = {
          subtotal: "100.0000",
          taxAmount: "11.0000",
          totalAmount: "111.0000",
          currency: "USD",
          lineItems: JSON.stringify([{ description: "Guard item", quantity: 1 }]),
        };

        const entity = await pool.query<{ id: number }>(
          `INSERT INTO finance_entities (workspace_owner_id, legal_name, country, accounting_system)
           VALUES ($1, 'AI invoice sync guard', 'LB', 'odoo')
           RETURNING id`,
          [workspaceOwnerId],
        );
        const entityId = entity.rows[0]!.id;
        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO ai_invoice_imports (
             workspace_owner_id, entity_id, status, review_status, sync_status,
             provider_sync_status, provider_bill_id, provider_bill_url,
             provider_bill_status, provider_synced_at, provider_sync_error,
             odoo_bill_id, odoo_bill_url, subtotal, tax_amount, total_amount,
             currency, line_items
           )
           VALUES
             ($1, $2, 'manually_entered', 'approved', 'succeeded', 'pending',
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, $3, $4, $5, $6, $7::jsonb),
             ($1, $2, 'manually_entered', 'approved', 'succeeded', 'succeeded',
              'provider-guard-1', 'https://provider.example/bills/1', 'created', now(),
              NULL, NULL, NULL, $3, $4, $5, $6, $7::jsonb),
             ($1, $2, 'manually_entered', 'approved', 'succeeded', 'succeeded',
              'odoo-guard-1', 'https://odoo.example/bills/1', 'created', now(), NULL, 'odoo-guard-1',
              'https://odoo.example/bills/1', $3, $4, $5, $6, $7::jsonb),
             ($1, $2, 'manually_entered', 'approved', 'failed', 'failed',
              NULL, NULL, 'failed', NULL, 'old provider failure', NULL, NULL,
              $3, $4, $5, $6, $7::jsonb)
           RETURNING id`,
          [
            workspaceOwnerId,
            entityId,
            invoiceValues.subtotal,
            invoiceValues.taxAmount,
            invoiceValues.totalAmount,
            invoiceValues.currency,
            invoiceValues.lineItems,
          ],
        );

        try {
          const repoRoot = join(__dirname, "../../../..");
          const run = spawnSync(
            "pnpm",
            ["--filter", "@workspace/api-server", "exec", "tsx", "./src/scripts/run-initdb.ts"],
            {
              cwd: repoRoot,
              env: { ...process.env, DATABASE_URL: INITDB_CHECK_DATABASE_URL },
              encoding: "utf8",
              timeout: 180_000,
              maxBuffer: 20 * 1024 * 1024,
            },
          );
          expect(
            run.status,
            `initDb failed with representative ai_invoice_imports rows:\n${run.stdout}\n${run.stderr}`,
          ).toBe(0);

          const after = await pool.query<{
            id: number;
            provider_sync_status: string;
            sync_status: string;
            provider_bill_id: string | null;
            provider_bill_url: string | null;
            provider_bill_status: string | null;
            provider_synced_at: string | null;
            provider_sync_error: string | null;
            odoo_bill_id: string | null;
            odoo_bill_url: string | null;
            subtotal: string;
            tax_amount: string;
            total_amount: string;
            currency: string;
            line_items: unknown;
          }>(
            `SELECT id, provider_sync_status, sync_status, provider_bill_id, provider_bill_url,
             provider_bill_status, provider_synced_at, provider_sync_error,
             odoo_bill_id, odoo_bill_url, subtotal, tax_amount, total_amount,
             currency, line_items
               FROM ai_invoice_imports
              WHERE workspace_owner_id = $1
              ORDER BY id`,
            [workspaceOwnerId],
          );

          expect(after.rows).toHaveLength(4);
          const afterById = new Map(after.rows.map((row) => [row.id, row]));
          const identityFreeExpected = {
            provider_sync_status: "pending",
            sync_status: "not_requested",
            provider_bill_id: null,
            provider_bill_url: null,
            provider_bill_status: null,
            provider_synced_at: null,
            provider_sync_error: null,
            odoo_bill_id: null,
            odoo_bill_url: null,
            subtotal: invoiceValues.subtotal,
            tax_amount: invoiceValues.taxAmount,
            total_amount: invoiceValues.totalAmount,
            currency: invoiceValues.currency,
            line_items: [{ description: "Guard item", quantity: 1 }],
          };
          expect(afterById.get(inserted.rows[0]!.id)).toMatchObject(identityFreeExpected);
          expect(afterById.get(inserted.rows[3]!.id)).toMatchObject(identityFreeExpected);

          expect(afterById.get(inserted.rows[1]!.id)).toMatchObject({
            provider_sync_status: "succeeded",
            sync_status: "succeeded",
            provider_bill_id: "provider-guard-1",
            provider_bill_url: "https://provider.example/bills/1",
            provider_bill_status: "created",
            odoo_bill_id: null,
            odoo_bill_url: null,
            subtotal: invoiceValues.subtotal,
            tax_amount: invoiceValues.taxAmount,
            total_amount: invoiceValues.totalAmount,
          });
          expect(afterById.get(inserted.rows[2]!.id)).toMatchObject({
            provider_sync_status: "succeeded",
            sync_status: "succeeded",
            provider_bill_id: "odoo-guard-1",
            provider_bill_url: "https://odoo.example/bills/1",
            odoo_bill_id: "odoo-guard-1",
            odoo_bill_url: "https://odoo.example/bills/1",
            subtotal: invoiceValues.subtotal,
            tax_amount: invoiceValues.taxAmount,
            total_amount: invoiceValues.totalAmount,
          });

          const nullability = await pool.query<{
            is_nullable: string;
            column_default: string | null;
          }>(
            `SELECT is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema='public'
                AND table_name='ai_invoice_imports'
                AND column_name='provider_sync_status'`,
          );
          expect(nullability.rows[0]).toMatchObject({
            is_nullable: "NO",
            column_default: "'pending'::text",
          });
        } finally {
          await pool.query(
            `DELETE FROM ai_invoice_imports WHERE workspace_owner_id = $1`,
            [workspaceOwnerId],
          );
          await pool.query(
            `DELETE FROM finance_entities WHERE workspace_owner_id = $1`,
            [workspaceOwnerId],
          );
        }
      },
      240_000,
    );
  },
);
