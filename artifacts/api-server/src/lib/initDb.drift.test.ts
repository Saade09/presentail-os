/**
 * Static drift check — no DB connection required.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * initDb.ts is the sole migration mechanism for production deployments.
 * Drizzle push is never run in production. When a developer adds a new table
 * to lib/db/src/schema/* but forgets to add the matching CREATE TABLE block in
 * initDb.ts, production deployments start with that table missing.
 *
 * This test catches that drift by comparing:
 *   • Every table exported from @workspace/db/schema (Drizzle schema)
 *   • Against every CREATE TABLE in initDb.ts (production DDL)
 *
 * It also verifies that tables appearing in initDb.ts but absent from the
 * Drizzle schema are explicitly listed in INITDB_ONLY_TABLE_ALLOWLIST — so
 * raw-SQL-only tables are accounted for and new ones can't slip through
 * silently.
 *
 * COMPLEMENTARY TEST
 * ──────────────────
 * initDb.schema.integration.test.ts performs the same check using a real DB
 * (requires INITDB_CHECK_DATABASE_URL). This test is cheaper: it runs on
 * every `pnpm test` pass without any infrastructure.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { is, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Tables that live in initDb.ts raw SQL only (not managed by Drizzle) ────
//
// When a table graduates to the Drizzle schema, remove it from this list.
// When a new raw-SQL-only table is added to initDb.ts, add it here.
const INITDB_ONLY_TABLE_ALLOWLIST = new Set([
  // ── Google Business Profile review ingestion (raw SQL only) ─────────────
  "gbp_connections",
  "gbp_oauth_config",
  "gbp_oauth_states",
  "gbp_location_connections",
  "gbp_tracked_locations",

  // ── Legacy print-agent tables (pre-Drizzle; raw SQL only) ───────────────
  "devices",
  "print_jobs",
  "known_user_devices",
  "known_user_countries",
  "download_events",
  "notification_seen_ids",
  "api_keys",

  // ── People / HR tables (raw SQL only) ───────────────────────────────────
  "people",
  "team_members",
  "team_member_profiles",
  "departments",
  "work_schedules",
  "work_schedule_days",
  "work_schedule_assignments",
  "work_schedule_exceptions",
  "attendance_records",
  "blackout_dates",
  "time_off_types",
  "time_off_policies",
  "user_time_off_policies",
  "time_off_balances",
  "time_off_requests",

  // ── Fleet / driver tables (raw SQL only) ─────────────────────────────────
  "fleet_drivers",
  "fleet_driver_api_tokens",
  "fleet_vehicle_types",
  "fleet_driver_order_assignments",
  "fleet_proof_of_delivery",
  "fleet_driver_transactions",
  "fleet_driver_notifications",
  "otp_rate_limits",

  // ── Catalog publishing webhook tables (raw SQL only) ─────────────────────
  "product_webhook_subscriptions",
  "product_webhook_deliveries",

  // ── Outgoing webhook tables (raw SQL only) ────────────────────────────────
  "webhook_endpoints",
  "webhook_deliveries",

  // ── Payment tables (raw SQL only) ────────────────────────────────────────
  "mamo_payments",
  "mamo_payment_links",
  "mamo_webhook_events",

  // ── Object storage tables (raw SQL only) ─────────────────────────────────
  "object_storage_uploads",
  "object_storage_objects",
  "object_storage_buckets",

  // ── AI invoice / finance tables (raw SQL only) ────────────────────────────
  "ai_invoice_batches",
  "ai_invoice_items",
  "ai_invoice_line_items",
  "ai_invoice_validation_results",
  "ai_invoice_extraction_batches",
  "ai_invoice_extraction_items",
  "ai_invoice_extraction_line_items",
  "ai_invoice_extraction_validation_results",

  // ── Publishing batch tables (raw SQL only) ────────────────────────────────
  "publishing_batches",
  "publishing_batch_items",

  // ── WooCommerce / legacy import tables (raw SQL only) ────────────────────
  "woocommerce_stores",
  "woocommerce_orders",
  "cities",

  // ── CMC POS tables (raw SQL only) ───────────────────────────────────────
  "cmc_order_counters",
  "cmc_return_counters",

  // ── Address Book tables (raw SQL only) ──────────────────────────────────
  "places",
  "place_aliases",
  "contact_addresses",
  "order_place_links",
  "order_place_contact_links",
  "place_verification_events",
  "place_order_address_contexts",
  "address_book_schema_migrations",

  // ── Scanner / device tables (raw SQL only) ───────────────────────────────
  "scanner_stations",
  "scanner_pairing_codes",
  "scanner_device_tokens",

  // ── One-time migration backup tables (raw SQL only) ─────────────────────
  "workspace_members_backup_20260803",
  "init_db_data_migrations",


  // ── Cash session overdue tables (raw SQL only) ───────────────────────────
  "cash_session_reminders",
  "cash_session_resolutions",

  "supplier_statement_entries",
  "supplier_reconciliation_sessions",
  "supplier_reconciliation_matches",
  "supplier_reconciliation_exceptions",
  "supplier_reconciliation_audit",

  "coupon_excluded_products",
  "coupon_excluded_attributes",
  "whatsapp_delivered_notifications",

  // ── Supplier finance tables (raw SQL only) ───────────────────────────────
  "supplier_invoice_payments",

  // ── Security / ops / misc tables (raw SQL only) ─────────────────────────
  "security_alert_events",
  "blocks",
  "supplier_catalog_item_stock_log",
  "smoke_test_runs",
  "low_stock_alert_notifications",
  "purchase_order_activity",
  "stock_alert_dismissals",
  "base_item_cutover_runs",
  "purchase_order_acceptances",

  // ── Events tables (raw SQL only) ─────────────────────────────────────────
  "events",
  "event_occasions",
  "event_publications",

  // ── Stripe Connect tables (raw SQL only) ─────────────────────────────────
  "stripe_connect_accounts",
  "stripe_connect_charges",
  "stripe_connect_transfers",
  "stripe_connect_refunds",
  "stripe_connect_payouts",
  "stripe_connect_balance_transactions",
  "stripe_connect_invoices",
  "stripe_connect_invoice_items",
  "stripe_connect_subscriptions",
  "stripe_connect_subscription_items",
  "stripe_connect_plans",
  "stripe_connect_products",
  "stripe_connect_customers",
  "stripe_connect_payment_methods",
  "stripe_connect_payment_intents",
  "stripe_connect_setup_intents",
  "stripe_connect_disputes",
  "stripe_connect_reviews",
  "stripe_connect_files",
  "stripe_connect_file_links",
  "stripe_connect_events",
  "stripe_connect_webhook_endpoints",
  "stripe_connect_webhook_events",

  // ── Operational batch / publication tables (raw SQL only) ───────────────
  "weekly_slot_cleanup_batches",
  "weekly_slot_cleanup_quarantine",
  "florist_photo_publications",
  "address_reverification_runs",
  "address_reverification_jobs",
]);

// ─── Derived sets ─────────────────────────────────────────────────────────────

/** All table names declared in the Drizzle schema (lib/db/src/schema/*). */
const DRIZZLE_SCHEMA_TABLES: string[] = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableName(t));

/** All table names that appear in a CREATE TABLE IF NOT EXISTS statement in initDb.ts. */
const initDbSource = readFileSync(join(__dirname, "initDb.ts"), "utf-8");
// Strip single-line comments before scanning so that lines like
//   // ... CREATE TABLE IF NOT EXISTS and thus …
// don't produce false positives.
const initDbSourceNoComments = initDbSource
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");
const INITDB_TABLE_NAMES: string[] = [
  ...new Set(
    [...initDbSourceNoComments.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
      (m) => m[1]!,
    ),
  ),
];

// These columns hold either durable product media references or the state
// needed to safely retry inbound address replies.  They are intentionally
// covered here as well as by the initDb-only integration parity check: a
// publish-time schema diff must never turn a live column into a DROP.
const PRESERVED_COLUMN_CONTRACTS = [
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

const normalizedInitDbSource = initDbSourceNoComments.replace(/\s+/g, " ");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("initDb drift — static check (no DB required)", () => {
  it("every Drizzle schema table has a CREATE TABLE IF NOT EXISTS block in initDb.ts", () => {
    const initDbSet = new Set(INITDB_TABLE_NAMES);
    const missing = DRIZZLE_SCHEMA_TABLES.filter((t) => !initDbSet.has(t));
    expect(
      missing,
      `The following Drizzle schema table(s) are missing from initDb.ts — ` +
        `add a CREATE TABLE IF NOT EXISTS block for each one so production ` +
        `deployments are not missing the table:\n  ${missing.join("\n  ")}`,
    ).toHaveLength(0);
  });

  it("every table in initDb.ts is either in the Drizzle schema or in INITDB_ONLY_TABLE_ALLOWLIST", () => {
    const drizzleSet = new Set(DRIZZLE_SCHEMA_TABLES);
    const unaccounted = INITDB_TABLE_NAMES.filter(
      (t) => !drizzleSet.has(t) && !INITDB_ONLY_TABLE_ALLOWLIST.has(t),
    );
    expect(
      unaccounted,
      `The following table(s) appear in initDb.ts but are neither in the ` +
        `Drizzle schema nor in INITDB_ONLY_TABLE_ALLOWLIST — either add them ` +
        `to the Drizzle schema or add them to the allowlist in this file:\n  ` +
        unaccounted.join("\n  "),
    ).toHaveLength(0);
  });

  it("keeps publish-critical product media and inbound-reply columns in initDb", () => {
    for (const contract of PRESERVED_COLUMN_CONTRACTS) {
      const createTable = normalizedInitDbSource.match(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS ${contract.tableName} \\([^;]*\\)`,
          "i",
        ),
      )?.[0];

      expect(
        createTable,
        `initDb.ts must create the ${contract.tableName} table with its live columns`,
      ).toBeDefined();

      for (const column of contract.columns) {
        expect(
          createTable,
          `${contract.tableName}.${column} is missing from its initDb CREATE TABLE definition`,
        ).toMatch(new RegExp(`\\b${column}\\b`, "i"));

        expect(
          normalizedInitDbSource,
          `${contract.tableName}.${column} must not have an active initDb DROP`,
        ).not.toMatch(
          new RegExp(
            `ALTER TABLE ${contract.tableName} DROP COLUMN[^;]*\\b${column}\\b`,
            "i",
          ),
        );
      }
    }
  });
});
